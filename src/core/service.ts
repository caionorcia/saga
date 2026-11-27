import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { systemClock, type Clock } from './clock'
import type { AlertKind, AlertRow, ContactKind, ContactRow, MessageRow, Repo } from './db/repo'
import { CLASSIFY_MAX_AGE_MS, RESOLVED_BY_REPLY, classifyChat } from './ai/classify'
import { WAIT_RED_MS } from '../shared/triage'
import type { AlertQuality, RateReason, ReplyReason } from '../shared/feedback'
import { alertQuality, feedbackCsv, rateAlert, reportMissedAlert } from './ai/alertFeedback'
import { applyReplyRule, confirmNoReply, ruleSaysNoReply, setNeedsReply } from './ai/needsReply'
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
  type LlmName,
  type LlmProvider
} from './ai/llm'
import { FREE_FALLBACKS, ProviderLimits, withFallback } from './ai/fallback'
import { resetGeminiModelCache } from './ai/freeProviders'
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
import { KbImportError, importArchive, importFolder, importPastedText, importSingleFile, type KbPackageDraft } from './kb/importer'
import { KB_LIMITS, type KbChunkView, type KbFilePatch, type KbImportResult, type KbPackageView } from '../shared/kb'
import { audioUrlFor } from './media'
import { runSearch } from './search/search'
import { BackupManager } from './backup/manager'
import { summarizeHits } from './ai/searchSummary'
import type { SearchFilters, SearchResult, SearchSummaryResult } from '../shared/search'
import { LIMITS, RateLimiter, type LimiterName } from './queue/limiter'
import { JobQueue, type JobType } from './queue/queue'
import { EncryptionUnavailableError, SettingsStore, testKey, type Cipher, type KeyKind, type Provider, type SettingsPatch } from './settings'
import type { NormalizedMessage } from './types'
import { recentSince } from './recent'
import { GROUPS_FETCHED_SETTING, WhatsAppClient, type ConnState, type WhatsAppClientDeps } from './wa/client'
import type { WaVersionFetcher } from './wa/version'
import { formatPhone } from './db/repo'
import { SendConflictError, sendJobKey, type SendRow } from './db/sendRepo'
import { SendGate, type SendBinding } from './send/gate'
import { CopilotoSync } from './copiloto/sync'
import {
  COPILOTO_TEXT,
  FOLLOWUP_AUTO,
  FOLLOWUP_LIMITS,
  FOLLOWUP_REASON,
  FOLLOWUP_TEXT,
  type CopilotoCodeResult,
  type CopilotoPatch,
  type CopilotoSaveResult,
  type CopilotoStatus,
  type CopilotoRepairResult,
  type CopilotoTestResult,
  type FollowupOpenResult,
  type FollowupView,
  CONVO_REASON,
  type ConvoAction,
  type ConvoActionResult,
  type ConvoView
} from '../shared/copiloto'
import { followupView, type FollowupRow } from './db/followupRepo'
import { shortReason } from './copiloto/followups'
import { FollowupAutoSender } from './copiloto/autoSend'
import { ConvoEngine, type ConvoDispatch } from './copiloto/convo'
import { draftConvoMessage, type ConvoPromptInput } from './ai/convoPrompt'
import { selectExamples } from './memory/memory'
import { knowledgeFor } from './kb/retrieve'
import { chatHash, hasRecentContactMessage, pickQuote, sendAddress, textHash } from './send/logic'
import { verifyUnknownSend } from './send/verify'
import {
  NOT_CONFIRMED_TEXT,
  SEND_ACTIVE,
  SEND_LIMITS,
  SEND_REFUSAL_TEXT,
  type PrepareSendInput,
  type PrepareSendResult,
  type SendAvulsaInput,
  type SendKind,
  type SendRefusal,
  type SendReplyInput,
  type SendReplyResult,
  type SendView,
  DRAFT_ID_RE
} from '../shared/send'
import { OUTSIDE_HOURS_REASON, isWithinSendHours, outsideHoursText, sendHoursInfo, type SendHoursInfo, type SendSchedule } from '../shared/sendHours'
import type {
  AiErrorCode,
  AnalysisResult,
  AppState,
  UpdateCheck,
  UpdateState,
  MessagePage,
  MessageView,
  RecentEvent,
  SaveReplyInput,
  SaveSettingsResult,
  SettingsView,
  Unsubscribe
} from '../shared/api'

/** Migração v11: conversas que estavam escondidas (os áudios delas voltam para a fila ao iniciar). */
const UNHIDDEN_KEY = 'migration.unhidden_jids'

/** O que o serviço usa do cliente do WhatsApp (o real ou um falso nos testes / modo SAGA_FAKE_WA). */
export interface WaClientLike {
  on(event: 'qr' | 'status' | 'message' | 'disk' | 'contacts' | 'send' | 'membership' | 'paired' | 'history', listener: (arg: any) => void): unknown
  start(): Promise<void>
  stop(): Promise<void>
  manualReconnect(): Promise<void>
  onResumeFromSleep(sleptMs: number): void
  getStatus(): ConnState | null
  /** próxima tentativa de reconexão (epoch ms), ou null */
  getRetryAt?(): number | null
  isDiskLow(): boolean
  recheckDisk(): Promise<void>
  /** geração da conexão atual (vai no job de cada envio: uma conexão nova invalida o que foi confirmado antes) */
  connGen?(): number
  /** o pedido deste envio ao WhatsApp ainda está em andamento */
  isSendInFlight?(sendId: number): boolean
  /** v0.5.0: o telefone (`@s.whatsapp.net`) já conhecido para um @lid, sem rede; null se não souber */
  pnForLid?(lid: string): string | null
  /** v0.8.1: pede a consulta dos grupos (nomes e participantes) de novo, pela fila */
  refreshGroupSubjects?(): void
  /** v0.8.3: o WhatsApp desta versão aceita o pedido de histórico ao celular */
  canFetchHistory?(): boolean
  /** v0.8.3: "Buscar no celular o histórico dos grupos" para estes grupos (pela fila, só leitura) */
  startGroupHistory?(jids: string[], noAnchor: number): unknown
  /** v0.10.0: o mentor está entre os participantes conhecidos do grupo (null = não se sabe) */
  isSelfInGroup?(groupJid: string): boolean | null
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
  llmFactory?: (kind: LlmName, apiKey: string, opts: CreateLlmOpts) => LlmProvider
  /** padrão: `createTranscriber` */
  transcriberFactory?: (kind: 'groq' | 'openai', apiKey: string, opts: CreateTranscriberOpts) => Transcriber
  /** usado por `testKey` (testes) */
  fetchImpl?: typeof fetch
  /** busca da versão do WhatsApp Web (testes); padrão: a do Baileys */
  fetchWaVersion?: WaVersionFetcher
  /** registro de diagnóstico (arquivo de log no processo principal) */
  diag?: (kind: string, detail: string) => void
  /** cópia de segurança: a versão do app (vai no arquivo) e a cifra do sistema (senha das cópias automáticas) */
  appVersion?: string
  cipher?: Cipher
}

const NO_CIPHER: Cipher = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error('criptografia indisponível')
  },
  decrypt: () => {
    throw new Error('criptografia indisponível')
  }
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
/** de quanto em quanto tempo a regra "esperando" (mais de 48 h sem resposta) é conferida */
const WAITING_REFRESH_MS = 5 * 60_000
/** os alertas em segundo plano ficam atrás dos áudios na fila */
const CLASSIFY_PRIORITY = -1
const WAITING_DETAIL = 'Sem resposta há mais de 2 dias.'
const DEFAULT_STOP_TIMEOUT_MS = 5_000
/** os envios confirmados passam na frente dos áudios e dos alertas (cada tipo tem o seu ritmo) */
const SEND_PRIORITY = 20
/** de quanto em quanto tempo os envios parados na fila há mais de 10 min voltam a "aguardando confirmação" */
const SEND_SWEEP_MS = 15_000
/** v0.9.0: mensagens por página da conversa ("Carregar mensagens mais antigas" pede mais) e o teto de uma página */
const MESSAGE_PAGE = 200
const MESSAGE_PAGE_MAX = 20_000
/** `listMessages` (sugestões): as mais novas */
const LIST_MESSAGES_MAX = 300
/** v0.9.0: "Transcrever" num áudio antigo: na frente dos áudios automáticos (atrás dos envios) */
const ON_DEMAND_PRIORITY = 10

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

/** v0.10.0: sem chave da IA principal (o follow-up de conversa mostra "configure a chave"). */
class MissingKeyError extends Error {
  constructor() {
    super('sem chave da IA')
    this.name = 'MissingKeyError'
  }
}

function aiErrorCode(e: unknown): AiErrorCode {
  if (e instanceof MissingKeyError) return 'missing_key'
  if (e instanceof InvalidKeyError) return 'invalid_key'
  if (e instanceof BudgetExceededError) return 'budget_exceeded'
  if (e instanceof LlmRateLimitError) return 'rate_limited'
  if (e instanceof LlmRefusalError) return 'refusal'
  if (e instanceof InvalidOutputError) return 'invalid_output'
  if (e instanceof NoMessagesError) return 'no_messages'
  if (e instanceof ModelUnavailableError) return 'model_unavailable'
  return 'unknown'
}

const FALLBACK_LABEL: Record<(typeof FREE_FALLBACKS)[number], string> = { gemini: 'Gemini', mistral: 'Mistral' }

/** O 429 final (depois da troca de modelo da Groq e das reservas gratuitas): o que fazer depende das chaves salvas. */
export function rateLimitedMessage(provider: Provider, fallbacks: ReadonlyArray<(typeof FREE_FALLBACKS)[number]>): string {
  const head = provider === 'claude' ? 'O Claude pediu para esperar um pouco (limite de pedidos).' : 'A IA gratuita (Groq) chegou ao limite de uso por agora.'
  if (fallbacks.length === 0) {
    return `${head} Ela volta sozinha mais tarde. Para não ficar sem sugestões, adicione uma chave gratuita do Gemini ou do Mistral em Configurações › Chaves de acesso${provider === 'claude' ? '' : ' (ou escolha o Claude)'}.`
  }
  const names = fallbacks.map((f) => FALLBACK_LABEL[f]).join(' e ')
  return `${head} As IAs gratuitas de reserva (${names}) também estão no limite agora; elas voltam sozinhas mais tarde.${provider === 'claude' ? '' : ' Se tiver pressa, escolha o Claude nas Configurações.'}`
}

