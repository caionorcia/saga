import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import QRCode from 'qrcode'
import makeWASocket, {
  Browsers,
  BufferJSON,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  type Contact,
  type LIDMapping,
  type MediaDownloadOptions,
  type UserFacingSocketConfig,
  type WAMessage
} from '@whiskeysockets/baileys'
import type { Clock } from '../clock'
import { NAME_RANK, type Repo } from '../db/repo'
import type { SendRow } from '../db/sendRepo'
import { ONE_GB, hasFreeSpace } from '../disk'
import { audioFileId } from '../media'
import { recentSince } from '../recent'
import type { RateLimiter } from '../queue/limiter'
import { DeferJobError, type JobQueue } from '../queue/queue'
import type { NormalizedMessage } from '../types'
import { useAtomicAuthState, type AtomicAuthState } from './authState'
import { isGroupJid, keyLidPair, normalize, participantJids, stripDevice, toMs, toPhoneJid, type ParticipantLike } from './normalize'
import { ReconnectPolicy, classifyDisconnect } from './reconnect'
import { WaVersionResolver, formatWaVersion, type WaVersionFetcher } from './version'
import {
  GROUP_HISTORY_LIMITS,
  historyTarget,
  loadRun,
  markExhausted,
  newRun,
  nextRequestAt,
  oldestAnchor,
  reachedTarget,
  recordRequest,
  runView,
  HISTORY_TS_UNIT,
  saveRun,
  savedTsUnit,
  tsForUnit,
  type HistoryAnchor
} from './groupHistory'
import type { GroupHistoryFetchView } from '../../shared/copiloto'
import { chatHash, errCode, findSentEcho, hasRecentContactMessage, newMessageId, quotedMessage, unreadKeys, type WaKey } from '../send/logic'
import { verifyUnknownSend } from '../send/verify'
import { CONN_LOST_REASON, DEFAULT_SEND_OPTIONS, PAUSED_REASON, SEND_LIMITS, typingMs, type SendOptions } from '../../shared/send'
import { OUTSIDE_HOURS_REASON, isWithinSendHours } from '../../shared/sendHours'

export type ConnState =
  | 'connecting'
  | 'open'
  | 'waiting_retry'
  | 'needs_qr'
  | 'stopped_logged_out'
  | 'stopped_restricted'
  | 'stopped_outdated'
  | 'stopped_replaced'
  | 'manual_retry_needed'

/**
 * O pedaço do socket do Baileys que o cliente usa. Nada que altere grupos, contatos ou conversas.
 *
 * Os três métodos de escrita (`sendPresenceUpdate`, `sendMessage`, `readMessages`) são chamados SÓ por `executeSend`,
 * o handler do job `send_message`, que só existe depois de o mentor confirmar o envio (token de uso único do
 * `prepareSend`). Nenhum outro caminho do app escreve no WhatsApp.
 */
export interface WaSocket {
  ev: { on(event: string, listener: (arg: any) => void): unknown }
  end(error: Error | undefined): unknown
  /** só o armazenamento local de pares @lid → telefone (leitura das chaves no disco; nenhuma consulta ao WhatsApp) */
  signalRepository?: { lidMapping?: { getPNForLID(lid: string): Promise<string | null> } }
  /** só leitura (uma consulta IQ): os grupos de que o mentor participa, com o assunto e os participantes. Sempre pela fila. */
  groupFetchAllParticipating?(): Promise<Record<string, { id?: string; subject?: string | null; participants?: ParticipantLike[] | null }>>
  /** v0.8.1, só leitura (uma consulta IQ): um grupo só (assunto e participantes). Sempre pela fila, no máximo uma vez por grupo. */
  groupMetadata?(jid: string): Promise<{ id?: string; subject?: string | null; participants?: ParticipantLike[] | null } | null | undefined>
  /**
   * v0.8.3, só o job `fetch_history` (pela fila, no máximo um a cada 20 s e 60 por dia): pede ao PRÓPRIO celular as
   * mensagens anteriores de um grupo (o mesmo pedido do WhatsApp Web ao rolar a conversa para cima). Vai só para o
   * aparelho do mentor, nunca para um contato ou grupo; a resposta chega como `messaging-history.set` (ON_DEMAND).
   */
  fetchMessageHistory?(count: number, oldestMsgKey: { remoteJid: string; id: string; fromMe: boolean; participant?: string }, oldestMsgTimestamp: number): Promise<string>
  /** só `executeSend`: "digitando…" na conversa, "parou" e, no fim, de volta a indisponível */
  sendPresenceUpdate?(type: 'composing' | 'paused' | 'unavailable', toJid?: string): Promise<void>
  /** só `executeSend`: a resposta confirmada pelo mentor */
  sendMessage?(jid: string, content: { text: string }, options?: { quoted?: unknown; messageId?: string }): Promise<{ key?: { id?: string | null } | null } | undefined>
  /** só `executeSend`: as mensagens do contato nessa conversa (e só nela) ficam lidas ao responder */
  readMessages?(keys: WaKey[]): Promise<void>
}

export type SocketFactory = (config: UserFacingSocketConfig) => WaSocket
/**
 * Baixa a mídia. `options.options` vai para o `fetch` do Baileys (7.0.0-rc14 ainda ignora o `signal`;
 * o prazo do job na fila é quem garante que um download travado não prende a fila).
 */
export type DownloadFn = (msg: WAMessage, type: 'buffer', options: MediaDownloadOptions) => Promise<Buffer>

export interface WhatsAppClientDeps {
  repo: Repo
  queue: JobQueue
  clock: Clock
  authDir: string
  backupDir: string
  mediaDir: string
  /** todos os limitadores (aquecimento ao acordar de suspensão) */
  limiters: RateLimiter[]
  rng?: () => number
  socketFactory?: SocketFactory
  authStateFactory?: (dir: string, backupDir: string) => Promise<AtomicAuthState>
  download?: DownloadFn
  hasFreeSpace?: (dir: string, minBytes: number) => Promise<boolean>
  /** busca a versão atual do WhatsApp Web (padrão: `fetchLatestWaWebVersion` do Baileys, até 10 s) */
  fetchWaVersion?: WaVersionFetcher
  /**
   * Registro de diagnóstico (arquivo de log): estados da conexão, códigos de queda, avisos do Baileys.
   * Nunca recebe conteúdo de mensagens, chaves nem o conteúdo do QR.
   */
  diag?: (kind: string, detail: string) => void
  /** opções do envio direto, lidas na hora de cada envio (padrão: tudo ligado) */
  sendOptions?: () => SendOptions
  /**
   * v0.8.0: conferência extra de um envio, antes do "digitando…" e logo antes de enviar (ex.: o envio automático de um
   * follow-up só sai se a opção e a integração continuam ligadas). Devolve o motivo para não enviar, ou null.
   */
  sendGuard?: (s: SendRow) => string | null
  /**
   * v0.10.0: a regra dos 30 dias não vale para este envio (o rascunho de um follow-up de conversa no grupo do
   * mentorado, grupo de que o mentor participa e com mensagens dele guardadas). Todas as outras travas continuam.
   */
  recentContactExempt?: (s: SendRow) => boolean
}

/** outro envio ainda em andamento: este espera 15 s, sem gastar tentativa (o envio expira se passar de 10 min na fila) */
const SEND_DEFER_MS = 15_000
/** pedido de envio sem resposta por 10 min: fica desconhecido (mas o reenvio continua bloqueado até ele terminar) */
const SEND_STALL_MS = 10 * 60_000

const DAY = 86_400_000
const URGENT_WINDOW_MS = 3 * DAY
const URGENT_PRIORITY = 10
const SLEEP_WARMUP_THRESHOLD_MS = 3_600_000
/** conexão aberta por este tempo sem cair = estável (escada de reconexão volta ao começo) */
const STABLE_AFTER_MS = 5 * 60_000
const RESTART_REQUIRED = 515
const CONNECTION_CLOSED = 428
/**
 * Como o app se apresenta ao WhatsApp, em ordem de tentativa. Desde o fim de 2026 o WhatsApp
 * derruba (428, antes do QR) quem se apresenta como app de desktop (sub-plataforma WIN32/DARWIN);
 * como navegador Chrome (sub-plataforma WEB_BROWSER) o QR aparece. O último fica como reserva.
 */
const BROWSER_LADDER: Array<[string, string, string]> = [
  Browsers.windows('Chrome'),
  Browsers.ubuntu('Chrome'),
  Browsers.windows('Desktop')
]
const BROWSER_SETTING = 'wa.browserIdx'
/**
 * quando os nomes e os participantes dos grupos foram buscados pela última vez (epoch ms do PC). Chave nova na v0.2.3
 * (antes só os nomes, em `wa.groupsFetchedAt`): quem atualiza busca os participantes logo na primeira conexão.
 */
export const GROUPS_FETCHED_SETTING = 'wa.groupMembersFetchedAt'
/**
 * v0.8.1: grupo sem nome visto (ou conectou com grupos sem nome): pede a consulta dos grupos de novo, no máximo uma vez
 * por hora (fora a de 24 h).
 */
const GROUPS_UNNAMED_EVERY_MS = 60 * 60_000
/** v0.8.1: prioridade das consultas de grupos na fila (na frente dos downloads de áudio, atrás dos envios; no ritmo de sempre) */
const GROUPS_JOB_PRIORITY = 15
/**
 * v0.8.1: consultas de um grupo só (grupos novos; o resto vem na consulta de todos): no máximo 10 por hora e 40 por dia
 * local, gravado no banco (vale entre reinícios), e no máximo uma por grupo por dia (sem nova tentativa no mesmo dia).
 */
