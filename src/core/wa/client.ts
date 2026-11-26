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
import { ONE_GB, hasFreeSpace } from '../disk'
import { audioFileId } from '../media'
import type { RateLimiter } from '../queue/limiter'
import { DeferJobError, type JobQueue } from '../queue/queue'
import type { NormalizedMessage } from '../types'
import { useAtomicAuthState, type AtomicAuthState } from './authState'
import { isGroupJid, normalize, participantJids, stripDevice, toPhoneJid, type ParticipantLike } from './normalize'
import { ReconnectPolicy, classifyDisconnect } from './reconnect'
import { WaVersionResolver, formatWaVersion, type WaVersionFetcher } from './version'
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
  signalRepository?: { lidMapping?: { getPNForLID(lid: string): Promise<string | null> } }
  /** só leitura (uma consulta IQ): os grupos de que o mentor participa, com o assunto e os participantes. Sempre pela fila. */
  groupFetchAllParticipating?(): Promise<Record<string, { id?: string; subject?: string | null; participants?: ParticipantLike[] | null }>>
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
}

/** outro envio ainda em andamento: este espera 15 s, sem gastar tentativa (o envio expira se passar de 10 min na fila) */
const SEND_DEFER_MS = 15_000
/** pedido de envio sem resposta por 10 min: fica desconhecido (mas o reenvio continua bloqueado até ele terminar) */
const SEND_STALL_MS = 10 * 60_000

