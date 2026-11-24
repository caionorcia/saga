import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { JobQueue, type JobType } from '../../../src/core/queue/queue'
import { LIMITS, RateLimiter } from '../../../src/core/queue/limiter'
import { WhatsAppClient, type ConnState } from '../../../src/core/wa/client'
import { useAtomicAuthState } from '../../../src/core/wa/authState'

const DAY = 86_400_000
const NOW = 1_764_000_000_000
const JID = '5547999998888@s.whatsapp.net'
const JID2 = '5511988887777@s.whatsapp.net'
const OWN = '5547900000000:3@s.whatsapp.net'
const STABLE_MS = 5 * 60_000

const FORBIDDEN = ['sendMessage', 'readMessages', 'sendReceipt', 'sendReceipts', 'sendPresenceUpdate', 'chatModify', 'updateMediaMessage', 'logout'] as const

class FakeSocket {
  ev = new EventEmitter()
  end = vi.fn()
  signalRepository = { lidMapping: { getPNForLID: vi.fn(async (_lid: string) => null as string | null) } }
  spies: Record<string, ReturnType<typeof vi.fn>> = {}
  constructor(public config: any) {
    for (const name of FORBIDDEN) {
      this.spies[name] = vi.fn()
      ;(this as any)[name] = this.spies[name]
    }
  }
  emit(event: string, data: unknown): void {
    this.ev.emit(event, data)
  }
  close(statusCode: number, message = 'Connection Failure'): void {
    const error = Object.assign(new Error(message), { output: { statusCode } })
    this.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } })
  }
}

function wamsg(o: {
  id: string
  jid?: string
  fromMe?: boolean
  ts: number
  text?: string
  audio?: number
  pushName?: string
  alt?: string
}): any {
  const message = o.audio !== undefined
    ? { audioMessage: { url: 'https://mmg.whatsapp.net/x.enc', directPath: '/x.enc', mediaKey: Buffer.alloc(32, 1), seconds: o.audio, ptt: true } }
    : { conversation: o.text ?? 'oi' }
  return {
    key: { remoteJid: o.jid ?? JID, remoteJidAlt: o.alt, fromMe: o.fromMe ?? false, id: o.id },
    messageTimestamp: Math.floor(o.ts / 1000),
    pushName: o.pushName,
    message
  }
}

