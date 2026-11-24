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
  let restoreSpy: ReturnType<typeof vi.fn<(r: boolean) => void>>

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
    download = vi.fn(async () => Buffer.from('OggS-fake-audio'))
    restoreSpy = vi.fn<(r: boolean) => void>()
    client = new WhatsAppClient({
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
        const real = a.restoreBackup
        a.restoreBackup = () => {
          const r = real()
          restoreSpy(r)
          return r
        }
        return a
      },
      download: download as any,
      hasFreeSpace: async () => diskFree
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
      expect(cfg.browser).toEqual(['Windows', 'Desktop', expect.any(String)])
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
          wamsg({ id: 'grp', jid: '120363000000000000@g.us', ts: NOW - DAY }),
          wamsg({ id: 'sts', jid: 'status@broadcast', ts: NOW - DAY })
        ]
      })
      expect(repo.listMessages(JID).map((m) => m.id)).toEqual(['new'])
      expect(repo.listContacts({ includeHidden: true }).map((c) => c.jid)).toEqual([JID])
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

    it('disco com menos de 1 GB → pausa a fila e registra disk_low, sem baixar', async () => {
      diskFree = false
      await queue.tick()
      expect(download).not.toHaveBeenCalled()
      expect(queue.isPaused()).toBe(true)
      expect(repo.recentEvents(5).map((e) => e.kind)).toContain('disk_low')
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

  describe('desconexão', () => {
    it.each([
      [401, 'stopped_logged_out'],
      [403, 'stopped_restricted'],
      [405, 'stopped_outdated']
    ] as const)('%i → pausa a fila, %s, registra evento e não reconecta', async (code, state) => {
      await close(code)
      expect(statuses.at(-1)).toBe(state)
      expect(queue.isPaused()).toBe(true)
      expect(repo.recentEvents(5).map((e) => e.kind)).toContain(`wa_${state}`)
      await advance(2 * 3_600_000)
      expect(sockets).toHaveLength(1)
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

    it('conexão aberta zera a política', async () => {
      await close(428)
      await advance(10_000)
      await emit('connection.update', { connection: 'open' })
      await close(428)
      await advance(10_000)
      expect(sockets).toHaveLength(3)
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
      expect(statuses.at(-1)).toBe('needs_qr')
      expect(existsSync(join(tmp, 'auth', 'creds.json'))).toBe(false)
      await advance(3_600_000)
      expect(sockets).toHaveLength(2)
    })

    it('bad_session sem backup → needs_qr direto', async () => {
      await close(500)
      expect(restoreSpy).toHaveBeenCalledWith(false)
      expect(statuses.at(-1)).toBe('needs_qr')
      expect(sockets).toHaveLength(1)
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
