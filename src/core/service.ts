import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { systemClock, type Clock } from './clock'
import type { ContactKind, ContactRow, MessageRow, Repo } from './db/repo'
import { hasFreeSpace as defaultHasFreeSpace } from './disk'
import { BudgetExceededError, CostTracker } from './ai/budget'
import {
  LlmRateLimitError,
  LlmRefusalError,
  NoMessagesError,
  analysisContext,
  createLlm,
  generateAnalysis,
  isAnalysisFresh,
  type CreateLlmOpts,
  type LlmProvider
} from './ai/llm'
import { InvalidOutputError } from './ai/prompt'
import { ModelUnavailableError, resetGroqModelCache } from './ai/groqModels'
import {
  InvalidKeyError,
  createTranscriber,
  registerTranscribeHandler,
  type CreateTranscriberOpts,
  type TranscribePauseReason,
  type Transcriber
} from './ai/transcriber'
import { reconcileSaved, reconcileSent, saveApproved } from './memory/memory'
import { audioUrlFor } from './media'
import { LIMITS, RateLimiter, type LimiterName } from './queue/limiter'
import { JobQueue, type JobType } from './queue/queue'
import { EncryptionUnavailableError, SettingsStore, testKey, type KeyKind, type Provider, type SettingsPatch } from './settings'
import type { NormalizedMessage } from './types'
import { WhatsAppClient, type ConnState, type WhatsAppClientDeps } from './wa/client'
import type { WaVersionFetcher } from './wa/version'
import type {
  AiErrorCode,
  AnalysisResult,
  AppState,
  UpdateState,
  MessageView,
  RecentEvent,
  SaveReplyInput,
  SaveSettingsResult,
  SettingsView,
  Unsubscribe
} from '../shared/api'

/** O que o serviço usa do cliente do WhatsApp (o real ou um falso nos testes / modo SAGA_FAKE_WA). */
export interface WaClientLike {
  on(event: 'qr' | 'status' | 'message' | 'disk' | 'contacts', listener: (arg: any) => void): unknown
  start(): Promise<void>
  stop(): Promise<void>
  manualReconnect(): Promise<void>
  onResumeFromSleep(sleptMs: number): void
  getStatus(): ConnState | null
  /** próxima tentativa de reconexão (epoch ms), ou null */
  getRetryAt?(): number | null
  isDiskLow(): boolean
  recheckDisk(): Promise<void>
}

export interface SagaServiceOpts {
  repo: Repo
  settings: SettingsStore
  paths: { authDir: string; backupDir: string; mediaDir: string }
  clock?: Clock
  rng?: () => number
  hasFreeSpace?: (dir: string, minBytes: number) => Promise<boolean>
  /** padrão: `new WhatsAppClient(deps)` */
  waClientFactory?: (deps: WhatsAppClientDeps) => WaClientLike
  /** padrão: `createLlm` */
  llmFactory?: (kind: Provider, apiKey: string, opts: CreateLlmOpts) => LlmProvider
  /** padrão: `createTranscriber` */
  transcriberFactory?: (kind: 'groq' | 'openai', apiKey: string, opts: CreateTranscriberOpts) => Transcriber
  /** usado por `testKey` (testes) */
  fetchImpl?: typeof fetch
  /** busca da versão do WhatsApp Web (testes); padrão: a do Baileys */
  fetchWaVersion?: WaVersionFetcher
  /** registro de diagnóstico (arquivo de log no processo principal) */
  diag?: (kind: string, detail: string) => void
}

const EVER_CONNECTED = 'wa.everConnected'
/** parada definitiva (restrição, outro lugar): vale também depois de reiniciar o app */
const STOPPED_STATE = 'wa.stoppedState'
/**
 * `stopped_outdated` não entra: ao reiniciar, o app busca a versão atual do WhatsApp Web e tenta de novo
 * (a versão 0.1.0 guardava essa parada e ficava sem QR para sempre).
 */
const PERSISTED_STOPS: ReadonlySet<ConnState> = new Set(['stopped_restricted', 'stopped_replaced'])
const EMIT_DELAY_MS = 150
const DEFAULT_STOP_TIMEOUT_MS = 5_000

/** Espera `p` por até `ms`; erros de `p` (agora ou depois) nunca escapam. */
async function withDeadline(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([p.catch(() => {}), new Promise<void>((r) => (timer = setTimeout(r, ms)))])
  clearTimeout(timer)
}