const AI_MESSAGES: Record<AiErrorCode, string> = {
  missing_key: 'Configure a chave da IA nas configurações.',
  invalid_key: 'A chave da IA foi recusada. Confira a chave nas configurações.',
  budget_exceeded: 'O teto diário de gasto com IA foi atingido.',
  rate_limited: 'A IA gratuita (Groq) chegou ao limite de uso por agora; ela volta sozinha mais tarde. Se tiver pressa, escolha o Claude nas Configurações.',
  refusal: 'A IA não quis responder a esta conversa. Tente de novo.',
  invalid_output: 'A IA respondeu fora do formato esperado. Tente de novo.',
  no_messages: 'Ainda não há mensagens deste contato.',
  model_unavailable:
    'Nenhum modelo de IA da Groq está disponível para a sua chave agora (os modelos que o app conhece foram aposentados). Tente de novo mais tarde ou escolha o Claude nas configurações.',
  unknown: 'Não foi possível gerar as sugestões agora. Tente de novo.',
  not_needed: 'Esta conversa não precisa de resposta agora.'
}

/**
 * Junta todos os módulos do core: fila, limitadores, cliente do WhatsApp, transcrição, IA e memória.
 * O processo principal só repassa chamadas (IPC) e eventos para cá.
 *
 * Eventos: `'state'(AppState)`, `'contacts'()`, `'messages'(jid)`, `'sends'(jid)` (um envio dessa conversa mudou).
 */
export class SagaService extends EventEmitter {
  readonly queue: JobQueue
  readonly limiters: Record<LimiterName, RateLimiter>
  /** cópia de segurança (v0.3.1) */
  readonly backup: BackupManager
  /** Copiloto da Saga (v0.5.0): fila de saída e envio por HTTPS, fora da fila do WhatsApp */
  readonly copiloto: CopilotoSync
  /** v0.8.0 (contrato v1.2): envio automático dos follow-ups marcados pelo Copiloto, com a opção ligada */
  readonly autoFollowups: FollowupAutoSender
  /** v0.10.0: follow-ups de conversa (onboarding/sumido) */
  readonly convos: ConvoEngine
  /** desde quando a conexão está aberta (null = fechada): o envio automático só sai com ela estável */
  private connOpenSince: number | null = null
  /** v0.8.1: quando esta execução começou (a consulta dos grupos feita depois disso vale para o reenvio dos grupos) */
  private readonly startedAt: number
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
  /** v0.7.0: os follow-ups do Copiloto mudaram */
  private pendingFollowups = false
  private update: UpdateState = { status: 'none' }
  private updateCheck: UpdateCheck = {
    enabled: false,
    currentVersion: '',
    checking: false,
    lastCheckAt: null,
    lastResult: null,
    latestVersion: null,
    lastError: null
  }
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
  /** por conversa: horário da mensagem mais nova que pediu classificação (pedidos durante um job em andamento) */
  private classifyWanted = new Map<string, number>()
  private waitingTimer: ReturnType<typeof setInterval> | null = null
  /** confirmações de envio (tokens de uso único do `prepareSend`) */
  private readonly sendGate: SendGate
  private pendingSendJids = new Set<string>()
  private sendSweepTimer: ReturnType<typeof setInterval> | null = null
  /** a última situação do horário de envio vista pela varredura (para a barra de status mudar sozinha) */
  private lastOutside: boolean | null = null