const DAY = 86_400_000
const HISTORY_WINDOW_MS = 30 * DAY
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
const GROUPS_FETCHED_SETTING = 'wa.groupMembersFetchedAt'
/** no máximo uma busca dos nomes dos grupos por dia */
const GROUPS_FETCH_EVERY_MS = DAY
/** chave fixa do job (um só pendente por vez; volta para a fila depois de concluído) */
const GROUPS_JOB_KEY = 'wa:group_subjects'
/** sem conexão aberta quando o job roda: tenta de novo daqui a 1 min, sem gastar tentativa */
const GROUPS_DEFER_MS = 60_000
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
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Cliente do WhatsApp do mentor como aparelho conectado. Lê; só escreve por um caminho: `executeSend`, o handler do job
 * `send_message` (uma resposta confirmada pelo mentor), que mostra "digitando…", envia, marca como lidas as mensagens
 * daquela conversa e volta a indisponível. Fora dele nunca envia mensagens, recibos de leitura nem presença; nunca pede
 * reenvio de mídia.
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
  private pausedByConnection = false
  /** menos de 1 GB livre: downloads pausados até a próxima medição com espaço */
  private diskLow = false
  private diskTimer: ReturnType<typeof setTimeout> | null = null
  /** LID (sem dispositivo) → JID de telefone */
  private lidToPn = new Map<string, string>()
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
    deps.queue.register('download_audio', (p, signal) => this.downloadAudio(p, signal))
    deps.queue.register('fetch_profile', (p) => this.fetchProfile(p))
    // um envio ainda em andamento (mesmo depois do prazo do job) segura o próximo: nunca dois ao mesmo tempo
    deps.queue.register('send_message', (p, signal) => this.executeSend(p, signal), { ready: () => this.inFlight.size === 0 })
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
      async (h: { messages: WAMessage[]; contacts?: Contact[]; chats?: ChatLike[]; lidPnMappings?: LIDMapping[] }) => {
        this.addLidMappings(h.lidPnMappings ?? [])
        await this.learnContacts('history', h.contacts ?? [])
        await this.learnChats('history', h.chats ?? [])
        return this.ingest(h.messages ?? [])
      }
    )
    on('messages.upsert', (u: { messages: WAMessage[] }) => this.ingest(u.messages ?? []))
    on('contacts.upsert', (cs: Contact[]) => this.learnContacts('contacts.upsert', cs ?? []))
    on('contacts.update', (cs: Partial<Contact>[]) => this.learnContacts('contacts.update', cs ?? []))
    on('chats.upsert', (cs: ChatLike[]) => this.learnChats('chats.upsert', cs ?? []))
    on('chats.update', (cs: ChatLike[]) => this.learnChats('chats.update', cs ?? []))
    on('groups.upsert', (gs: GroupLike[]) => this.learnGroups(gs ?? []))
    on('groups.update', (gs: GroupLike[]) => this.learnGroups(gs ?? []))
  }

  private async onConnectionUpdate(u: {
    connection?: 'open' | 'connecting' | 'close'
    qr?: string
    lastDisconnect?: { error?: unknown }
  }): Promise<void> {
    if (u.connection) this.diag('wa_connection_update', u.connection)
    if (u.qr) {
      this.socketProgressed = true
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
    this.scheduleGroupSubjects()
  }

  /**
   * Uma vez por abertura, no máximo uma vez a cada 24 h: pede os nomes (assuntos) dos grupos PELA FILA,
   * como um job `fetch_profile` (respeita o ritmo do limitador). Nunca chama na hora.
   */
  private scheduleGroupSubjects(): void {
    const last = Number(this.deps.repo.getSetting(GROUPS_FETCHED_SETTING) ?? 0)
    if (Number.isFinite(last) && last > 0 && this.deps.clock.now() - last < GROUPS_FETCH_EVERY_MS) return
    this.deps.queue.requeue('fetch_profile', GROUPS_JOB_KEY, { kind: 'group_subjects' })
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
      this.lidToPn.set(lid, pn)
      // nome que chegou para o @lid antes do telefone: vai para o contato do telefone
      const pending = this.knownNames.get(lid)
      if (pending) {
        this.knownNames.delete(lid)
        if (this.rememberName(pn, pending.name, pending.rank)) this.emit('contacts')
      }
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
      if (this.rememberName(g.id, subject, NAME_RANK.profile)) applied = true
    }
    return applied
  }

  private learnGroups(groups: GroupLike[]): void {
    if (this.applyGroupNames(groups)) this.emit('contacts')
  }

  /** Aplica nomes de uma lista de JIDs que são a mesma pessoa (id, telefone, @lid). */
  private async learnName(ids: Array<string | null | undefined>, name: string, rank: number): Promise<boolean> {
    const targets = new Set<string>()
    const raw = ids.filter(WhatsAppClient.isPersonJid).map((j) => stripDevice(j))
    const pn = raw.find((j) => !j.endsWith('@lid'))
    for (const lid of raw.filter((j) => j.endsWith('@lid'))) {
      if (pn && !this.lidToPn.has(lid)) this.lidToPn.set(lid, pn)
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

  /** `@lid` → telefone quando conhecido (mapa do histórico/eventos, depois o armazenamento local do Baileys). */
  private async resolveJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid
    const known = this.lidToPn.get(jid)
    if (known) return known
    try {
      // consulta só o armazenamento local de chaves (sem rede)
      const pn = toPhoneJid(await this.sock?.signalRepository?.lidMapping?.getPNForLID(jid))
      if (pn) {
        this.lidToPn.set(jid, pn)
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

  private async ingest(messages: WAMessage[]): Promise<void> {
    const { repo, queue } = this.deps
    const me = this.auth?.state.creds.me as { id?: string; lid?: string } | undefined
    const opts = { ownJid: me?.id, ownLid: me?.lid }
    const normalized = messages.map((raw) => ({ raw, n: normalize(raw, opts) }))
    const bound = this.anchorBound()
    const batchMax = normalized.reduce((m, { n }) => (n && n.ts > m && n.ts <= bound ? n.ts : m), -Infinity)
    // janela de 30 dias pelo horário das mensagens do WhatsApp, nunca pelo relógio do PC
    const cutoff = this.waNow(batchMax) - HISTORY_WINDOW_MS
    const audios: NormalizedMessage[] = []
    for (const { raw, n } of normalized) {
      if (!n || n.ts < cutoff) continue
      const lid = n.jid
      n.jid = await this.resolveJid(n.jid)
      if (n.senderJid) n.senderJid = await this.resolveJid(n.senderJid)
      // eco de uma resposta enviada pelo app (id gerado aqui): fica na conversa de onde ela saiu, mesmo enviada ao @lid
      if (n.fromMe) {
        const sent = repo.sends.byMsgId(n.id)
        if (sent) n.jid = sent.jid
      }
      // menções e citação das minhas mensagens de grupo: guarda o @lid e o telefone (casa com a conversa individual)
      if (n.targets?.length) {
        const all = new Set(n.targets)
        for (const t of n.targets) all.add(await this.resolveJid(t))
        n.targets = [...all]
      }
      // num grupo o pushName é de quem mandou (vai na mensagem), nunca o nome do grupo
      const pushName = n.fromMe || n.isGroup ? null : raw.pushName?.trim() || null
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
      if (!repo.insertMessage(n)) continue
      this.emit('message', n)
      if (n.kind === 'audio') audios.push(n)
    }
    // prioridade depois de gravar o lote inteiro (o histórico chega fora de ordem);
    // contatos escondidos não têm os áudios baixados (voltam para a fila se forem mostrados de novo)
    for (const a of audios) {
      if (repo.isHidden(a.jid)) continue
      queue.enqueue('download_audio', a.id, { id: a.id, ts: a.ts }, this.priorityFor(a))
    }
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

  private async downloadAudio(payload: { id: string; ts?: number }, signal?: AbortSignal): Promise<void> {
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
      this.priorityFor(row)
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
    const groups = entries.map(([id, g]) => ({ id: g?.id ?? id, subject: g?.subject ?? null }))
    const members = await this.applyGroupMembers(entries.map(([id, g]) => ({ id: g?.id ?? id, participants: g?.participants })))
    // só as contagens: nunca os nomes dos grupos nem os participantes
    this.diag('wa_groups', `nomes de grupos: ${groups.length} grupos${members.count ? `, ${members.count} participantes` : ''}`)
    this.deps.repo.setSetting(GROUPS_FETCHED_SETTING, String(this.deps.clock.now()))
    if (this.applyGroupNames(groups) || members.changed) this.emit('contacts')
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
          if (pn && !this.lidToPn.has(f)) this.lidToPn.set(f, pn)
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
   * fica `failed`/`expired`; uma queda durante o envio fica `unknown` (e é conferida pelo id).
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
    if (!hasRecentContactMessage(messages, clock.now())) return fail(['queued'], 'sem mensagem do contato nos últimos 30 dias')
    // a citação é a que o mentor viu na confirmação; se ela sumiu, vai sem citação
    const quoteRow = s.quotedId ? repo.getMessage(s.quotedId) : null
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
      // nova tentativa: uma anterior pode ter chegado (o eco veio depois); nesse caso não envia de novo
      if (s.attempt > 1) {
        const echo = findSentEcho(s.msgIds, (mid) => repo.getMessage(mid))
        if (echo) {
          if (repo.sends.transition(s.id, s.attempt, ['typing'], 'sent', { sentAt: echo.ts, waMsgId: echo.id, error: null })) {
            repo.setApprovedSentText(s.replyId, echo.text ?? s.text)
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
        repo.setApprovedSentText(s.replyId, s.text)
        this.diag('send_sent', `${tag}${quote ? ' com citação' : ''}`)
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