function toView(m: MessageRow): MessageView {
  return {
    id: m.id,
    jid: m.jid,
    fromMe: m.fromMe,
    ts: m.ts,
    kind: m.kind,
    text: m.text,
    durationSec: m.durationSec,
    hasAudio: !!m.audioPath,
    transcript: m.transcript,
    transcriptStatus: m.transcriptStatus,
    senderJid: m.senderJid,
    senderName: m.senderLabel,
    mentionsMe: m.mentionsMe
  }
}

function aiErrorCode(e: unknown): AiErrorCode {
  if (e instanceof InvalidKeyError) return 'invalid_key'
  if (e instanceof BudgetExceededError) return 'budget_exceeded'
  if (e instanceof LlmRateLimitError) return 'rate_limited'
  if (e instanceof LlmRefusalError) return 'refusal'
  if (e instanceof InvalidOutputError) return 'invalid_output'
  if (e instanceof NoMessagesError) return 'no_messages'
  if (e instanceof ModelUnavailableError) return 'model_unavailable'
  return 'unknown'
}

const AI_MESSAGES: Record<AiErrorCode, string> = {
  missing_key: 'Configure a chave da IA nas configurações.',
  invalid_key: 'A chave da IA foi recusada. Confira a chave nas configurações.',
  budget_exceeded: 'O teto diário de gasto com IA foi atingido.',
  rate_limited: 'A IA pediu para esperar um pouco. Tente de novo em instantes.',
  refusal: 'A IA não quis responder a esta conversa. Tente de novo.',
  invalid_output: 'A IA respondeu fora do formato esperado. Tente de novo.',
  no_messages: 'Ainda não há mensagens deste contato.',
  model_unavailable:
    'Nenhum modelo de IA da Groq está disponível para a sua chave agora (os modelos que o app conhece foram aposentados). Tente de novo mais tarde ou escolha o Claude nas configurações.',
  unknown: 'Não foi possível gerar as sugestões agora. Tente de novo.'
}

/**
 * Junta todos os módulos do core: fila, limitadores, cliente do WhatsApp, transcrição, IA e memória.
 * O processo principal só repassa chamadas (IPC) e eventos para cá.
 *
 * Eventos: `'state'(AppState)`, `'contacts'()`, `'messages'(jid)`.
 */
export class SagaService extends EventEmitter {
  readonly queue: JobQueue
  readonly limiters: Record<LimiterName, RateLimiter>
  private readonly wa: WaClientLike
  private readonly repo: Repo
  private readonly settings: SettingsStore
  private readonly clock: Clock
  private readonly cost: CostTracker
  private readonly llmFactory: NonNullable<SagaServiceOpts['llmFactory']>
  private readonly transcriberFactory: NonNullable<SagaServiceOpts['transcriberFactory']>
  private readonly fetchImpl?: typeof fetch

  private qr: string | null = null
  /** geração em andamento por contato; `generates` = vai chamar a IA (forçada ou cache velho) */
  private inflight = new Map<string, { p: Promise<AnalysisResult>; generates: boolean }>()
  private pendingJids = new Set<string>()
  private pendingContacts = false
  private pendingState = false
  private update: UpdateState = { status: 'none' }
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private stopping: Promise<void> | null = null
  /** parada definitiva lida do banco ao iniciar: não conecta até "Reconectar" */
  private persistedStop: ConnState | null = null
  /** a fila foi pausada por causa de `persistedStop` (volta ao reconectar) */
  private pausedByPersistedStop = false
  private transcribePauseReason: TranscribePauseReason | null = null
  /** downloads de áudio concluídos no lote atual (zera quando o lote termina) */
  private downloadsDone = 0
  /** `start()` falhou: a interface mostra o erro em vez de "Conectando…" */
  private startError: string | null = null
  private readonly diagFn?: (kind: string, detail: string) => void