  constructor(opts: SagaServiceOpts) {
    super()
    const { repo } = opts
    const clock = opts.clock ?? systemClock
    const rng = opts.rng ?? Math.random
    this.repo = repo
    this.settings = opts.settings
    this.clock = clock
    this.startedAt = clock.now()
    this.fetchImpl = opts.fetchImpl
    this.diagFn = opts.diag
    this.llmFactory = opts.llmFactory ?? ((kind, key, o) => createLlm(kind, key, o))
    this.transcriberFactory = opts.transcriberFactory ?? ((kind, key, o) => createTranscriber(kind, key, fetch, o))
    this.cost = new CostTracker(repo, clock)
    this.sendGate = new SendGate(clock)
    this.backup = new BackupManager({
      repo,
      settings: opts.settings,
      cipher: opts.cipher ?? NO_CIPHER,
      clock,
      appVersion: opts.appVersion ?? '0.0.0',
      diag: (k, d) => this.diag(k, d),
      onRestored: () => {
        this.markContacts()
        this.markState()
      }
    })

    this.copiloto = new CopilotoSync({
      repo,
      cipher: opts.cipher ?? NO_CIPHER,
      clock,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      pnForLid: (lid) => this.wa?.pnForLid?.(lid) ?? null,
      diag: (k, d) => this.diag(k, d),
      onFollowups: () => this.markFollowups(),
      onSendChanged: (jid) => this.markSends(jid),
      waReady: () => this.groupsReady()
    })

    this.autoFollowups = new FollowupAutoSender({
      repo,
      clock,
      rng,
      active: () => this.autoActive(),
      enabledAt: () => this.copiloto.autoFollowupsAt(),
      checkCancelled: (id) => this.copiloto.checkCancelled(id),
      getBackoff: () => ({
        failures: Number(this.repo.getSetting('copiloto.autoPollFailures') ?? 0) || 0,
        until: Number(this.repo.getSetting('copiloto.autoPollUntil') ?? 0) || 0
      }),
      setBackoff: (b) => {
        this.repo.setSetting('copiloto.autoPollFailures', String(b.failures))
        this.repo.setSetting('copiloto.autoPollUntil', String(b.until))
      },
      schedule: () => this.settings.sendOptions().schedule,
      ready: () => this.autoReady(),
      busy: () => this.repo.sends.listByStatus('queued', 'typing', 'sending').length > 0,
      limiterAt: (now) => this.limiters.wa_send.nextAllowedAt(now),
      dispatch: (f) => this.autoDispatch(f),
      diag: (k, d) => this.diag(k, d),
      changed: () => this.markFollowups()
    })

    this.convos = new ConvoEngine({
      repo,
      clock,
      rng,
      active: () => this.copiloto.healthy(),
      testMode: () => this.copiloto.followupTestOn(),
      schedule: () => this.settings.sendOptions().schedule,
      isMentee: (j) => this.copiloto.isMenteeSender(j),
      groupEligible: (jid) => this.convoGroupEligible(jid),
      ready: () => this.autoReady(),
      busy: () => this.repo.sends.listByStatus('queued', 'typing', 'sending').length > 0,
      limiterAt: (now) => this.limiters.wa_send.nextAllowedAt(now),
      draft: (input) => this.convoDraft(input),
      aiErrorText: (e) => this.aiMessage(aiErrorCode(e), this.settings.get().provider),
      dispatch: (c, draftId, text, forced) => this.convoDispatch(c.jid, draftId, text, forced),
      cancelSend: (id) => this.cancelSendNow(id),
      diag: (k, d) => this.diag(k, d),
      changed: () => this.markFollowups(),
      kick: () => {
        if (this.copiloto.enabled()) this.copiloto.kick()
      }
    })
    this.copiloto.setConvoHandler(this.convos)

    const lim = (name: LimiterName) => new RateLimiter(LIMITS[name], clock, rng, { repo, key: `limiter:${name}` })
    this.limiters = {
      wa_media: lim('wa_media'),
      wa_profile: lim('wa_profile'),
      groq_audio: lim('groq_audio'),
      llm: lim('llm'),
      classify: lim('classify'),
      wa_send: lim('wa_send'),
      wa_history: lim('wa_history')
    }
    const byType: Record<JobType, RateLimiter> = {
      download_audio: this.limiters.wa_media,
      transcribe: this.limiters.groq_audio,
      fetch_profile: this.limiters.wa_profile,
      classify: this.limiters.classify,
      send_message: this.limiters.wa_send,
      fetch_history: this.limiters.wa_history
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
    this.queue.register('classify', (payload: { jid?: unknown }, signal) => {
      if (typeof payload?.jid !== 'string') return Promise.resolve()
      return classifyChat(
        {
          repo,
          clock,
          // só a IA gratuita em segundo plano: nunca gasta com o Claude, seja qual for o provedor das sugestões
          getLlm: () => {
            const key = this.settings.getKey('groq')
            return key ? this.chatLlm('groq', key) : null
          },
          cost: this.cost,
          getCapUsd: () => this.settings.get().dailyCapUsd,
          diag: (k, d) => this.diag(k, d),
          onChanged: () => this.markContacts()
        },
        payload.jid,
        signal
      )
    })
    this.queue.onJobFailed((job) => {
      if (job.type === 'send_message') {
        // estourou o prazo ou deu erro inesperado: nunca tenta de novo sozinho (o envio mostra o estado certo)
        try {
          repo.markJobDone(job.id)
          this.sendJobFailed(job.payload)
        } catch {
          // banco fechado
        }
        this.markState()
        return
      }
      if (job.type === 'fetch_history') {
        // v0.8.3: a busca do histórico nunca vira "áudios com falha"; o estado da busca está gravado (clicar de novo retoma)
        try {
          repo.markJobDone(job.id)
        } catch {
          // banco fechado
        }
        this.markState()
        return
      }
      if (job.type === 'classify') {
        // alertas são um extra: um job que estourou o prazo 3 vezes não vira "áudios com falha" na barra de status
        try {
          repo.markJobDone(job.id)
        } catch {
          // banco fechado
        }
        this.markState()
        return
      }
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
      if (job.type === 'classify') {
        const p = job.payload as { jid?: unknown; ts?: unknown } | null
        if (typeof p?.jid !== 'string') return
        // chegou mensagem enquanto o job rodava: classifica de novo (só as novas)
        const wanted = this.classifyWanted.get(p.jid)
        this.classifyWanted.delete(p.jid)
        if (wanted !== undefined && wanted > Number(p.ts)) this.maybeClassify(p.jid, wanted)
        return
      }
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
      ...(opts.diag ? { diag: opts.diag } : {}),
      sendOptions: () => this.settings.sendOptions(),
      sendGuard: (s) => this.autoSendGuard(s),
      recentContactExempt: (s) => this.convos.isConvoSend(s.id) && this.convoGroupEligible(s.jid).ok
    })
    this.wa.on('send', (jid: string) => this.markSends(jid))
    this.wa.on('qr', (dataUrl: string) => {
      this.qr = dataUrl
      this.markState()
    })
    this.wa.on('status', (s: ConnState) => {
      if (s !== 'needs_qr') this.qr = null
      if (s === 'open') repo.setSetting(EVER_CONNECTED, '1')
      if (s !== 'open') this.connOpenSince = null
      else this.connOpenSince ??= clock.now()
      if (PERSISTED_STOPS.has(s)) repo.setSetting(STOPPED_STATE, s)
      this.markState()
    })
    this.wa.on('disk', () => this.markState())
    // v0.8.1: participantes de grupo ou um @lid com telefone novo: o Copiloto confere de novo os grupos
    this.wa.on('membership', () => this.copiloto.membershipChanged())
    // v0.8.3: aparelho vinculado de novo (QR) ou histórico pedido ao celular: o histórico antigo vai ao Copiloto, e os
    // follow-ups que ele gerar nas próximas 24 h ficam para a confirmação do mentor (nenhum envio automático por isso)
    this.wa.on('paired', () => this.copiloto.holdAutoFollowups())
    this.wa.on('history', () => this.copiloto.holdAutoFollowups())
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
      // v0.9.0: histórico antigo (mais de 30 dias) só fica guardado: sem alertas, "Para responder" nem IA
      if (m.ts < recentSince(this.clock.now())) {
        this.markMessages(m.jid)
        return
      }
      try {
        // o mentor respondeu: os alertas de antes se resolvem (o desânimo fica até o mentor resolver)
        if (m.fromMe) {
          repo.dismissAlertsUpTo(m.jid, RESOLVED_BY_REPLY, m.ts)
          // um envio de estado desconhecido nessa conversa: a mensagem apareceu?
          this.verifyUnknownSends(m.jid)
        }
        else {
          // só "obrigado", "ok" ou emoji: sai de "Para responder" na hora, sem IA (e mesmo sem chave da Groq)
          applyReplyRule(repo, m.jid)
          this.maybeClassify(m.jid, m.ts)
        }
      } catch (e) {
        repo.logEvent('alerts_error', e instanceof Error ? e.message : String(e))
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
    // antes da fila: envios que não saíram nunca saem sozinhos depois de reiniciar
    this.recoverSends()
    this.queue.recoverAfterCrash()
    this.requeueUnhidden()
    for (const l of Object.values(this.limiters)) l.startWarmup()
    // alertas em segundo plano: o primeiro só sai depois de um intervalo inteiro (nada de rajada ao abrir)
    this.limiters.classify.markFinished()
    if (!this.waitingTimer) {
      this.waitingTimer = setInterval(() => {
        try {
          if (this.refreshWaitingAlerts()) this.markContacts()
        } catch {
          // banco fechado: tenta de novo na próxima volta
        }
      }, WAITING_REFRESH_MS)
      ;(this.waitingTimer as { unref?: () => void }).unref?.()
    }
    if (!this.sendSweepTimer) {
      this.sendSweepTimer = setInterval(() => {
        try {
          this.expireStaleSends()
          this.autoTick()
          this.convoTick()
        } catch {
          // banco fechado
        }
      }, SEND_SWEEP_MS)
      ;(this.sendSweepTimer as { unref?: () => void }).unref?.()
    }
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
    this.copiloto.start()
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
      if (this.waitingTimer) clearInterval(this.waitingTimer)
      this.waitingTimer = null
      if (this.sendSweepTimer) clearInterval(this.sendSweepTimer)
      this.sendSweepTimer = null
      this.copiloto.stop()
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
      updateCheck: this.updateCheck,
      triage: this.repo.triageCounts(),
      sendHours: s.directSend ? this.outsideHours(s.sendSchedule) : null,
      followupTestUntil: this.copiloto.followupTestUntil(),
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

  /** Chamado pelo atualizador: a situação da procura por atualizações (Configurações › Atualizações). */
  setUpdateCheck(c: UpdateCheck): void {
    this.updateCheck = c
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

  private markContacts(): void {
    this.pendingContacts = true
    this.pendingState = true
    this.scheduleEmit()
  }

  private markFollowups(): void {
    this.pendingFollowups = true
    this.scheduleEmit()
  }

  /** v0.7.0: os follow-ups do Copiloto mudaram (chegou, saiu, foi recusado ou cancelado) */
  onFollowupsChanged(cb: () => void): Unsubscribe {
    this.on('followups', cb)
    return () => this.off('followups', cb)
  }

  private markSends(jid: string): void {
    this.pendingSendJids.add(jid)
    this.scheduleEmit()
  }

  onSends(jid: string, cb: () => void): Unsubscribe {
    const l = (j: string) => {
      if (j === jid) cb()
    }
    this.on('sends', l)
    return () => this.off('sends', l)
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
      const sendJids = [...this.pendingSendJids]
      const contacts = this.pendingContacts
      const state = this.pendingState
      // um envio mudou ou chegou mensagem (o eco): o follow-up que ele leva pode ter saído
      if (sendJids.length > 0 || jids.length > 0) {
        try {
          this.copiloto.reconcileFollowups()
        } catch {
          // banco fechado
        }
      }
      // um envio terminou ou chegou follow-up: o próximo envio automático pode sair (sempre um por vez)
      if (sendJids.length > 0 || this.pendingFollowups) this.autoTick()
      // v0.10.0: mensagem nova no grupo (resposta do mentorado) ou envio que mudou: a conversa de follow-up anda
      if (sendJids.length > 0 || jids.length > 0) this.convoTick()
      const followups = this.pendingFollowups
      this.pendingFollowups = false
      this.pendingJids.clear()
      this.pendingSendJids.clear()
      this.pendingContacts = false
      this.pendingState = false
      try {
        if (contacts) this.emit('contacts')
        for (const j of jids) this.emit('messages', j)
        for (const j of sendJids) this.emit('sends', j)
        if (followups) this.emit('followups')
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
    if (this.refreshWaitingAlerts()) this.markContacts()
    return this.repo.listContacts({ includeHidden, kind })
  }

  // --- fila do dia e alertas ---

  /** Alertas ativos de uma conversa, ou de todas as que não estão escondidas (mais graves primeiro). */
  async listAlerts(jid?: string): Promise<AlertRow[]> {
    if (this.refreshWaitingAlerts()) this.markContacts()
    return this.repo.listAlerts(jid)
  }

  /** "Resolver": tira o alerta da lista (fica no histórico; um sinal novo cria outro). */
  async dismissAlert(jid: string, kind: AlertKind): Promise<void> {
    if (this.repo.dismissAlert(jid, kind)) this.markContacts()
  }

  /**
   * 👍/👎 num alerta da IA (ver `ai/alertFeedback.ts`). O 👎 resolve o alerta e, com o tipo certo, cria esse.
   * O registro de diagnóstico só leva o veredito e o tipo (nunca texto nem jid).
   */
  async rateAlert(alertId: number, verdict: 'up' | 'down', reason?: RateReason): Promise<void> {
    const changed = rateAlert(this.repo, alertId, verdict, reason)
    this.diag('alert_feedback', `verdict=${verdict}${reason ? ` reason=${reason.code}` : ''}`)
    if (changed) this.markContacts()
  }

  /**
   * "Não precisa responder" (`needed` false, com o motivo) ou "Precisa sim" (true): vale até chegar outra mensagem do
   * contato e vira um exemplo para a IA. O registro de diagnóstico só leva o veredito e o código do motivo.
   */
  async setNeedsReply(jid: string, needed: boolean, reason?: ReplyReason): Promise<void> {
    const changed = setNeedsReply(this.repo, jid, needed, reason)
    this.diag('reply_feedback', `verdict=${needed ? 'reply_needed' : 'reply_not_needed'}${reason ? ` reason=${reason.code}` : ''}`)
    if (changed) this.markContacts()
  }

  /** 👍 no "O SagaZap acha que esta conversa não precisa de resposta". */
  async confirmNoReply(jid: string): Promise<void> {
    const changed = confirmNoReply(this.repo, jid)
    this.diag('reply_feedback', 'verdict=reply_ok')
    if (changed) this.markContacts()
  }

  /** "Faltou um alerta?": grava o exemplo e cria o alerta, marcado como do mentor. */
  async reportMissedAlert(jid: string, kind: AlertKind, msgId?: string | null, text?: string | null): Promise<void> {
    const changed = reportMissedAlert(this.repo, jid, kind, msgId ?? null, text ?? null)
    this.diag('alert_feedback', `verdict=missed kind=${kind}`)
    if (changed) this.markContacts()
  }

  /** "Qualidade dos alertas": contagens dos últimos 30 dias. */
  async alertQuality(): Promise<AlertQuality> {
    return alertQuality(this.repo, this.clock.now())
  }

  /** O CSV de todas as avaliações (o processo principal grava no arquivo escolhido). */
  alertFeedbackCsv(opts: { anonymize: boolean }): { csv: string; rows: number } {
    const rows = this.repo.listFeedback()
    const replyRows = this.repo.listReplyFeedback()
    const names = new Map(this.repo.listContacts({ includeHidden: true }).map((c) => [c.jid, c.displayName]))
    const csv = feedbackCsv(rows, (jid) => names.get(jid) ?? 'Conversa removida', opts.anonymize, replyRows)
    const n = rows.length + replyRows.length
    this.diag('alert_feedback_export', `rows=${n} anonymized=${opts.anonymize}`)
    return { csv, rows: n }
  }

  /**
   * Agenda a procura de alertas pela IA numa conversa que recebeu mensagem do contato: só com chave da Groq,
   * fora dos escondidos, para mensagens dos últimos dias e ainda não olhadas.
   */
  private maybeClassify(jid: string, ts: number): void {
    if (ts < this.clock.now() - CLASSIFY_MAX_AGE_MS) return
    const check = this.repo.getAlertCheck(jid)
    if (check && ts <= check.lastTs) return
    if (this.repo.isHidden(jid)) return
    if (!this.settings.getKey('groq')) return
    // só agradecimento/ok/emoji desde a resposta do mentor: a regra já decidiu, não gasta uma chamada da IA
    if (ruleSaysNoReply(this.repo, jid)) return
    this.classifyWanted.set(jid, Math.max(ts, this.classifyWanted.get(jid) ?? -Infinity))
    this.queue.requeue('classify', `classify:${jid}`, { jid, ts }, CLASSIFY_PRIORITY)
  }

  /**
   * Regra "esperando" (sem IA): conversa em "Para responder" há mais de 48 h ganha o alerta; resolvido à mão,
   * não volta na mesma espera. Em grupo, só se alguém mencionou o mentor nessa espera. Conversa que não precisa de
   * resposta (agradecimento, decisão da IA ou do mentor) não tem "esperando". `true` se mudou algo.
   */
  private refreshWaitingAlerts(): boolean {
    const now = this.clock.now()
    let changed = false
    for (const c of this.repo.listContacts({ includeHidden: false })) {
      const active = c.alerts.includes('esperando')
      const late = c.needsReply && c.waitingSince !== null && now - c.waitingSince > WAIT_RED_MS
      if (late && !active) {
        if (c.isGroup && !this.repo.hasMentionSince(c.jid, c.waitingSince!)) continue
        const msgId = this.repo.waitingMessageId(c.jid, c.waitingSince!)
        const last = this.repo.lastAlert(c.jid, 'esperando')
        if (last && last.msgId === msgId) continue
        changed = this.repo.upsertAlert({ jid: c.jid, kind: 'esperando', detail: WAITING_DETAIL, msgId }) || changed
      } else if (active && (c.waitingSince === null || !c.needsReply)) {
        changed = this.repo.dismissAlert(c.jid, 'esperando') || changed
      }
    }
    return changed
  }

  /** As mensagens mais novas da conversa (no máximo 300; a conversa na tela usa `listMessagesPage`). */
  async listMessages(jid: string): Promise<MessageView[]> {
    return this.views(this.repo.listMessages(jid, LIST_MESSAGES_MAX))
  }

  /**
   * v0.9.0: uma página da conversa (as `limit` mais novas; "Carregar mensagens mais antigas" pede mais). `includeId`: a
   * página cresce até incluir essa mensagem (resultado da busca).
   */
  async listMessagesPage(jid: string, limit: number, includeId?: string | null): Promise<MessagePage> {
    const n = Math.min(MESSAGE_PAGE_MAX, Math.max(1, Math.floor(Number(limit) || MESSAGE_PAGE)))
    const page = this.repo.listMessagesPage(jid, n, includeId ?? null)
    return { messages: this.views(page.messages), hasMore: page.hasMore }
  }

  /** As mensagens para a tela; áudio antigo (mais de 30 dias) sem transcrição e fora da fila: "Transcrever" sob pedido. */
  private views(rows: MessageRow[]): MessageView[] {
    const since = this.repo.recentSince()
    const old = rows.filter((m) => m.kind === 'audio' && m.transcriptStatus === null && m.ts < since)
    const queued = this.repo.activeJobKeys(old.flatMap((m) => [m.id, `transcribe:${m.id}`]))
    const onDemand = new Set(old.filter((m) => !queued.has(m.id) && !queued.has(`transcribe:${m.id}`)).map((m) => m.id))
    return rows.map((m) => (onDemand.has(m.id) ? { ...toView(m), onDemand: true } : toView(m)))
  }

  /**
   * v0.9.0: "Transcrever" num áudio antigo (mais de 30 dias, não baixado sozinho): baixa e transcreve só este, pela fila
   * de sempre (ritmo do WhatsApp, limite de gasto do dia). `false` se não é um áudio que espera transcrição.
   */
  async transcribeAudio(id: string): Promise<boolean> {
    const m = this.repo.getMessage(id)
    if (!m || m.kind !== 'audio' || (m.transcriptStatus !== null && m.transcriptStatus !== 'failed')) return false
    if (m.transcriptStatus === 'failed') this.repo.clearTranscriptStatus(id)
    if (m.audioPath && existsSync(m.audioPath)) {
      this.queue.requeue('transcribe', `transcribe:${m.id}`, { id: m.id, durationSec: m.durationSec, ts: m.ts }, ON_DEMAND_PRIORITY, { revive: true })
    } else {
      this.queue.requeue('download_audio', m.id, { id: m.id, ts: m.ts, manual: true }, ON_DEMAND_PRIORITY, { revive: true })
    }
    this.diag('audio_on_demand', 'áudio antigo pedido para transcrever')
    this.markMessages(m.jid)
    this.markState()
    return true
  }

  async renameContact(jid: string, name: string): Promise<void> {
    this.repo.renameContact(jid, name)
    this.pendingContacts = true
    this.scheduleEmit()
  }

  /**
   * Esconder para de baixar/transcrever os áudios do contato; mostrar de novo devolve os que faltam à fila.
   * Desde a v0.3.0 a interface não esconde mais (telefone só profissional): fica para o núcleo e os testes.
   */
  async setHidden(jid: string, hidden: boolean): Promise<void> {
    this.repo.setHidden(jid, hidden)
    if (!hidden) this.requeueMissingAudio(jid)
    this.pendingContacts = true
    this.pendingState = true
    this.scheduleEmit()
  }

  /**
   * Devolve à fila (no ritmo normal) os áudios do contato ainda sem transcrição: baixar ou só transcrever. v0.9.0: só os
   * dos últimos 30 dias (os mais antigos ficam com "Transcrever" sob pedido).
   */
  private requeueMissingAudio(jid: string): number {
    let n = 0
    const since = this.repo.recentSince()
    for (const m of this.repo.listMessages(jid)) {
      if (m.kind !== 'audio' || m.transcriptStatus !== null || m.ts < since) continue
      if (m.audioPath && existsSync(m.audioPath)) {
        this.queue.requeue('transcribe', `transcribe:${m.id}`, { id: m.id, durationSec: m.durationSec, ts: m.ts })
      } else {
        this.queue.requeue('download_audio', m.id, { id: m.id, ts: m.ts })
      }
      n++
    }
    return n
  }

  /**
   * Migração v11 (v0.3.0): os contatos que estavam escondidos voltaram a aparecer; os áudios que ficaram sem baixar ou
   * transcrever enquanto eles estavam escondidos voltam para a fila. Roda uma vez (a lista é apagada depois).
   */
  private requeueUnhidden(): void {
    const raw = this.repo.getSetting(UNHIDDEN_KEY)
    if (raw === null) return
    let jids: unknown = []
    try {
      jids = JSON.parse(raw)
    } catch {
      // lista corrompida: só apaga
    }
    let audios = 0
    const list = Array.isArray(jids) ? jids.filter((j): j is string => typeof j === 'string') : []
    for (const jid of list) audios += this.requeueMissingAudio(jid)
    this.repo.deleteSetting(UNHIDDEN_KEY)
    this.repo.logEvent('unhidden_requeue', `${list.length} conversa(s) voltaram a aparecer; ${audios} áudio(s) de volta à fila`)
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

  /**
   * `onlyIfNeeded` (abertura automática da conversa e atualização silenciosa): se a conversa não precisa da resposta do
   * mentor agora (ele falou por último, "Não precisa responder", respondido no grupo…), não chama a IA: devolve a
   * análise guardada se ela ainda vale, senão `not_needed`. Sem a opção (botão "Gerar sugestões mesmo assim"), gera.
   */
  getAnalysis(jid: string, opts: { onlyIfNeeded?: boolean } = {}): Promise<AnalysisResult> {
    // v0.10.0: grupo com follow-up de conversa andando: o cartão do follow-up cuida (nada de rascunho em dobro)
    if (opts.onlyIfNeeded && !this.inflight.has(jid) && (!this.needsReplyNow(jid) || this.convos.activeIn(jid))) {
      if (this.cacheFresh(jid)) return Promise.resolve({ ok: true, analysis: this.repo.getAnalysis(jid)! })
      return Promise.resolve({ ok: false, code: 'not_needed', message: AI_MESSAGES.not_needed, provider: this.settings.get().provider })
    }
    return this.analyze(jid, false)
  }

  /** A conversa pede a resposta do mentor agora (está em "Para responder")? Sem mensagens: não. */
  private needsReplyNow(jid: string): boolean {
    const c = this.repo.listContacts({ includeHidden: true }).find((x) => x.jid === jid)
    return !!c && c.needsReply && !c.hidden
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

  // --- busca geral (v0.3.1) ---

  /** Procura em todas as conversas e transcrições (local). O registro de diagnóstico só leva contagens e o tempo. */
  async searchMessages(query: string, filters: SearchFilters = {}): Promise<SearchResult> {
    const { result } = runSearch(this.repo, query, filters, this.clock.now())
    this.diag('search', `palavras=${result.terms.length} modo=${result.mode} conversas=${result.groups.length} mensagens=${result.total} ms=${result.tookMs}`)
    return result
  }

  /**
   * "Resumir com IA" (só quando o mentor clica): no máximo os 30 trechos mais relevantes vão para a IA das sugestões,
   * dentro do teto diário de gasto.
   */
  async summarizeSearch(query: string, filters: SearchFilters = {}): Promise<SearchSummaryResult> {
    const s = this.settings.get()
    const provider = s.provider
    const fail = (code: AiErrorCode): SearchSummaryResult => ({ ok: false, code, message: this.aiMessage(code, provider) })
    const { result, ranked } = runSearch(this.repo, query, filters, this.clock.now())
    if (ranked.length === 0) {
      return { ok: false, code: 'no_results', message: result.mode === 'empty' ? 'Escreva o assunto que você procura.' : 'Nenhuma mensagem encontrada para resumir.' }
    }
    const key = this.settings.getKey(provider)
    if (!key) return fail('missing_key')
    try {
      const out = await summarizeHits(
        {
          llm: this.chatLlm(provider, key),
          limiter: this.limiters.llm,
          cost: this.cost,
          capUsd: s.dailyCapUsd,
          clock: this.clock,
          diag: (k, d) => this.diag(k, d)
        },
        query,
        ranked
      )
      return { ok: true, ...out }
    } catch (e) {
      const code = aiErrorCode(e)
      this.repo.logEvent('ai_error', `${provider}: resumo da busca: ${code}`)
      return fail(code)
    } finally {
      this.markState()
    }
  }

  /** Reservas gratuitas com chave salva, na ordem da corrente. */
  private fallbackKinds(): Array<(typeof FREE_FALLBACKS)[number]> {
    return FREE_FALLBACKS.filter((k) => this.settings.hasKey(k))
  }

  /**
   * A IA de conversa: a principal (`kind`) e, se ela chegar ao limite, o Gemini e o Mistral (só os que têm chave).
   * Vale também com o Claude como principal: um 429 dele passa às reservas gratuitas.
   */
  private chatLlm(kind: Provider, key: string): LlmProvider {
    const o: CreateLlmOpts = { repo: this.repo, clock: this.clock, diag: (k, d) => this.diag(k, d) }
    const fallbacks: LlmProvider[] = []
    for (const f of this.fallbackKinds()) {
      const fk = this.settings.getKey(f)
      if (fk) fallbacks.push(this.llmFactory(f, fk, o))
    }
    return withFallback(this.llmFactory(kind, key, o), fallbacks, { repo: this.repo, clock: this.clock, diag: (k, d) => this.diag(k, d) })
  }

  private aiMessage(code: AiErrorCode, provider: Provider): string {
    return code === 'rate_limited' ? rateLimitedMessage(provider, this.fallbackKinds()) : AI_MESSAGES[code]
  }

  private async doAnalyze(jid: string, force: boolean): Promise<AnalysisResult> {
    const s = this.settings.get()
    const provider = s.provider
    const fail = (code: AiErrorCode): AnalysisResult => ({ ok: false, code, message: this.aiMessage(code, provider), provider })
    const key = this.settings.getKey(provider)
    if (!key) return fail('missing_key')
    try {
      const analysis = await generateAnalysis(
        {
          repo: this.repo,
          llm: this.chatLlm(provider, key),
          limiter: this.limiters.llm,
          cost: this.cost,
          capUsd: s.dailyCapUsd,
          clock: this.clock,
          diag: (k, d) => this.diag(k, d)
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
    // escolha: as outras sugestões dessa análise viram "não escolhidas" (só se a análise guardada é a mesma)
    const chosen =
      input.chosenIndex !== undefined && stored && stored.lastMsgId === (input.analysisLastMsgId ?? stored.lastMsgId) && input.chosenIndex < stored.suggestions.length
        ? input.chosenIndex
        : undefined
    const rejected = chosen === undefined ? [] : stored!.suggestions.filter((_, i) => i !== chosen)
    const id = saveApproved(this.repo, {
      jid: input.jid,
      contextText,
      originalSuggestion: input.originalSuggestion,
      finalText,
      provider,
      rejected
    })
    if (chosen !== undefined) this.repo.setChosen(input.jid, stored!.lastMsgId, chosen, id)
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
    // envios nunca voltam por aqui: só com uma nova confirmação do mentor
    const failed = this.repo.listJobs('failed').filter((j) => j.type !== 'send_message')
    for (const j of failed) this.queue.retryFailed(j.id)
    this.markState()
    return failed.length
  }

  // --- envio direto (v0.4.0) ---

  private sendDiag(kind: string, s: Pick<SendRow, 'id' | 'jid' | 'attempt'>, extra = ''): void {
    const job = this.repo.jobIdByKey(sendJobKey(s))
    this.diag(kind, `send #${s.id}${job !== null ? ` job #${job}` : ''} chat=${chatHash(s.jid)}${extra ? ` ${extra}` : ''}`)
  }

  /** As regras que valem antes de qualquer envio: envio direto ligado, texto válido, conversa conhecida, contato recente. */
  private sendRefusal(jid: string, text: string, exempt30 = false): Exclude<SendRefusal, 'outside_hours'> | null {
    if (!this.settings.sendOptions().enabled) return 'disabled'
    const t = text.trim()
    if (!t) return 'empty'
    if ([...t].length > SEND_LIMITS.textChars) return 'too_long'
    if (!this.repo.listContacts({ includeHidden: true }).some((c) => c.jid === jid)) return 'unknown_chat'
    // v0.10.0: o follow-up de conversa no grupo do mentorado (o mentor participa e já escreveu lá) não inicia conversa
    if (!exempt30 && !hasRecentContactMessage(this.repo.listMessages(jid, 300), this.clock.now())) return 'no_recent_contact'
    // confirmar sem conexão não adianta: o envio só vale para a conexão em que foi confirmado
    if (this.persistedStop || this.wa.getStatus() !== 'open') return 'offline'
    return null
  }

  /** O destino e a citação que a confirmação mostra (e que ficam presos ao token). */
  private sendBinding(jid: string, isGroup: boolean, kind: SendKind): { address: string; quote: MessageRow | null } {
    const messages = this.repo.listMessages(jid, 300)
    // a mensagem avulsa nunca cita (nem em grupo): não responde a nenhuma mensagem
    const q = kind === 'reply' && isGroup && this.settings.sendOptions().quoteInGroups ? pickQuote(messages) : null
    // só cita com a chave original da mensagem (nunca uma reconstruída)
    return { address: sendAddress(messages, jid), quote: q?.waKeyJson ? q : null }
  }

  /**
   * O diálogo "Enviar" abriu: confere as regras e devolve o que mostrar (para quem, a citação no grupo) e uma
   * confirmação de uso único para exatamente este jid + texto (vale 5 min). Não envia nada. `kind: 'avulsa'` (v0.6.0):
   * a confirmação da mensagem avulsa (sem citação; só vale no `sendAvulsa`).
   */
  async prepareSend(input: PrepareSendInput): Promise<PrepareSendResult> {
    return this.prepareSendNow(input)
  }

  private prepareSendNow(input: PrepareSendInput, exempt30 = false): PrepareSendResult {
    const jid = input.jid
    const text = input.text.trim()
    const forced = input.forced === true
    const kind: SendKind = input.kind === 'avulsa' ? 'avulsa' : 'reply'
    const refusal = this.sendRefusal(jid, text, exempt30 && kind === 'avulsa')
    if (refusal) return { ok: false, code: refusal, message: SEND_REFUSAL_TEXT[refusal] }
    const contact = this.repo.listContacts({ includeHidden: true }).find((c) => c.jid === jid)!
    const options = this.settings.sendOptions()
    const bind = this.sendBinding(jid, contact.isGroup, kind)
    let quote: { senderName: string; text: string } | null = null
    const q = bind.quote
    if (q) {
      const body = q.text ?? (q.transcriptStatus === 'done' ? q.transcript : null) ?? (q.kind === 'audio' ? '[áudio]' : '')
      quote = { senderName: q.senderLabel ?? 'Participante', text: body.length > 140 ? `${body.slice(0, 139)}…` : body }
    }
    const phone = contact.isGroup || jid.endsWith('@lid') ? null : formatPhone(jid)
    const draft = { jid, text, kind, recipient: { name: contact.displayName, phone, isGroup: contact.isGroup }, quote, options }
    // fora do horário de envio: sem "Forçar envio" não há token (nada pode sair); a confirmação mostra o aviso
    const outsideHours = this.outsideHours(options.schedule)
    if (outsideHours && !forced) {
      this.diag('send_outside_hours', `chat=${chatHash(jid)} confirmação aberta fora do horário`)
      return { ok: false, code: 'outside_hours', message: outsideHoursText(outsideHours), nextAllowedAt: outsideHours.nextAllowedAt, hours: outsideHours, draft }
    }
    const { token, expiresAt } = this.sendGate.issue(jid, text, { address: bind.address, quotedId: q?.id ?? null, forced, kind })
    return { ok: true, preview: { token, expiresAt, ...draft, forced, outsideHours } }
  }

  /** Fora do horário de envio agora? A situação (resumo e próximo horário); null = pode enviar (ou sem horário). */
  private outsideHours(schedule: SendSchedule): SendHoursInfo | null {
    const now = this.clock.now()
    return isWithinSendHours(schedule, now) ? null : sendHoursInfo(schedule, now)
  }

  /**
   * "Enviar" no diálogo de confirmação: exige o token do `prepareSend` para exatamente este jid + texto (uso único,
   * 5 min). Escolhe a sugestão (salva na memória com as não escolhidas, como Copiar/Salvar) e põe o envio na fila.
   * A mesma resposta com o mesmo texto nunca vira dois envios.
   */
  async sendReply(input: SendReplyInput): Promise<SendReplyResult> {
    const jid = input.jid
    const text = input.text.trim()
    const gate = this.consumeConfirmation(input.token, jid, text, 'reply')
    if (!gate.ok) return gate
    const { bind, outside } = gate
    const reusedRow = input.replyId ? this.repo.getApproved(input.replyId) : null
    const reused = reusedRow && reusedRow.jid === jid && reusedRow.finalText.trim() === text ? reusedRow : null
    // o pedido anterior desta mesma resposta ainda não terminou: nunca uma segunda tentativa por cima
    const prev = reused ? this.repo.sends.byIdemKey(`${reused.id}:${textHash(text)}`) : null
    if (prev && this.wa.isSendInFlight?.(prev.id)) {
      this.diag('send_refused', `send #${prev.id} chat=${chatHash(jid)} in_flight`)
      return { ok: false, code: 'in_flight', message: SEND_REFUSAL_TEXT.in_flight }
    }
    const replyId = reused
        ? reused.id
        : await this.saveReply({
            jid,
            originalSuggestion: input.originalSuggestion ?? null,
            finalText: text,
            analysisLastMsgId: input.analysisLastMsgId ?? null,
            ...(input.chosenIndex !== undefined ? { chosenIndex: input.chosenIndex } : {})
          })
    return this.enqueueConfirmed({ idemKey: `${replyId}:${textHash(text)}`, kind: 'reply', replyId, jid, text, bind, outside })
  }

  /**
   * v0.6.0 "Enviar mensagem avulsa": a mesma confirmação (token do `prepareSend({ kind: 'avulsa' })`, uso único, preso
   * a jid + texto + destino + "forçar"), as mesmas regras e a mesma fila das respostas. Nunca cita, nunca grava na
   * memória (nada em `approved_replies`, nem como resposta enviada). O mesmo rascunho com o mesmo texto nunca vira dois
   * envios: a chave é conversa + rascunho + impressão do texto.
   */
  async sendAvulsa(input: SendAvulsaInput): Promise<SendReplyResult> {
    // pela interface, nunca automático: só a confirmação do mentor
    return this.sendAvulsaNow(input, false)
  }

  /**
   * O corpo do `sendAvulsa`. `auto` (v0.8.0) só vem do envio automático de um follow-up, que fez a confirmação aqui
   * dentro com o mesmo `prepareSend` (token de uso único, nunca "Forçar envio"); fica marcado no envio.
   */
  private sendAvulsaNow(input: SendAvulsaInput, auto: boolean, exempt30 = false): SendReplyResult {
    const jid = input.jid
    const text = input.text.trim()
    if (typeof input.draftId !== 'string' || !DRAFT_ID_RE.test(input.draftId)) {
      this.diag('send_refused', `chat=${chatHash(jid)} rascunho inválido`)
      return { ok: false, code: 'not_confirmed', message: NOT_CONFIRMED_TEXT }
    }
    // v0.7.0: o rascunho de um follow-up do Copiloto tem o id dele; o mesmo follow-up nunca sai duas vezes
    const followup = this.repo.followups.get(input.draftId)
    if (followup) {
      const refused = this.followupSendRefusal(followup, jid, text)
      if (refused) return refused
    }
    const gate = this.consumeConfirmation(input.token, jid, text, 'avulsa', exempt30)
    if (!gate.ok) {
      // a regra dos 30 dias barrou: o follow-up volta ao Copiloto como "não dá para enviar"
      if (followup && gate.code === 'no_recent_contact') this.copiloto.finishFollowup(followup.id, 'failed', FOLLOWUP_REASON.outside30)
      return gate
    }
    const idemKey = `avulsa:${jid}:${input.draftId}:${textHash(text)}`
    const prev = this.repo.sends.byIdemKey(idemKey)
    if (prev && this.wa.isSendInFlight?.(prev.id)) {
      this.diag('send_refused', `send #${prev.id} chat=${chatHash(jid)} in_flight`)
      return { ok: false, code: 'in_flight', message: SEND_REFUSAL_TEXT.in_flight }
    }
    if (auto && (!followup || gate.bind.forced)) return { ok: false, code: 'not_confirmed', message: NOT_CONFIRMED_TEXT }
    const r = this.enqueueConfirmed({ idemKey, kind: 'avulsa', replyId: null, jid, text, bind: gate.bind, outside: gate.outside, auto })
    if (r.ok && followup) {
      // a ligação fica gravada (o id do rascunho também está na chave do envio): reiniciar no meio ainda relata certo
      if (this.repo.followups.transition(followup.id, ['waiting', 'sending'], 'sending', { sendId: r.send.id, sendError: null })) this.markFollowups()
      this.sendDiag('send_followup', this.repo.sends.get(r.send.id)!, auto ? 'follow-up do Copiloto, automático' : 'follow-up do Copiloto')
    }
    return r
  }

  /**
   * v0.7.0: o follow-up pode sair agora? Só o que espera o mentor (ou um cujo envio anterior não saiu), na conversa dele,
   * com até 4000 caracteres, e sem nenhum envio dele na fila, saindo, desconhecido ou já enviado.
   */
  private followupSendRefusal(f: FollowupRow, jid: string, text: string): { ok: false; code: SendRefusal | 'not_confirmed'; message: string } | null {
    this.copiloto.reconcileFollowups()
    const cur = this.repo.followups.get(f.id) ?? f
    if (cur.jid !== jid) {
      this.diag('send_refused', `chat=${chatHash(jid)} follow-up de outra conversa`)
      return { ok: false, code: 'unknown_chat', message: SEND_REFUSAL_TEXT.unknown_chat }
    }
    if (cur.status !== 'waiting') {
      this.diag('send_refused', `chat=${chatHash(jid)} follow-up ${cur.status}`)
      return cur.status === 'sending'
        ? { ok: false, code: 'in_flight', message: SEND_REFUSAL_TEXT.in_flight }
        : { ok: false, code: 'followup_done', message: SEND_REFUSAL_TEXT.followup_done }
    }
    if ([...text].length > FOLLOWUP_LIMITS.textChars) return { ok: false, code: 'too_long', message: SEND_REFUSAL_TEXT.too_long }
    for (const id of this.repo.followups.sendIdsOf(cur.id, jid)) {
      const s = this.repo.sends.get(id)!
      if (s.status === 'sent' || s.status === 'unknown' || SEND_ACTIVE.has(s.status)) {
        this.diag('send_refused', `send #${s.id} chat=${chatHash(jid)} follow-up já tem envio`)
        return { ok: false, code: 'in_flight', message: SEND_REFUSAL_TEXT.in_flight }
      }
    }
    return null
  }

  // --- follow-up com envio automático (v0.8.0, contrato v1.2) ---

  /** A opção ligada, a integração ligada e o envio direto ligado. */
  private autoActive(): boolean {
    return this.copiloto.healthy() && this.copiloto.autoFollowups() && this.settings.sendOptions().enabled
  }

  /** WhatsApp conectado e estável (de pé há 1 min), sem "Pausar tudo" nem parada guardada. */
  private autoReady(): boolean {
    if (this.persistedStop || this.queue.isPaused() || this.wa.getStatus() !== 'open' || this.connOpenSince === null) return false
    return this.clock.now() - this.connOpenSince >= FOLLOWUP_AUTO.stableMs
  }

  private autoTick(): void {
    if (this.stopping) return
    const fail = (e: unknown) => {
      try {
        this.repo.logEvent('copiloto_error', `envio automático: ${e instanceof Error ? e.name : 'Error'}`)
      } catch {
        // banco fechado
      }
    }
    try {
      void this.autoFollowups.tick().catch(fail)
    } catch (e) {
      fail(e)
    }
  }

  /**
   * A confirmação que o mentor daria, feita aqui dentro: o mesmo `prepareSend` (todas as regras; nunca "Forçar envio")
   * e o mesmo token de uso único gasto no `sendAvulsa`, com o id do follow-up como id do rascunho. A regra dos 30 dias
   * barrando → o follow-up vai ao Copiloto como `fora_30_dias`.
   */
  private autoDispatch(f: FollowupRow & { jid: string }): { ok: true; sendId: number } | { ok: false; code: string } {
    const prep = this.prepareSendNow({ jid: f.jid, text: f.text, kind: 'avulsa' })
    if (!prep.ok) {
      if (prep.code === 'no_recent_contact') this.copiloto.finishFollowup(f.id, 'failed', FOLLOWUP_REASON.outside30)
      return { ok: false, code: prep.code }
    }
    const r = this.sendAvulsaNow({ token: prep.preview.token, jid: f.jid, text: prep.preview.text, draftId: f.id }, true)
    return r.ok ? { ok: true, sendId: r.send.id } : { ok: false, code: r.code }
  }

  /**
   * Conferido pelo `executeSend` antes do "digitando…" e logo antes de enviar: um envio automático só sai se a opção, a
   * integração e o envio direto continuam ligados e o follow-up dele ainda está saindo (não foi cancelado nem apagado).
   */
  private autoSendGuard(s: SendRow): string | null {
    if (!s.auto) return null
    if (!this.autoActive()) return 'envio automático desligado'
    const f = this.repo.followups.bySendId(s.id)
    if (!f || f.status !== 'sending' || !f.autoSend || f.autoOff) return 'o follow-up não está mais para envio automático'
    return null
  }

  /** O que está na fila de envio automático não sai (vira "não enviada"; o follow-up volta ao cartão ou a esperar). */
  private expireAutoSends(why: string): void {
    for (const s of this.repo.sends.listByStatus('queued')) {
      if (s.auto && this.repo.sends.transition(s.id, s.attempt, ['queued'], 'expired', { error: why })) {
        this.sendDiag('send_expired', s, why)
        this.markSends(s.jid)
      }
    }
  }

  // --- follow-ups de conversa: onboarding e sumido (v0.10.0, contrato v2) ---

  /**
   * A regra dos 30 dias não vale para o follow-up de conversa SÓ quando o alvo é um grupo de que o mentor participa
   * (participantes conhecidos com ele, ou ainda não consultados) e com mensagens dele guardadas: escrever no grupo do
   * mentorado não é "iniciar conversa". Conversa individual nunca entra aqui (a regra continua valendo).
   */
  private convoGroupEligible(jid: string): { ok: true } | { ok: false; reason: string } {
    if (!this.repo.isGroup(jid)) return { ok: false, reason: CONVO_REASON.notGroup }
    if (this.wa.isSelfInGroup?.(jid) === false) return { ok: false, reason: CONVO_REASON.notMember }
    if (!this.repo.hasMentorMessage(jid)) return { ok: false, reason: CONVO_REASON.noHistory }
    return { ok: true }
  }

  private convoTick(): void {
    if (this.stopping) return
    const fail = (e: unknown) => {
      try {
        this.repo.logEvent('copiloto_error', `follow-up de conversa: ${e instanceof Error ? e.name : 'Error'}`)
      } catch {
        // banco fechado
      }
    }
    try {
      void this.convos.tick().catch(fail)
    } catch (e) {
      fail(e)
    }
  }

  /** O rascunho da IA para a conversa (mesma corrente, limitador e teto das sugestões; memória de estilo e base). */
  private async convoDraft(input: Omit<ConvoPromptInput, 'examples' | 'knowledge' | 'notes'> & { jid: string }) {
    const s = this.settings.get()
    const key = this.settings.getKey(s.provider)
    if (!key) throw new MissingKeyError()
    const theirs = input.messages.filter((m) => input.speaker(m) === 'mentorado').slice(-5)
    const textOf = (m: MessageRow) => (m.kind === 'text' ? m.text : m.transcriptStatus === 'done' ? m.transcript : null) ?? ''
    const contextText = theirs.map(textOf).join('\n')
    const query = contextText || [...input.goal.pendingItems, input.goal.note ?? ''].join('\n')
    let knowledge = null
    try {
      knowledge = knowledgeFor(this.repo.kb, query)
    } catch {
      knowledge = null
    }
    const contact = this.repo.listContacts({ includeHidden: true }).find((c) => c.jid === input.jid)
    try {
      return await draftConvoMessage(
        { llm: this.chatLlm(s.provider, key), limiter: this.limiters.llm, cost: this.cost, capUsd: s.dailyCapUsd, clock: this.clock, diag: (k, d) => this.diag(k, d) },
        { ...input, examples: selectExamples(this.repo, input.jid, contextText), knowledge, notes: contact?.notes ?? null }
      )
    } finally {
      this.markState()
    }
  }

  /**
   * "Enviar" no cartão (a confirmação do mentor): o mesmo caminho da mensagem avulsa, com o id do rascunho; a regra
   * dos 30 dias só não vale no grupo do mentorado (ver `convoGroupEligible`). O mesmo rascunho nunca sai duas vezes.
   */
  private convoDispatch(jid: string, draftId: string, text: string, forced: boolean): ConvoDispatch {
    for (const id of this.repo.followups.sendIdsOf(draftId, jid)) {
      const s = this.repo.sends.get(id)!
      if (s.status === 'sent' || s.status === 'unknown' || SEND_ACTIVE.has(s.status)) return { ok: false, code: 'in_flight', message: SEND_REFUSAL_TEXT.in_flight }
    }
    const exempt = this.convoGroupEligible(jid).ok
    const prep = this.prepareSendNow({ jid, text, kind: 'avulsa', ...(forced ? { forced: true } : {}) }, exempt)
    if (!prep.ok) return { ok: false, code: prep.code, message: prep.message }
    const r = this.sendAvulsaNow({ token: prep.preview.token, jid, text: prep.preview.text, draftId }, false, exempt)
    if (!r.ok) return { ok: false, code: r.code, message: r.message }
    this.sendDiag('send_followup', this.repo.sends.get(r.send.id)!, 'follow-up de conversa')
    return { ok: true, sendId: r.send.id }
  }

  /** As conversas de follow-up (andando e, por algumas horas, as encerradas). */
  async listConvos(): Promise<ConvoView[]> {
    this.convoTick()
    return this.convos.list(FOLLOWUP_LIMITS.recentMs)
  }

  /** Um botão do cartão. "Enviar" só marca a confirmação: o envio sai na próxima volta, com todas as travas. */
  async convoAction(id: string, action: ConvoAction): Promise<ConvoActionResult> {
    const r = this.convos.action(id, action)
    this.convoTick()
    return r
  }

  // --- follow-up do Copiloto (v0.7.0) ---

  /** Os follow-ups que a interface mostra (esperando, saindo, e por algumas horas os enviados e os sem envio). */
  async listFollowups(): Promise<FollowupView[]> {
    this.copiloto.reconcileFollowups()
    this.autoTick()
    return this.repo.followups.listVisible(FOLLOWUP_LIMITS.recentMs).map((f) => ({ ...followupView(f), auto: this.autoFollowups.view(f) }))
  }

  /**
   * "Abrir para enviar": confere se ainda dá (a regra dos 30 dias barra: volta ao Copiloto como `fora_30_dias`) e
   * devolve o follow-up para a caixa da mensagem avulsa. Não envia nada: o envio é a confirmação de sempre.
   */
  async followupOpen(id: string): Promise<FollowupOpenResult> {
    this.copiloto.reconcileFollowups()
    const f = this.repo.followups.get(id)
    if (!f || !f.jid) return { ok: false, code: 'not_found', message: FOLLOWUP_TEXT.notFound }
    if (f.status !== 'waiting') return { ok: false, code: 'done', message: FOLLOWUP_TEXT.done }
    if (!this.settings.sendOptions().enabled) return { ok: false, code: 'disabled', message: SEND_REFUSAL_TEXT.disabled }
    if (!hasRecentContactMessage(this.repo.listMessages(f.jid, 300), this.clock.now())) {
      this.copiloto.finishFollowup(f.id, 'failed', FOLLOWUP_REASON.outside30)
      return { ok: false, code: 'fora_30_dias', message: FOLLOWUP_TEXT.outside30 }
    }
    return { ok: true, followup: followupView(f as FollowupRow & { jid: string }) }
  }

  /** "Recusar": vai ao Copiloto como recusado, com o motivo digitado (até 200 caracteres) ou `recusado_pelo_mentor`. */
  async followupDecline(id: string, reason: string | null): Promise<boolean> {
    this.copiloto.reconcileFollowups()
    // v0.8.0 "Não enviar" de um envio automático ainda na fila: cancela o envio (só na fila; depois não dá mais)
    const f = this.repo.followups.get(id)
    if (f?.status === 'sending' && f.autoSend && f.sendId !== null) {
      const s = this.repo.sends.get(f.sendId)
      if (!s?.auto || !(await this.cancelSend(s.id))) return false
      this.copiloto.reconcileFollowups()
    }
    return this.copiloto.finishFollowup(id, 'declined', shortReason(reason) ?? FOLLOWUP_REASON.declined)
  }

  /**
   * Gasta o token (uso único) e confere de novo as regras e o horário. A confirmação de um tipo (resposta ou avulsa)
   * nunca vale para o outro.
   */
  private consumeConfirmation(
    token: string,
    jid: string,
    text: string,
    kind: SendKind,
    exempt30 = false
  ): { ok: true; bind: SendBinding; outside: SendHoursInfo | null } | { ok: false; code: SendRefusal | 'not_confirmed'; message: string } {
    const bind = this.sendGate.consume(token, jid, text, kind)
    if (!bind) {
      this.diag('send_refused', `chat=${chatHash(jid)} sem confirmação válida`)
      return { ok: false, code: 'not_confirmed', message: NOT_CONFIRMED_TEXT }
    }
    const refusal = this.sendRefusal(jid, text, exempt30)
    if (refusal) {
      this.diag('send_refused', `chat=${chatHash(jid)} ${refusal}`)
      return { ok: false, code: refusal, message: SEND_REFUSAL_TEXT[refusal] }
    }
    // a confirmação sem "Forçar envio" nunca vale fora do horário (mesmo que o diálogo tenha aberto dentro dele)
    const outside = this.outsideHours(this.settings.sendOptions().schedule)
    if (outside && !bind.forced) {
      this.diag('send_outside_hours', `chat=${chatHash(jid)} confirmação sem forçar, fora do horário`)
      return { ok: false, code: 'outside_hours', message: outsideHoursText(outside) }
    }
    return { ok: true, bind, outside }
  }

  /** Põe na fila (ou devolve o mesmo envio, pela chave de idempotência) um envio já confirmado. */
  private enqueueConfirmed(a: {
    idemKey: string
    kind: SendKind
    replyId: number | null
    jid: string
    text: string
    bind: SendBinding
    outside: SendHoursInfo | null
    auto?: boolean
  }): SendReplyResult {
    const { jid, text, bind, outside } = a
    let enq: ReturnType<Repo['sends']['enqueue']>
    try {
      enq = this.repo.sends.enqueue({
        idemKey: a.idemKey,
        kind: a.kind,
        replyId: a.replyId,
        jid,
        text,
        address: bind.address,
        quotedId: bind.quotedId,
        forced: bind.forced,
        auto: a.auto === true
      })
    } catch (e) {
      if (!(e instanceof SendConflictError)) throw e
      this.diag('send_refused', `chat=${chatHash(jid)} conflito de chave`)
      return { ok: false, code: 'unknown_chat', message: SEND_REFUSAL_TEXT.unknown_chat }
    }
    const { send, created } = enq
    if (created) {
      // a geração da conexão vai junto: se a conexão cair antes da vez, este envio nunca sai
      this.queue.enqueue('send_message', sendJobKey(send), { sendId: send.id, attempt: send.attempt, gen: this.wa.connGen?.() ?? 0 }, SEND_PRIORITY)
      this.sendDiag('send_queued', send, [send.kind === 'avulsa' ? 'avulsa' : '', send.auto ? 'automático' : '', send.attempt > 1 ? `tentativa ${send.attempt}` : ''].filter(Boolean).join(' '))
      if (send.forced && outside) this.sendDiag('send_forced', send, 'fora do horário de envio')
    }
    this.markSends(jid)
    this.markState()
    return { ok: true, send: this.sendViews([send])[0] }
  }

  /** "Cancelar envio": só enquanto está na fila (depois do "digitando…" não dá mais). `true` se cancelou. */
  async cancelSend(id: number): Promise<boolean> {
    return this.cancelSendNow(id)
  }

  private cancelSendNow(id: number): boolean {
    const s = this.repo.sends.get(id)
    if (!s || !this.repo.sends.transition(id, s.attempt, ['queued'], 'canceled')) return false
    this.sendDiag('send_canceled', s)
    this.markSends(s.jid)
    return true
  }

  /** Os envios recentes de uma conversa (mais novos primeiro), com a estimativa de quando os da fila saem. */
  async listSends(jid: string): Promise<SendView[]> {
    return this.sendViews(this.repo.sends.listForJid(jid))
  }

  /** "Conferir": procura de novo a mensagem na conversa; devolve o envio como ficou. */
  async checkSend(id: number): Promise<SendView | null> {
    const s = this.repo.sends.get(id)
    if (!s) return null
    if (verifyUnknownSend(this.repo, s)) {
      this.sendDiag('send_sent', s, 'achada na conversa')
      this.markSends(s.jid)
    }
    return this.sendViews([this.repo.sends.get(id)!])[0]
  }

  private sendViews(rows: SendRow[]): SendView[] {
    const now = this.clock.now()
    const queued = this.repo.sends.listByStatus('queued')
    const gap = LIMITS.wa_send.minGapMs
    let next = Math.max(now, this.limiters.wa_send.nextAllowedAt(now))
    const eta = new Map<number, number>()
    for (const q of queued) {
      eta.set(q.id, next)
      next += gap
    }
    const waitingFor = this.queue.isPaused() ? 'paused' : this.wa.getStatus() !== 'open' ? 'connection' : null
    return rows.map((r) => ({
      id: r.id,
      jid: r.jid,
      kind: r.kind,
      replyId: r.replyId,
      text: r.text,
      status: r.status,
      queuedAt: r.queuedAt,
      etaAt: r.status === 'queued' ? (eta.get(r.id) ?? now) : null,
      waitingFor: r.status === 'queued' ? waitingFor : null,
      sentAt: r.sentAt,
      error: r.error
    }))
  }

  /** Envio na fila há mais de 10 min (pausa, sem conexão): volta a "aguardando confirmação"; nunca sai atrasado. */
  private expireStaleSends(): void {
    const now = this.clock.now()
    const cut = now - SEND_LIMITS.queuedMaxMs
    const schedule = this.settings.sendOptions().schedule
    const inside = isWithinSendHours(schedule, now)
    for (const s of this.repo.sends.listByStatus('queued')) {
      // passou do fim do horário com o envio ainda na fila (sem "Forçar envio"): não sai depois, expira
      if (!inside && !s.forced) {
        if (this.repo.sends.transition(s.id, s.attempt, ['queued'], 'expired', { error: OUTSIDE_HOURS_REASON })) {
          this.sendDiag('send_expired', s, OUTSIDE_HOURS_REASON)
          this.sendDiag('send_outside_hours', s, 'expirou na fila')
          this.markSends(s.jid)
        }
        continue
      }
      if (s.queuedAt > cut) continue
      if (this.repo.sends.transition(s.id, s.attempt, ['queued'], 'expired', { error: 'mais de 10 min na fila' })) {
        this.sendDiag('send_expired', s, 'mais de 10 min na fila')
        this.markSends(s.jid)
      }
    }
    // a barra de status mostra "Fora do horário de envio": avisa quando o horário abre ou fecha
    if (this.lastOutside !== !inside) {
      this.lastOutside = !inside
      this.markState()
    }
  }

  /**
   * Ao abrir o app: nada sai sozinho. Os da fila (e os que estavam no "digitando…", que ainda não tinham saído) voltam a
   * "aguardando confirmação"; um que estava no meio do envio fica desconhecido e é conferido na conversa.
   */
  private recoverSends(): void {
    for (const s of this.repo.sends.listByStatus('queued', 'typing')) {
      if (this.repo.sends.transition(s.id, s.attempt, ['queued', 'typing'], 'expired', { error: 'o SagaZap fechou antes de enviar' })) {
        this.sendDiag('send_expired', s, 'o SagaZap fechou antes de enviar')
      }
    }
    for (const s of this.repo.sends.listByStatus('sending')) {
      if (this.repo.sends.transition(s.id, s.attempt, ['sending'], 'unknown', { error: 'o SagaZap fechou durante o envio' })) {
        this.sendDiag('send_unknown', s, 'o SagaZap fechou durante o envio')
      }
    }
    for (const s of this.repo.sends.listByStatus('unknown')) {
      if (verifyUnknownSend(this.repo, s)) this.sendDiag('send_sent', s, 'achada na conversa')
    }
    this.repo.finishPendingJobs('send_message')
  }

  private verifyUnknownSends(jid: string): void {
    for (const s of this.repo.sends.listForJid(jid)) {
      if (s.status === 'unknown' && verifyUnknownSend(this.repo, s)) {
        this.sendDiag('send_sent', s, 'achada na conversa')
        this.markSends(jid)
      }
    }
  }

  /** O job do envio estourou o prazo (ou lançou): o envio fica no estado certo, nunca volta para a fila sozinho. */
  private sendJobFailed(payload: unknown): void {
    const p = payload as { sendId?: unknown; attempt?: unknown } | null
    const id = Number(p?.sendId)
    const attempt = Number(p?.attempt)
    const s = Number.isSafeInteger(id) ? this.repo.sends.get(id) : null
    if (!s || s.attempt !== attempt) return
    // o pedido ao WhatsApp ainda está em andamento: fica "enviando" até ele terminar (quem decide é a resposta dele)
    if (this.wa.isSendInFlight?.(id)) {
      this.sendDiag('send_slow', s, 'o WhatsApp ainda não respondeu; esperando')
      return
    }
    if (this.repo.sends.transition(id, attempt, ['queued', 'typing'], 'failed', { error: 'não chegou a enviar' })) {
      this.sendDiag('send_failed', s, 'não chegou a enviar')
    } else if (this.repo.sends.transition(id, attempt, ['sending'], 'unknown', { error: 'o WhatsApp não respondeu' })) {
      this.sendDiag('send_unknown', s, 'o WhatsApp não respondeu')
      verifyUnknownSend(this.repo, this.repo.sends.get(id)!)
    }
    this.markSends(s.jid)
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
    // reserva gratuita com chave nova (ou removida): volta a valer na hora, sem o "no limite" da chave antiga
    if (patch.geminiKey !== undefined) {
      resetGeminiModelCache(this.repo)
      new ProviderLimits(this.repo, this.clock).clear('gemini')
    }
    if (patch.mistralKey !== undefined) new ProviderLimits(this.repo, this.clock).clear('mistral')
    // uma chave nova pode destravar as transcrições pausadas por falta de chave (ou chave recusada)
    // e um teto novo pode destravar as pausadas pelo gasto
    if (patch.groqKey || patch.openaiKey || patch.transcriber || patch.dailyCapUsd !== undefined) this.queue.resumeType('transcribe')
    // envio direto desligado: o que estava na fila não sai (volta a "aguardando confirmação")
    if (patch.directSend === false) {
      for (const s of this.repo.sends.listByStatus('queued')) {
        if (this.repo.sends.transition(s.id, s.attempt, ['queued'], 'expired', { error: 'envio direto desligado' })) {
          this.sendDiag('send_expired', s, 'envio direto desligado')
          this.markSends(s.jid)
        }
      }
    }
    // horário de envio mudou: o que está na fila e ficou fora dele expira agora
    if (patch.sendSchedule !== undefined) this.expireStaleSends()
    this.markState()
    return { ok: true, settings: this.settings.get() }
  }

  testKey(kind: KeyKind, key: string): Promise<boolean> {
    return testKey(kind, key, { fetchImpl: this.fetchImpl })
  }

  // --- Copiloto da Saga (v0.5.0) ---

  async copilotoStatus(): Promise<CopilotoStatus> {
    return this.copiloto.status()
  }

  async copilotoSave(patch: CopilotoPatch): Promise<CopilotoSaveResult> {
    const r = this.copiloto.save(patch)
    if (patch.followupTest !== undefined) this.markState()
    // envio automático desligado (ou a integração): o automático que está na fila não sai
    if (!this.autoActive()) this.expireAutoSends('envio automático desligado')
    else this.autoTick()
    return r
  }

  /** O código aparece só nesta resposta; depois a interface só sabe que ele existe. */
  async copilotoGenerateCode(): Promise<CopilotoCodeResult> {
    return this.copiloto.generateCode()
  }

  copilotoTest(): Promise<CopilotoTestResult> {
    return this.copiloto.test()
  }

  /** v0.8.1: "Reenviar histórico dos grupos": pede os nomes dos grupos de novo e põe o histórico dos grupos na fila. */
  copilotoRepairGroups(): Promise<CopilotoRepairResult> {
    try {
      this.wa.refreshGroupSubjects?.()
    } catch {
      // sem conexão: os nomes vêm na próxima consulta
    }
    return this.copiloto.repairGroups()
  }

  /**
   * v0.8.3: "Buscar no celular o histórico dos grupos". v0.9.0: "o histórico completo dos mentorados": as conversas
   * individuais e os grupos de mentorados com mensagem guardada aqui que o celular ainda não esgotou. O cliente pede ao
   * celular pela fila, aos poucos; o que chegar entra pela ingestão normal; só os últimos 30 dias vão ao Copiloto.
   */
  async copilotoFetchGroupHistory(): Promise<CopilotoRepairResult> {
    if (!this.copiloto.enabled()) return { ok: false, message: COPILOTO_TEXT.historyOff }
    if (!this.wa.startGroupHistory) return { ok: false, message: COPILOTO_TEXT.historyUnavailable }
    const c = this.copiloto.historyCandidates()
    if (!c) {
      this.copiloto.kick()
      return { ok: false, message: COPILOTO_TEXT.historyNoRoster }
    }
    this.wa.startGroupHistory(c.jids, c.noAnchor)
    this.markState()
    return { ok: true, status: this.copiloto.status() }
  }

  /**
   * v0.8.1: o reenvio automático dos grupos espera o WhatsApp de pé há 1 min e a consulta dos grupos feita nesta
   * execução (os eventos levam os nomes); se a consulta não sair, no máximo 15 min de conexão.
   */
  private groupsReady(): boolean {
    if (this.connOpenSince === null) return false
    const open = this.clock.now() - this.connOpenSince
    const fetched = Number(this.repo.getSetting(GROUPS_FETCHED_SETTING) ?? 0)
    const named = fetched >= this.startedAt || (fetched > 0 && this.repo.unnamedGroupCount() === 0)
    return (open >= 60_000 && named) || open >= 15 * 60_000
  }

  // --- base de conhecimento ---

  async kbList(): Promise<KbPackageView[]> {
    return this.repo.kb.listPackages()
  }

  /** Importa (ou reimporta, trocando o de mesmo nome) um pacote: `.zip`/`.skill` ou uma pasta, pelo caminho escolhido no diálogo. */
  async kbImportPackage(path: string, kind: 'archive' | 'folder'): Promise<KbImportResult> {
    return this.kbImport(() => {
      if (kind === 'folder') return importFolder(path)
      if (statSync(path).size > KB_LIMITS.archiveBytes) throw new KbImportError('O arquivo é grande demais (máximo de 25 MB).')
      return importArchive(readFileSync(path), path)
    }, 'package')
  }

  /** "Adicionar arquivo": um .md, .txt ou .docx para os "Arquivos avulsos" (substitui o de mesmo nome). */
  async kbAddFile(path: string): Promise<KbImportResult> {
    return this.kbImport(() => importSingleFile(path), 'manual')
  }

  /** "Colar texto": título + texto para os "Arquivos avulsos" (substitui o de mesmo título). */
  async kbAddText(title: string, text: string): Promise<KbImportResult> {
    return this.kbImport(() => importPastedText(title, text), 'manual')
  }

  private kbImport(make: () => KbPackageDraft, mode: 'package' | 'manual'): KbImportResult {
    try {
      const draft = make()
      const { replaced } = mode === 'package' ? this.repo.kb.replacePackage(draft) : this.repo.kb.upsertManualFiles(draft)
      const sections = draft.files.reduce((n, f) => n + f.sections, 0)
      // só contagens: nunca nomes de arquivos nem texto da base no registro
      this.repo.logEvent(
        'kb_import',
        `${draft.files.length} arquivo(s), ${sections} seção(ões), ${draft.skipped} ignorado(s), ${draft.duplicates} repetido(s)${replaced ? ', substituiu a versão anterior' : ''}`
      )
      return { status: 'imported', packageName: draft.name, files: draft.files.length, sections, skipped: draft.skipped, duplicates: draft.duplicates, replaced }
    } catch (e) {
      const message = e instanceof KbImportError ? e.message : 'Não foi possível importar. Confira se o arquivo não está aberto em outro programa.'
      this.repo.logEvent('kb_import_error', e instanceof KbImportError ? 'arquivo recusado' : e instanceof Error ? e.name : 'erro')
      return { status: 'error', message }
    }
  }

  async kbUpdateFile(fileId: number, patch: KbFilePatch): Promise<void> {
    if (!this.repo.kb.updateFile(fileId, patch)) throw new Error('arquivo não encontrado')
  }

  async kbSetPackageEnabled(packageId: number, enabled: boolean): Promise<void> {
    if (!this.repo.kb.setPackageEnabled(packageId, enabled)) throw new Error('pacote não encontrado')
  }

  async kbRemovePackage(packageId: number): Promise<void> {
    if (!this.repo.kb.deletePackage(packageId)) throw new Error('pacote não encontrado')
    this.repo.logEvent('kb_removed', '1 pacote')
  }

  async kbGetChunk(chunkId: number): Promise<KbChunkView | null> {
    return this.repo.kb.getChunk(chunkId)
  }
}