export const GROUP_META_LIMITS = { perHour: 10, perDay: 40 } as const
/** meia-noite (local) do dia de `now` */
const localDayStart = (now: number): number => {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
/** registro (persistido) das consultas de um grupo só: quando cada uma rodou e o dia local da última de cada grupo */
export const GROUP_META_LOG_SETTING = 'wa.groupMetaLog'
/** mensagem de grupo até este tempo antes da última consulta de todos ainda conta como "grupo novo" */
const GROUPS_META_MARGIN_MS = 10 * 60_000
/** no máximo uma busca dos nomes dos grupos por dia */
const GROUPS_FETCH_EVERY_MS = DAY
/** chave fixa do job (um só pendente por vez; volta para a fila depois de concluído) */
const GROUPS_JOB_KEY = 'wa:group_subjects'
/** sem conexão aberta quando o job roda: tenta de novo daqui a 1 min, sem gastar tentativa */
const GROUPS_DEFER_MS = 60_000
/** v0.8.3: o job único da busca do histórico dos grupos no celular */
const HISTORY_JOB_KEY = 'wa:group_history'
/** atrás das consultas de grupos e dos envios; a fila escolhe pela prioridade, cada tipo no seu ritmo */
const HISTORY_JOB_PRIORITY = 5
/** `HistorySyncType.ON_DEMAND` do protocolo (resposta a um `fetchMessageHistory`) */
const ON_DEMAND_SYNC = 6
/** o pedido ao celular nunca prende a fila: sem retorno em 15 s, segue (a resposta, se vier, chega como evento) */
const HISTORY_SEND_TIMEOUT_MS = 15_000
/** com a conexão aberta, mede o disco de novo a cada 10 min */
const DISK_CHECK_MS = 10 * 60_000

const noop = () => {}
const VERSION_FETCH_TIMEOUT_MS = 10_000

/** Texto curto de um aviso do Baileys: só a mensagem (e a do erro, se houver), nunca o objeto inteiro. */
function baileysLogText(obj: unknown, msg?: unknown): string {
  const parts: string[] = []
  if (typeof msg === 'string') parts.push(msg)
  else if (typeof obj === 'string') parts.push(obj)
  const err = obj instanceof Error ? obj : (obj as { err?: unknown; error?: unknown } | null)?.err ?? (obj as { error?: unknown } | null)?.error
  if (err instanceof Error && err.message) parts.push(err.message)
  return parts.join(': ').replace(/\s+/g, ' ').slice(0, 300) || '(sem mensagem)'
}

/**
 * Logger no formato do pino para o Baileys: só `warn` e `error` vão para o registro de diagnóstico,
 * com a mensagem apenas (os objetos de contexto podem trazer conteúdo de mensagens e são descartados).
 */
export function makeBaileysLogger(diag?: (kind: string, detail: string) => void): any {
  const forward = (kind: string) => (obj: unknown, msg?: unknown) => {
    if (!diag) return
    try {
      diag(kind, baileysLogText(obj, msg))
    } catch {
      // registrar nunca derruba a conexão
    }
  }
  const logger: any = {
    level: 'warn',
    child: () => logger,
    trace: noop,
    debug: noop,
    info: noop,
    warn: forward('baileys_warn'),
    error: forward('baileys_error'),
    fatal: forward('baileys_error')
  }
  return logger
}

const defaultFetchWaVersion: WaVersionFetcher = () =>
  fetchLatestWaWebVersion({ signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS) }) as ReturnType<WaVersionFetcher>

const defaultSocketFactory: SocketFactory = (config) => makeWASocket(config) as unknown as WaSocket
const defaultDownload: DownloadFn = (msg, type, options) => downloadMediaMessage(msg, type, options)

function statusOf(e: unknown): number | undefined {
  const x = e as { output?: { statusCode?: number }; status?: number; statusCode?: number } | null
  return x?.output?.statusCode ?? x?.status ?? x?.statusCode
}

/** O que o cliente lê de uma conversa do Baileys (`Chat` / `ChatUpdate`): só o id e o nome. */
interface ChatLike {
  id?: string | null
  name?: string | null
  displayName?: string | null
  pnJid?: string | null
  lidJid?: string | null
}

/** O que o cliente lê de um grupo do Baileys (`GroupMetadata`): só o id e o assunto. */
interface GroupLike {
  id?: string | null
  subject?: string | null
  /** `groups.upsert` (grupo novo, ou o mentor entrou nele) traz os participantes */
  participants?: ParticipantLike[] | null
}

/** v0.8.1: `group-participants.update` (entrou ou saiu gente; o Baileys manda o JID ou o participante inteiro). */
interface GroupParticipantsUpdate {
  id?: string | null
  action?: string | null
  participants?: Array<string | ParticipantLike> | null
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Cliente do WhatsApp do mentor como aparelho conectado. Lê; só escreve por um caminho: `executeSend`, o handler do job
 * `send_message` (uma resposta confirmada pelo mentor), que mostra "digitando…", envia, marca como lidas as mensagens
 * daquela conversa e volta a indisponível. Fora dele nunca envia mensagens, recibos de leitura nem presença; nunca pede
 * reenvio de mídia.
 * v0.8.3: o pedido de histórico de um grupo ao PRÓPRIO celular (`fetchMessageHistory`, job `fetch_history`, a pedido do
 * mentor e no ritmo da busca) não é mensagem a ninguém: é o mesmo pedido do WhatsApp Web ao rolar a conversa para cima.
 *
 * Eventos: `'qr'(dataUrl)`, `'status'(ConnState)`, `'message'(NormalizedMessage)`,
 * `'disk'(low: boolean)` (só quando muda), `'contacts'()` (nomes de contatos mudaram), `'send'(jid)` (um envio mudou de estado).
 */
export class WhatsAppClient extends EventEmitter {
  private readonly policy: ReconnectPolicy
  private readonly socketFactory: SocketFactory
  private readonly authStateFactory: (dir: string, backupDir: string) => Promise<AtomicAuthState>
  private readonly download: DownloadFn
  private readonly hasFreeSpace: (dir: string, minBytes: number) => Promise<boolean>
  private readonly versions: WaVersionResolver
  private readonly baileysLogger: any

  private sock: WaSocket | null = null
  private auth: AtomicAuthState | null = null
  /** cada socket tem uma geração; eventos de gerações antigas são ignorados */
  private gen = 0
  private running = false
  private status: ConnState | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAtMs: number | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  /** já tentou restaurar o backup desde a última conexão estável */
  private restoredOnce = false
  /** já apagou a sessão e reconectou na hora desde a última conexão estável */
  private wipedOnce = false
  /** a última queda foi um 515 que reconectou sem contar */
  private last515 = false
  /** já buscou a versão de novo e reconectou depois de um 405 desde a última conexão estável */
  private outdatedRetried = false
  /** a próxima conexão busca a versão do WhatsApp Web sem usar o cache */
  private forceVersionRefresh = false
  /** já mostrou um QR neste socket (o registro anota só o primeiro) */
  private qrLogged = false
  /** este socket chegou a mostrar QR ou abrir (então um 428 não é recusa da identidade) */
  private socketProgressed = false
  /** já abriu alguma vez nesta execução */
  private everOpened = false
  /** v0.8.3: quando a conexão atual abriu (epoch ms), ou null fora de `open` */
  private openedAt: number | null = null
  /** v0.8.3: este socket mostrou um QR (vínculo novo): ao abrir, o aparelho foi vinculado agora */
  private qrThisSocket = false
  private pausedByConnection = false
  /** menos de 1 GB livre: downloads pausados até a próxima medição com espaço */
  private diskLow = false
  private diskTimer: ReturnType<typeof setTimeout> | null = null
  /** LID (sem dispositivo) → JID de telefone */
  private lidToPn = new Map<string, string>()
  /** v0.8.1: quando a consulta dos grupos foi pedida por último (grupo sem nome: no máximo uma por hora) */
  private groupsRequestedAt = -Infinity
  /**
   * Melhor nome conhecido por JID (telefone ou @lid ainda sem telefone). Vale para contatos que ainda não
   * têm mensagem (o nome entra quando a primeira chegar) e para @lid que só depois ganha o telefone.
   */
  private knownNames = new Map<string, { name: string; rank: number }>()
  private work: Promise<void> = Promise.resolve()
  /**
   * envios com o pedido ao WhatsApp em andamento (id → tentativa): o socket caindo agora deixa o estado desconhecido,
   * e enquanto o pedido não termina nenhuma nova tentativa do mesmo envio é aceita
   */
  private inFlight = new Map<number, number>()
  private readonly rng: () => number

  constructor(private readonly deps: WhatsAppClientDeps) {
    super()
    this.policy = new ReconnectPolicy(deps.clock, deps.rng ?? Math.random)
    this.socketFactory = deps.socketFactory ?? defaultSocketFactory
    this.authStateFactory = deps.authStateFactory ?? useAtomicAuthState
    this.download = deps.download ?? defaultDownload
    this.hasFreeSpace = deps.hasFreeSpace ?? hasFreeSpace
    this.versions = new WaVersionResolver(deps.repo, deps.clock, deps.fetchWaVersion ?? defaultFetchWaVersion)
    this.baileysLogger = makeBaileysLogger(deps.diag)
    // v0.10.1: os pares @lid → telefone já aprendidos (guardados): valem desde o início, antes de o WhatsApp conectar
    try {
      for (const { lid, pn } of deps.repo.lidPnPairs()) this.lidToPn.set(lid, pn)
    } catch {
      // banco sem os pares: aprende de novo
    }
    deps.queue.register('download_audio', (p, signal) => this.downloadAudio(p, signal))
    deps.queue.register('fetch_profile', (p) => this.fetchProfile(p))
    // um envio ainda em andamento (mesmo depois do prazo do job) segura o próximo: nunca dois ao mesmo tempo
    deps.queue.register('send_message', (p, signal) => this.executeSend(p, signal), { ready: () => this.inFlight.size === 0 })
    // v0.8.3: só roda quando um pedido pode sair (conexão estável, ritmo, limite do dia, sem pedido esperando resposta)
    deps.queue.register('fetch_history', () => this.fetchHistoryStep(), { ready: () => this.historyReady() })
    this.rng = deps.rng ?? Math.random
    // downloads, consultas e envios ao WhatsApp só com a conexão aberta
    deps.queue.pauseType('download_audio')
    deps.queue.pauseType('fetch_profile')
    deps.queue.pauseType('send_message')
  }

  getStatus(): ConnState | null {
    return this.status
  }

  /** A geração da conexão atual: vai no job de cada envio; uma conexão nova invalida os envios confirmados antes. */
  connGen(): number {
    return this.gen
  }

  /** O pedido deste envio ao WhatsApp ainda não terminou (não aceitar outra tentativa nem dar como desconhecido). */
  isSendInFlight(sendId: number): boolean {
    return this.inFlight.has(sendId)
  }

  /** quando a próxima tentativa de reconexão está agendada (epoch ms), ou null */
  getRetryAt(): number | null {
    return this.status === 'waiting_retry' ? this.retryAtMs : null
  }

  isDiskLow(): boolean {
    return this.diskLow
  }

  /** Mede o disco agora (botão "Retomar"): com espaço e conexão aberta, retoma os downloads. */
  async recheckDisk(): Promise<void> {
    this.schedule(() => this.checkDisk())
    await this.whenIdle()
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.schedule(() => this.connect())
    await this.whenIdle()
  }

  async stop(): Promise<void> {
    this.running = false
    this.clearRetry()
    this.clearStable()
    this.clearDiskTimer()
    this.dropSocket()
    this.deps.queue.pauseType('download_audio')
    this.deps.queue.pauseType('fetch_profile')
    this.deps.queue.pauseType('send_message')
    await this.whenIdle()
    await this.auth?.close()
  }

