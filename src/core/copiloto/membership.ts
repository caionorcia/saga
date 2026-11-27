/**
 * Copiloto da Saga, Adendo v1.4 (v0.11.0): conferência dos grupos da mentoria.
 *
 * O mentor escolhe, em Configurações › Copiloto da Saga, qual grupo (ou comunidade) do WhatsApp é cada marca do perfil
 * (`MEMBERSHIP_SLOTS`). Uma vez por dia (no começo do horário de envio + alguns minutos) e 2 min depois de alguém entrar
 * num desses grupos, o SagaZap manda `{action: "group_membership"}` com, por grupo, só os hashes do roster de quem
 * participa. Ninguém fora do roster nem sem telefone conhecido sai do computador.
 *
 * - Participantes: os guardados aqui (`group_members`, da consulta diária dos grupos e dos eventos de entrada/saída),
 *   com o @lid resolvido pelo mesmo caminho dos eventos (`pnForLid`: memória, `lid_pn`, armazenamento local do Baileys).
 *   Comunidade: a comunidade e o grupo de avisos dela. Grupo escolhido sem participantes conhecidos: uma consulta só dele
 *   (pela fila do WhatsApp, dentro dos limites de sempre) e espera até 5 min.
 * - O pedido vai pela fila de uma requisição por vez do Copiloto. 429/5xx/rede: espera crescente (1 → 30 min). `invalid`
 *   (ou 400): a mesma conferência não vai de novo. 401: para tudo, como as outras ações.
 * - Registro: só contagens de grupos. Nunca participantes, hashes, nomes ou JIDs.
 */
import type { Clock } from '../clock'
import type { Repo } from '../db/repo'
import { sha256hex, phoneOfJid, phoneVariants, rosterHash } from './identity'
import { loadGroupKinds, sourceGroups } from '../wa/groupKinds'
import { parseHHMM, type SendSchedule } from '../../shared/sendHours'
import {
  MEMBERSHIP_KEYS,
  MEMBERSHIP_LIMITS,
  MEMBERSHIP_SLOTS,
  MEMBERSHIP_TEXT,
  isMembershipKey,
  type MembershipCheckResult,
  type MembershipGroupOption,
  type MembershipKey,
  type MembershipResult,
  type MembershipView
} from '../../shared/membership'

export const MEMBERSHIP_SETTINGS = {
  /** JSON `{chave: jid do grupo}` (só as escolhidas) */
  groups: 'copiloto.membershipGroups',
  /** JSON `{chave: MembershipResult}`: a última resposta `stored` de cada grupo */
  results: 'copiloto.membershipResults',
  /** JSON `{day, at, done}`: o horário sorteado da conferência de hoje e se ela já foi */
  daily: 'copiloto.membershipDaily',
  /** epoch ms do último "Conferir agora" */
  manualAt: 'copiloto.membershipManualAt',
  /** impressão da última conferência recusada (`invalid`/400): a mesma não vai de novo */
  invalid: 'copiloto.membershipInvalid',
  /** epoch ms da última conferência que foi ao Copiloto e o último problema (texto fixo) */
  lastAttemptAt: 'copiloto.membershipLastAttemptAt',
  lastProblem: 'copiloto.membershipLastProblem'
} as const

const S = MEMBERSHIP_SETTINGS
const MIN = 60_000

export interface MembershipDeps {
  repo: Repo
  clock: Clock
  rng?: () => number
  /** o horário de envio (Configurações › Envio direto); null/desligado = 09:00 */
  schedule?: () => SendSchedule | null
  /** o telefone (`@s.whatsapp.net`) conhecido para um @lid, sem rede */
  pnForLid?: (lid: string) => string | null
  /** a consulta só de um grupo (pela fila do WhatsApp, nos limites de sempre) */
  requestMeta?: (groupJid: string) => void
  diag?: (kind: string, detail: string) => void
}

/** O resultado do POST, como o `CopilotoSync` vê. */
export type MembershipPost = { kind: 'network' } | { kind: 'http'; status: number; body: unknown }

