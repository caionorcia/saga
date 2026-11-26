/**
 * Copiloto da Saga (v0.5.0): a fila de saída e o envio para o Copiloto (HTTPS para o Supabase; não toca no WhatsApp,
 * por isso não passa pela fila de jobs do WhatsApp). Contrato: `docs/superpowers/specs/2026-11-26-copiloto-integration.md`.
 *
 * - Uma requisição por vez, no mínimo 2 s entre elas; lotes de até 100 eventos e 512 KB (413 → lote menor).
 * - 200: cada evento do lote está concluído, seja qual for o status dele. 400: o lote inteiro fica inválido.
 * - 401: para tudo e mostra "Código do Copiloto inválido". 429, 5xx, rede: espera crescente de 1 min até 30 min.
 * - Roster (telefones dos mentorados, em hash) ao ligar e a cada 6 h; conversa nova de mentorado ganha a carga dos
 *   últimos 30 dias.
 * - Registro: só contagens e códigos de status. Nunca o conteúdo, telefones, o endereço ou o código.
 */
import type { Clock } from '../clock'
import type { Repo } from '../db/repo'
import type { OutboxRow } from '../db/copilotoRepo'
import type { Cipher } from '../settings'
import {
  COPILOTO_TEXT,
  isCopilotoUrl,
  type CopilotoCodeResult,
  type CopilotoPatch,
  type CopilotoSaveResult,
  type CopilotoStatus,
  type CopilotoTestResult
} from '../../shared/copiloto'
import { EventBuilder, serialize } from './events'
import { generateCode, isRosterHash } from './identity'

export const COPILOTO_LIMITS = {
  batchEvents: 100,
  batchBytes: 512 * 1024,
  gapMs: 2_000,
  retryMinMs: 60_000,
  retryMaxMs: 30 * 60_000,
  rosterEveryMs: 6 * 60 * 60_000,
  backfillDays: 30,
  timeoutMs: 30_000,
  idleMs: 15_000,
  dirtyPerTick: 500,
  /** eventos já aceitos: a impressão fica este tempo (evita reenviar o mesmo estado) */
  keepDoneMs: 45 * 24 * 60 * 60_000,
  rosterMax: 100_000
} as const

const DAY = 24 * 60 * 60_000

export const COPILOTO_KEYS = {
  enabled: 'copiloto.enabled',
  url: 'copiloto.url',
  code: 'key.copiloto',
  roster: 'copiloto.roster',
  lastSentAt: 'copiloto.lastSentAt',
  lastError: 'copiloto.lastError',
  lastErrorAt: 'copiloto.lastErrorAt',
  authFailed: 'copiloto.authFailed'
} as const

const K = COPILOTO_KEYS

export interface CopilotoSyncDeps {
  repo: Repo
  cipher: Cipher
  clock: Clock
  fetchImpl?: typeof fetch
  /** o telefone que o cliente do WhatsApp conhece para um @lid */
  pnForLid?: (lid: string) => string | null
  diag?: (kind: string, detail: string) => void
}

interface Roster {
  at: number
  phones: string[]
}

type PostResult = { kind: 'network' } | { kind: 'http'; status: number; body: unknown }

export class CopilotoSync {
  private readonly repo: Repo
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopped = true
  /** uma requisição por vez (envio, roster e "Testar conexão") */
  private lock: Promise<unknown> = Promise.resolve()
  private nextRequestAt = 0
  private failures = 0
  private rosterRetryAt = 0
  private maxBatch: number = COPILOTO_LIMITS.batchEvents
  private rosterCache: { raw: string; set: Set<string> } | null = null

  constructor(private readonly deps: CopilotoSyncDeps) {
    this.repo = deps.repo
  }

  // --- configurações ---

  enabled(): boolean {
    return this.repo.getSetting(K.enabled) === '1'
  }

  private url(): string | null {
    return this.repo.getSetting(K.url)
  }

  /** O código, só para o cabeçalho da requisição. Nunca registrar nem mandar à interface. */
  private code(): string | null {
    const raw = this.repo.getSetting(K.code)
    if (!raw) return null
    try {
      return this.deps.cipher.decrypt(Buffer.from(raw, 'base64')) || null
    } catch {
      return null
    }
  }

  private roster(): Roster | null {
    const raw = this.repo.getSetting(K.roster)
    if (!raw) return null
    try {
      const v = JSON.parse(raw) as Roster
      if (typeof v?.at === 'number' && Array.isArray(v.phones)) return v
    } catch {
      // ilegível: busca de novo
    }
    return null
  }