  /** Botão "Tentar de novo": zera a política e conecta já. */
  async manualReconnect(): Promise<void> {
    this.running = true
    this.clearRetry()
    this.clearStable()
    this.policy.manualRetry()
    this.last515 = false
    this.outdatedRetried = false
    // nenhuma identidade funcionou ainda: o clique recomeça a lista do início
    if (!this.browserConfirmed) this.deps.repo.setSetting(BROWSER_SETTING, '0')
    this.dropSocket()
    this.schedule(() => this.connect())
    await this.whenIdle()
  }

  /** Chamado ao acordar de suspensão: mais de 1 h dormindo → aquecimento em todos os limitadores. */
  onResumeFromSleep(sleptMs: number): void {
    if (sleptMs > SLEEP_WARMUP_THRESHOLD_MS) for (const l of this.deps.limiters) l.startWarmup()
    // o disco pode ter mudado enquanto o computador dormia
    if (this.running) this.schedule(() => this.checkDisk())
  }

  /** Resolve quando todo o trabalho enfileirado (eventos do socket, conexão) terminou. */
  async whenIdle(): Promise<void> {
    let w: Promise<void>
    do {
      w = this.work
      await w
    } while (w !== this.work)
  }

  // --- conexão ---

  private schedule(fn: () => Promise<void> | void): void {
    this.work = this.work.then(fn).catch((e) => {
      try {
        this.deps.repo.logEvent('wa_error', errMsg(e))
      } catch {
        // banco fechado: nada a fazer
      }
    })
  }

  /** Registro de diagnóstico (nunca lança). */
  private diag(kind: string, detail: string): void {
    try {
      this.deps.diag?.(kind, detail)
    } catch {
      // registrar nunca pode quebrar a conexão
    }
  }

  private setStatus(s: ConnState): void {
    // downloads de mídia só com a conexão aberta (a volta é em onOpen, depois de checar o disco)
    if (s !== 'open') {
      this.openedAt = null
      this.deps.queue.pauseType('download_audio')
      this.deps.queue.pauseType('fetch_profile')
      this.deps.queue.pauseType('send_message')
      this.clearDiskTimer()
      // nunca sai depois de reconectar sem nova confirmação
      this.expireUnsent()
    }
    if (this.status === s) return
    this.status = s
    this.diag('wa_status', s)
    this.emit('status', s)
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.retryAtMs = null
  }

  private clearDiskTimer(): void {
    if (this.diskTimer) clearTimeout(this.diskTimer)
    this.diskTimer = null
  }

  /** Próxima medição periódica do disco (só com a conexão aberta). */
  private armDiskTimer(): void {
    this.clearDiskTimer()
    if (!this.running || this.status !== 'open') return
    this.diskTimer = setTimeout(() => {
      this.diskTimer = null
      this.schedule(() => this.checkDisk())
    }, DISK_CHECK_MS)
  }

  /** Marca o disco como cheio/com espaço; pausa os downloads se cheio; registra e avisa só na mudança. */
  private setDiskLow(low: boolean): void {
    if (low) this.deps.queue.pauseType('download_audio')
    if (low === this.diskLow) return
    this.diskLow = low
    if (low) this.deps.repo.logEvent('disk_low', `menos de 1 GB livre em ${this.deps.mediaDir}`)
    else this.deps.repo.logEvent('disk_ok', `espaço em disco de volta em ${this.deps.mediaDir}`)
    this.emit('disk', low)
  }

  /** Mede o disco; com espaço e conexão aberta, retoma os downloads. Reagenda a medição periódica. */
  private async checkDisk(): Promise<void> {
    if (!this.running) return
    const gen = this.gen
    const free = await this.hasFreeSpace(this.deps.mediaDir, ONE_GB)
    // parou ou trocou de socket enquanto media: a medição é velha
    if (gen !== this.gen || !this.running) return
    this.setDiskLow(!free)
    if (free && this.status === 'open') this.deps.queue.resumeType('download_audio')
    this.armDiskTimer()
  }

  private clearStable(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
  }