/** O que um pedido leva (para o registro e a resposta). */
export interface MembershipRequest {
  body: string
  keys: MembershipKey[]
  /** hashes enviados e se passou de 1500, por grupo */
  sent: Partial<Record<MembershipKey, { count: number; capped: boolean }>>
  /** a impressão do pedido sem o `checked_at` */
  fingerprint: string
  at: number
}

/** Os hashes do roster de uma lista de participantes (todas as formas: telefone e @lid), sem repetir, no máximo `max`. */
export function memberHashes(
  memberJids: Iterable<string>,
  roster: ReadonlySet<string>,
  pnForLid: (lid: string) => string | null = () => null,
  max: number = MEMBERSHIP_LIMITS.membersMax
): { hashes: string[]; capped: boolean } {
  const out: string[] = []
  const seen = new Set<string>()
  let capped = false
  for (const jid of memberJids) {
    let phone: string | null = null
    if (jid.endsWith('@s.whatsapp.net')) phone = phoneOfJid(jid)
    else if (jid.endsWith('@lid')) {
      try {
        phone = phoneOfJid(pnForLid(`${jid.slice(0, jid.lastIndexOf('@')).split(':')[0]}@lid`))
      } catch {
        phone = null
      }
    }
    // sem telefone conhecido: fica de fora
    if (!phone) continue
    for (const v of phoneVariants(phone)) {
      const h = rosterHash(v)
      if (!roster.has(h) || seen.has(h)) continue
      if (out.length >= max) {
        capped = true
        continue
      }
      seen.add(h)
      out.push(h)
    }
  }
  return { hashes: out, capped }
}

/** `checked_at`: ISO-8601 em UTC, sem os milissegundos (nunca no futuro). */
export const checkedAt = (now: number): string => new Date(Math.floor(now / 1000) * 1000).toISOString().replace('.000Z', 'Z')