  private rosterSet(): Set<string> | null {
    const raw = this.repo.getSetting(K.roster)
    if (!raw) return null
    if (this.rosterCache?.raw === raw) return this.rosterCache.set
    const r = this.roster()
    if (!r) return null
    this.rosterCache = { raw, set: new Set(r.phones) }
    return this.rosterCache.set
  }

  status(): CopilotoStatus {
    const num = (k: string) => {
      const v = Number(this.repo.getSetting(k) ?? NaN)
      return Number.isFinite(v) ? v : null
    }
    const r = this.roster()
    return {
      enabled: this.enabled(),
      url: this.url(),
      hasCode: this.code() !== null,
      pending: this.repo.copiloto.pendingCount(),
      lastSentAt: num(K.lastSentAt),
      lastError: this.repo.getSetting(K.lastError),
      lastErrorAt: num(K.lastErrorAt),
      authFailed: this.repo.getSetting(K.authFailed) === '1',
      rosterSize: r?.phones.length ?? 0,
      rosterAt: r?.at ?? null,
      chats: this.repo.copiloto.chatCount()
    }
  }

  /** Liga/desliga e o endereço. Ligar exige endereço e código; desligar apaga a fila local. */
  save(patch: CopilotoPatch): CopilotoSaveResult {
    if (patch.url !== undefined) {
      const url = typeof patch.url === 'string' ? patch.url.trim() : ''
      if (url && !isCopilotoUrl(url)) return { ok: false, message: COPILOTO_TEXT.invalidUrl }
      if (url !== (this.url() ?? '')) {
        if (url) this.repo.setSetting(K.url, url)
        else this.repo.deleteSetting(K.url)
        // outro servidor: a lista de mentorados e o bloqueio por código recusado valem de novo
        this.repo.deleteSetting(K.roster)
        this.repo.deleteSetting(K.authFailed)
        this.rosterRetryAt = 0
      }
    }
    if (patch.enabled === true && !this.enabled()) {
      if (!this.url() || !this.code()) return { ok: false, message: COPILOTO_TEXT.needsSetup }
      this.repo.setSetting(K.enabled, '1')
      this.repo.deleteSetting(K.authFailed)
      // roster novo ao ligar (e a carga inicial das conversas de mentorados)
      this.repo.deleteSetting(K.roster)
      this.resetBackoff()
      this.repo.logEvent('copiloto_on', 'integração com o Copiloto ligada')
    } else if (patch.enabled === false && this.enabled()) {
      this.repo.setSetting(K.enabled, '0')
      this.repo.copiloto.clearAll()
      this.repo.deleteSetting(K.roster)
      this.repo.deleteSetting(K.lastError)
      this.repo.deleteSetting(K.lastErrorAt)
      this.repo.logEvent('copiloto_off', 'integração com o Copiloto desligada; fila local apagada')
    }
    if (this.enabled()) this.kick()
    else this.clearTimer()
    return { ok: true, status: this.status() }
  }

  /** "Gerar código": guarda cifrado e devolve uma vez só. */
  generateCode(): CopilotoCodeResult {
    if (!this.deps.cipher.isAvailable()) return { ok: false, message: COPILOTO_TEXT.encryption }
    const code = generateCode()
    this.repo.setSetting(K.code, this.deps.cipher.encrypt(code).toString('base64'))
    this.repo.deleteSetting(K.authFailed)
    this.resetBackoff()
    this.repo.logEvent('copiloto_code', 'código novo gerado')
    if (this.enabled()) this.kick()
    return { ok: true, code }
  }

  /** "Testar conexão": pede o roster agora. */
  test(): Promise<CopilotoTestResult> {
    return this.exclusive(async () => {
      const url = this.url()
      const code = this.code()
      if (!url || !code) return { ok: false, message: COPILOTO_TEXT.needsSetup }
      const r = await this.fetchRoster(url, code)
      if (!r.ok) return { ok: false, message: r.message }
      const chats = this.applyRoster(r.phones)
      this.repo.deleteSetting(K.authFailed)
      this.repo.logEvent('copiloto_test', `conexão ok: ${r.phones.length} telefone(s) no roster, ${chats} conversa(s)`)
      if (this.enabled()) this.kick()
      return { ok: true, phones: r.phones.length, chats }
    })
  }

  // --- ciclo ---