  private retryIn(ms: number): void {
    this.clearRetry()
    this.retryAtMs = this.deps.clock.now() + ms
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retryAtMs = null
      this.schedule(() => this.connect())
    }, ms)
  }

  /** Invalida o socket atual (os eventos dele passam a ser ignorados) e o fecha. */
  private dropSocket(): void {
    this.sendInterrupted('a conexão foi refeita durante o envio')
    this.expireUnsent()
    this.gen++
    const s = this.sock
    this.sock = null
    if (s) {
      try {
        s.end(undefined)
      } catch {
        // já fechado
      }
    }
  }

  /**
   * Conecta; qualquer erro ao montar a conexão (sessão, versão, criação do socket) vira uma queda comum
   * (espera da política e "Tentar de novo"), nunca um "Conectando…" eterno.
   */
  private async connect(): Promise<void> {
    if (!this.running) return
    this.dropSocket()
    const gen = this.gen
    try {
      await this.openSocket(gen)
    } catch (e) {
      if (gen !== this.gen || !this.running) return
      this.gen++
      this.sock = null
      const detail = `falha ao conectar: ${errMsg(e).slice(0, 300)}`
      this.deps.repo.logEvent('wa_connect_error', detail)
      this.diag('wa_connect_error', detail)
      this.retryWithPolicy(detail)
    }
  }

  private async openSocket(gen: number): Promise<void> {
    this.setStatus('connecting')
    this.qrLogged = false
    this.qrThisSocket = false
    this.socketProgressed = false
    await this.auth?.close()
    const auth = await this.authStateFactory(this.deps.authDir, this.deps.backupDir)
    if (gen !== this.gen || !this.running) return
    this.auth = auth
    const force = this.forceVersionRefresh
    this.forceVersionRefresh = false
    const v = await this.versions.resolve({ force })
    if (gen !== this.gen || !this.running) return
    this.diag(
      'wa_version',
      `WhatsApp Web ${formatWaVersion(v.version)} (${v.source}${force ? ', forçada' : ''})${v.error ? `; busca falhou: ${v.error}` : ''}`
    )
    const sock = this.socketFactory({
      ...(v.version ? { version: v.version } : {}),
      auth: auth.state,
      browser: BROWSER_LADDER[this.browserIdx()],
      // presença "indisponível" ao conectar: o celular continua recebendo notificações
      // e os recibos automáticos do Baileys saem como 'inactive' (entregue, nunca "lido")
      markOnlineOnConnect: false,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      generateHighQualityLinkPreview: false,
      logger: this.baileysLogger
    })
    this.sock = sock
    const on = (event: string, fn: (arg: any) => Promise<void> | void) =>
      sock.ev.on(event, (arg) => {
        if (gen !== this.gen) return
        this.schedule(() => (gen === this.gen ? fn(arg) : undefined))
      })
    on('connection.update', (u) => this.onConnectionUpdate(u))
    on('creds.update', () => auth.saveCreds())
    on('lid-mapping.update', (m: LIDMapping) => this.addLidMappings([m]))
    on(
      'messaging-history.set',
      async (h: { messages: WAMessage[]; contacts?: Contact[]; chats?: ChatLike[]; lidPnMappings?: LIDMapping[]; syncType?: number | null }) => {
        this.addLidMappings(h.lidPnMappings ?? [])
        await this.learnContacts('history', h.contacts ?? [])
        await this.learnChats('history', h.chats ?? [])
        const onDemand = h.syncType === ON_DEMAND_SYNC
        const r = await this.ingest(h.messages ?? [])
        if (onDemand) this.onDemandHistory(h.messages ?? [], r.byJid)
        // v0.8.3: histórico de um vínculo novo (QR) ou pedido ao celular: o serviço segura o envio automático dos follow-ups
        if (r.inserted > 0 && (onDemand || this.qrThisSocket)) this.emit('history', { inserted: r.inserted, onDemand })
      }
    )
    on('messages.upsert', async (u: { messages: WAMessage[] }) => void (await this.ingest(u.messages ?? [])))
    on('contacts.upsert', (cs: Contact[]) => this.learnContacts('contacts.upsert', cs ?? []))
    on('contacts.update', (cs: Partial<Contact>[]) => this.learnContacts('contacts.update', cs ?? []))
    on('chats.upsert', (cs: ChatLike[]) => this.learnChats('chats.upsert', cs ?? []))
    on('chats.update', (cs: ChatLike[]) => this.learnChats('chats.update', cs ?? []))
    on('groups.upsert', (gs: GroupLike[]) => this.learnGroups(gs ?? []))
    on('groups.update', (gs: GroupLike[]) => this.learnGroups(gs ?? []))
    on('group-participants.update', (u: GroupParticipantsUpdate) => this.learnParticipants(u))
  }

  private async onConnectionUpdate(u: {
    connection?: 'open' | 'connecting' | 'close'
    qr?: string
    lastDisconnect?: { error?: unknown }
  }): Promise<void> {
    if (u.connection) this.diag('wa_connection_update', u.connection)
    if (u.qr) {
      this.socketProgressed = true
      this.qrThisSocket = true
      this.rememberBrowser()
      // nunca o conteúdo do QR: só que ele chegou
      if (!this.qrLogged) {
        this.qrLogged = true
        this.deps.repo.logEvent('wa_qr', 'QR Code pronto para escanear')
        this.diag('wa_qr', 'QR Code recebido')
      }
      const dataUrl = await QRCode.toDataURL(u.qr)
      this.emit('qr', dataUrl)
      this.setStatus('needs_qr')
    }
    if (u.connection === 'open') {
      this.socketProgressed = true
      this.everOpened = true
      this.rememberBrowser()
      await this.onOpen()
    }
    else if (u.connection === 'close') await this.onClose(u.lastDisconnect?.error)
  }

  private async onOpen(): Promise<void> {
    // não zera a política aqui: um link que abre e cai em seguida continua contando
    this.clearStable()
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null
      this.policy.markStable()
      this.restoredOnce = false
      this.wipedOnce = false
      this.last515 = false
      this.outdatedRetried = false
    }, STABLE_AFTER_MS)
    if (this.pausedByConnection) {
      this.pausedByConnection = false
      this.deps.queue.resume()
    }
    this.openedAt = this.deps.clock.now()
    this.setStatus('open')
    this.deps.queue.resumeType('fetch_profile')
    this.deps.queue.resumeType('send_message')
    this.deps.repo.logEvent('wa_open', 'conectado')
    const gen = this.gen
    await this.checkDisk()
    // stop()/manualReconnect() durante a medição: este socket não vale mais
    if (gen !== this.gen || !this.running) return
    // grava as credenciais atuais antes de copiar: o backup sempre reflete uma sessão que abriu
    await this.auth?.saveCreds()
    await this.auth?.backup()
    // v0.10.1: remetentes @lid guardados sem telefone: o armazenamento local do Baileys pode já saber (sem rede)
    try {
      await this.resolveStoredLids()
    } catch {
      // nunca atrapalha a conexão
    }
    if (gen !== this.gen || !this.running) return
    if (this.qrThisSocket) {
      // v0.8.3: aparelho vinculado agora (primeira vez ou de novo): o histórico vai chegar. Os grupos (nomes e
      // participantes) são consultados de novo pela fila, uma vez, e o serviço segura o envio automático dos follow-ups
      this.diag('wa_paired', 'aparelho vinculado por QR nesta conexão')
      this.emit('paired')
      this.requestGroupSubjects(true)
    } else this.scheduleGroupSubjects()
    // v0.8.3: uma busca no celular em andamento (o app reiniciou, o job parou) continua, no ritmo dela
    try {
      if (loadRun(this.deps.repo)?.state === 'running') {
        this.deps.queue.requeue('fetch_history', HISTORY_JOB_KEY, { kind: 'group_history' }, HISTORY_JOB_PRIORITY, { revive: true })
      }
    } catch {
      // nunca atrapalha a conexão
    }
  }

  /**
   * Uma vez por abertura, no máximo uma vez a cada 24 h: pede os nomes (assuntos) dos grupos PELA FILA,
   * como um job `fetch_profile` (respeita o ritmo do limitador). Nunca chama na hora.
   */
  private scheduleGroupSubjects(): void {
    const last = Number(this.deps.repo.getSetting(GROUPS_FETCHED_SETTING) ?? 0)
    if (Number.isFinite(last) && last > 0 && this.deps.clock.now() - last < GROUPS_FETCH_EVERY_MS) {
      // v0.8.1: grupos sem nome aqui: consulta de novo (no máximo uma vez por hora)
      if (this.deps.repo.unnamedGroupCount() > 0) this.requestGroupSubjects()
      return
    }
    this.requestGroupSubjects(true)
  }

  /**
   * v0.8.1: põe a consulta dos grupos na fila (com prioridade, no ritmo do limitador). Um job que falhou de vez antes
   * volta também (antes ficava falho para sempre e os nomes nunca chegavam). Fora a de 24 h, no máximo uma por hora.
   */
  private requestGroupSubjects(force = false): void {
    const now = this.deps.clock.now()
    if (!force && now - this.groupsRequestedAt < GROUPS_UNNAMED_EVERY_MS) return
    this.groupsRequestedAt = now
    this.deps.queue.requeue('fetch_profile', GROUPS_JOB_KEY, { kind: 'group_subjects' }, GROUPS_JOB_PRIORITY, { revive: true })
  }

  private stopWith(state: ConnState, detail: string): void {
    this.running = false
    if (!this.deps.queue.isPaused()) {
      this.deps.queue.pause()
      this.pausedByConnection = true
    }
    this.setStatus(state)
    this.deps.repo.logEvent(`wa_${state}`, detail)
  }

  /** Espera da política, ou `manual_retry_needed` quando ela esgota. */
  private retryWithPolicy(detail: string): void {
    const delay = this.policy.nextDelayMs()
    if (delay === null) {
      this.setStatus('manual_retry_needed')
      this.deps.repo.logEvent('wa_manual_retry_needed', detail)
    } else {
      this.setStatus('waiting_retry')
      this.retryIn(delay)
    }
  }

  private browserIdx(): number {
    const n = Number(this.deps.repo.getSetting(BROWSER_SETTING) ?? 0)
    return Number.isInteger(n) && n >= 0 && n < BROWSER_LADDER.length ? n : 0
  }

  /** a identidade atual funcionou (QR ou conexão aberta): fica gravada para as próximas vezes */
  private rememberBrowser(): void {
    if (!this.browserConfirmed) {
      this.browserConfirmed = true
      this.diag('wa_browser', `identidade aceita: ${BROWSER_LADDER[this.browserIdx()].join(' / ')}`)
    }
  }
  private browserConfirmed = false

  /**
   * 428 logo depois de conectar, sem QR nem abertura: o WhatsApp recusou a identidade.
   * Passa para a próxima da lista e reconecta já (sem contar); depois da última, segue a política normal.
   */
  private tryNextBrowser(detail: string): boolean {
    if (this.browserConfirmed) return false
    const next = this.browserIdx() + 1
    if (next >= BROWSER_LADDER.length) return false
    this.deps.repo.setSetting(BROWSER_SETTING, String(next))
    const msg = `${detail}; tentando como ${BROWSER_LADDER[next].join(' / ')}`
    this.deps.repo.logEvent('wa_browser_switch', msg)
    this.diag('wa_browser_switch', msg)
    this.setStatus('waiting_retry')
    this.retryIn(0)
    return true
  }

  private async onClose(error: unknown): Promise<void> {
    if (!this.running) return
    // um socket fecha uma vez só: eventos seguintes dele são ignorados
    this.sendInterrupted('a conexão caiu durante o envio')
    this.expireUnsent()
    this.gen++
    this.sock = null
    this.clearStable()
    const auth = this.auth
    const code = statusOf(error)
    const detail = `código ${code ?? '?'}: ${error ? errMsg(error).slice(0, 300) : 'sem detalhe'}`
    this.diag('wa_close', detail)
    if (code === CONNECTION_CLOSED && !this.socketProgressed && !this.everOpened && this.tryNextBrowser(detail)) return
    const isRestart = code === RESTART_REQUIRED
    if (isRestart && !this.last515) {
      // "reinicie": normal depois de parear; reconecta já, sem contar (uma vez seguida)
      this.last515 = true
      this.setStatus('waiting_retry')
      this.retryIn(0)
      return
    }
    if (!isRestart) this.last515 = false

    const cls = classifyDisconnect(code, error instanceof Error ? error.message : undefined)
    if (cls !== 'outdated') this.deps.repo.logEvent('wa_closed', detail)
    switch (cls) {
      case 'retry':
        this.retryWithPolicy(detail)
        return
      case 'bad_session':
        // 500 ("Stream Errored", ex.: "ack") é um erro passageiro do servidor, não sessão estragada.
        // Nunca restaurar o backup nem apagar aqui: voltar as chaves de criptografia para uma cópia
        // antiga desencontra as sessões ("No session found to decrypt") e trava a sincronização.
        // Credenciais ilegíveis já são restauradas do backup ao carregar.
        this.deps.repo.logEvent('wa_stream_error', detail)
        this.retryWithPolicy(detail)
        return
      case 'logged_out':
        // o aparelho foi desconectado no celular: as credenciais não servem mais (nem o backup)
        await auth?.close()
        auth?.wipe()
        this.stopWith('stopped_logged_out', detail)
        return
      case 'restricted':
        this.stopWith('stopped_restricted', detail)
        return
      case 'outdated':
        if (!this.outdatedRetried) {
          // versão do WhatsApp Web recusada (405 antes do QR): busca a versão atual e tenta já, sem contar
          this.outdatedRetried = true
          this.forceVersionRefresh = true
          this.deps.repo.logEvent('wa_outdated_retry', `${detail}; buscando a versão atual do WhatsApp Web`)
          this.setStatus('waiting_retry')
          this.retryIn(0)
          return
        }
        this.stopWith('stopped_outdated', detail)
        return
      case 'replaced':
        this.stopWith('stopped_replaced', detail)
        return
    }
  }

  // --- ingestão ---

  private addLidMappings(maps: LIDMapping[]): void {
    for (const m of maps) {
      const pn = toPhoneJid(m?.pn)
      if (!m?.lid || !pn) continue
      const lid = stripDevice(m.lid)
      this.learnLid(lid, pn)
      // nome que chegou para o @lid antes do telefone: vai para o contato do telefone
      const pending = this.knownNames.get(lid)
      if (pending) {
        this.knownNames.delete(lid)
        if (this.rememberName(pn, pending.name, pending.rank)) this.emit('contacts')
      }
    }
  }

  /**
   * v0.8.1: um par @lid → telefone. Novo: o telefone entra como forma do participante nos grupos em que o @lid está
   * (guardado; o mapa é só da memória) e o Copiloto confere de novo os grupos (pode ter passado a ser de mentorado).
   */
  private learnLid(lid: string, pn: string): void {
    if (this.lidToPn.get(lid) === pn) return
    this.lidToPn.set(lid, pn)
    try {
      this.deps.repo.linkLidPhone(lid, pn)
    } catch {
      // só melhora a participação conhecida; nunca quebra a ingestão
    }
    this.emit('membership')
  }

  /**
   * v0.8.1: mensagem de grupo: sem nome, pede a consulta dos grupos (no máximo uma por hora); sem participantes
   * conhecidos (grupo novo), a consulta só desse grupo, pela fila. Só com a conexão aberta.
   */
  private checkGroup(groupJid: string, ts: number): void {
    if (this.status !== 'open') return
    try {
      if (!this.deps.repo.groupHasName(groupJid)) this.requestGroupSubjects()
      // só grupo que apareceu depois da última consulta de todos (o histórico antigo espera a consulta de todos)
      const fetched = Number(this.deps.repo.getSetting(GROUPS_FETCHED_SETTING) ?? 0)
      if (fetched > 0 && ts >= fetched - GROUPS_META_MARGIN_MS && !this.deps.repo.hasGroupMembership(groupJid)) this.requestGroupMeta(groupJid)
    } catch {
      // nunca quebra a ingestão
    }
  }

  /** Guarda o nome se não for pior que o já conhecido e aplica no contato, se ele existir. */
  private rememberName(jid: string, name: string, rank: number): boolean {
    const cur = this.knownNames.get(jid)
    if (cur && cur.rank > rank) return false
    this.knownNames.set(jid, { name, rank })
    return this.deps.repo.setContactName(jid, name, rank)
  }

  /** Nome e qualidade de um contato do Baileys: agenda > perfil (notify) > nome verificado (empresa). */
  private static contactName(c: Partial<Contact>): { name: string; rank: number } | null {
    const book = c.name?.trim()
    if (book) return { name: book, rank: NAME_RANK.addressBook }
    const profile = c.notify?.trim() || c.verifiedName?.trim()
    return profile ? { name: profile, rank: NAME_RANK.profile } : null
  }

  /** Só conversas individuais (telefone ou @lid); grupos, status e newsletters não viram contato. */
  private static isPersonJid(j: unknown): j is string {
    return typeof j === 'string' && (j.endsWith('@s.whatsapp.net') || j.endsWith('@lid'))
  }

  /** Nome (assunto) de grupos vindos de `groups.upsert`/`groups.update` ou da consulta pela fila. `true` se algum mudou. */
  private applyGroupNames(groups: GroupLike[]): boolean {
    let applied = false
    for (const g of groups) {
      const subject = g?.subject?.trim()
      if (!subject || !g.id || !isGroupJid(g.id)) continue
      // v0.8.1: guardado mesmo sem a conversa do grupo existir ainda (antes ficava só na memória e se perdia ao fechar)
      this.knownNames.set(g.id, { name: subject, rank: NAME_RANK.profile })
      if (this.deps.repo.setGroupSubject(g.id, subject)) applied = true
    }
    return applied
  }

  private async learnGroups(groups: GroupLike[]): Promise<void> {
    const named = this.applyGroupNames(groups)
    // v0.8.1: grupo novo (ou o mentor entrou nele): os participantes vêm junto, sem consulta nenhuma
    const withMembers = groups.filter((g) => g?.id && Array.isArray(g.participants)).map((g) => ({ id: g.id as string, participants: g.participants }))
    const members = withMembers.length ? await this.applyGroupMembers(withMembers) : { count: 0, changed: false }
    if (members.changed) this.emit('membership')
    if (named || members.changed) this.emit('contacts')
  }

  /** v0.8.1: `group-participants.update`: entrou ou saiu gente do grupo (sem consulta). */
  private async learnParticipants(u: GroupParticipantsUpdate): Promise<void> {
    const id = u?.id
    if (!id || !isGroupJid(id) || !Array.isArray(u.participants)) return
    const action = u.action === 'add' ? 'add' : u.action === 'remove' ? 'remove' : null
    if (!action) return
    const forms = new Set<string>()
    for (const p of u.participants) {
      const part: ParticipantLike = typeof p === 'string' ? { id: p } : p
      for (const f of participantJids(part, (lid) => this.lidToPn.get(lid) ?? null)) {
        forms.add(f)
        if (f.endsWith('@lid')) forms.add(await this.resolveJid(f))
      }
    }
    if (!this.deps.repo.hasGroupMembership(id) && action === 'add') {
      // ainda não se sabe quem mais está no grupo: uma consulta só deste grupo, pela fila
      this.requestGroupMeta(id)
    }
    if (this.deps.repo.changeGroupMembers(id, action, [...forms], u.participants.length)) {
      this.emit('membership')
      this.emit('contacts')
    }
  }

  /** v0.8.1: a consulta de um grupo só (assunto e participantes), pela fila, dentro dos limites (`GROUP_META_LIMITS`). */
  private requestGroupMeta(groupJid: string): void {
    if (!this.sock?.groupMetadata || !this.groupMetaAllowed(groupJid)) return
    this.deps.queue.requeue('fetch_profile', `wa:group_meta:${groupJid}`, { kind: 'group_meta', jid: groupJid }, GROUPS_JOB_PRIORITY, { revive: true })
  }

  /** Aplica nomes de uma lista de JIDs que são a mesma pessoa (id, telefone, @lid). */
  private async learnName(ids: Array<string | null | undefined>, name: string, rank: number): Promise<boolean> {
    const targets = new Set<string>()
    const raw = ids.filter(WhatsAppClient.isPersonJid).map((j) => stripDevice(j))
    const pn = raw.find((j) => !j.endsWith('@lid'))
    for (const lid of raw.filter((j) => j.endsWith('@lid'))) {
      if (pn && !this.lidToPn.has(lid)) this.learnLid(lid, pn)
    }
    for (const j of raw) targets.add(await this.resolveJid(j))
    let changed = false
    for (const j of targets) if (this.rememberName(j, name, rank)) changed = true
    return changed
  }

  private async learnContacts(source: string, contacts: Partial<Contact>[]): Promise<void> {
    let named = 0
    let applied = 0
    for (const c of contacts) {
      const n = c ? WhatsAppClient.contactName(c) : null
      if (!n) continue
      named++
      if (await this.learnName([c.id, c.phoneNumber, c.lid], n.name, n.rank)) applied++
    }
    if (named) this.diag('wa_names', `${source}: ${contacts.length} contatos, ${named} com nome, ${applied} aplicados`)
    if (applied) this.emit('contacts')
  }

  private async learnChats(source: string, chats: ChatLike[]): Promise<void> {
    let named = 0
    let applied = 0
    for (const c of chats) {
      const name = (c?.name || c?.displayName)?.trim()
      if (!name) continue
      if (c.id && isGroupJid(c.id)) {
        named++
        if (this.rememberName(c.id, name, NAME_RANK.profile)) applied++
        continue
      }
      if (!WhatsAppClient.isPersonJid(c.id)) continue
      named++
      if (await this.learnName([c.id, c.pnJid, c.lidJid], name, NAME_RANK.profile)) applied++
    }
    if (named) this.diag('wa_names', `${source}: ${chats.length} conversas, ${named} com nome, ${applied} aplicados`)
    if (applied) this.emit('contacts')
  }

  /** v0.8.1: "Atualizar nomes dos grupos": a consulta dos grupos de novo, pela fila (com a conexão aberta). */
  refreshGroupSubjects(): void {
    this.requestGroupSubjects(true)
  }

  /**
   * v0.5.0 (Copiloto): o telefone já conhecido para um @lid, sem rede; null se não souber. v0.10.1: o mapa da memória e,
   * depois, os pares guardados no banco (de outra execução do app).
   */
  pnForLid(lid: string): string | null {
    const known = this.lidToPn.get(lid)
    if (known) return known
    try {
      const saved = this.deps.repo.pnForLid(lid)
      if (saved) this.lidToPn.set(lid, saved)
      return saved
    } catch {
      return null
    }
  }

  /**
   * v0.10.1: os @lid guardados aqui ainda sem telefone (quem mandou mensagem num grupo, participantes) são procurados no
   * armazenamento local do Baileys (só leitura das chaves no disco, nenhuma consulta ao WhatsApp). Quantos ganharam telefone.
   */
  async resolveStoredLids(): Promise<{ checked: number; resolved: number }> {
    const store = this.sock?.signalRepository?.lidMapping
    if (!store) return { checked: 0, resolved: 0 }
    let lids: string[]
    try {
      lids = this.deps.repo.unresolvedLids()
    } catch {
      return { checked: 0, resolved: 0 }
    }
    let resolved = 0
    for (const lid of lids) {
      try {
        const pn = toPhoneJid(await store.getPNForLID(lid))
        if (pn) {
          this.learnLid(lid, pn)
          resolved++
        }
      } catch {
        // sem mapeamento para este: segue
      }
    }
    if (lids.length) this.diag('wa_lids', `remetentes @lid sem telefone: ${lids.length}; encontrados no armazenamento local: ${resolved}`)
    return { checked: lids.length, resolved }
  }

  /**
   * v0.10.0: o mentor está entre os participantes conhecidos do grupo? null = não dá para saber (participantes ainda
   * não consultados, ou a conta ainda sem identificação). Sem rede.
   */
  isSelfInGroup(groupJid: string): boolean | null {
    const me = this.auth?.state.creds.me as { id?: string; lid?: string } | undefined
    const own = [me?.id, me?.lid].filter((j): j is string => typeof j === 'string' && j.includes('@')).map(stripDevice)
    if (own.length === 0 || !this.deps.repo.hasGroupMembership(groupJid)) return null
    const members = new Set(this.deps.repo.groupMembers(groupJid).map(stripDevice))
    return own.some((j) => members.has(j))
  }

  /** `@lid` → telefone quando conhecido (mapa do histórico/eventos, depois o armazenamento local do Baileys). */
  private async resolveJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid
    // v0.10.1: a memória e os pares guardados no banco
    const known = this.pnForLid(jid)
    if (known) return known
    try {
      // consulta só o armazenamento local de chaves (sem rede)
      const pn = toPhoneJid(await this.sock?.signalRepository?.lidMapping?.getPNForLID(jid))
      if (pn) {
        this.learnLid(jid, pn)
        return pn
      }
    } catch {
      // sem mapeamento: fica o @lid
    }
    return jid
  }

  /** Horários acima disto (PC + 1 dia) são tratados como absurdos e nunca viram a âncora da janela. */
  private anchorBound(): number {
    return this.deps.clock.now() + DAY
  }

  /**
   * "Agora" pelo horário do WhatsApp: a mensagem mais nova já vista (no banco ou em `batchMaxTs`),
   * limitada a PC + 1 dia; o relógio do PC só quando ainda não há nenhuma mensagem. Um PC adiantado não
   * encolhe a janela, e uma mensagem com horário absurdo no futuro não derruba as reais (o limite só alarga).
   */
  private waNow(batchMaxTs = -Infinity): number {
    const bound = this.anchorBound()
    const batch = batchMaxTs <= bound ? batchMaxTs : -Infinity
    const newest = Math.max(this.deps.repo.newestMessageTs(bound) ?? -Infinity, batch)
    return Number.isFinite(newest) ? Math.min(newest, bound) : this.deps.clock.now()
  }

  /**
   * Grava as mensagens novas (as já guardadas, pela id, ficam como estão). Devolve quantas entraram, por conversa.
   * v0.9.0 (contrato v1.3): guarda TODO o histórico que o celular mandar, de qualquer data. A janela de 30 dias (pelo
   * horário das mensagens do WhatsApp) vale só para o download automático dos áudios (e a transcrição que vem depois);
   * áudio mais antigo fica como áudio, com "Transcrever" sob pedido na conversa. O lote é gravado numa transação só
   * (primeiro os JIDs são resolvidos, depois tudo é gravado sem `await` no meio) e os avisos saem depois de gravar.
   */
  private async ingest(messages: WAMessage[]): Promise<{ inserted: number; byJid: Map<string, number> }> {
    const { repo, queue } = this.deps
    const me = this.auth?.state.creds.me as { id?: string; lid?: string } | undefined
    const opts = { ownJid: me?.id, ownLid: me?.lid }
    const bound = this.anchorBound()
    // 1) normaliza e resolve @lid → telefone (pode consultar o armazenamento do Baileys)
    const ready: Array<{ n: NormalizedMessage; lid: string; pushName: string | null }> = []
    let batchMax = -Infinity
    for (const raw of messages) {
      const n = normalize(raw, opts)
      if (!n) continue
      if (n.ts > batchMax && n.ts <= bound) batchMax = n.ts
      // v0.10.1: o par @lid ↔ telefone que a chave traz (participantAlt/remoteJidAlt) fica aprendido e guardado
      const pair = keyLidPair(raw.key)
      if (pair && this.lidToPn.get(pair.lid) !== pair.pn) this.learnLid(pair.lid, pair.pn)
      const lid = n.jid
      n.jid = await this.resolveJid(n.jid)
      if (n.senderJid) {
        n.senderJid = await this.resolveJid(n.senderJid)
        n.senderPn = n.senderPn ?? toPhoneJid(n.senderJid)
      }
      // menções e citação das minhas mensagens de grupo: guarda o @lid e o telefone (casa com a conversa individual)
      if (n.targets?.length) {
        const all = new Set(n.targets)
        for (const t of n.targets) all.add(await this.resolveJid(t))
        n.targets = [...all]
      }
      // num grupo o pushName é de quem mandou (vai na mensagem), nunca o nome do grupo
      const pushName = n.fromMe || n.isGroup ? null : raw.pushName?.trim() || null
      ready.push({ n, lid, pushName })
    }
    if (ready.length === 0) return { inserted: 0, byJid: new Map() }
    // janela dos áudios automáticos pelo horário das mensagens do WhatsApp, nunca pelo relógio do PC
    const autoSince = recentSince(this.waNow(batchMax))
    // 2) grava o lote inteiro numa transação (síncrono)
    const fresh: NormalizedMessage[] = []
    repo.transaction(() => {
      for (const { n, lid, pushName } of ready) {
        // eco de uma resposta enviada pelo app (id gerado aqui): fica na conversa de onde ela saiu, mesmo enviada ao @lid
        if (n.fromMe) {
          const sent = repo.sends.byMsgId(n.id)
          if (sent) n.jid = sent.jid
        }
        repo.upsertContact({ jid: n.jid, pushName, nameRank: NAME_RANK.push, isGroup: n.isGroup === true })
        // nome melhor já conhecido (agenda, perfil, chat), inclusive o que chegou para o @lid
        const known = this.knownNames.get(n.jid) ?? (lid !== n.jid ? this.knownNames.get(lid) : undefined)
        if (known) {
          if (lid !== n.jid && this.knownNames.get(lid) === known) {
            this.knownNames.delete(lid)
            this.knownNames.set(n.jid, known)
          }
          repo.setContactName(n.jid, known.name, known.rank)
        }
        if (n.isGroup) this.checkGroup(n.jid, n.ts)
        if (repo.insertMessage(n)) fresh.push(n)
      }
    })
    // 3) avisos e áudios, depois de gravar o lote inteiro (o histórico chega fora de ordem)
    const byJid = new Map<string, number>()
    const audios: NormalizedMessage[] = []
    for (const n of fresh) {
      byJid.set(n.jid, (byJid.get(n.jid) ?? 0) + 1)
      this.emit('message', n)
      if (n.kind === 'audio' && n.ts >= autoSince) audios.push(n)
    }
    // contatos escondidos não têm os áudios baixados (voltam para a fila se forem mostrados de novo)
    for (const a of audios) {
      if (repo.isHidden(a.jid)) continue
      queue.enqueue('download_audio', a.id, { id: a.id, ts: a.ts }, this.priorityFor(a))
    }
    return { inserted: fresh.length, byJid }
  }

  /**
   * Mensagem com menos de 3 dias (horário do WhatsApp) e:
   * - individual: o contato aguarda resposta → 10;
   * - grupo: me menciona ou cita uma mensagem minha → 10 (o resto do grupo fica com 0).
   * Senão 0.
   */
  private priorityFor(m: { jid: string; ts: number; mentionsMe?: boolean }): number {
    if (m.ts < this.waNow() - URGENT_WINDOW_MS) return 0
    if (this.deps.repo.isGroup(m.jid)) return m.mentionsMe ? URGENT_PRIORITY : 0
    const lastMsg = this.deps.repo.listMessages(m.jid, 1)[0]
    return lastMsg && !lastMsg.fromMe ? URGENT_PRIORITY : 0
  }

  // --- handlers da fila ---

  /**
   * Baixa o áudio e põe a transcrição na fila. v0.9.0: `manual` = o mentor clicou em "Transcrever" num áudio antigo
   * (mais de 30 dias): a transcrição vai na frente, no ritmo e no limite de gasto de sempre.
   */
  private async downloadAudio(payload: { id: string; ts?: number; manual?: boolean }, signal?: AbortSignal): Promise<void> {
    const { repo, queue, mediaDir } = this.deps
    if (!(await this.hasFreeSpace(mediaDir, ONE_GB))) {
      // pausa só os downloads e devolve o job sem gastar tentativa; voltam na próxima medição com espaço
      this.setDiskLow(true)
      throw new DeferJobError('espaço em disco abaixo de 1 GB')
    }
    const row = repo.getMessage(payload.id)
    if (!row || row.transcriptStatus === 'unavailable') return
    // contato escondido depois de enfileirar: não baixa (volta para a fila se ele for mostrado de novo)
    if (repo.isHidden(row.jid)) return

    if (!row.audioPath || !existsSync(row.audioPath)) {
      let msg: WAMessage
      try {
        msg = JSON.parse(row.mediaKeyJson ?? '', BufferJSON.reviver)
      } catch {
        repo.setTranscript(row.id, null, 'unavailable')
        return
      }
      let buf: Buffer
      try {
        // sem ctx/reuploadRequest: nunca pedir ao celular do remetente para reenviar a mídia
        buf = await this.download(msg, 'buffer', signal ? { options: { signal } } : {})
      } catch (e) {
        const code = statusOf(e)
        if (code === 404 || code === 410) {
          repo.setTranscript(row.id, null, 'unavailable')
          return
        }
        throw e
      }
      // o job estourou o prazo enquanto baixava: outra tentativa cuida disso (não grava nada)
      signal?.throwIfAborted()
      await mkdir(mediaDir, { recursive: true })
      const file = join(mediaDir, `${audioFileId(row.id)}.ogg`)
      await writeFile(`${file}.tmp`, buf)
      await rename(`${file}.tmp`, file)
      repo.setAudioPath(row.id, file)
    }
    signal?.throwIfAborted()
    queue.enqueue(
      'transcribe',
      `transcribe:${row.id}`,
      { id: row.id, durationSec: row.durationSec, ts: row.ts },
      payload.manual === true ? URGENT_PRIORITY : this.priorityFor(row)
    )
  }

  /**
   * `{ kind: 'group_subjects' }`: os nomes dos grupos, numa única consulta só de leitura
   * (`groupFetchAllParticipating`, uma IQ). Sem conexão aberta, adia sem gastar tentativa.
   *
   * `{ jid }` (antigo): o Baileys v7 não tem consulta de nome de contato que seja só leitura e confiável
   * (`onWhatsApp` não traz nome; `getBusinessProfile` só serve a contas comerciais).
   * Os nomes vêm do `pushName` e do histórico na ingestão; aqui só registramos e concluímos.
   */
  private async fetchProfile(payload: { jid?: string; kind?: string }): Promise<void> {
    if (payload?.kind === 'group_subjects') return this.fetchGroupSubjects()
    if (payload?.kind === 'group_meta' && typeof payload.jid === 'string') return this.fetchGroupMeta(payload.jid)
    this.deps.repo.logEvent('fetch_profile_skipped', String(payload?.jid))
  }

  private async fetchGroupSubjects(): Promise<void> {
    const sock = this.sock
    if (!sock || this.status !== 'open' || !sock.groupFetchAllParticipating) {
      throw new DeferJobError('sem conexão aberta para buscar os nomes dos grupos', GROUPS_DEFER_MS)
    }
    const all = await sock.groupFetchAllParticipating()
    // mesmo se o socket caiu enquanto buscava, a resposta (só leitura) vale
    const entries = Object.entries(all ?? {})
    // v0.8.1: resposta vazia com grupos aqui não conta como feita (tenta de novo, no ritmo da fila)
    if (entries.length === 0 && this.deps.repo.groupCount() > 0) throw new Error('consulta dos grupos sem nenhum grupo')
    const groups = entries.map(([id, g]) => ({ id: g?.id ?? id, subject: g?.subject ?? null }))
    const members = await this.applyGroupMembers(entries.map(([id, g]) => ({ id: g?.id ?? id, participants: g?.participants })))
    // só as contagens: nunca os nomes dos grupos nem os participantes
    this.diag('wa_groups', `nomes de grupos: ${groups.length} grupos${members.count ? `, ${members.count} participantes` : ''}`)
    this.deps.repo.setSetting(GROUPS_FETCHED_SETTING, String(this.deps.clock.now()))
    if (members.changed) this.emit('membership')
    if (this.applyGroupNames(groups) || members.changed) this.emit('contacts')
  }

  /** v0.8.1: `{ kind: 'group_meta', jid }`: um grupo só (uma IQ de leitura), para um grupo novo de que nada se sabe. */
  private async fetchGroupMeta(groupJid: string): Promise<void> {
    const sock = this.sock
    if (!sock || this.status !== 'open' || !sock.groupMetadata) {
      throw new DeferJobError('sem conexão aberta para consultar o grupo', GROUPS_DEFER_MS)
    }
    // conferido de novo na hora: acima do limite (ou já tentada hoje), espera a consulta de todos do dia
    if (!this.groupMetaAllowed(groupJid)) {
      this.diag('wa_groups', 'consulta de um grupo: limite atingido, fica para a consulta de todos')
      return
    }
    this.recordGroupMeta(groupJid)
    let g: Awaited<ReturnType<NonNullable<WaSocket['groupMetadata']>>>
    try {
      g = await sock.groupMetadata(groupJid)
    } catch (e) {
      // nunca tenta de novo no mesmo dia (o job conclui; a consulta de todos do dia cobre o grupo)
      this.diag('wa_groups', `consulta de um grupo falhou: ${e instanceof Error ? e.name : 'erro'}`)
      return
    }
    if (!g) return
    const named = this.applyGroupNames([{ id: groupJid, subject: g.subject ?? null }])
    const members = await this.applyGroupMembers([{ id: groupJid, participants: g.participants }])
    this.diag('wa_groups', `consulta de um grupo: ${members.count} participantes`)
    if (members.changed) this.emit('membership')
    if (named || members.changed) this.emit('contacts')
  }

  // --- v0.8.3: histórico dos grupos pedido ao celular ---

  /** O WhatsApp desta versão aceita o pedido de histórico ao celular (com a conexão aberta). */
  canFetchHistory(): boolean {
    return typeof this.sock?.fetchMessageHistory === 'function'
  }

  /**
   * "Buscar no celular o histórico dos grupos": grava a busca para estes grupos (todos com mensagem guardada aqui) e põe
   * o job na fila. Uma busca em andamento continua (não recomeça). `noAnchor`: grupos sem mensagem nenhuma (só contados).
   */
  startGroupHistory(jids: string[], noAnchor: number): GroupHistoryFetchView | null {
    const { repo, clock, queue } = this.deps
    const now = clock.now()
    const cur = loadRun(repo)
    if (cur?.state === 'running') {
      cur.noAnchor = noAnchor
      saveRun(repo, cur)
    } else {
      const run = newRun(now, historyTarget(repo, now), jids, noAnchor)
      saveRun(repo, run)
      // só contagens: nunca os grupos
      this.diag('wa_history', `busca no celular: ${run.order.length} grupo(s); ${noAnchor} sem mensagem aqui`)
    }
    if (loadRun(repo)?.state === 'running') queue.requeue('fetch_history', HISTORY_JOB_KEY, { kind: 'group_history' }, HISTORY_JOB_PRIORITY, { revive: true })
    return runView(repo, now)
  }

  /** A busca pode dar um passo agora? (sem gastar vaga do limitador nem tentativa enquanto não pode) */
  private historyReady(): boolean {
    if (this.status !== 'open' || this.openedAt === null || !this.canFetchHistory()) return false
    const { repo, clock } = this.deps
    const now = clock.now()
    if (now - this.openedAt < GROUP_HISTORY_LIMITS.stableMs) return false
    const run = loadRun(repo)
    if (!run || run.state !== 'running') return true
    if (run.pending && now - run.pending.at < GROUP_HISTORY_LIMITS.responseWaitMs) return false
    return nextRequestAt(repo, now) <= now
  }

  /**
   * Um passo da busca: o pedido anterior sem resposta conta como perdido; depois, no máximo UM pedido de 50 mensagens
   * antes da mais antiga conhecida do próximo grupo. Só leitura: o celular responde com mensagens que já existem.
   */
  private async fetchHistoryStep(): Promise<void> {
    const { repo, clock } = this.deps
    const sock = this.sock
    if (!sock?.fetchMessageHistory || this.status !== 'open') throw new DeferJobError('sem conexão aberta para pedir o histórico', GROUPS_DEFER_MS)
    const run = loadRun(repo)
    if (!run || run.state !== 'running') return
    const now = clock.now()
    const L = GROUP_HISTORY_LIMITS
    if (run.pending) {
      const waited = now - run.pending.at
      if (waited < L.responseWaitMs) throw new DeferJobError('esperando a resposta do celular', L.responseWaitMs - waited)
      const g = run.groups[run.pending.jid]
      const triedMs = savedTsUnit(repo) === null && (run.pending.unit ?? 'ms') === 'ms'
      run.pending = null
      if (triedMs && g) {
        // unidade ainda não conhecida: o mesmo ponto vai de novo em segundos (só depois das duas conta como perdido)
        g.nextUnit = 's'
        this.diag('wa_history', 'sem resposta em milissegundos: o próximo pedido vai em segundos')
      } else {
        if (g) {
          delete g.nextUnit
          g.misses++
          if (g.misses >= L.maxGroupMisses) g.s = 'gave_up'
        }
        run.misses++
        this.diag('wa_history', `o celular não respondeu (${run.misses} seguida(s))`)
      }
      if (run.misses >= L.maxMisses) {
        run.state = 'waiting_phone'
        saveRun(repo, run)
        repo.logEvent('wa_history', 'busca do histórico parada: o celular não respondeu')
        return
      }
    }
    const wait = nextRequestAt(repo, now) - now
    if (wait > 0) {
      saveRun(repo, run)
      throw new DeferJobError('ritmo dos pedidos de histórico', wait)
    }
    for (const jid of run.order) {
      const g = run.groups[jid]
      if (!g || g.s !== 'pending') continue
      const anchor: HistoryAnchor | null = g.anchor ?? oldestAnchor(repo, jid)
      if (!anchor || reachedTarget(anchor.ts, run.target)) {
        g.s = 'done'
        continue
      }
      g.anchor = anchor
      const unit = savedTsUnit(repo) ?? g.nextUnit ?? 'ms'
      run.pending = { jid, anchorId: anchor.id, at: now, unit }
      run.requests++
      // gravado antes de sair: um pedido que trava ainda conta no ritmo e no limite do dia
      recordRequest(repo, now)
      saveRun(repo, run)
      this.diag('wa_history', `pedido ${run.requests}: ${L.batch} mensagens anteriores de um grupo`)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const key = { remoteJid: jid, id: anchor.id, fromMe: anchor.fromMe, ...(anchor.participant ? { participant: anchor.participant } : {}) }
        // horário na unidade gravada (ou a que está sendo testada: milissegundos primeiro, depois segundos)
        await Promise.race([
          sock.fetchMessageHistory(L.batch, key, tsForUnit(anchor.ts, unit)),
          new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error('sem retorno')), HISTORY_SEND_TIMEOUT_MS)
          })
        ])
      } catch (e) {
        // quieto: sem resposta em 60 s o pedido conta como perdido
        this.diag('wa_history', `pedido não confirmado: ${e instanceof Error ? e.name : 'erro'}`)
      } finally {
        clearTimeout(timer)
      }
      // o próximo passo espera a resposta (ou o prazo dela) e o ritmo
      throw new DeferJobError('próximo pedido de histórico', L.gapMs)
    }
    run.state = 'done'
    run.finishedAt = now
    saveRun(repo, run)
    repo.logEvent('wa_history', `busca do histórico concluída: ${run.requests} pedido(s), ${run.received} mensagem(ns) nova(s)`)
  }

  /** A resposta do celular (ON_DEMAND) para o pedido que espera: anota o progresso do grupo e libera o próximo pedido. */
  private onDemandHistory(messages: WAMessage[], insertedByJid: Map<string, number>): void {
    const { repo, queue } = this.deps
    const run = loadRun(repo)
    if (!run || run.state !== 'running' || !run.pending) return
    const jid = run.pending.jid
    const unit = run.pending.unit
    // v0.9.0: conversa individual pode voltar pelo @lid (ou pelo telefone): vale a mesma conversa guardada aqui
    const sameChat = (r: unknown) => typeof r === 'string' && (r === jid || this.lidToPn.get(stripDevice(r)) === jid)
    const mine = messages.filter((m) => sameChat(m?.key?.remoteJid) && typeof m.key.id === 'string')
    // resposta de outra conversa: o pedido deste grupo continua esperando
    if (mine.length === 0 && messages.length > 0) return
    run.pending = null
    run.misses = 0
    const g = run.groups[jid]
    if (g) {
      g.misses = 0
      delete g.nextUnit
      // a primeira unidade que trouxe resposta fica gravada
      if (unit && savedTsUnit(repo) === null) {
        repo.setSetting(HISTORY_TS_UNIT, unit)
        this.diag('wa_history', `unidade do horário do pedido: ${unit === 'ms' ? 'milissegundos' : 'segundos'}`)
      }
      run.received += insertedByJid.get(jid) ?? 0
      let oldest: HistoryAnchor | null = null
      for (const m of mine) {
        const ts = toMs(m.messageTimestamp)
        if (ts === null) continue
        if (!oldest || ts < oldest.ts) {
          const participant = typeof m.key.participant === 'string' ? m.key.participant : undefined
          oldest = { id: m.key.id as string, fromMe: m.key.fromMe === true, ts, ...(participant ? { participant } : {}) }
        }
      }
      // nada antes da mais antiga: o celular não tem mais (fica anotado: a próxima busca não pede de novo)
      if (!oldest || (g.anchor && oldest.ts >= g.anchor.ts) || reachedTarget(oldest.ts, run.target)) {
        g.s = 'done'
        if (g.anchor) markExhausted(repo, jid, g.anchor.id)
      } else g.anchor = oldest
    }
    saveRun(repo, run)
    this.diag('wa_history', `resposta do celular: ${mine.length} mensagem(ns), ${insertedByJid.get(jid) ?? 0} nova(s)`)
    queue.poke()
  }

  private groupMetaLog(): { at: number[]; groups: Record<string, number> } {
    try {
      const v = JSON.parse(this.deps.repo.getSetting(GROUP_META_LOG_SETTING) ?? 'null') as { at?: unknown; groups?: unknown } | null
      const at = Array.isArray(v?.at) ? v.at.filter((x): x is number => typeof x === 'number') : []
      const groups = v?.groups && typeof v.groups === 'object' ? (v.groups as Record<string, number>) : {}
      return { at, groups }
    } catch {
      return { at: [], groups: {} }
    }
  }

  /** Cabe mais uma consulta deste grupo agora? (10/h, 40/dia local, uma por grupo por dia) */
  private groupMetaAllowed(groupJid: string): boolean {
    const now = this.deps.clock.now()
    const day = localDayStart(now)
    const log = this.groupMetaLog()
    if (log.groups[groupJid] === day) return false
    if (log.at.filter((t) => t >= day).length >= GROUP_META_LIMITS.perDay) return false
    return log.at.filter((t) => t > now - 60 * 60_000).length < GROUP_META_LIMITS.perHour
  }

  private recordGroupMeta(groupJid: string): void {
    const now = this.deps.clock.now()
    const day = localDayStart(now)
    const log = this.groupMetaLog()
    const keep = Math.min(day, now - 60 * 60_000)
    const groups = Object.fromEntries(Object.entries(log.groups).filter(([, d]) => d === day))
    groups[groupJid] = day
    this.deps.repo.setSetting(GROUP_META_LOG_SETTING, JSON.stringify({ at: [...log.at.filter((t) => t >= keep), now], groups }))
  }

  /**
   * Guarda quem participa de cada grupo (todas as formas do JID: telefone e @lid), para "Respondido no grupo": o mentor
   * respondeu ao mentorado no grupo dele. Aprende o par @lid → telefone quando o participante traz os dois.
   */
  private async applyGroupMembers(groups: Array<{ id: string; participants?: ParticipantLike[] | null }>): Promise<{ count: number; changed: boolean }> {
    let count = 0
    let changed = false
    for (const g of groups) {
      if (!isGroupJid(g.id) || !Array.isArray(g.participants)) continue
      const jids = new Set<string>()
      for (const p of g.participants) {
        const forms = participantJids(p, (lid) => this.lidToPn.get(lid) ?? null)
        const pn = forms.find((j) => !j.endsWith('@lid'))
        for (const f of forms) {
          jids.add(f)
          if (!f.endsWith('@lid')) continue
          if (pn && !this.lidToPn.has(f)) this.learnLid(f, pn)
          jids.add(await this.resolveJid(f))
        }
      }
      count += g.participants.length
      if (this.deps.repo.setGroupMembers(g.id, jids, g.participants.length)) changed = true
    }
    return { count, changed }
  }

  // --- envio direto (o ÚNICO caminho que escreve no WhatsApp) ---

  private sendOptions(): SendOptions {
    try {
      return this.deps.sendOptions?.() ?? DEFAULT_SEND_OPTIONS
    } catch {
      return DEFAULT_SEND_OPTIONS
    }
  }

  private emitSend(jid: string): void {
    this.emit('send', jid)
  }

  /** O socket caiu (ou foi refeito) com o pedido de envio em andamento: o estado fica desconhecido até conferir. */
  private sendInterrupted(reason: string): void {
    for (const [id, attempt] of this.inFlight) {
      try {
        const s = this.deps.repo.sends.get(id)
        if (s && this.deps.repo.sends.transition(id, attempt, ['sending'], 'unknown', { error: reason })) {
          this.diag('send_unknown', `send #${id} chat=${chatHash(s.jid)} ${reason}`)
          verifyUnknownSend(this.deps.repo, { ...s, status: 'unknown' })
          this.emitSend(s.jid)
        }
      } catch {
        // banco fechado: a recuperação ao abrir cuida disso
      }
    }
    // a conexão mudou: o pedido daquele socket morreu com ele; o bloqueio de reenvio acaba aqui
    if (this.inFlight.size) {
      this.inFlight.clear()
      this.deps.queue.poke()
    }
  }

  /**
   * A conexão caiu, foi refeita ou o app está parando: o que ainda não saiu (na fila ou no "digitando…") volta a
   * "aguardando confirmação" e os jobs pendentes são concluídos sem rodar. Nunca sai depois de reconectar.
   */
  private expireUnsent(): void {
    try {
      const { repo } = this.deps
      const rows = repo.sends.listByStatus('queued', 'typing')
      if (!rows.length) return
      for (const s of rows) {
        if (repo.sends.transition(s.id, s.attempt, ['queued', 'typing'], 'expired', { error: CONN_LOST_REASON })) {
          this.diag('send_expired', `send #${s.id} chat=${chatHash(s.jid)} ${CONN_LOST_REASON}`)
          this.emitSend(s.jid)
        }
      }
      repo.finishPendingJobs('send_message')
    } catch {
      // banco fechado: a recuperação ao abrir cuida disso
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }

  /**
   * Job `send_message` (`{ sendId, attempt, gen }`): um envio que o mentor confirmou nesta conexão. Confere de novo as
   * regras (mesma tentativa, mesma conexão, ainda na fila há menos de 10 min, envio direto ligado, o contato falou nos
   * últimos 30 dias, conexão aberta) e então: "digitando…" proporcional ao texto → "parou" → envia para o destino
   * confirmado (nos grupos citando a mensagem confirmada, com um id de mensagem gerado aqui) → marca como lidas as
   * mensagens do contato SÓ dessa conversa → volta a indisponível. Nunca tenta de novo sozinho: uma falha antes do envio
   * fica `failed`/`expired`; uma queda durante o envio fica `unknown` (e é conferida pelo id). A mensagem avulsa
   * (v0.6.0) passa exatamente por aqui, com as mesmas regras; só não cita e não grava `sent_text` (não tem resposta
   * aprovada). "Marcar como lida" vale igual: mandar mensagem numa conversa, no celular, também a deixa lida.
   */
  private async executeSend(payload: { sendId?: unknown; attempt?: unknown; gen?: unknown }, signal?: AbortSignal): Promise<void> {
    const { repo, clock, queue } = this.deps
    const id = Number(payload?.sendId)
    const s = Number.isSafeInteger(id) ? repo.sends.get(id) : null
    if (!s || s.status !== 'queued' || s.attempt !== payload?.attempt) return
    // outro envio ainda está no ar (mesmo depois do prazo do job): espera, sem gastar tentativa nem sobrepor
    if (this.inFlight.size) throw new DeferJobError('outro envio ainda em andamento', SEND_DEFER_MS)
    const tag = `send #${s.id} chat=${chatHash(s.jid)}`
    const opts = this.sendOptions()
    const expire = (from: Array<'queued' | 'typing'>, why: string) => {
      if (repo.sends.transition(s.id, s.attempt, from, 'expired', { error: why })) {
        this.diag('send_expired', `${tag} ${why}`)
        this.emitSend(s.jid)
      }
    }
    const fail = (from: Array<'queued' | 'typing'>, why: string) => {
      if (repo.sends.transition(s.id, s.attempt, from, 'failed', { error: why })) {
        this.diag('send_failed', `${tag} ${why}`)
        this.emitSend(s.jid)
      }
    }
    // confirmado numa conexão que não existe mais: nunca sai depois de reconectar
    if (payload?.gen !== this.gen) return expire(['queued'], CONN_LOST_REASON)
    if (!opts.enabled) return expire(['queued'], 'envio direto desligado')
    const guarded = (from: Array<'queued' | 'typing'>) => {
      let why: string | null
      try {
        why = this.deps.sendGuard?.(s) ?? null
      } catch {
        why = 'conferência do envio falhou'
      }
      if (why) expire(from, why)
      return why !== null
    }
    if (guarded(['queued'])) return
    if (clock.now() - s.queuedAt > SEND_LIMITS.queuedMaxMs) return expire(['queued'], 'mais de 10 min na fila')
    // fora do horário de envio (sem "Forçar envio"): expira, nunca espera para sair depois
    const outsideHours = (from: Array<'queued' | 'typing'>) => {
      if (s.forced || isWithinSendHours(this.sendOptions().schedule, clock.now())) return false
      this.diag('send_outside_hours', `${tag} ${from[0] === 'typing' ? 'antes de enviar' : 'antes do "digitando"'}`)
      expire(from, OUTSIDE_HOURS_REASON)
      return true
    }
    if (outsideHours(['queued'])) return
    const sock = this.sock
    const gen = this.gen
    if (!sock || this.status !== 'open' || !sock.sendMessage) return expire(['queued'], CONN_LOST_REASON)
    if (signal?.aborted) return fail(['queued'], 'tempo esgotado antes de enviar')
    const messages = repo.listMessages(s.jid, 300)
    // responder, nunca iniciar conversa
    let exempt = false
    try {
      exempt = this.deps.recentContactExempt?.(s) === true
    } catch {
      exempt = false
    }
    if (!exempt && !hasRecentContactMessage(messages, clock.now())) return fail(['queued'], 'sem mensagem do contato nos últimos 30 dias')
    // a citação é a que o mentor viu na confirmação; se ela sumiu, vai sem citação
    // (a mensagem avulsa nunca cita, nem em grupo)
    const quoteRow = s.quotedId && s.kind !== 'avulsa' ? repo.getMessage(s.quotedId) : null
    const quote = quoteRow && quoteRow.jid === s.jid && !quoteRow.fromMe ? quoteRow : null
    const keys = opts.markRead ? unreadKeys(messages) : []
    if (!repo.sends.transition(s.id, s.attempt, ['queued'], 'typing', { startedAt: clock.now() })) return
    this.diag('send_typing', tag)
    this.emitSend(s.jid)
    let presence = false
    try {
      if (opts.typing && sock.sendPresenceUpdate) {
        try {
          presence = true
          await sock.sendPresenceUpdate('composing', s.address)
          await this.wait(typingMs(s.text, this.rng()))
          await sock.sendPresenceUpdate('paused', s.address)
        } catch (e) {
          return fail(['typing'], `"digitando" falhou (${errCode(e)})`)
        }
      }
      if (gen !== this.gen || this.status !== 'open') return expire(['typing'], CONN_LOST_REASON)
      if (signal?.aborted) return fail(['typing'], 'tempo esgotado antes de enviar')
      if (queue.isPaused()) return expire(['typing'], PAUSED_REASON)
      if (outsideHours(['typing'])) return
      if (guarded(['typing'])) return
      // nova tentativa: uma anterior pode ter chegado (o eco veio depois); nesse caso não envia de novo
      if (s.attempt > 1) {
        const echo = findSentEcho(s.msgIds, (mid) => repo.getMessage(mid))
        if (echo) {
          if (repo.sends.transition(s.id, s.attempt, ['typing'], 'sent', { sentAt: echo.ts, waMsgId: echo.id, error: null })) {
            if (s.replyId !== null) repo.setApprovedSentText(s.replyId, echo.text ?? s.text)
            this.diag('send_sent', `${tag} a tentativa anterior já tinha chegado`)
            this.emitSend(s.jid)
          }
          return
        }
      }
      const msgId = newMessageId()
      if (!repo.sends.transition(s.id, s.attempt, ['typing'], 'sending', { newMsgId: msgId })) return
      this.inFlight.set(s.id, s.attempt)
      // sem resposta em 10 min (e a conexão de pé): desconhecido, mas o reenvio continua bloqueado até o pedido terminar
      const stall = setTimeout(() => {
        if (this.inFlight.get(s.id) !== s.attempt) return
        try {
          if (repo.sends.transition(s.id, s.attempt, ['sending'], 'unknown', { error: 'o WhatsApp não respondeu em 10 min' })) {
            this.diag('send_unknown', `${tag} sem resposta em 10 min`)
            this.emitSend(s.jid)
          }
        } catch {
          // banco fechado
        }
      }, SEND_STALL_MS)
      ;(stall as { unref?: () => void }).unref?.()
      let res: Awaited<ReturnType<NonNullable<WaSocket['sendMessage']>>>
      try {
        res = await sock.sendMessage(s.address, { text: s.text }, quote ? { quoted: quotedMessage(quote), messageId: msgId } : { messageId: msgId })
      } catch (e) {
        // o pedido pode ter saído: nunca reenviar no escuro
        if (repo.sends.transition(s.id, s.attempt, ['sending'], 'unknown', { error: `envio sem confirmação (${errCode(e)})` })) {
          this.diag('send_unknown', `${tag} o WhatsApp não confirmou o envio (${errCode(e)})`)
          verifyUnknownSend(repo, { ...repo.sends.get(s.id)! })
          this.emitSend(s.jid)
        }
        return
      } finally {
        clearTimeout(stall)
        if (this.inFlight.get(s.id) === s.attempt) {
          this.inFlight.delete(s.id)
          this.deps.queue.poke()
        }
      }
      presence = true
      if (repo.sends.transition(s.id, s.attempt, ['sending', 'unknown'], 'sent', { sentAt: clock.now(), waMsgId: res?.key?.id ?? msgId, error: null })) {
        // a mensagem avulsa não tem resposta aprovada: nunca ensina a memória
        if (s.replyId !== null) repo.setApprovedSentText(s.replyId, s.text)
        this.diag('send_sent', `${tag}${quote ? ' com citação' : ''}${s.kind === 'avulsa' ? ' avulsa' : ''}`)
        this.emitSend(s.jid)
      }
      if (keys.length && sock.readMessages && gen === this.gen) {
        try {
          await sock.readMessages(keys)
        } catch {
          // marcar como lida é um extra: a mensagem já saiu
        }
      }
    } finally {
      if (presence && sock.sendPresenceUpdate && gen === this.gen) {
        try {
          await sock.sendPresenceUpdate('unavailable')
        } catch {
          // a conexão pode ter caído: ao reconectar o app já se apresenta indisponível
        }
      }
    }
  }
}