describe('WhatsAppClient', () => {
  let tmp: string
  let clock: FakeClock
  let repo: Repo
  let queue: JobQueue
  let limiters: Record<JobType, RateLimiter>
  let sockets: FakeSocket[]
  let client: WhatsAppClient
  let statuses: ConnState[]
  let download: ReturnType<typeof vi.fn>
  let diskFree: boolean
  let diskGate: Promise<boolean> | null
  let diskChecks: number
  let restoreSpy: ReturnType<typeof vi.fn<(r: boolean) => void>>
  let fetchVersion: ReturnType<typeof vi.fn>
  let waRevision: number
  let diagLines: Array<[string, string]>

  const last = () => sockets[sockets.length - 1]
  const advance = async (ms: number) => {
    clock.advance(ms)
    await vi.advanceTimersByTimeAsync(ms)
    await client.whenIdle()
  }
  const emit = async (event: string, data: unknown) => {
    last().emit(event, data)
    await client.whenIdle()
  }
  const close = async (code: number, msg?: string) => {
    last().close(code, msg)
    await client.whenIdle()
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    tmp = mkdtempSync(join(tmpdir(), 'saga-wa-'))
    clock = new FakeClock(NOW)
    repo = new Repo(openDb(':memory:'), clock)
    limiters = {
      download_audio: new RateLimiter(LIMITS.wa_media, clock, () => 0),
      transcribe: new RateLimiter(LIMITS.groq_audio, clock, () => 0),
      fetch_profile: new RateLimiter(LIMITS.wa_profile, clock, () => 0)
    }
    queue = new JobQueue(repo, clock, limiters)
    sockets = []
    statuses = []
    diskFree = true
    diskGate = null
    diskChecks = 0
    download = vi.fn(async () => Buffer.from('OggS-fake-audio'))
    restoreSpy = vi.fn<(r: boolean) => void>()
    waRevision = 1_100_000_001
    fetchVersion = vi.fn(async () => ({ version: [2, 3000, waRevision] as [number, number, number], isLatest: true }))
    diagLines = []
    client = new WhatsAppClient({
      fetchWaVersion: fetchVersion as any,
      diag: (k, d) => diagLines.push([k, d]),
      repo,
      queue,
      clock,
      authDir: join(tmp, 'auth'),
      backupDir: join(tmp, 'auth-backup'),
      mediaDir: join(tmp, 'media'),
      limiters: Object.values(limiters),
      rng: () => 0.5,
      socketFactory: (cfg) => {
        const s = new FakeSocket(cfg)
        sockets.push(s)
        return s as any
      },
      authStateFactory: async (dir, backupDir) => {
        const a = await useAtomicAuthState(dir, backupDir)
        a.state.creds.me = { id: OWN, name: 'Mentor' }
        const real = a.restoreBackup
        a.restoreBackup = () => {
          const r = real()
          restoreSpy(r)
          return r
        }
        return a
      },
      download: download as any,
      hasFreeSpace: async () => {
        diskChecks++
        return diskGate ?? diskFree
      }
    })
    client.on('status', (s: ConnState) => statuses.push(s))
    await client.start()
  })

  afterEach(async () => {
    await client.stop()
    for (const s of sockets) for (const name of FORBIDDEN) expect(s.spies[name]).not.toHaveBeenCalled()
    vi.useRealTimers()
    rmSync(tmp, { recursive: true, force: true })
  })

  describe('socket', () => {
    it('cria o socket com as opções de somente leitura', () => {
      expect(sockets).toHaveLength(1)
      const cfg = last().config
      expect(cfg.markOnlineOnConnect).toBe(false)
      expect(cfg.syncFullHistory).toBe(true)
      expect(cfg.generateHighQualityLinkPreview).toBe(false)
      expect(cfg.shouldSyncHistoryMessage({})).toBe(true)
      expect(cfg.browser).toEqual(['Windows', 'Chrome', expect.any(String)])
      expect(cfg.auth.creds).toBeDefined()
      expect(statuses).toEqual(['connecting'])
    })

    it('QR vira data URL e estado needs_qr', async () => {
      const qrs: string[] = []
      client.on('qr', (d: string) => qrs.push(d))
      await emit('connection.update', { qr: '2@abc,def,ghi' })
      expect(qrs).toHaveLength(1)
      expect(qrs[0]).toMatch(/^data:image\/png;base64,/)
      expect(statuses.at(-1)).toBe('needs_qr')
    })

    it('conexão aberta → open e backup das credenciais', async () => {
      await emit('connection.update', { connection: 'open' })
      expect(statuses.at(-1)).toBe('open')
      expect(existsSync(join(tmp, 'auth-backup', 'creds.json'))).toBe(true)
    })

    it('creds.update grava as credenciais', async () => {
      await emit('creds.update', {})
      expect(existsSync(join(tmp, 'auth', 'creds.json'))).toBe(true)
    })
  })

  describe('ingestão', () => {
    it('janela de 30 dias pelo timestamp da mensagem; grupos e status ignorados', async () => {
      await emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [
          wamsg({ id: 'old', ts: NOW - 31 * DAY }),
          wamsg({ id: 'new', ts: NOW - 29 * DAY }),
          wamsg({ id: 'today', ts: NOW - 1000 }),
          wamsg({ id: 'grp', jid: '120363000000000000@g.us', ts: NOW - DAY }),
          wamsg({ id: 'sts', jid: 'status@broadcast', ts: NOW - DAY })
        ]
      })
      expect(repo.listMessages(JID).map((m) => m.id)).toEqual(['new', 'today'])
      expect(repo.listContacts({ includeHidden: true }).map((c) => c.jid)).toEqual([JID])
    })

    it('relógio do PC muito atrasado: a janela nunca encolhe (âncora limitada a PC + 1 dia só alarga)', async () => {
      const waNow = NOW + 60 * DAY // o PC está 60 dias atrás
      await emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [
          wamsg({ id: 'velha', ts: waNow - 31 * DAY }),
          wamsg({ id: 'dentro', ts: waNow - 29 * DAY }),
          wamsg({ id: 'nova', ts: waNow - 1000 })
        ]
      })
      expect(repo.listMessages(JID).map((m) => m.id)).toEqual(['velha', 'dentro', 'nova'])
    })

    it('relógio do PC adiantado: a janela conta a partir da mensagem mais nova do WhatsApp', async () => {
      clock.advance(60 * DAY) // o PC está 60 dias à frente
      await emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [
          wamsg({ id: 'velha', ts: NOW - 31 * DAY }),
          wamsg({ id: 'dentro', ts: NOW - 29 * DAY }),
          wamsg({ id: 'nova', ts: NOW - 1000 })
        ]
      })
      expect(repo.listMessages(JID).map((m) => m.id)).toEqual(['dentro', 'nova'])
      // um lote depois, só com mensagem velha, usa a mais nova já vista no banco
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'velha2', jid: JID2, ts: NOW - 40 * DAY })] })
      expect(repo.listMessages(JID2)).toEqual([])
    })

    it('uma mensagem com horário absurdo no futuro não derruba as mensagens reais (nem neste lote, nem nos próximos)', async () => {
      await emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [
          wamsg({ id: 'futuro', jid: JID2, ts: NOW + 10 * 365 * DAY }),
          wamsg({ id: 'ontem', ts: NOW - DAY }),
          wamsg({ id: 'semana', ts: NOW - 7 * DAY })
        ]
      })
      expect(repo.listMessages(JID).map((m) => m.id)).toEqual(['semana', 'ontem'])
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'hoje', ts: NOW - 1000 }), wamsg({ id: 'mes', ts: NOW - 20 * DAY })] })
      expect(repo.listMessages(JID).map((m) => m.id)).toEqual(['mes', 'semana', 'ontem', 'hoje'])
    })

    it('contato escondido: o áudio é gravado mas não entra na fila de download', async () => {
      repo.upsertContact({ jid: JID2 })
      repo.setHidden(JID2, true)
      await emit('messages.upsert', {
        type: 'notify',
        messages: [wamsg({ id: 'h1', jid: JID2, audio: 10, ts: NOW - 1000 }), wamsg({ id: 'v1', jid: JID, audio: 10, ts: NOW - 900 })]
      })
      expect(repo.getMessage('h1')).not.toBeNull()
      expect(repo.listJobs('pending').map((j) => j.key)).toEqual(['v1'])
      expect(repo.listJobs('pending')[0].payload).toEqual({ id: 'v1', ts: Math.floor((NOW - 900) / 1000) * 1000 })
    })

    it('contato nunca visto: cria o contato antes da mensagem (FK) com o pushName', async () => {
      const got: string[] = []
      client.on('message', (m: any) => got.push(m.id))
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'm1', jid: JID2, ts: NOW - 1000, pushName: 'Bruno' })] })
      expect(repo.listMessages(JID2).map((m) => m.id)).toEqual(['m1'])
      expect(repo.listContacts({ includeHidden: true })[0]).toMatchObject({ jid: JID2, pushName: 'Bruno' })
      expect(got).toEqual(['m1'])
      // repetida não emite de novo
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'm1', jid: JID2, ts: NOW - 1000 })] })
      expect(got).toEqual(['m1'])
    })

    it('pushName de mensagem minha não vira o nome do contato', async () => {
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'm1', fromMe: true, ts: NOW - 1000, pushName: 'Mentor' })] })
      expect(repo.listContacts({ includeHidden: true })[0].pushName).toBeNull()
    })

    it('LID: usa remoteJidAlt, depois o mapa do histórico, depois o @lid', async () => {
      await emit('messaging-history.set', {
        chats: [],
        contacts: [],
        lidPnMappings: [{ lid: '222@lid', pn: '5511911112222@s.whatsapp.net' }],
        messages: [
          wamsg({ id: 'a', jid: '111@lid', alt: JID, ts: NOW - DAY }),
          wamsg({ id: 'b', jid: '222@lid', ts: NOW - DAY }),
          wamsg({ id: 'c', jid: '333@lid', ts: NOW - DAY })
        ]
      })
      await emit('lid-mapping.update', { lid: '444@lid', pn: '5511944445555@s.whatsapp.net' })
      last().signalRepository.lidMapping.getPNForLID.mockImplementation(async (lid: string) =>
        lid === '555@lid' ? '5511955556666:0@s.whatsapp.net' : null
      )
      await emit('messages.upsert', {
        type: 'notify',
        messages: [wamsg({ id: 'd', jid: '444@lid', ts: NOW - 1 }), wamsg({ id: 'e', jid: '555@lid', ts: NOW - 1 })]
      })
      const jids = repo.listContacts({ includeHidden: true }).map((c) => c.jid).sort()
      expect(jids).toEqual(
        ['333@lid', '5511911112222@s.whatsapp.net', '5511944445555@s.whatsapp.net', '5511955556666@s.whatsapp.net', JID].sort()
      )
    })

    it('fromMe em chat @lid com remoteJidAlt = meu número vai para o contato, não para mim', async () => {
      await emit('messaging-history.set', {
        chats: [],
        contacts: [],
        lidPnMappings: [{ lid: '777@lid', pn: JID2 }],
        messages: [wamsg({ id: 'mine', jid: '777@lid', alt: '5547900000000@s.whatsapp.net', fromMe: true, ts: NOW - DAY })]
      })
      expect(repo.listMessages(JID2).map((m) => m.id)).toEqual(['mine'])
      expect(repo.listContacts({ includeHidden: true }).map((c) => c.jid)).toEqual([JID2])
    })

    it('áudio: prioridade 10 se o contato aguarda resposta e o áudio tem menos de 3 dias, senão 0', async () => {
      await emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [
          wamsg({ id: 'a-recent', jid: JID, audio: 10, ts: NOW - 2 * DAY }),
          wamsg({ id: 'a-old', jid: JID, audio: 10, ts: NOW - 5 * DAY }),
          wamsg({ id: 'a-answered', jid: JID2, audio: 10, ts: NOW - 2 * DAY }),
          wamsg({ id: 'reply', jid: JID2, fromMe: true, ts: NOW - DAY })
        ]
      })
      const jobs = Object.fromEntries(repo.listJobs('pending').map((j) => [j.key, j]))
      expect(Object.keys(jobs).sort()).toEqual(['a-answered', 'a-old', 'a-recent'])
      expect(jobs['a-recent']).toMatchObject({ type: 'download_audio', priority: 10, payload: { id: 'a-recent' } })
      expect(jobs['a-old'].priority).toBe(0)
      expect(jobs['a-answered'].priority).toBe(0)
    })
  })

  describe('download_audio', () => {
    beforeEach(async () => {
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'AUD1', audio: 37, ts: NOW - 1000 })] })
      await emit('connection.update', { connection: 'open' })
    })

    it('fica pausado (por tipo) enquanto a conexão não está aberta', async () => {
      await close(428)
      expect(queue.isTypePaused('download_audio')).toBe(true)
      expect(await queue.tick()).toBe('idle')
      expect(download).not.toHaveBeenCalled()
      await advance(10_000)
      await emit('connection.update', { connection: 'open' })
      expect(queue.isTypePaused('download_audio')).toBe(false)
      expect(await queue.tick()).toBe('ran')
      expect(download).toHaveBeenCalledTimes(1)
    })

    it('ao abrir, re-checa o disco antes de despausar', async () => {
      await close(428)
      await advance(10_000)
      diskFree = false
      await emit('connection.update', { connection: 'open' })
      expect(queue.isTypePaused('download_audio')).toBe(true)
      expect(repo.recentEvents(5).map((e) => e.kind)).toContain('disk_low')
    })

    it('baixa sem pedir reenvio, salva media/<id>.ogg e enfileira transcribe', async () => {
      expect(await queue.tick()).toBe('ran')
      expect(download).toHaveBeenCalledTimes(1)
      const [msg, type, opts, ctx] = download.mock.calls[0]
      expect(msg.key.id).toBe('AUD1')
      expect(Buffer.isBuffer(msg.message.audioMessage.mediaKey)).toBe(true)
      expect(type).toBe('buffer')
      expect(opts).toEqual({})
      expect(ctx).toBeUndefined()
      const file = join(tmp, 'media', 'AUD1.ogg')
      expect(readFileSync(file, 'utf8')).toBe('OggS-fake-audio')
      expect(repo.getMessage('AUD1')!.audioPath).toBe(file)
      const t = repo.listJobs('pending').find((j) => j.type === 'transcribe')!
      expect(t).toMatchObject({ key: 'transcribe:AUD1', payload: { id: 'AUD1', durationSec: 37 }, priority: 10 })
      expect(repo.listJobs('done').map((j) => j.key)).toEqual(['AUD1'])
    })

    it('contato escondido depois de enfileirar: o download é pulado (sem rede)', async () => {
      repo.setHidden(JID, true)
      expect(await queue.tick()).toBe('ran')
      expect(download).not.toHaveBeenCalled()
      expect(repo.getMessage('AUD1')!.audioPath).toBeNull()
      expect(repo.listJobs('pending').filter((j) => j.type === 'transcribe')).toEqual([])
    })

    it.each([404, 410])('mídia expirada (%i) → unavailable, sem nova tentativa', async (code) => {
      download.mockRejectedValueOnce(Object.assign(new Error('Failed to fetch stream'), { output: { statusCode: code } }))
      await queue.tick()
      expect(repo.getMessage('AUD1')!.transcriptStatus).toBe('unavailable')
      expect(repo.listJobs('done').map((j) => j.key)).toEqual(['AUD1'])
      expect(repo.listJobs('pending')).toEqual([])
    })

    it('outro erro de rede → falha com nova tentativa pela fila', async () => {
      download.mockRejectedValueOnce(Object.assign(new Error('boom'), { output: { statusCode: 500 } }))
      await queue.tick()
      const j = repo.listJobs('pending').find((x) => x.key === 'AUD1')!
      expect(j.attempts).toBe(1)
      expect(repo.getMessage('AUD1')!.transcriptStatus).toBeNull()
    })

    it('disco com menos de 1 GB → pausa o download, registra disk_low, sem baixar e sem gastar tentativa', async () => {
      diskFree = false
      await queue.tick()
      expect(download).not.toHaveBeenCalled()
      expect(queue.isTypePaused('download_audio')).toBe(true)
      expect(queue.isPaused()).toBe(false)
      expect(repo.recentEvents(5).map((e) => e.kind)).toContain('disk_low')
      const j = repo.listJobs('pending').find((x) => x.key === 'AUD1')!
      expect(j.attempts).toBe(0)
    })
  })

  describe('fetch_profile', () => {
    it('não faz chamada de rede: registra e conclui', async () => {
      repo.upsertContact({ jid: JID })
      queue.enqueue('fetch_profile', `profile:${JID}`, { jid: JID })
      expect(await queue.tick()).toBe('ran')
      expect(repo.listJobs('done').map((j) => j.key)).toEqual([`profile:${JID}`])
    })
  })

  describe('identidade (navegador) recusada com 428 antes do QR', () => {
    it('troca para a próxima identidade e reconecta já, sem contar', async () => {
      expect(last().config.browser).toEqual(['Windows', 'Chrome', expect.any(String)])
      await close(428, 'Connection Terminated')
      await advance(0)
      expect(sockets).toHaveLength(2)
      expect(last().config.browser).toEqual(['Ubuntu', 'Chrome', expect.any(String)])
      expect(repo.recentEvents(5).map((e) => e.kind)).toContain('wa_browser_switch')
      await close(428, 'Connection Terminated')
      await advance(0)
      expect(sockets).toHaveLength(3)
      expect(last().config.browser).toEqual(['Windows', 'Desktop', expect.any(String)])
      // lista esgotada: segue a política normal (espera 10 s)
      await close(428, 'Connection Terminated')
      await advance(0)
      expect(sockets).toHaveLength(3)
      await advance(10_000)
      expect(sockets).toHaveLength(4)
    })

    it('a identidade que mostrou QR fica gravada e um 428 depois do QR não troca', async () => {
      await close(428, 'Connection Terminated')
      await advance(0)
      await emit('connection.update', { qr: 'qr-teste' })
      expect(repo.getSetting('wa.browserIdx')).toBe('1')
      await close(428, 'Connection Terminated')
      await advance(0)
      expect(sockets).toHaveLength(2)
      expect(last().config.browser).toEqual(['Ubuntu', 'Chrome', expect.any(String)])
    })

    it('Tentar de novo sem nenhuma identidade aceita recomeça a lista', async () => {
      await close(428, 'Connection Terminated')
      await advance(0)
      await client.manualReconnect()
      expect(last().config.browser).toEqual(['Windows', 'Chrome', expect.any(String)])
    })
  })

  describe('desconexão', () => {
    // estes testes tratam da política de reconexão: a identidade já está confirmada (sem troca no 428)
    beforeEach(() => {
      ;(client as any).browserConfirmed = true
    })

    it.each([
      [401, 'stopped_logged_out'],
      [403, 'stopped_restricted']
    ] as const)('%i → pausa a fila, %s, registra evento e não reconecta', async (code, state) => {
      await close(code)
      expect(statuses.at(-1)).toBe(state)
      expect(queue.isPaused()).toBe(true)
      expect(repo.recentEvents(5).map((e) => e.kind)).toContain(`wa_${state}`)
      await advance(2 * 3_600_000)
      expect(sockets).toHaveLength(1)
    })

    it('405 (versão recusada): busca a versão de novo sem cache e reconecta já, sem contar; o segundo 405 para', async () => {
      expect(fetchVersion).toHaveBeenCalledTimes(1)
      expect(last().config.version).toEqual([2, 3000, 1_100_000_001])
      waRevision = 1_100_000_002
      await close(405)
      await advance(0)
      expect(sockets).toHaveLength(2)
      // cache de 24 h ignorado: buscou de novo
      expect(fetchVersion).toHaveBeenCalledTimes(2)
      expect(last().config.version).toEqual([2, 3000, 1_100_000_002])
      expect(statuses).not.toContain('stopped_outdated')
      expect(queue.isPaused()).toBe(false)
      expect(repo.recentEvents(5).map((e) => e.kind)).toContain('wa_outdated_retry')
      await close(405)
      expect(statuses.at(-1)).toBe('stopped_outdated')
      expect(queue.isPaused()).toBe(true)
      expect(repo.recentEvents(5).map((e) => e.kind)).toContain('wa_stopped_outdated')
      await advance(2 * 3_600_000)
      expect(sockets).toHaveLength(2)
    })

    it('405 depois de uma conexão estável volta a ganhar a nova tentativa; "Tentar de novo" também', async () => {
      await close(405)
      await advance(0)
      await emit('connection.update', { connection: 'open' })
      await advance(STABLE_MS + 1000)
      await close(405)
      await advance(0)
      expect(sockets).toHaveLength(3)
      expect(statuses.at(-1)).not.toBe('stopped_outdated')
      await close(405)
      expect(statuses.at(-1)).toBe('stopped_outdated')
      await client.manualReconnect()
      await close(405)
      await advance(0)
      expect(statuses.at(-1)).not.toBe('stopped_outdated')
      expect(sockets).toHaveLength(5)
    })

    it('a versão fica em cache: reconexões comuns não buscam de novo', async () => {
      await close(428)
      await advance(10_000)
      expect(sockets).toHaveLength(2)
      expect(fetchVersion).toHaveBeenCalledTimes(1)
    })

    it('busca da versão falhou e sem cache: socket sem `version` (o Baileys usa a embutida)', async () => {
      fetchVersion.mockImplementation(async () => ({ version: [2, 3000, 1], isLatest: false, error: new Error('Forbidden') }))
      repo.deleteSetting('wa.webVersion')
      await client.manualReconnect()
      expect('version' in last().config).toBe(false)
      expect(diagLines.some(([k, d]) => k === 'wa_version' && /Forbidden/.test(d))).toBe(true)
    })

    it('erro ao montar a conexão não deixa "Conectando…" para sempre: registra e espera para tentar de novo', async () => {
      fetchVersion.mockImplementation(async () => {
        throw new Error('boom')
      })
      repo.deleteSetting('wa.webVersion')
      // a falha de `fetchVersion` é tratada pelo resolvedor; a de criar o socket vem daqui
      const sf = (client as any).socketFactory
      ;(client as any).socketFactory = () => {
        throw new Error('falha ao carregar o módulo')
      }
      await client.manualReconnect()
      expect(statuses.at(-1)).toBe('waiting_retry')
      expect(client.getRetryAt()).not.toBeNull()
      expect(repo.recentEvents(5).find((e) => e.kind === 'wa_connect_error')?.detail).toMatch(/falha ao carregar o módulo/)
      ;(client as any).socketFactory = sf
      await advance(15_000)
      expect(statuses.at(-1)).toBe('connecting')
      expect(sockets.length).toBeGreaterThanOrEqual(2)
    })

    it('registro de diagnóstico: estados, código da queda e QR sem o conteúdo', async () => {
      await emit('connection.update', { qr: '2@SEGREDO-DO-QR,abc' })
      await close(428, 'Connection Terminated')
      const all = diagLines.map(([k, d]) => `${k} ${d}`).join('\n')
      expect(all).toMatch(/wa_qr/)
      expect(all).toMatch(/wa_close código 428: Connection Terminated/)
      expect(all).toMatch(/wa_status waiting_retry/)
      expect(all).not.toMatch(/SEGREDO/)
      expect(repo.recentEvents(5).map((e) => e.kind)).toEqual(expect.arrayContaining(['wa_qr', 'wa_closed']))
    })

    it('logger do Baileys: só warn/error, só a mensagem', () => {
      const lg = last().config.logger
      expect(lg.level).toBe('warn')
      lg.info({ msg: 'x' }, 'info ignorado')
      lg.debug('debug ignorado')
      lg.child({ a: 1 }).warn({ message: { conversation: 'texto secreto' } }, 'aviso do socket')
      lg.error({ err: new Error('stream errored') }, 'erro do socket')
      const b = diagLines.filter(([k]) => k.startsWith('baileys_'))
      expect(b).toEqual([
        ['baileys_warn', 'aviso do socket'],
        ['baileys_error', 'erro do socket: stream errored']
      ])
    })

    it('logged_out apaga a sessão (o próximo conectar pede QR)', async () => {
      await emit('connection.update', { connection: 'open' })
      await close(401)
      expect(existsSync(join(tmp, 'auth', 'creds.json'))).toBe(false)
      expect(existsSync(join(tmp, 'auth-backup', 'creds.json'))).toBe(false)
    })

    it('440 (substituída) → stopped_replaced, sem nova tentativa', async () => {
      await close(440)
      expect(statuses.at(-1)).toBe('stopped_replaced')
      await advance(2 * 3_600_000)
      expect(sockets).toHaveLength(1)
    })

    it('retry usa a espera da política', async () => {
      await close(428)
      expect(statuses.at(-1)).toBe('waiting_retry')
      await advance(9_999)
      expect(sockets).toHaveLength(1)
      await advance(1)
      expect(sockets).toHaveLength(2)
      expect(statuses.at(-1)).toBe('connecting')
    })

    it('política esgotada (null) → manual_retry_needed; manualReconnect conecta de novo', async () => {
      const seq = [10_000, 30_000, 120_000, 300_000, 900_000, 1_800_000]
      for (const d of seq) {
        await close(408)
        await advance(d)
      }
      expect(sockets).toHaveLength(7)
      await close(408)
      expect(statuses.at(-1)).toBe('manual_retry_needed')
      await advance(3_600_000)
      expect(sockets).toHaveLength(7)

      await client.manualReconnect()
      expect(sockets).toHaveLength(8)
      expect(statuses.at(-1)).toBe('connecting')
    })

    const expectReconnectAfter = async (ms: number) => {
      const n = sockets.length
      await advance(ms - 1)
      expect(sockets).toHaveLength(n)
      await advance(1)
      expect(sockets).toHaveLength(n + 1)
    }

    it('abrir e cair em seguida (oscilação) não zera a política: 7ª queda em 1 h → manual_retry_needed', async () => {
      const seq = [10_000, 30_000, 120_000, 300_000, 900_000, 1_800_000]
      for (const d of seq) {
        await emit('connection.update', { connection: 'open' })
        await close(428)
        await expectReconnectAfter(d)
      }
      await emit('connection.update', { connection: 'open' })
      await close(428)
      expect(statuses.at(-1)).toBe('manual_retry_needed')
      await advance(3_600_000)
      expect(sockets).toHaveLength(7)
    })

    it('aberta e estável por 5 min: a escada volta a 10 s, mas a janela de 1 h continua contando', async () => {
      await close(428)
      await expectReconnectAfter(10_000)
      await emit('connection.update', { connection: 'open' })
      await advance(STABLE_MS)
      await close(428)
      await expectReconnectAfter(10_000)
      for (const d of [30_000, 120_000, 300_000, 900_000]) {
        await close(428)
        await expectReconnectAfter(d)
      }
      // 6 tentativas em menos de 1 h (2 antes e 4 depois do markStable)
      await close(428)
      expect(statuses.at(-1)).toBe('manual_retry_needed')
    })

    it('aberta menos de 5 min não conta como estável', async () => {
      await close(428)
      await expectReconnectAfter(10_000)
      await emit('connection.update', { connection: 'open' })
      await advance(STABLE_MS - 1)
      await close(428)
      await expectReconnectAfter(30_000)
    })

    it('duas quedas do mesmo socket contam uma tentativa só', async () => {
      last().close(428)
      last().close(428)
      await client.whenIdle()
      await expectReconnectAfter(10_000)
      await close(428)
      await expectReconnectAfter(30_000)
    })

    it('515 (reiniciar): reconecta já sem contar, só uma vez seguida', async () => {
      await close(515)
      await advance(0)
      expect(sockets).toHaveLength(2)
      await close(515)
      await advance(0)
      expect(sockets).toHaveLength(2)
      await expectReconnectAfter(10_000)
      await close(428)
      await expectReconnectAfter(30_000)
    })

    it('bad_session: restaura o backup uma vez, depois needs_qr', async () => {
      await emit('connection.update', { connection: 'open' })
      await close(500)
      expect(restoreSpy).toHaveBeenCalledTimes(1)
      expect(restoreSpy).toHaveBeenLastCalledWith(true)
      await advance(0)
      expect(sockets).toHaveLength(2)

      await close(500)
      expect(restoreSpy).toHaveBeenCalledTimes(1)
      expect(existsSync(join(tmp, 'auth-backup', 'creds.json'))).toBe(false)
      expect(repo.recentEvents(5).map((e) => e.kind)).toContain('wa_bad_session')
      // sessão nova na hora: o socket novo mostra um QR
      await advance(0)
      expect(sockets).toHaveLength(3)
      expect(last().config.auth.creds.registrationId).not.toBe(sockets[0].config.auth.creds.registrationId)
      await emit('connection.update', { qr: '2@novo' })
      expect(statuses.at(-1)).toBe('needs_qr')
    })

    it('bad_session sem backup → sessão nova na hora; a seguinte já passa pela política', async () => {
      await close(500)
      expect(restoreSpy).toHaveBeenCalledWith(false)
      await advance(0)
      expect(sockets).toHaveLength(2)
      await close(500)
      expect(restoreSpy).toHaveBeenCalledTimes(1)
      await expectReconnectAfter(10_000)
    })

    it('abrir de novo despausa a fila que a desconexão pausou', async () => {
      await close(403)
      expect(queue.isPaused()).toBe(true)
      await client.manualReconnect()
      await emit('connection.update', { connection: 'open' })
      expect(queue.isPaused()).toBe(false)
    })

    it('eventos de um socket antigo são ignorados após stop()', async () => {
      const s = last()
      await client.stop()
      expect(s.end).toHaveBeenCalled()
      s.close(428)
      await client.whenIdle()
      await advance(3_600_000)
      expect(sockets).toHaveLength(1)
    })
  })

  describe('disco', () => {
    const kinds = () => repo.recentEvents(50).map((e) => e.kind)

    it('stop() enquanto onOpen mede o disco: não despausa os downloads', async () => {
      let release!: (v: boolean) => void
      diskGate = new Promise<boolean>((r) => (release = r))
      last().emit('connection.update', { connection: 'open' })
      await vi.advanceTimersByTimeAsync(0)
      expect(diskChecks).toBe(1)
      const stopping = client.stop()
      release(true)
      await stopping
      expect(queue.isTypePaused('download_audio')).toBe(true)
    })

    it('disk_low só na transição: reconectar com o disco ainda cheio não repete o evento', async () => {
      diskFree = false
      await emit('connection.update', { connection: 'open' })
      expect(client.isDiskLow()).toBe(true)
      await close(428)
      await advance(10_000)
      await emit('connection.update', { connection: 'open' })
      expect(kinds().filter((k) => k === 'disk_low')).toHaveLength(1)
      expect(queue.isTypePaused('download_audio')).toBe(true)
    })

    it('a cada 10 min conectado re-checa o disco: espaço de volta → retoma downloads e avisa', async () => {
      const disk: boolean[] = []
      client.on('disk', (low: boolean) => disk.push(low))
      diskFree = false
      await emit('connection.update', { connection: 'open' })
      diskFree = true
      await advance(9 * 60_000)
      expect(queue.isTypePaused('download_audio')).toBe(true)
      await advance(60_000)
      expect(queue.isTypePaused('download_audio')).toBe(false)
      expect(client.isDiskLow()).toBe(false)
      expect(kinds()).toContain('disk_ok')
      expect(disk).toEqual([true, false])
    })

    it('a checagem periódica também pausa se o disco encher com a conexão aberta', async () => {
      await emit('connection.update', { connection: 'open' })
      expect(queue.isTypePaused('download_audio')).toBe(false)
      diskFree = false
      await advance(10 * 60_000)
      expect(queue.isTypePaused('download_audio')).toBe(true)
      expect(kinds()).toContain('disk_low')
    })

    it('sem conexão aberta não há checagem periódica', async () => {
      await emit('connection.update', { connection: 'open' })
      await close(428)
      const before = diskChecks
      await advance(20 * 60_000)
      // só a reconexão (connecting, sem open) aconteceu: nenhuma medição nova
      expect(diskChecks).toBe(before)
    })

    it('ao acordar da suspensão re-checa o disco', async () => {
      diskFree = false
      await emit('connection.update', { connection: 'open' })
      diskFree = true
      client.onResumeFromSleep(1_000)
      await client.whenIdle()
      expect(queue.isTypePaused('download_audio')).toBe(false)
    })

    it('recheckDisk(): re-checa na hora (botão Retomar)', async () => {
      diskFree = false
      await emit('connection.update', { connection: 'open' })
      diskFree = true
      await client.recheckDisk()
      expect(queue.isTypePaused('download_audio')).toBe(false)
    })
  })

  describe('onResumeFromSleep', () => {
    it('> 1 h → startWarmup em todos os limitadores', () => {
      const spies = Object.values(limiters).map((l) => vi.spyOn(l, 'startWarmup'))
      client.onResumeFromSleep(30 * 60_000)
      for (const s of spies) expect(s).not.toHaveBeenCalled()
      client.onResumeFromSleep(3_600_001)
      for (const s of spies) expect(s).toHaveBeenCalledTimes(1)
    })
  })
})