  start(): void {
    this.stopped = false
    if (this.enabled()) this.schedule(COPILOTO_LIMITS.gapMs)
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
  }

  /** Algo mudou (ligou, código novo): roda logo, respeitando o intervalo entre requisições. */
  kick(): void {
    if (!this.stopped) this.schedule(0)
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(ms: number): void {
    this.clearTimer()
    if (this.stopped) return
    this.timer = setTimeout(
      () => {
        this.timer = null
        void this.tick()
          .then((next) => {
            if (next !== null) this.schedule(next)
          })
          .catch((e) => {
            this.diag('copiloto_error', `volta falhou: ${e instanceof Error ? e.name : 'erro'}`)
            this.schedule(COPILOTO_LIMITS.idleMs)
          })
      },
      Math.max(0, ms)
    )
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  /**
   * Uma volta: roster (se preciso), o que mudou → fila, e no máximo um lote. Devolve em quanto tempo rodar de novo
   * (null = parado: desligado ou código recusado). Público para os testes.
   */
  async tick(): Promise<number | null> {
    if (this.running) return COPILOTO_LIMITS.gapMs
    this.running = true
    try {
      return await this.exclusive(() => this.step())
    } finally {
      this.running = false
    }
  }

  private async step(): Promise<number | null> {
    if (!this.enabled() || this.repo.getSetting(K.authFailed) === '1') return null
    const url = this.url()
    const code = this.code()
    if (!url || !code) return null
    const now = this.deps.clock.now()
    const wait = this.nextRequestAt - now
    const roster = this.roster()
    const stale = !roster || now - roster.at >= COPILOTO_LIMITS.rosterEveryMs
    if (stale && now >= this.rosterRetryAt) {
      if (wait > 0) return wait
      const r = await this.fetchRoster(url, code)
      this.nextRequestAt = this.deps.clock.now() + COPILOTO_LIMITS.gapMs
      if (r.ok) {
        this.applyRoster(r.phones)
        this.repo.logEvent('copiloto_roster', `${r.phones.length} telefone(s) de mentorados; ${this.repo.copiloto.chatCount()} conversa(s)`)
        this.repo.copiloto.pruneDone(now - COPILOTO_LIMITS.keepDoneMs)
      } else if (r.auth) {
        return null
      } else {
        this.rosterRetryAt = this.deps.clock.now() + COPILOTO_LIMITS.retryMinMs * 5
      }
      return COPILOTO_LIMITS.gapMs
    }
    // sem roster nenhum ainda: nada vira evento (o que mudou fica anotado, só local)
    const set = this.rosterSet()
    if (!set) return Math.max(this.rosterRetryAt - now, COPILOTO_LIMITS.gapMs)
    const processed = this.processDirty(set)
    if (wait > 0) return wait
    const rows = this.repo.copiloto.due(now, this.maxBatch)
    if (rows.length > 0) {
      await this.sendBatch(url, code, rows)
      if (this.repo.getSetting(K.authFailed) === '1') return null
      return Math.max(this.nextRequestAt - this.deps.clock.now(), COPILOTO_LIMITS.gapMs)
    }
    if (processed > 0 || this.repo.copiloto.dirtyCount() > 0) return COPILOTO_LIMITS.gapMs
    const next = this.repo.copiloto.nextDueAt()
    return next === null ? COPILOTO_LIMITS.idleMs : Math.min(COPILOTO_LIMITS.idleMs, Math.max(next - now, COPILOTO_LIMITS.gapMs))
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lock.then(fn, fn)
    this.lock = p.catch(() => {})
    return p
  }

  private resetBackoff(): void {
    this.failures = 0
    this.nextRequestAt = 0
    this.rosterRetryAt = 0
    this.maxBatch = COPILOTO_LIMITS.batchEvents
  }

  private diag(kind: string, detail: string): void {
    try {
      this.deps.diag?.(kind, detail)
    } catch {
      // registrar nunca quebra o envio
    }
  }

  private setError(text: string | null): void {
    if (text === null) {
      this.repo.deleteSetting(K.lastError)
      this.repo.deleteSetting(K.lastErrorAt)
      return
    }
    this.repo.setSetting(K.lastError, text)
    this.repo.setSetting(K.lastErrorAt, String(this.deps.clock.now()))
  }

  // --- roster ---

  /** Guarda o roster novo e acerta as conversas: carga inicial das novas, fora da fila as que saíram. */
  private applyRoster(phones: string[]): number {
    const roster: Roster = { at: this.deps.clock.now(), phones }
    this.repo.setSetting(K.roster, JSON.stringify(roster))
    const set = this.rosterSet()!
    const b = this.builder(set)
    const chats = new Set(this.repo.copiloto.listChats().filter((c) => b.chat(c.jid) !== null).map((c) => c.jid))
    if (!this.enabled()) return chats.size
    const dropped = this.repo.copiloto.dropPendingExcept(chats)
    this.repo.copiloto.forgetChatsExcept(chats)
    const since = this.deps.clock.now() - COPILOTO_LIMITS.backfillDays * DAY
    let fresh = 0
    for (const jid of chats) {
      if (this.repo.copiloto.isBackfilled(jid)) continue
      this.repo.copiloto.backfill(jid, since)
      fresh++
    }
    if (fresh || dropped) this.diag('copiloto_backfill', `conversas novas=${fresh} pendentes removidos=${dropped}`)
    return chats.size
  }

  private async fetchRoster(url: string, code: string): Promise<{ ok: true; phones: string[] } | { ok: false; auth: boolean; message: string }> {
    const r = await this.post(url, code, JSON.stringify({ action: 'roster' }))
    if (r.kind === 'network') {
      this.diag('copiloto_roster', 'falhou: rede')
      return { ok: false, auth: false, message: COPILOTO_TEXT.network }
    }
    if (r.status === 401) {
      this.authFailed('roster')
      return { ok: false, auth: true, message: COPILOTO_TEXT.invalidCode }
    }
    const body = r.body as { version?: unknown; phones?: unknown } | null
    if (r.status !== 200 || !body || body.version !== 1 || !Array.isArray(body.phones) || body.phones.length > COPILOTO_LIMITS.rosterMax) {
      this.diag('copiloto_roster', `falhou: status=${r.status}`)
      return { ok: false, auth: false, message: `${COPILOTO_TEXT.server} (HTTP ${r.status})` }
    }
    const phones = [...new Set(body.phones.filter(isRosterHash))]
    return { ok: true, phones }
  }

  private authFailed(where: string): void {
    this.repo.setSetting(K.authFailed, '1')
    this.setError(COPILOTO_TEXT.invalidCode)
    this.repo.logEvent('copiloto_error', `status=401 (${where}): envio parado até gerar outro código ou testar a conexão`)
  }

  // --- o que mudou → fila ---

  private builder(roster: ReadonlySet<string>): EventBuilder {
    return new EventBuilder({ repo: this.repo, roster, ...(this.deps.pnForLid ? { pnForLid: this.deps.pnForLid } : {}) })
  }

  /** Transforma as mudanças anotadas em eventos (só de mentorados) e põe na fila. Devolve quantas olhou. */
  processDirty(roster: ReadonlySet<string>): number {
    const refs = this.repo.copiloto.takeDirty(COPILOTO_LIMITS.dirtyPerTick)
    if (refs.length === 0) return 0
    const b = this.builder(roster)
    const since = this.deps.clock.now() - COPILOTO_LIMITS.backfillDays * DAY
    const extra: Array<{ ref: string; jid: string }> = []
    let queued = 0
    for (const { ref, jid } of refs) {
      if (!b.chat(jid)) continue
      if (!this.repo.copiloto.isBackfilled(jid)) this.repo.copiloto.backfill(jid, since)
      const sep = ref.indexOf(':')
      const kind = ref.slice(0, sep)
      const key = ref.slice(sep + 1)
      let built = null
      if (kind === 'm') {
        const m = this.repo.getMessage(key)
        if (m && m.jid === jid) {
          built = b.message(m)
          // o mentor escreveu num grupo: o "Respondido no grupo" das conversas individuais dos participantes pode mudar
          if (m.fromMe && jid.endsWith('@g.us')) {
            for (const p of this.repo.copiloto.groupParticipants(jid)) if (b.chat(p)) extra.push({ ref: `r:${p}`, jid: p })
          }
        }
      } else if (kind === 'a') built = b.alert(Number(key))
      else if (kind === 'r') built = b.replyState(jid)
      else if (kind === 's') built = b.summary(jid)
      else if (kind === 'x') built = b.send(Number(key))
      if (!built || built.jid !== jid) continue
      const { json, hash } = serialize(built.event)
      if (this.repo.copiloto.upsert(built.id, built.jid, json, hash)) queued++
    }
    this.repo.copiloto.removeDirty(refs.map((r) => r.ref))
    if (extra.length) this.repo.copiloto.addDirty(extra)
    if (queued) this.diag('copiloto_queue', `mudanças=${refs.length} eventos na fila=${queued}`)
    return refs.length
  }

  // --- envio ---

  private async post(url: string, code: string, body: string): Promise<PostResult> {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${code}` },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(COPILOTO_LIMITS.timeoutMs)
      })
      let parsed: unknown = null
      try {
        parsed = await res.json()
      } catch {
        // corpo vazio ou não-JSON
      }
      return { kind: 'http', status: res.status, body: parsed }
    } catch {
      return { kind: 'network' }
    }
  }

  private async sendBatch(url: string, code: string, rows: OutboxRow[]): Promise<void> {
    const L = COPILOTO_LIMITS
    const head = '{"version":1,"events":['
    const overhead = Buffer.byteLength(head) + 2
    const batch: OutboxRow[] = []
    let bytes = overhead
    for (const r of rows) {
      const size = Buffer.byteLength(r.payloadJson) + 1
      if (overhead + size > L.batchBytes) {
        // um evento sozinho maior que o limite nunca vai passar
        this.repo.copiloto.finish([r], 'invalid', () => 'too_large')
        continue
      }
      if (bytes + size > L.batchBytes) break
      batch.push(r)
      bytes += size
    }
    if (batch.length === 0) return
    const body = `${head}${batch.map((r) => r.payloadJson).join(',')}]}`
    const res = await this.post(url, code, body)
    const now = this.deps.clock.now()
    this.nextRequestAt = now + L.gapMs
    if (res.kind === 'network') return this.retry(batch, 'network', COPILOTO_TEXT.network)
    const st = res.status
    if (st === 200) {
      const results = new Map<string, string>()
      const list = (res.body as { results?: unknown } | null)?.results
      if (Array.isArray(list)) {
        for (const x of list) {
          const o = x as { id?: unknown; status?: unknown }
          if (typeof o?.id === 'string' && typeof o.status === 'string') results.set(o.id, o.status.slice(0, 32))
        }
      }
      this.repo.copiloto.finish(batch, 'done', (id) => results.get(id) ?? 'ok')
      this.failures = 0
      this.maxBatch = Math.min(L.batchEvents, this.maxBatch * 2)
      this.repo.setSetting(K.lastSentAt, String(now))
      this.setError(null)
      const counts = new Map<string, number>()
      for (const r of batch) {
        const s = results.get(r.eventId) ?? 'sem_status'
        counts.set(s, (counts.get(s) ?? 0) + 1)
      }
      this.diag('copiloto_batch', `status=200 eventos=${batch.length} ${[...counts].map(([k, n]) => `${k}=${n}`).join(' ')}`)
      return
    }
    if (st === 401) {
      this.authFailed('envio')
      return
    }
    if (st === 400) {
      this.repo.copiloto.finish(batch, 'invalid', () => '400')
      this.setError('O Copiloto recusou um lote de eventos (formato inválido).')
      this.repo.logEvent('copiloto_error', `status=400 eventos=${batch.length} marcados como inválidos`)
      return
    }
    if (st === 413) {
      if (batch.length > 1) {
        this.maxBatch = Math.max(1, Math.floor(batch.length / 2))
        this.diag('copiloto_batch', `status=413 eventos=${batch.length} lote dividido`)
      } else {
        this.repo.copiloto.finish(batch, 'invalid', () => '413')
        this.diag('copiloto_batch', 'status=413 evento grande demais')
      }
      return
    }
    return this.retry(batch, String(st), `${COPILOTO_TEXT.server} (HTTP ${st})`)
  }

  /** 429, 5xx, rede (e qualquer outra resposta inesperada): espera crescente, 1 min → 30 min. */
  private retry(batch: OutboxRow[], code: string, text: string): void {
    this.failures++
    const delay = Math.min(COPILOTO_LIMITS.retryMaxMs, COPILOTO_LIMITS.retryMinMs * 2 ** (this.failures - 1))
    const at = this.deps.clock.now() + delay
    this.repo.copiloto.retryLater(batch, at, code)
    this.nextRequestAt = Math.max(this.nextRequestAt, at)
    this.setError(text)
    this.repo.logEvent('copiloto_error', `status=${code} eventos=${batch.length} tentativa=${this.failures} nova tentativa em ${Math.round(delay / 60_000)} min`)
  }
}