  constructor(opts: SagaServiceOpts) {
    super()
    const { repo } = opts
    const clock = opts.clock ?? systemClock
    const rng = opts.rng ?? Math.random
    this.repo = repo
    this.settings = opts.settings
    this.clock = clock
    this.fetchImpl = opts.fetchImpl
    this.diagFn = opts.diag
    this.llmFactory = opts.llmFactory ?? ((kind, key, o) => createLlm(kind, key, o))
    this.transcriberFactory = opts.transcriberFactory ?? ((kind, key, o) => createTranscriber(kind, key, fetch, o))
    this.cost = new CostTracker(repo, clock)

    const lim = (name: LimiterName) => new RateLimiter(LIMITS[name], clock, rng, { repo, key: `limiter:${name}` })
    this.limiters = { wa_media: lim('wa_media'), wa_profile: lim('wa_profile'), groq_audio: lim('groq_audio'), llm: lim('llm') }
    const byType: Record<JobType, RateLimiter> = {
      download_audio: this.limiters.wa_media,
      transcribe: this.limiters.groq_audio,
      fetch_profile: this.limiters.wa_profile
    }
    this.queue = new JobQueue(repo, clock, byType, { diag: (k, d) => this.diag(k, d) })

    registerTranscribeHandler({
      queue: this.queue,
      repo,
      getTranscriber: () => this.currentTranscriber(),
      cost: this.cost,
      getCapUsd: () => this.settings.get().dailyCapUsd,
      onPause: (reason) => {
        this.transcribePauseReason = reason
        this.markState()
      }
    })
    this.queue.onJobFailed((job) => {
      if (job.type === 'download_audio') {
        const c = repo.jobCounts('download_audio')
        if (c.pending + c.running === 0) this.downloadsDone = 0
      }
      const id = (job.payload as { id?: unknown } | null)?.id
      // áudio sem transcrição depois da última tentativa: estado "falhou" com "Tentar de novo"
      if ((job.type === 'transcribe' || job.type === 'download_audio') && typeof id === 'string') {
        const msg = repo.getMessage(id)
        if (msg && msg.transcriptStatus !== 'done' && msg.transcriptStatus !== 'unavailable') {
          repo.setTranscript(id, null, 'failed')
          this.markMessages(msg.jid)
        }
      }
      this.markState()
    })
    this.queue.onJobDone((job) => {
      if (job.type === 'download_audio') {
        const c = repo.jobCounts('download_audio')
        this.downloadsDone = c.pending + c.running === 0 ? 0 : this.downloadsDone + 1
      }
      const id = (job.payload as { id?: unknown } | null)?.id
      if (typeof id === 'string') {
        const msg = repo.getMessage(id)
        if (msg) this.markMessages(msg.jid)
      }
      this.markState()
    })

    const factory = opts.waClientFactory ?? ((d: WhatsAppClientDeps) => new WhatsAppClient(d))
    this.wa = factory({
      repo,
      queue: this.queue,
      clock,
      rng,
      ...opts.paths,
      limiters: Object.values(this.limiters),
      hasFreeSpace: opts.hasFreeSpace ?? defaultHasFreeSpace,
      ...(opts.fetchWaVersion ? { fetchWaVersion: opts.fetchWaVersion } : {}),
      ...(opts.diag ? { diag: opts.diag } : {})
    })
    this.wa.on('qr', (dataUrl: string) => {
      this.qr = dataUrl
      this.markState()
    })
    this.wa.on('status', (s: ConnState) => {
      if (s !== 'needs_qr') this.qr = null
      if (s === 'open') repo.setSetting(EVER_CONNECTED, '1')
      if (PERSISTED_STOPS.has(s)) repo.setSetting(STOPPED_STATE, s)
      this.markState()
    })
    this.wa.on('disk', () => this.markState())
    this.wa.on('contacts', () => {
      this.pendingContacts = true
      this.scheduleEmit()
    })
    this.wa.on('message', (m: NormalizedMessage) => {
      try {
        reconcileSent(repo, m)
      } catch (e) {
        repo.logEvent('reconcile_error', e instanceof Error ? e.message : String(e))
      }
      this.markMessages(m.jid)
    })
  }

  // --- ciclo de vida ---

