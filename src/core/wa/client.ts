import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import QRCode from 'qrcode'
import makeWASocket, {
  Browsers,
  BufferJSON,
  downloadMediaMessage,
  type Contact,
  type LIDMapping,
  type UserFacingSocketConfig,
  type WAMessage
} from '@whiskeysockets/baileys'
import type { Clock } from '../clock'
import type { Repo } from '../db/repo'
import { ONE_GB, hasFreeSpace } from '../disk'
import type { RateLimiter } from '../queue/limiter'
import type { JobQueue } from '../queue/queue'
import type { NormalizedMessage } from '../types'
import { useAtomicAuthState, type AtomicAuthState } from './authState'
import { normalize, stripDevice, toPhoneJid } from './normalize'
import { ReconnectPolicy, classifyDisconnect } from './reconnect'

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
 * O pedaço do socket do Baileys que o cliente usa. De propósito não inclui nada que envie
 * mensagem, recibo de leitura ou presença.
 */
export interface WaSocket {
  ev: { on(event: string, listener: (arg: any) => void): unknown }
  end(error: Error | undefined): unknown
  signalRepository?: { lidMapping?: { getPNForLID(lid: string): Promise<string | null> } }
}

export type SocketFactory = (config: UserFacingSocketConfig) => WaSocket
export type DownloadFn = (msg: WAMessage, type: 'buffer', options: Record<string, never>) => Promise<Buffer>

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
}

const DAY = 86_400_000
const HISTORY_WINDOW_MS = 30 * DAY
const URGENT_WINDOW_MS = 3 * DAY
const URGENT_PRIORITY = 10
const SLEEP_WARMUP_THRESHOLD_MS = 3_600_000

const noop = () => {}
const silentLogger: any = {
  level: 'silent',
  child: () => silentLogger,
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop
}

const defaultSocketFactory: SocketFactory = (config) => makeWASocket(config) as unknown as WaSocket
const defaultDownload: DownloadFn = (msg, type, options) => downloadMediaMessage(msg, type, options)