const localDayStart = (now: number): number => {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000

/** A resposta 200 do Copiloto. `stored` com os números de cada grupo (só os que vieram certos). */
export function parseMembershipResponse(body: unknown): { status: string; groups: Partial<Record<MembershipKey, { received: number; matched: number; marked: number }>> } {
  const b = body as { status?: unknown; groups?: unknown } | null
  const status = typeof b?.status === 'string' ? b.status.slice(0, 16) : 'sem_status'
  const groups: Partial<Record<MembershipKey, { received: number; matched: number; marked: number }>> = {}
  if (b?.groups && typeof b.groups === 'object' && !Array.isArray(b.groups)) {
    for (const [k, v] of Object.entries(b.groups as Record<string, unknown>)) {
      if (!isMembershipKey(k) || !v || typeof v !== 'object') continue
      const x = v as Record<string, unknown>
      if (isCount(x.received) && isCount(x.matched) && isCount(x.marked)) groups[k] = { received: x.received, matched: x.matched, marked: x.marked }
    }
  }
  return { status, groups }
}

interface Pending {
  keys: Set<MembershipKey>
  /** esta conferência é a diária (marca o dia como feito quando acabar) */
  daily: boolean
  attempts: number
  nextAt: number
  /** a consulta dos grupos sem participantes conhecidos já foi pedida (espera até `metaUntil`) */
  metaUntil: number | null
  /** 413: um grupo por pedido */
  split: boolean
}

export class GroupMembership {
  private pending: Pending | null = null
  /** entradas recentes: chave → primeira entrada e quando sai (2 min sem entrada nova, no máximo 10 min) */
  private joins = new Map<MembershipKey, { first: number; due: number }>()

  constructor(private readonly deps: MembershipDeps) {}

  private get repo(): Repo {
    return this.deps.repo
  }

  private now(): number {
    return this.deps.clock.now()
  }

  private diag(detail: string): void {
    try {
      this.deps.diag?.('copiloto_membership', detail)
    } catch {
      // registrar nunca quebra a fila
    }
  }

  private readJson<T>(key: string, fallback: T): T {
    try {
      const v = JSON.parse(this.repo.getSetting(key) ?? 'null') as T | null
      return v && typeof v === 'object' ? v : fallback
    } catch {
      return fallback
    }
  }

  // --- escolha dos grupos ---

  /** Os grupos escolhidos (chave → JID). */
  chosen(): Partial<Record<MembershipKey, string>> {
    const raw = this.readJson<Record<string, unknown>>(S.groups, {})
    const out: Partial<Record<MembershipKey, string>> = {}
    for (const k of MEMBERSHIP_KEYS) {
      const j = raw[k]
      if (typeof j === 'string' && j.endsWith('@g.us')) out[k] = j
    }
    return out
  }

  /** Escolhe (ou tira, com null) o grupo de uma marca. A próxima conferência diária já vale para ele. */
  setGroup(key: MembershipKey, jid: string | null): boolean {
    if (!isMembershipKey(key)) return false
    if (jid !== null && !(typeof jid === 'string' && /^[0-9-]{5,40}@g\.us$/.test(jid))) return false
    const cur = this.chosen()
    if ((cur[key] ?? null) === jid) return true
    if (jid === null) delete cur[key]
    else cur[key] = jid
    this.repo.setSetting(S.groups, JSON.stringify(cur))
    // o resultado era de outro grupo
    const results = this.results()
    delete results[key]
    this.repo.setSetting(S.results, JSON.stringify(results))
    this.joins.delete(key)
    this.pending?.keys.delete(key)
    if (this.pending && this.pending.keys.size === 0 && !this.pending.daily) this.pending = null
    this.repo.logEvent('copiloto_membership', `grupos escolhidos para a conferência: ${Object.keys(cur).length}`)
    return true
  }

  private results(): Partial<Record<MembershipKey, MembershipResult>> {
    const raw = this.readJson<Record<string, unknown>>(S.results, {})
    const out: Partial<Record<MembershipKey, MembershipResult>> = {}
    for (const k of MEMBERSHIP_KEYS) {
      const r = raw[k] as Partial<MembershipResult> | undefined
      if (r && typeof r.at === 'number' && isCount(r.received) && isCount(r.matched) && isCount(r.marked)) {
        out[k] = { at: r.at, received: r.received, matched: r.matched, marked: r.marked, capped: r.capped === true }
      }
    }
    return out
  }

  /** Os grupos e comunidades de que a conta participa, por nome (para a lista). */
  options(): MembershipGroupOption[] {
    const kinds = loadGroupKinds(this.repo)
    const known = Object.keys(kinds.groups)
    const names = this.repo.groupNames()
    const nameOf = new Map(names.map((g) => [g.jid, g.name]))
    // depois da primeira consulta dos grupos: só os de que a conta participa; antes, todos com nome
    const jids = new Set(known.length ? known : names.map((g) => g.jid))
    for (const j of Object.values(this.chosen())) if (j) jids.add(j)
    const out: MembershipGroupOption[] = []
    for (const jid of jids) {
      const k = kinds.groups[jid]
      const base = nameOf.get(jid)
      const kind: MembershipGroupOption['kind'] = k?.c === 1 ? 'community' : k?.a === 1 ? 'announce' : 'group'
      let name = base ?? null
      if (kind === 'announce' && k?.p) {
        const parent = nameOf.get(k.p)
        name = parent ? `${parent} › avisos` : (base ?? null)
      }
      if (!name) continue
      out.push({ jid, name, kind })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
  }

  view(): MembershipView {
    const chosen = this.chosen()
    const results = this.results()
    const nameOf = new Map(this.options().map((o) => [o.jid, o.name]))
    const now = this.now()
    const manualAt = Number(this.repo.getSetting(S.manualAt) ?? 0) || 0
    const lastAttempt = Number(this.repo.getSetting(S.lastAttemptAt) ?? NaN)
    return {
      slots: MEMBERSHIP_SLOTS.map((s) => {
        const jid = chosen[s.key] ?? null
        return { key: s.key, label: s.label, jid, name: jid ? (nameOf.get(jid) ?? null) : null, last: results[s.key] ?? null }
      }),
      lastAttemptAt: Number.isFinite(lastAttempt) ? lastAttempt : null,
      lastProblem: this.repo.getSetting(S.lastProblem),
      manualAvailableAt: manualAt && now - manualAt < MEMBERSHIP_LIMITS.manualEveryMs ? manualAt + MEMBERSHIP_LIMITS.manualEveryMs : null
    }
  }

  // --- quando ---

  /** Os grupos escolhidos cujos participantes vêm deste grupo (ele mesmo, ou a comunidade/os avisos dela). */
  private keysFor(groupJid: string): MembershipKey[] {
    const kinds = loadGroupKinds(this.repo)
    const chosen = this.chosen()
    return MEMBERSHIP_KEYS.filter((k) => {
      const j = chosen[k]
      return !!j && sourceGroups(j, kinds).includes(groupJid)
    })
  }

  /** `group-participants.update` com `add`: a conferência só desse grupo, 2 min depois da última entrada. */
  onJoin(groupJid: string): boolean {
    const keys = this.keysFor(groupJid)
    if (keys.length === 0) return false
    const now = this.now()
    for (const k of keys) {
      const first = this.joins.get(k)?.first ?? now
      this.joins.set(k, { first, due: Math.min(now + MEMBERSHIP_LIMITS.joinDebounceMs, first + MEMBERSHIP_LIMITS.joinMaxWaitMs) })
    }
    return true
  }

  /** "Conferir agora": todos os escolhidos, no máximo uma vez a cada 10 min. */
  requestNow(enabled: boolean): MembershipCheckResult {
    if (!enabled) return { ok: false, message: MEMBERSHIP_TEXT.off }
    const keys = Object.keys(this.chosen()) as MembershipKey[]
    if (keys.length === 0) return { ok: false, message: MEMBERSHIP_TEXT.none }
    const now = this.now()
    const last = Number(this.repo.getSetting(S.manualAt) ?? 0) || 0
    if (last && now - last < MEMBERSHIP_LIMITS.manualEveryMs) {
      return { ok: false, message: MEMBERSHIP_TEXT.wait(Math.max(1, Math.ceil((last + MEMBERSHIP_LIMITS.manualEveryMs - now) / MIN))) }
    }
    this.repo.setSetting(S.manualAt, String(now))
    // o pedido manual não tem a mesma impressão garantida: uma recusa anterior não o barra
    this.repo.deleteSetting(S.invalid)
    this.enqueue(keys, false, now)
    return { ok: true, view: this.view() }
  }

  private enqueue(keys: Iterable<MembershipKey>, daily: boolean, at: number): void {
    if (!this.pending) this.pending = { keys: new Set(), daily: false, attempts: 0, nextAt: at, metaUntil: null, split: false }
    // em espera crescente (o Copiloto falhou) ou esperando a consulta de um grupo: junta e sai junto, na mesma hora
    else if (this.pending.attempts === 0 && this.pending.metaUntil === null) this.pending.nextAt = Math.min(this.pending.nextAt, at)
    for (const k of keys) this.pending.keys.add(k)
    if (daily) this.pending.daily = true
  }

  /** O horário sorteado da conferência de hoje (null = hoje não é dia de envio). Grava o sorteio do dia. */
  dailyTarget(now: number = this.now()): { day: number; at: number; done: boolean } | null {
    const day = localDayStart(now)
    const saved = this.readJson<{ day?: unknown; at?: unknown; done?: unknown }>(S.daily, {})
    if (saved.day === day && typeof saved.at === 'number') return { day, at: saved.at, done: saved.done === true }
    const sched = this.deps.schedule?.() ?? null
    let startMin: number = MEMBERSHIP_LIMITS.defaultStartMin
    if (sched?.enabled) {
      const d = sched.days[new Date(now).getDay()]
      const start = parseHHMM(d?.start)
      if (!d?.on || start === null) return null
      startMin = start
    }
    const rng = this.deps.rng ?? Math.random
    const jitter = MEMBERSHIP_LIMITS.jitterMinMs + Math.floor(rng() * (MEMBERSHIP_LIMITS.jitterMaxMs - MEMBERSHIP_LIMITS.jitterMinMs))
    const base = new Date(now)
    const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(startMin / 60), startMin % 60).getTime() + jitter
    const v = { day, at, done: false }
    this.repo.setSetting(S.daily, JSON.stringify(v))
    return v
  }

  private markDailyDone(): void {
    const t = this.dailyTarget()
    if (t) this.repo.setSetting(S.daily, JSON.stringify({ ...t, done: true }))
  }

  /** Põe na fila o que venceu (a diária, as entradas). */
  private collect(now: number): void {
    if (Object.keys(this.chosen()).length === 0) {
      this.joins.clear()
      return
    }
    const t = this.dailyTarget(now)
    // a diária: no horário sorteado ou depois (o computador ligado mais tarde no mesmo dia confere assim que ligar)
    if (t && !t.done && now >= t.at && !this.pending?.daily) this.enqueue(Object.keys(this.chosen()) as MembershipKey[], true, now)
    const due: MembershipKey[] = []
    for (const [k, j] of this.joins) if (j.due <= now) due.push(k)
    if (due.length) {
      for (const k of due) this.joins.delete(k)
      this.enqueue(due, false, now)
    }
  }

  /** Quando há algo para mandar (epoch ms), ou null. */
  nextAt(now: number = this.now()): number | null {
    if (Object.keys(this.chosen()).length === 0) return null
    let at = this.pending ? this.pending.nextAt : Infinity
    for (const j of this.joins.values()) at = Math.min(at, j.due)
    const t = this.dailyTarget(now)
    if (t && !t.done) at = Math.min(at, t.at)
    return Number.isFinite(at) ? at : null
  }

  // --- o pedido ---

  /**
   * O pedido que deve sair agora (null = nada). Grupo escolhido sem participantes conhecidos: pede a consulta dele e
   * espera até 5 min (uma vez por conferência); depois vai sem ele. Conferência igual à última recusada: não vai.
   */
  take(roster: ReadonlySet<string>, now: number = this.now()): MembershipRequest | null {
    this.collect(now)
    const p = this.pending
    if (!p || p.nextAt > now) return null
    const chosen = this.chosen()
    const kinds = loadGroupKinds(this.repo)
    const keys = [...p.keys].filter((k) => chosen[k])
    if (keys.length === 0) {
      this.finish(p)
      return null
    }
    const unknown = new Set<string>()
    for (const k of keys) for (const src of sourceGroups(chosen[k]!, kinds)) if (!this.repo.hasGroupMembership(src)) unknown.add(src)
    if (unknown.size && p.metaUntil === null && this.deps.requestMeta) {
      for (const j of unknown) {
        try {
          this.deps.requestMeta(j)
        } catch {
          // sem a consulta: vai com o que se sabe
        }
      }
      p.metaUntil = now + MEMBERSHIP_LIMITS.metaWaitMs
      p.nextAt = p.metaUntil
      this.diag(`conferência: ${unknown.size} grupo(s) sem participantes conhecidos; consulta pedida`)
      return null
    }
    const groups: Record<string, { members: string[] }> = {}
    const sent: MembershipRequest['sent'] = {}
    const sendKeys: MembershipKey[] = []
    for (const k of MEMBERSHIP_KEYS) {
      if (!keys.includes(k)) continue
      if (p.split && sendKeys.length > 0) break
      const srcs = sourceGroups(chosen[k]!, kinds).filter((j) => this.repo.hasGroupMembership(j))
      // participantes ainda desconhecidos: este grupo não é conferido desta vez
      if (srcs.length === 0) continue
      const members = new Set<string>()
      for (const src of srcs) for (const m of this.repo.groupMembers(src)) members.add(m)
      const { hashes, capped } = memberHashes([...members].sort(), roster, this.deps.pnForLid)
      groups[k] = { members: hashes }
      sent[k] = { count: hashes.length, capped }
      sendKeys.push(k)
    }
    if (sendKeys.length === 0) {
      this.diag(`conferência: nenhum grupo com participantes conhecidos (${keys.length} escolhido(s)); fica para a próxima`)
      this.finish(p)
      return null
    }
    const fingerprint = sha256hex(JSON.stringify(groups))
    if (this.repo.getSetting(S.invalid) === fingerprint) {
      this.diag(`conferência igual à recusada pelo Copiloto: não enviada (grupos=${sendKeys.length})`)
      this.done(p, sendKeys)
      return null
    }
    const body = JSON.stringify({ version: 1, action: 'group_membership', checked_at: checkedAt(now), groups })
    return { body, keys: sendKeys, sent, fingerprint, at: Math.floor(now / 1000) * 1000 }
  }

  private finish(p: Pending): void {
    if (p.daily) this.markDailyDone()
    if (this.pending === p) this.pending = null
  }

  /** Estes grupos acabaram (aceitos ou recusados de vez); o resto do pedido continua. */
  private done(p: Pending, keys: ReadonlyArray<MembershipKey>): void {
    for (const k of keys) p.keys.delete(k)
    p.attempts = 0
    if (p.keys.size === 0) this.finish(p)
    else p.nextAt = this.now()
  }

  /**
   * A resposta do Copiloto. `'auth'` = 401 (o `CopilotoSync` para tudo). Registro: só o status e quantos grupos.
   */
  handle(req: MembershipRequest, r: MembershipPost): 'ok' | 'auth' | 'retry' | 'invalid' {
    const p = this.pending
    const now = this.now()
    this.repo.setSetting(S.lastAttemptAt, String(now))
    if (r.kind === 'http' && r.status === 401) return 'auth'
    if (!p) return 'ok'
    if (r.kind === 'http' && r.status === 200) {
      const parsed = parseMembershipResponse(r.body)
      if (parsed.status === 'invalid') return this.invalid(p, req, '200 invalid')
      const results = this.results()
      for (const k of req.keys) {
        const g = parsed.groups[k]
        if (g) results[k] = { at: req.at, ...g, capped: req.sent[k]?.capped === true }
      }
      this.repo.setSetting(S.results, JSON.stringify(results))
      this.repo.deleteSetting(S.lastProblem)
      this.repo.deleteSetting(S.invalid)
      this.diag(`conferência: status=200 ${parsed.status} grupos=${req.keys.length}`)
      this.done(p, req.keys)
      return 'ok'
    }
    if (r.kind === 'http' && r.status === 400) return this.invalid(p, req, '400')
    if (r.kind === 'http' && r.status === 413) {
      if (req.keys.length > 1) {
        p.split = true
        p.nextAt = now
        this.diag(`conferência: status=413 grupos=${req.keys.length}; um grupo por pedido`)
        return 'retry'
      }
      return this.invalid(p, req, '413')
    }
    // 429, 5xx, rede e o resto: espera crescente (1 → 30 min); a próxima tentativa refaz a lista com o que houver
    p.attempts++
    const delay = Math.min(30 * MIN, MIN * 2 ** (p.attempts - 1))
    p.nextAt = now + delay
    p.metaUntil = p.metaUntil ?? now
    const st = r.kind === 'network' ? 'network' : String(r.status)
    this.repo.setSetting(S.lastProblem, 'O Copiloto não respondeu à conferência dos grupos. Nova tentativa em breve.')
    this.repo.logEvent('copiloto_error', `conferência dos grupos: status=${st} tentativa=${p.attempts} nova tentativa em ${Math.round(delay / MIN)} min`)
    return 'retry'
  }

  private invalid(p: Pending, req: MembershipRequest, why: string): 'invalid' {
    this.repo.setSetting(S.invalid, req.fingerprint)
    this.repo.setSetting(S.lastProblem, MEMBERSHIP_TEXT.invalid)
    this.repo.logEvent('copiloto_error', `conferência dos grupos recusada (${why}): grupos=${req.keys.length}; a mesma não vai de novo`)
    this.done(p, req.keys)
    return 'invalid'
  }

  /** Integração desligada (ou outro servidor): esquece o que estava para sair. */
  reset(): void {
    this.pending = null
    this.joins.clear()
  }
}