  /**
   * Recupera a fila, aquece os limitadores, conecta e liga a fila. Não chama a IA.
   * Se o WhatsApp parou de vez da última vez (restrição, versão, outro lugar), não conecta e a fila fica
   * pausada até o mentor clicar em "Reconectar".
   */
  async start(): Promise<void> {
    try {
      await this.doStart()
      this.startError = null
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300)
      this.startError = msg
      try {
        this.repo.logEvent('start_error', msg)
      } catch {
        // banco indisponível: o registro de diagnóstico ainda anota
      }
      this.diag('start_error', e instanceof Error && e.stack ? e.stack.slice(0, 1000) : msg)
      this.markState()
      throw e
    }
  }

  private diag(kind: string, detail: string): void {
    try {
      this.diagFn?.(kind, detail)
    } catch {
      // registrar nunca quebra o app
    }
  }

  private async doStart(): Promise<void> {
    this.queue.recoverAfterCrash()
    for (const l of Object.values(this.limiters)) l.startWarmup()
    const stopped = this.repo.getSetting(STOPPED_STATE) as ConnState | null
    // parada guardada que não vale mais entre reinícios (ex.: versão desatualizada da 0.1.0): descarta
    if (stopped && !PERSISTED_STOPS.has(stopped)) this.repo.deleteSetting(STOPPED_STATE)
    if (stopped && PERSISTED_STOPS.has(stopped)) {
      this.persistedStop = stopped
      if (!this.queue.isPaused()) {
        this.queue.pause()
        this.pausedByPersistedStop = true
      }
      this.repo.logEvent(`wa_${stopped}`, 'parado desde a última vez; aguardando "Reconectar"')
    } else {
      await this.wa.start()
    }
    this.queue.start()
    this.markState()
  }

  /**
   * Para a fila (espera o job atual por até `timeoutMs`) e depois desconecta o WhatsApp
   * (também por até `timeoutMs`): o cliente é sempre parado, mesmo com um job travado.
   * O que ainda rodar depois do prazo termina sozinho; erros dele (ex.: banco já fechado)
   * são engolidos pela fila e pelo cliente.
   */
  stop(opts: { timeoutMs?: number } = {}): Promise<void> {
    this.stopping ??= (async () => {
      if (this.emitTimer) clearTimeout(this.emitTimer)
      this.emitTimer = null
      const timeoutMs = opts.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
      await withDeadline(this.queue.stop(), timeoutMs)
      await withDeadline(this.wa.stop(), timeoutMs)
    })()
    return this.stopping
  }

  onResumeFromSleep(sleptMs: number): void {
    this.wa.onResumeFromSleep(sleptMs)
  }

  // --- estado e eventos ---

  async getState(): Promise<AppState> {
    return this.state()
  }

  state(): AppState {
    const s = this.settings.get()
    return {
      conn: this.persistedStop ?? this.wa.getStatus() ?? 'connecting',
      qr: this.qr,
      retryAt: this.wa.getRetryAt?.() ?? null,
      queue: this.queue.stats(),
      paused: this.queue.isPaused(),
      diskLow: this.wa.isDiskLow(),
      transcribePaused: this.queue.isTypePaused('transcribe'),
      transcribePausedReason: this.queue.isTypePaused('transcribe') ? (this.transcribePauseReason ?? 'key') : null,
      downloads: this.downloadsState(),
      costTodayUsd: this.cost.todayUsd(),
      setupDone: s.keys.groq && this.repo.getSetting(EVER_CONNECTED) === '1',
      provider: s.provider,
      update: this.update,
      ...(this.startError ? { startError: this.startError } : {})
    }
  }

  private downloadsState(): AppState['downloads'] {
    const c = this.repo.jobCounts('download_audio')
    return { remaining: c.pending + c.running, done: this.downloadsDone }
  }

  /** Chamado pelo atualizador (processo principal) quando o estado da atualização muda. */
  setUpdate(u: UpdateState): void {
    this.update = u
    this.markState()
  }

  onState(cb: (s: AppState) => void): Unsubscribe {
    this.on('state', cb)
    return () => this.off('state', cb)
  }

  onContactsChanged(cb: () => void): Unsubscribe {
    this.on('contacts', cb)
    return () => this.off('contacts', cb)
  }

  onMessages(jid: string, cb: () => void): Unsubscribe {
    const l = (j: string) => {
      if (j === jid) cb()
    }
    this.on('messages', l)
    return () => this.off('messages', l)
  }

  private markState(): void {
    this.pendingState = true
    this.scheduleEmit()
  }

  private markMessages(jid: string): void {
    this.pendingJids.add(jid)
    this.pendingContacts = true
    this.pendingState = true
    this.scheduleEmit()
  }

  /** Junta rajadas (histórico com centenas de mensagens) em poucos eventos. */
  private scheduleEmit(): void {
    if (this.emitTimer || this.stopping) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      const jids = [...this.pendingJids]
      const contacts = this.pendingContacts
      const state = this.pendingState
      this.pendingJids.clear()
      this.pendingContacts = false
      this.pendingState = false
      try {
        if (contacts) this.emit('contacts')
        for (const j of jids) this.emit('messages', j)
        if (state) this.emit('state', this.state())
      } catch (e) {
        this.repo.logEvent('emit_error', e instanceof Error ? e.message : String(e))
      }
    }, EMIT_DELAY_MS)
  }

  // --- contatos e mensagens ---

  /**
   * Nomes de perfil não são buscados aqui: o handler `fetch_profile` não faz chamada de rede
   * (Baileys v7 não tem consulta de nome só de leitura); os nomes vêm da ingestão.
   */
  async listContacts(includeHidden: boolean, kind: ContactKind = 'all'): Promise<ContactRow[]> {
    return this.repo.listContacts({ includeHidden, kind })
  }

  async listMessages(jid: string): Promise<MessageView[]> {
    return this.repo.listMessages(jid).map(toView)
  }

  async renameContact(jid: string, name: string): Promise<void> {
    this.repo.renameContact(jid, name)
    this.pendingContacts = true
    this.scheduleEmit()
  }

  /** Esconder para de baixar/transcrever os áudios do contato; mostrar de novo devolve os que faltam à fila. */
  async setHidden(jid: string, hidden: boolean): Promise<void> {
    this.repo.setHidden(jid, hidden)
    if (!hidden) {
      for (const m of this.repo.listMessages(jid)) {
        if (m.kind !== 'audio' || m.transcriptStatus !== null) continue
        if (m.audioPath && existsSync(m.audioPath)) {
          this.queue.requeue('transcribe', `transcribe:${m.id}`, { id: m.id, durationSec: m.durationSec, ts: m.ts })
        } else {
          this.queue.requeue('download_audio', m.id, { id: m.id, ts: m.ts })
        }
      }
    }
    this.pendingContacts = true
    this.pendingState = true
    this.scheduleEmit()
  }

  async setNotes(jid: string, text: string): Promise<void> {
    this.repo.setNotes(jid, text)
  }

  async audioUrl(id: string): Promise<string | null> {
    const m = this.repo.getMessage(id)
    if (!m?.audioPath) return null
    return audioUrlFor(basename(m.audioPath, '.ogg'))
  }

  // --- IA ---

  getAnalysis(jid: string): Promise<AnalysisResult> {
    return this.analyze(jid, false)
  }

  regenerate(jid: string): Promise<AnalysisResult> {
    return this.analyze(jid, true)
  }

  /**
   * Uma geração por contato de cada vez, sem chamadas pagas repetidas:
   * - uma chamada normal se junta a qualquer uma em andamento;
   * - uma forçada se junta só a uma que de fato está gerando (forçada ou cache velho);
   *   se a em andamento só leu o cache, a forçada roda depois dela (e as próximas se juntam a esta).
   */
  private analyze(jid: string, force: boolean): Promise<AnalysisResult> {
    const cur = this.inflight.get(jid)
    if (cur && (cur.generates || !force)) return cur.p
    const generates = force || !this.cacheFresh(jid)
    const run = cur
      ? cur.p.then(
          () => this.doAnalyze(jid, force),
          () => this.doAnalyze(jid, force)
        )
      : this.doAnalyze(jid, force)
    const entry = {
      generates,
      p: run.finally(() => {
        if (this.inflight.get(jid) === entry) this.inflight.delete(jid)
      })
    }
    this.inflight.set(jid, entry)
    return entry.p
  }

  /** A análise guardada ainda vale (mesma última mensagem e mesmas transcrições)? */
  private cacheFresh(jid: string): boolean {
    return isAnalysisFresh(this.repo, jid)
  }

  private async doAnalyze(jid: string, force: boolean): Promise<AnalysisResult> {
    const s = this.settings.get()
    const provider = s.provider
    const fail = (code: AiErrorCode): AnalysisResult => ({ ok: false, code, message: AI_MESSAGES[code], provider })
    const key = this.settings.getKey(provider)
    if (!key) return fail('missing_key')
    try {
      const analysis = await generateAnalysis(
        {
          repo: this.repo,
          llm: this.llmFactory(provider, key, { repo: this.repo, clock: this.clock, diag: (k, d) => this.diag(k, d) }),
          limiter: this.limiters.llm,
          cost: this.cost,
          capUsd: s.dailyCapUsd,
          clock: this.clock
        },
        jid,
        { force }
      )
      return { ok: true, analysis }
    } catch (e) {
      const code = aiErrorCode(e)
      // a mensagem do erro vem do nosso código ou do SDK; nunca contém a chave
      this.repo.logEvent('ai_error', `${provider}: ${code}: ${e instanceof Error ? e.message : String(e)}`)
      return fail(code)
    } finally {
      this.markState()
    }
  }

  /**
   * Grava a resposta aprovada. O contexto são as mensagens novas do contato como eram na análise que gerou
   * a sugestão (o mentor pode ter copiado e enviado antes de salvar). Se essa resposta já foi enviada
   * (mensagem minha parecida nas últimas 6 h), liga o texto enviado na hora.
   */
  async saveReply(input: SaveReplyInput): Promise<number> {
    const finalText = input.finalText.trim()
    if (!finalText) throw new Error('resposta vazia')
    const stored = this.repo.getAnalysis(input.jid)
    const { contextText } = analysisContext(this.repo, input.jid, input.analysisLastMsgId ?? stored?.lastMsgId)
    const provider = stored?.provider ?? this.settings.get().provider
    const id = saveApproved(this.repo, {
      jid: input.jid,
      contextText,
      originalSuggestion: input.originalSuggestion,
      finalText,
      provider
    })
    try {
      reconcileSaved(this.repo, { id, jid: input.jid, finalText }, this.clock.now())
    } catch (e) {
      this.repo.logEvent('reconcile_error', e instanceof Error ? e.message : String(e))
    }
    return id
  }

  private currentTranscriber(): Transcriber | null {
    const kind = this.settings.get().transcriber
    const key = this.settings.getKey(kind)
    if (!key) return null
    const t = this.transcriberFactory(kind, key, { repo: this.repo, clock: this.clock, diag: (k, d) => this.diag(k, d) })
    // o tipo vem da configuração (custo: OpenAI é paga), não do objeto criado
    return { kind, transcribe: (file, sec, signal) => t.transcribe(file, sec, signal) }
  }

  // --- fila ---

  async pauseAll(): Promise<void> {
    this.queue.pause()
    this.markState()
  }

  /** Retoma a fila, as transcrições e re-checa o disco (downloads voltam se houver espaço e conexão). */
  async resumeAll(): Promise<void> {
    this.queue.resume()
    this.queue.resumeType('transcribe')
    await this.wa.recheckDisk()
    this.markState()
  }

  /** "Reconectar" / "Gerar novo QR Code": limpa a parada definitiva guardada e conecta já. */
  async manualReconnect(): Promise<void> {
    if (this.startError) {
      // o início falhou: tenta o início inteiro de novo (fila, limitadores e conexão)
      this.repo.deleteSetting(STOPPED_STATE)
      this.persistedStop = null
      await this.start()
      return
    }
    this.repo.deleteSetting(STOPPED_STATE)
    this.persistedStop = null
    if (this.pausedByPersistedStop) {
      this.pausedByPersistedStop = false
      this.queue.resume()
    }
    await this.wa.manualReconnect()
    this.markState()
  }

  async retryFailedJobs(): Promise<number> {
    const failed = this.repo.listJobs('failed')
    for (const j of failed) this.queue.retryFailed(j.id)
    this.markState()
    return failed.length
  }

  // --- configurações ---

  async recentEvents(limit: number): Promise<RecentEvent[]> {
    return this.repo.recentEvents(limit)
  }

  async getSettings(): Promise<SettingsView> {
    return this.settings.get()
  }

  async saveSettings(patch: SettingsPatch): Promise<SaveSettingsResult> {
    try {
      this.settings.save(patch)
    } catch (e) {
      if (e instanceof EncryptionUnavailableError) return { ok: false, code: 'encryption_unavailable', message: e.message }
      return { ok: false, code: 'invalid', message: e instanceof Error ? e.message : String(e) }
    }
    // chave da Groq ou modelo configurado mudou: a lista de modelos e os "aposentados" valem de novo
    if (patch.groqKey !== undefined || patch.groqModel !== undefined) resetGroqModelCache(this.repo)
    // uma chave nova pode destravar as transcrições pausadas por falta de chave (ou chave recusada)
    // e um teto novo pode destravar as pausadas pelo gasto
    if (patch.groqKey || patch.openaiKey || patch.transcriber || patch.dailyCapUsd !== undefined) this.queue.resumeType('transcribe')
    this.markState()
    return { ok: true, settings: this.settings.get() }
  }

  testKey(kind: KeyKind, key: string): Promise<boolean> {
    return testKey(kind, key, { fetchImpl: this.fetchImpl })
  }
}