function statusOf(e: unknown): number | undefined {
  const x = e as { output?: { statusCode?: number }; status?: number; statusCode?: number } | null
  return x?.output?.statusCode ?? x?.status ?? x?.statusCode
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Cliente do WhatsApp do mentor como aparelho conectado, SOMENTE LEITURA.
 * Nunca envia mensagens, recibos de leitura nem presença; nunca pede reenvio de mídia.
 *
 * Eventos: `'qr'(dataUrl)`, `'status'(ConnState)`, `'message'(NormalizedMessage)`.
 */
export class WhatsAppClient extends EventEmitter {
  private readonly policy: ReconnectPolicy
  private readonly socketFactory: SocketFactory
  private readonly authStateFactory: (dir: string, backupDir: string) => Promise<AtomicAuthState>
  private readonly download: DownloadFn
  private readonly hasFreeSpace: (dir: string, minBytes: number) => Promise<boolean>

  private sock: WaSocket | null = null
  private auth: AtomicAuthState | null = null
  /** cada socket tem uma geração; eventos de gerações antigas são ignorados */
  private gen = 0
  private running = false
  private status: ConnState | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private restoredOnce = false
  private pausedByConnection = false
  /** LID (sem dispositivo) → JID de telefone */
  private lidToPn = new Map<string, string>()
  private work: Promise<void> = Promise.resolve()

  constructor(private readonly deps: WhatsAppClientDeps) {
    super()
    this.policy = new ReconnectPolicy(deps.clock, deps.rng ?? Math.random)
    this.socketFactory = deps.socketFactory ?? defaultSocketFactory
    this.authStateFactory = deps.authStateFactory ?? useAtomicAuthState
    this.download = deps.download ?? defaultDownload
    this.hasFreeSpace = deps.hasFreeSpace ?? hasFreeSpace
    deps.queue.register('download_audio', (p) => this.downloadAudio(p))
    deps.queue.register('fetch_profile', (p) => this.fetchProfile(p))
  }

  getStatus(): ConnState | null {
    return this.status
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
    this.dropSocket()
    await this.whenIdle()
  }

  /** Botão "Tentar de novo": zera a política e conecta já. */
  async manualReconnect(): Promise<void> {
    this.running = true
    this.clearRetry()
    this.policy.manualRetry()
    this.dropSocket()
    this.schedule(() => this.connect())
    await this.whenIdle()
  }

  /** Chamado ao acordar de suspensão: mais de 1 h dormindo → aquecimento em todos os limitadores. */
  onResumeFromSleep(sleptMs: number): void {
    if (sleptMs > SLEEP_WARMUP_THRESHOLD_MS) for (const l of this.deps.limiters) l.startWarmup()
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

  private setStatus(s: ConnState): void {
    if (this.status === s) return
    this.status = s
    this.emit('status', s)
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private retryIn(ms: number): void {
    this.clearRetry()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.schedule(() => this.connect())
    }, ms)
  }

  /** Invalida o socket atual (os eventos dele passam a ser ignorados) e o fecha. */
  private dropSocket(): void {
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

  private async connect(): Promise<void> {
    if (!this.running) return
    this.dropSocket()
    const gen = this.gen
    this.setStatus('connecting')
    const auth = await this.authStateFactory(this.deps.authDir, this.deps.backupDir)
    if (gen !== this.gen || !this.running) return
    this.auth = auth
    const sock = this.socketFactory({
      auth: auth.state,
      browser: Browsers.windows('Desktop'),
      // presença "indisponível" ao conectar: o celular continua recebendo notificações
      // e os recibos automáticos do Baileys saem como 'inactive' (entregue, nunca "lido")
      markOnlineOnConnect: false,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      generateHighQualityLinkPreview: false,
      logger: silentLogger
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
    on('messaging-history.set', (h: { messages: WAMessage[]; contacts?: Contact[]; lidPnMappings?: LIDMapping[] }) => {
      this.addLidMappings(h.lidPnMappings ?? [])
      return this.ingest(h.messages ?? [], this.namesFrom(h.contacts ?? []))
    })
    on('messages.upsert', (u: { messages: WAMessage[] }) => this.ingest(u.messages ?? []))
  }

  private async onConnectionUpdate(u: {
    connection?: 'open' | 'connecting' | 'close'
    qr?: string
    lastDisconnect?: { error?: unknown }
  }): Promise<void> {
    if (u.qr) {
      const dataUrl = await QRCode.toDataURL(u.qr)
      this.emit('qr', dataUrl)
      this.setStatus('needs_qr')
    }
    if (u.connection === 'open') await this.onOpen()
    else if (u.connection === 'close') this.onClose(u.lastDisconnect?.error)
  }

  private async onOpen(): Promise<void> {
    this.policy.reset()
    this.restoredOnce = false
    if (this.pausedByConnection) {
      this.pausedByConnection = false
      this.deps.queue.resume()
    }
    this.setStatus('open')
    this.deps.repo.logEvent('wa_open', 'conectado')
    // grava as credenciais atuais antes de copiar: o backup sempre reflete uma sessão que abriu
    await this.auth?.saveCreds()
    await this.auth?.backup()
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

  private onClose(error: unknown): void {
    this.sock = null
    const code = statusOf(error)
    const detail = `código ${code ?? '?'}: ${error ? errMsg(error) : 'sem detalhe'}`
    switch (classifyDisconnect(code, error instanceof Error ? error.message : undefined)) {
      case 'retry': {
        const delay = this.policy.nextDelayMs()
        if (delay === null) {
          this.setStatus('manual_retry_needed')
          this.deps.repo.logEvent('wa_manual_retry_needed', detail)
        } else {
          this.setStatus('waiting_retry')
          this.retryIn(delay)
        }
        return
      }
      case 'bad_session':
        if (!this.restoredOnce && this.auth?.restoreBackup()) {
          this.restoredOnce = true
          this.deps.repo.logEvent('wa_bad_session_restored', detail)
          this.retryIn(0)
        } else {
          // sessão sem conserto: apaga e espera o usuário pedir um QR novo (manualReconnect)
          this.auth?.wipe()
          this.running = false
          this.setStatus('needs_qr')
          this.deps.repo.logEvent('wa_bad_session', detail)
        }
        return
      case 'logged_out':
        // o aparelho foi desconectado no celular: as credenciais não servem mais (nem o backup)
        this.auth?.wipe()
        this.stopWith('stopped_logged_out', detail)
        return
      case 'restricted':
        this.stopWith('stopped_restricted', detail)
        return
      case 'outdated':
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
      if (m?.lid && pn) this.lidToPn.set(stripDevice(m.lid), pn)
    }
  }

  /** Nomes vindos do histórico (nome salvo na agenda > nome do perfil), indexados pelo JID do contato. */
  private namesFrom(contacts: Contact[]): Map<string, string> {
    const names = new Map<string, string>()
    for (const c of contacts) {
      const name = c.name || c.notify || c.verifiedName
      if (!name) continue
      for (const j of [c.id, c.phoneNumber, c.lid]) if (j) names.set(stripDevice(j), name)
    }
    return names
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

  private async ingest(messages: WAMessage[], names?: Map<string, string>): Promise<void> {
    const { repo, queue, clock } = this.deps
    const cutoff = clock.now() - HISTORY_WINDOW_MS
    const audios: NormalizedMessage[] = []
    for (const raw of messages) {
      const n = normalize(raw)
      if (!n || n.ts < cutoff) continue
      const lid = n.jid
      n.jid = await this.resolveJid(n.jid)
      const pushName = n.fromMe ? null : raw.pushName?.trim() || null
      repo.upsertContact({ jid: n.jid, pushName: names?.get(n.jid) ?? names?.get(lid) ?? pushName })
      if (!repo.insertMessage(n)) continue
      this.emit('message', n)
      if (n.kind === 'audio') audios.push(n)
    }
    // prioridade depois de gravar o lote inteiro (o histórico chega fora de ordem)
    for (const a of audios) queue.enqueue('download_audio', a.id, { id: a.id }, this.priorityFor(a.jid, a.ts))
  }

  /** 10 se o contato aguarda resposta e a mensagem tem menos de 3 dias; senão 0. */
  private priorityFor(jid: string, ts: number): number {
    if (ts < this.deps.clock.now() - URGENT_WINDOW_MS) return 0
    const lastMsg = this.deps.repo.listMessages(jid, 1)[0]
    return lastMsg && !lastMsg.fromMe ? URGENT_PRIORITY : 0
  }

  // --- handlers da fila ---

  private async downloadAudio(payload: { id: string }): Promise<void> {
    const { repo, queue, mediaDir } = this.deps
    if (!(await this.hasFreeSpace(mediaDir, ONE_GB))) {
      queue.pause()
      repo.logEvent('disk_low', `menos de 1 GB livre em ${mediaDir}`)
      throw new Error('espaço em disco abaixo de 1 GB')
    }
    const row = repo.getMessage(payload.id)
    if (!row || row.transcriptStatus === 'unavailable') return

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
        buf = await this.download(msg, 'buffer', {})
      } catch (e) {
        const code = statusOf(e)
        if (code === 404 || code === 410) {
          repo.setTranscript(row.id, null, 'unavailable')
          return
        }
        throw e
      }
      await mkdir(mediaDir, { recursive: true })
      const file = join(mediaDir, `${row.id.replace(/[^A-Za-z0-9_-]/g, '_')}.ogg`)
      await writeFile(`${file}.tmp`, buf)
      await rename(`${file}.tmp`, file)
      repo.setAudioPath(row.id, file)
    }
    queue.enqueue('transcribe', `transcribe:${row.id}`, { id: row.id, durationSec: row.durationSec }, this.priorityFor(row.jid, row.ts))
  }

  /**
   * O Baileys v7 não tem consulta de nome de contato que seja só leitura e confiável
   * (`onWhatsApp` não traz nome; `getBusinessProfile` só serve a contas comerciais).
   * Os nomes vêm do `pushName` e do histórico na ingestão; aqui só registramos e concluímos.
   */
  private async fetchProfile(payload: { jid: string }): Promise<void> {
    this.deps.repo.logEvent('fetch_profile_skipped', String(payload?.jid))
  }
}
