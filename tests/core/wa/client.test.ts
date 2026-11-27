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
import { sendJobKey } from '../../../src/core/db/sendRepo'
import { chatHash, pickQuote, sendAddress } from '../../../src/core/send/logic'
import { verifyUnknownSend } from '../../../src/core/send/verify'
import { isGroupJid } from '../../../src/core/wa/normalize'
import { runView } from '../../../src/core/wa/groupHistory'
import { DEFAULT_SEND_OPTIONS, typingMs, type SendOptions } from '../../../src/shared/send'

const DAY = 86_400_000
const NOW = 1_764_000_000_000
const JID = '5547999998888@s.whatsapp.net'
const JID2 = '5511988887777@s.whatsapp.net'
const OWN = '5547900000000:3@s.whatsapp.net'
const STABLE_MS = 5 * 60_000

const OWN_LID = '777000:3@lid'
const GRP = '120363025555555555@g.us'
const GRP2 = '120363026666666666@g.us'

/**
 * Métodos de escrita do socket. Os três primeiros só podem ser chamados pelo caminho de envio (job `send_message`,
 * criado depois da confirmação do mentor): fora do bloco "envio direto" nenhum teste pode vê-los chamados; dentro dele,
 * só eles, e só tantas vezes quantos envios saíram da fila. Os outros nunca.
 */
const SEND_PATH = ['sendMessage', 'sendPresenceUpdate', 'readMessages'] as const
const FORBIDDEN = [
  'sendMessage',
  'readMessages',
  'sendReceipt',
  'sendReceipts',
  'sendPresenceUpdate',
  'chatModify',
  'updateMediaMessage',
  'logout',
  // grupos: nunca escrever
  'groupCreate',
  'groupLeave',
  'groupUpdateSubject',
  'groupUpdateDescription',
  'groupParticipantsUpdate',
  'groupRequestParticipantsUpdate',
  'groupSettingUpdate',
  'groupToggleEphemeral',
  'groupMemberAddMode',
  'groupJoinApprovalMode',
  'groupRevokeInvite',
  'groupAcceptInvite',
  'groupAcceptInviteV4'
] as const

class FakeSocket {
  ev = new EventEmitter()
  end = vi.fn()
  signalRepository = { lidMapping: { getPNForLID: vi.fn(async (_lid: string) => null as string | null) } }
  /** leitura (IQ): os grupos de que participo */
  groupFetchAllParticipating = vi.fn(async () => ({}) as Record<string, { id: string; subject?: string }>)
  /** leitura (IQ): um grupo só (v0.8.1) */
  groupMetadata = vi.fn(async (_jid: string) => null as null | { id: string; subject?: string; participants?: unknown[] })
  /** v0.8.3: pedido de histórico ao próprio celular (só pelo job `fetch_history`) */
  fetchMessageHistory = vi.fn(async (_count: number, _key: any, _ts: number) => 'PDO')
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
  participant?: string
  participantAlt?: string
  contextInfo?: any
}): any {
  const ci = o.contextInfo ? { contextInfo: o.contextInfo } : {}
  const message = o.audio !== undefined
    ? { audioMessage: { url: 'https://mmg.whatsapp.net/x.enc', directPath: '/x.enc', mediaKey: Buffer.alloc(32, 1), seconds: o.audio, ptt: true, ...ci } }
    : o.contextInfo
      ? { extendedTextMessage: { text: o.text ?? 'oi', ...ci } }
      : { conversation: o.text ?? 'oi' }
  return {
    key: {
      remoteJid: o.jid ?? JID,
      remoteJidAlt: o.alt,
      fromMe: o.fromMe ?? false,
      id: o.id,
      ...(o.participant ? { participant: o.participant } : {}),
      ...(o.participantAlt ? { participantAlt: o.participantAlt } : {})
    },
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
  let limiters: Partial<Record<JobType, RateLimiter>>
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
  /** o bloco "envio direto" libera os métodos do caminho de envio (só eles) */
  let allowSendPath: boolean
  /** v0.8.3: só os testes da busca no celular podem ver o pedido de histórico */
  let allowHistory: boolean
  let sendOpts: SendOptions

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
      fetch_profile: new RateLimiter(LIMITS.wa_profile, clock, () => 0),
      send_message: new RateLimiter(LIMITS.wa_send, clock, () => 0),
      fetch_history: new RateLimiter(LIMITS.wa_history, clock, () => 0)
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
    allowSendPath = false
    allowHistory = false
    sendOpts = { ...DEFAULT_SEND_OPTIONS }
    client = new WhatsAppClient({
      sendOptions: () => sendOpts,
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
        a.state.creds.me = { id: OWN, name: 'Mentor', lid: OWN_LID }
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
    for (const s of sockets) {
      for (const name of FORBIDDEN) {
        if (allowSendPath && (SEND_PATH as readonly string[]).includes(name)) continue
        expect(s.spies[name], name).not.toHaveBeenCalled()
      }
      if (!allowHistory) expect(s.fetchMessageHistory, 'fetchMessageHistory').not.toHaveBeenCalled()
    }
    if (allowSendPath) {
      // cada sendMessage corresponde a um envio confirmado que saiu da fila (nunca dois para o mesmo envio)
      const left = repo.sends.listByStatus('typing', 'sending', 'sent', 'failed', 'unknown').length
      const sent = sockets.reduce((n, s) => n + s.spies.sendMessage.mock.calls.length, 0)
      expect(sent).toBeLessThanOrEqual(left)
    }
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
    it('janela de 30 dias pelo timestamp da mensagem; grupos entram; status, newsletter e transmissão ignorados', async () => {
      await emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [
          wamsg({ id: 'old', ts: NOW - 31 * DAY }),
          wamsg({ id: 'new', ts: NOW - 29 * DAY }),
          wamsg({ id: 'today', ts: NOW - 1000 }),
          wamsg({ id: 'grp', jid: GRP, participant: JID2, ts: NOW - DAY }),
          wamsg({ id: 'grp-old', jid: GRP, participant: JID2, ts: NOW - 31 * DAY }),
          wamsg({ id: 'sts', jid: 'status@broadcast', ts: NOW - DAY }),
          wamsg({ id: 'nws', jid: '120363000000000000@newsletter', ts: NOW - DAY }),
          wamsg({ id: 'bcl', jid: '1234567890@broadcast', ts: NOW - DAY })
        ]
      })
      expect(repo.listMessages(JID).map((m) => m.id)).toEqual(['new', 'today'])
      expect(repo.listMessages(GRP).map((m) => m.id)).toEqual(['grp'])
      expect(repo.listContacts({ includeHidden: true }).map((c) => [c.jid, c.isGroup])).toEqual([
        [JID, false],
        [GRP, true]
      ])
    })

    describe('grupos', () => {
      it('guarda o remetente (@lid → telefone pelo mapa; participantAlt) e o pushName dele; o pushName não vira o nome do grupo', async () => {
        await emit('messaging-history.set', {
          chats: [],
          contacts: [],
          lidPnMappings: [{ lid: '222@lid', pn: JID2 }],
          messages: [
            wamsg({ id: 'g1', jid: GRP, participant: '222:5@lid', pushName: 'Bruno', ts: NOW - 3000 }),
            wamsg({ id: 'g2', jid: GRP, participant: '333@lid', participantAlt: '5511933334444@s.whatsapp.net', pushName: 'Carla', ts: NOW - 2000 }),
            wamsg({ id: 'g3', jid: GRP, participant: '444@lid', ts: NOW - 1500 }),
            wamsg({ id: 'g4', jid: GRP, fromMe: true, participant: OWN, pushName: 'Mentor', ts: NOW - 1000 })
          ]
        })
        const msgs = repo.listMessages(GRP)
        expect(msgs.map((m) => [m.id, m.fromMe, m.senderJid, m.senderName])).toEqual([
          ['g1', false, JID2, 'Bruno'],
          ['g2', false, '5511933334444@s.whatsapp.net', 'Carla'],
          ['g3', false, '444@lid', null],
          ['g4', true, null, null]
        ])
        const g = repo.listContacts({ includeHidden: true }).find((c) => c.jid === GRP)!
        expect(g).toMatchObject({ isGroup: true, pushName: null, displayName: 'Grupo sem nome', awaitingReply: false })
        // remetentes não viram conversas
        expect(repo.listContacts({ includeHidden: true }).map((c) => c.jid)).toEqual([GRP])
      })

      it('áudio de grupo: prioridade 0, mesmo aguardando; 10 se me menciona ou cita minha mensagem (e é recente)', async () => {
        await emit('messaging-history.set', {
          chats: [],
          contacts: [],
          messages: [
            wamsg({ id: 'ga-plain', jid: GRP, participant: JID2, audio: 10, ts: NOW - DAY }),
            wamsg({ id: 'ga-mention', jid: GRP, participant: JID2, audio: 10, ts: NOW - DAY, contextInfo: { mentionedJid: ['5547900000000@s.whatsapp.net'] } }),
            wamsg({ id: 'ga-lid', jid: GRP2, participant: JID2, audio: 10, ts: NOW - DAY, contextInfo: { mentionedJid: ['777000@lid'] } }),
            wamsg({ id: 'ga-quote', jid: GRP2, participant: JID2, audio: 10, ts: NOW - DAY, contextInfo: { participant: '5547900000000@s.whatsapp.net', stanzaId: 'X' } }),
            wamsg({ id: 'ga-old', jid: GRP2, participant: JID2, audio: 10, ts: NOW - 5 * DAY, contextInfo: { mentionedJid: ['5547900000000@s.whatsapp.net'] } }),
            wamsg({ id: 'ga-other', jid: GRP2, participant: JID2, audio: 10, ts: NOW - DAY, contextInfo: { mentionedJid: [JID] } }),
            // 1:1 continua como antes
            wamsg({ id: 'a-recent', jid: JID, audio: 10, ts: NOW - DAY })
          ]
        })
        const prio = Object.fromEntries(repo.listJobs('pending').map((j) => [j.key, j.priority]))
        expect(prio).toEqual({ 'ga-plain': 0, 'ga-mention': 10, 'ga-lid': 10, 'ga-quote': 10, 'ga-old': 0, 'ga-other': 0, 'a-recent': 10 })
        expect(repo.getMessage('ga-mention')!.mentionsMe).toBe(true)
        expect(repo.getMessage('ga-plain')!.mentionsMe).toBe(false)
      })

      it('grupo escondido: o áudio é gravado mas não entra na fila', async () => {
        await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'g0', jid: GRP, participant: JID2, ts: NOW - 2000 })] })
        repo.setHidden(GRP, true)
        await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'ga', jid: GRP, participant: JID2, audio: 5, ts: NOW - 1000 })] })
        expect(repo.getMessage('ga')).not.toBeNull()
        expect(repo.listJobs('pending')).toEqual([])
      })

      it('nome do grupo: groups.upsert, groups.update (assunto novo vence) e conversas do histórico', async () => {
        const name = (jid: string) => repo.listContacts({ includeHidden: true }).find((c) => c.jid === jid)?.displayName
        await emit('groups.upsert', [{ id: GRP, subject: 'Mentoria Turma 3' }])
        await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'g1', jid: GRP, participant: JID2, pushName: 'Bruno', ts: NOW - 1000 })] })
        expect(name(GRP)).toBe('Mentoria Turma 3')
        await emit('groups.update', [{ id: GRP, subject: 'Mentoria Turma 3 (2026)' }])
        expect(name(GRP)).toBe('Mentoria Turma 3 (2026)')
        await emit('groups.update', [{ id: GRP, announce: true }])
        expect(name(GRP)).toBe('Mentoria Turma 3 (2026)')
        await emit('messaging-history.set', {
          chats: [{ id: GRP2, name: 'Mastermind Vendas' }],
          contacts: [],
          messages: [wamsg({ id: 'h1', jid: GRP2, participant: JID2, ts: NOW - DAY })]
        })
        expect(name(GRP2)).toBe('Mastermind Vendas')
        // nome personalizado continua vencendo
        repo.renameContact(GRP, 'Turma 3')
        await emit('groups.update', [{ id: GRP, subject: 'Outro' }])
        expect(name(GRP)).toBe('Turma 3')
      })

      describe('nomes dos grupos pela fila (groupFetchAllParticipating)', () => {
        const groupJobs = () => repo.listJobs('pending').filter((j) => j.type === 'fetch_profile')
        beforeEach(async () => {
          await emit('messages.upsert', {
            type: 'notify',
            messages: [wamsg({ id: 'g1', jid: GRP, participant: JID2, ts: NOW - 1000 }), wamsg({ id: 'g2', jid: GRP2, participant: JID2, ts: NOW - 900 })]
          })
          last().groupFetchAllParticipating.mockResolvedValue({
            [GRP]: { id: GRP, subject: 'Mentoria Turma 3' },
            [GRP2]: { id: GRP2, subject: 'Mastermind' },
            '120363027777777777@g.us': { id: '120363027777777777@g.us', subject: 'Sem mensagens' }
          })
        })

        it('ao abrir enfileira um fetch_profile (sem chamar na hora); a fila chama, aplica os nomes e registra só a contagem', async () => {
          await emit('connection.update', { connection: 'open' })
          expect(last().groupFetchAllParticipating).not.toHaveBeenCalled()
          expect(groupJobs()).toHaveLength(1)
          expect(await queue.tick()).toBe('ran')
          expect(last().groupFetchAllParticipating).toHaveBeenCalledTimes(1)
          const names = Object.fromEntries(repo.listContacts({ includeHidden: true }).map((c) => [c.jid, c.displayName]))
          expect(names).toEqual({ [GRP]: 'Mentoria Turma 3', [GRP2]: 'Mastermind' })
          const lines = diagLines.filter(([k]) => k === 'wa_groups')
          expect(lines).toEqual([['wa_groups', 'nomes de grupos: 3 grupos']])
          expect(repo.listJobs('done').some((j) => j.type === 'fetch_profile')).toBe(true)
        })

        it('minha menção a um @lid num grupo grande casa com a conversa individual pelo telefone', async () => {
          last().signalRepository.lidMapping.getPNForLID.mockImplementation(async (l: string) => (l === '4242@lid' ? JID2 : null))
          await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'p1', jid: JID2, ts: NOW - 80_000 })] })
          await emit('messages.upsert', {
            type: 'notify',
            messages: [wamsg({ id: 'g3', jid: GRP, fromMe: true, ts: NOW - 50_000, contextInfo: { mentionedJid: ['4242:5@lid'] } })]
          })
          const c = repo.listContacts({ includeHidden: true }).find((x) => x.jid === JID2)!
          expect(c.replyDecision).toMatchObject({ needed: false, by: 'group', group: { jid: GRP } })
        })

        it('guarda os participantes (telefone e @lid, sem dispositivo) e registra só as contagens', async () => {
          const LID = '99887766554433@lid'
          last().groupFetchAllParticipating.mockResolvedValue({
            [GRP]: {
              id: GRP,
              subject: 'Mentoria Turma 3',
              participants: [{ id: LID, phoneNumber: '5511944443333:7@s.whatsapp.net' }, { id: '5531933332222@s.whatsapp.net' }]
            } as never,
            [GRP2]: { id: GRP2, subject: 'Mastermind', participants: [{ id: '55555@lid' }] } as never
          })
          last().signalRepository.lidMapping.getPNForLID.mockImplementation(async (l: string) => (l === '55555@lid' ? '5562911110000@s.whatsapp.net' : null))
          await emit('connection.update', { connection: 'open' })
          await queue.tick()
          expect(repo.groupMembers(GRP)).toEqual([LID, '5511944443333@s.whatsapp.net', '5531933332222@s.whatsapp.net'].sort())
          expect(repo.groupMembers(GRP2)).toEqual(['55555@lid', '5562911110000@s.whatsapp.net'])
          expect(diagLines.filter(([k]) => k === 'wa_groups')).toEqual([['wa_groups', 'nomes de grupos: 2 grupos, 3 participantes']])
        })

        it('no máximo uma vez a cada 24 h (horário gravado), mesmo reconectando ou reiniciando', async () => {
          await emit('connection.update', { connection: 'open' })
          await queue.tick()
          await close(428)
          await advance(10_000)
          await emit('connection.update', { connection: 'open' })
          expect(groupJobs()).toHaveLength(0)
          clock.advance(24 * 3_600_000)
          await close(428)
          await client.manualReconnect()
          await emit('connection.update', { connection: 'open' })
          expect(groupJobs()).toHaveLength(1)
        })

        it('várias aberturas antes da fila rodar: um job só', async () => {
          await emit('connection.update', { connection: 'open' })
          await close(428)
          await advance(10_000)
          await emit('connection.update', { connection: 'open' })
          expect(groupJobs()).toHaveLength(1)
        })

        it('conexão fechada: o tipo fica pausado (sem chamar) e o job espera a próxima abertura', async () => {
          await emit('connection.update', { connection: 'open' })
          await close(428)
          const s = last()
          expect(queue.isTypePaused('fetch_profile')).toBe(true)
          expect(await queue.tick()).toBe('idle')
          expect(s.groupFetchAllParticipating).not.toHaveBeenCalled()
          const j = groupJobs()[0]
          expect(j.attempts).toBe(0)
          expect(repo.getSetting('wa.groupMembersFetchedAt')).toBeNull()
        })

        // --- v0.8.1: nomes que se perdiam, consulta que falhou de vez, grupos novos ---
        const GRP3 = '120363027777777777@g.us'
        const name = (jid: string) => repo.listContacts({ includeHidden: true }).find((c) => c.jid === jid)?.displayName

        it('v0.8.1: assunto de um grupo ainda sem conversa fica guardado e vira o nome quando a conversa aparece', async () => {
          await emit('connection.update', { connection: 'open' })
          expect(await queue.tick()).toBe('ran')
          expect(repo.groupHasName(GRP3)).toBe(true)
          // como depois de reiniciar (sem a memória do cliente): a conversa nasce já com o nome
          repo.upsertContact({ jid: GRP3, isGroup: true })
          expect(name(GRP3)).toBe('Sem mensagens')
        })

        it('v0.8.1: resposta vazia não conta como feita (tenta de novo pela fila)', async () => {
          last().groupFetchAllParticipating.mockResolvedValue({})
          await emit('connection.update', { connection: 'open' })
          expect(await queue.tick()).toBe('ran')
          expect(repo.getSetting('wa.groupMembersFetchedAt')).toBeNull()
          expect(groupJobs()).toHaveLength(1)
          expect(groupJobs()[0].attempts).toBe(1)
        })

        it('v0.8.1: grupo sem nome visto: a consulta volta (mesmo a que falhou de vez), no máximo uma vez por hora', async () => {
          const groupJobs = () => repo.listJobs('pending').filter((j) => j.key === 'wa:group_subjects')
          last().groupFetchAllParticipating.mockResolvedValue({ [GRP]: { id: GRP, subject: 'Mentoria Turma 3' } })
          await emit('connection.update', { connection: 'open' })
          const job = groupJobs()[0]
          expect(job.priority).toBeGreaterThan(10)
          repo.markJobFailed(job.id, 3, 'falhou', null)
          expect(groupJobs()).toHaveLength(0)
          // dentro da hora do pedido: espera
          await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'n0', jid: GRP2, participant: JID2, ts: NOW - 200 })] })
          expect(groupJobs()).toHaveLength(0)
          // antes (v0.8.0) o job falho nunca voltava; agora volta com o próximo grupo sem nome visto depois da hora
          await advance(61 * 60_000)
          await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'n1', jid: GRP2, participant: JID2, ts: NOW + 61 * 60_000 })] })
          expect(groupJobs()).toHaveLength(1)
          expect(await queue.tick()).toBe('ran')
          expect(name(GRP)).toBe('Mentoria Turma 3')
          // GRP2 continua sem nome: dentro da hora, nada de consulta nova
          await advance(30 * 60_000)
          await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'n2', jid: GRP2, participant: JID2, ts: NOW + 91 * 60_000 })] })
          expect(groupJobs()).toHaveLength(0)
          await advance(31 * 60_000)
          await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'n3', jid: GRP2, participant: JID2, ts: NOW + 122 * 60_000 })] })
          expect(groupJobs()).toHaveLength(1)
        })

        it('v0.8.1: groups.upsert com participantes (grupo novo) e group-participants.update guardam a participação e avisam', async () => {
          const membership = vi.fn()
          client.on('membership', membership)
          await emit('groups.upsert', [{ id: GRP3, subject: 'Grupo novo', participants: [{ id: '5531933332222@s.whatsapp.net' }] }])
          expect(repo.groupMembers(GRP3)).toEqual(['5531933332222@s.whatsapp.net'])
          expect(repo.groupHasName(GRP3)).toBe(true)
          expect(membership).toHaveBeenCalledTimes(1)
          await emit('group-participants.update', { id: GRP3, action: 'add', participants: ['5541922221111@s.whatsapp.net'] })
          expect(repo.groupMembers(GRP3)).toEqual(['5531933332222@s.whatsapp.net', '5541922221111@s.whatsapp.net'])
          await emit('group-participants.update', { id: GRP3, action: 'remove', participants: [{ id: '5531933332222@s.whatsapp.net' }] })
          expect(repo.groupMembers(GRP3)).toEqual(['5541922221111@s.whatsapp.net'])
          await emit('group-participants.update', { id: GRP3, action: 'promote', participants: ['5541922221111@s.whatsapp.net'] })
          expect(membership).toHaveBeenCalledTimes(3)
        })

        it('v0.8.1: @lid que ganha telefone: o telefone entra como forma do participante (guardado) e avisa', async () => {
          const membership = vi.fn()
          client.on('membership', membership)
          repo.setGroupMembers(GRP, ['55555@lid'])
          await emit('lid-mapping.update', { lid: '55555:2@lid', pn: '5562911110000:4@s.whatsapp.net' })
          expect(repo.groupMembers(GRP)).toEqual(['55555@lid', '5562911110000@s.whatsapp.net'])
          expect(membership).toHaveBeenCalledTimes(1)
          // o mesmo par de novo: nada
          await emit('lid-mapping.update', { lid: '55555@lid', pn: '5562911110000@s.whatsapp.net' })
          expect(membership).toHaveBeenCalledTimes(1)
        })

        it('v0.8.1: grupo que aparece depois da consulta de todos, sem participantes: uma consulta só dele, pela fila', async () => {
          await emit('connection.update', { connection: 'open' })
          expect(await queue.tick()).toBe('ran')
          const s = last()
          s.groupMetadata.mockResolvedValue({ id: GRP3, subject: 'Turma nova', participants: [{ id: '5531933332222@s.whatsapp.net' }] })
          await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'm1', jid: GRP3, fromMe: true, ts: NOW + 1000 })] })
          await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'm2', jid: GRP3, fromMe: true, ts: NOW + 2000 })] })
          const meta = groupJobs().filter((j) => (j.payload as { kind?: string }).kind === 'group_meta')
          expect(meta).toHaveLength(1)
          expect(s.groupMetadata).not.toHaveBeenCalled()
          await advance(60_000)
          expect(await queue.tick()).toBe('ran')
          expect(s.groupMetadata).toHaveBeenCalledWith(GRP3)
          expect(repo.groupMembers(GRP3)).toEqual(['5531933332222@s.whatsapp.net'])
          expect(name(GRP3)).toBe('Turma nova')
        })

        it('v0.8.1: consultas de um grupo só com limite gravado (10/h, 40/dia local) e uma por grupo por dia, sem nova tentativa', async () => {
          await emit('connection.update', { connection: 'open' })
          expect(await queue.tick()).toBe('ran')
          const s = last()
          s.groupMetadata.mockRejectedValue(new Error('rate-overlimit'))
          const metaJobs = () => repo.listJobs('pending').filter((j) => (j.payload as { kind?: string }).kind === 'group_meta')
          const g = (i: number) => `1203630300000000${String(i).padStart(2, '0')}@g.us`
          let seq = 0
          const msgIn = (jid: string) =>
            emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: `q${++seq}`, jid, fromMe: true, ts: clock.now() + 1000 })] })
          const runAll = async () => {
            for (let i = 0; i < 30 && metaJobs().length; i++) {
              await advance(60_000)
              await queue.tick()
            }
          }
          for (let i = 0; i < 12; i++) await msgIn(g(i))
          await runAll()
          // 12 grupos novos na mesma hora: só 10 consultas; falha não tenta de novo
          expect(s.groupMetadata).toHaveBeenCalledTimes(10)
          expect(metaJobs()).toHaveLength(0)
          // o mesmo grupo de novo no mesmo dia: nunca outra consulta (mesmo depois de reiniciar: está no banco)
          await advance(61 * 60_000)
          await msgIn(g(0))
          expect(metaJobs()).toHaveLength(0)
          // limite do dia local (gravado): com 40 hoje, nenhuma consulta nova, mesmo numa hora livre
          const midnight = new Date(clock.now())
          midnight.setHours(0, 0, 0, 0)
          const today = Array.from({ length: 40 }, (_, i) => midnight.getTime() + i)
          repo.setSetting('wa.groupMetaLog', JSON.stringify({ at: today, groups: {} }))
          await msgIn(g(40))
          expect(metaJobs()).toHaveLength(0)
          const perGroup = new Map<string, number>()
          for (const [jid] of s.groupMetadata.mock.calls) perGroup.set(jid as string, (perGroup.get(jid as string) ?? 0) + 1)
          expect(Math.max(...perGroup.values())).toBe(1)
        })
      })
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

    describe('nomes de contatos', () => {
      const names = () => Object.fromEntries(repo.listContacts({ includeHidden: true }).map((c) => [c.jid, c.displayName]))
      const msgFrom = (jid: string, id: string, pushName?: string) =>
        emit('messages.upsert', { type: 'notify', messages: [wamsg({ id, jid, ts: NOW - 1000, pushName })] })

      it('contacts.upsert: nome da agenda > notify > verifiedName; não cria contato sem mensagem', async () => {
        await msgFrom(JID, 'm1')
        await msgFrom(JID2, 'm2')
        const changed = vi.fn()
        client.on('contacts', changed)
        await emit('contacts.upsert', [
          { id: JID, name: 'Ana da agenda', notify: 'Ana perfil' },
          { id: JID2, notify: 'Bruno perfil', verifiedName: 'Bruno Ltda' },
          { id: '5511900000000@s.whatsapp.net', name: 'Sem mensagem' }
        ])
        expect(names()).toEqual({ [JID]: 'Ana da agenda', [JID2]: 'Bruno perfil' })
        expect(changed).toHaveBeenCalledTimes(1)
        expect(diagLines.find(([k]) => k === 'wa_names')?.[1]).toBe('contacts.upsert: 3 contatos, 3 com nome, 2 aplicados')
      })

      it('nome que chega antes da primeira mensagem é aplicado quando o contato aparece', async () => {
        await emit('contacts.upsert', [{ id: JID2, name: 'Bruno' }])
        expect(repo.listContacts({ includeHidden: true })).toEqual([])
        await msgFrom(JID2, 'm1', 'b.perfil')
        expect(names()[JID2]).toBe('Bruno')
      })

      it('precedência: nome personalizado > agenda > notify > pushName (um pushName novo não sobrescreve a agenda)', async () => {
        await msgFrom(JID, 'm1', 'push1')
        expect(names()[JID]).toBe('push1')
        await emit('contacts.update', [{ id: JID, notify: 'notify1' }])
        expect(names()[JID]).toBe('notify1')
        await msgFrom(JID, 'm2', 'push2')
        expect(names()[JID]).toBe('notify1')
        await emit('contacts.update', [{ id: JID, name: 'Agenda' }])
        await emit('contacts.update', [{ id: JID, notify: 'notify2' }])
        expect(names()[JID]).toBe('Agenda')
        repo.renameContact(JID, 'Meu nome')
        await emit('contacts.update', [{ id: JID, name: 'Agenda 2' }])
        expect(names()[JID]).toBe('Meu nome')
        expect(repo.listContacts({ includeHidden: true })[0].pushName).toBe('Agenda 2')
      })

      it('@lid: nome guardado e aplicado no contato do telefone quando o mapeamento chega', async () => {
        await msgFrom(JID2, 'm1')
        await emit('contacts.upsert', [{ id: '999@lid', notify: 'Bruno via lid' }])
        expect(names()[JID2]).not.toBe('Bruno via lid')
        await emit('lid-mapping.update', { lid: '999@lid', pn: JID2 })
        expect(names()[JID2]).toBe('Bruno via lid')
      })

      it('@lid já mapeado: vai direto para o telefone; contato com phoneNumber também', async () => {
        await emit('lid-mapping.update', { lid: '888@lid', pn: JID })
        await msgFrom(JID, 'm1')
        await msgFrom(JID2, 'm2')
        await emit('contacts.upsert', [
          { id: '888@lid', name: 'Ana' },
          { id: '777@lid', phoneNumber: JID2, notify: 'Bruno' }
        ])
        expect(names()).toEqual({ [JID]: 'Ana', [JID2]: 'Bruno' })
      })

      it('messaging-history.set: nomes dos contatos e dos chats; chats.upsert também', async () => {
        await emit('messaging-history.set', {
          chats: [{ id: JID2, name: 'Bruno (chat)' }],
          contacts: [{ id: JID, notify: 'Ana' }],
          messages: [wamsg({ id: 'a', jid: JID, ts: NOW - DAY }), wamsg({ id: 'b', jid: JID2, ts: NOW - DAY })]
        })
        expect(names()).toEqual({ [JID]: 'Ana', [JID2]: 'Bruno (chat)' })
        await msgFrom('5511933334444@s.whatsapp.net', 'c')
        await emit('chats.upsert', [{ id: '5511933334444@s.whatsapp.net', name: 'Carla' }, { id: '120363000000000000@g.us', name: 'Grupo' }])
        expect(names()['5511933334444@s.whatsapp.net']).toBe('Carla')
      })
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
      // nomes dos grupos buscados há pouco: a fila aqui só tem o áudio
      repo.setSetting('wa.groupMembersFetchedAt', String(NOW))
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
      // só o sinal de cancelamento para o fetch; nunca `reuploadRequest`
      expect(Object.keys(opts)).toEqual(['options'])
      expect(opts.options.signal).toBeInstanceOf(AbortSignal)
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

    it('download que nunca responde: estoura o prazo (120 s), conta tentativa e a fila segue; a resposta atrasada é descartada', async () => {
      let late: ((b: Buffer) => void) | null = null
      download.mockImplementationOnce(() => new Promise<Buffer>((r) => (late = r)))
      const t = queue.tick()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(await t).toBe('ran')
      const j = repo.listJobs('pending').find((x) => x.key === 'AUD1')!
      expect(j).toMatchObject({ attempts: 1 })
      expect(j.lastError).toMatch(/tempo esgotado/)
      expect(download.mock.calls[0][2].options.signal.aborted).toBe(true)
      late!(Buffer.from('tarde'))
      await vi.advanceTimersByTimeAsync(10)
      expect(repo.getMessage('AUD1')!.audioPath).toBeNull()
      expect(existsSync(join(tmp, 'media', 'AUD1.ogg'))).toBe(false)
      expect(repo.listJobs('pending').filter((x) => x.type === 'transcribe')).toEqual([])
      // na nova tentativa, baixa normalmente
      clock.advance(30_000)
      expect(await queue.tick()).toBe('ran')
      expect(repo.getMessage('AUD1')!.audioPath).toBe(join(tmp, 'media', 'AUD1.ogg'))
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
    it('payload de contato (antigo): não faz chamada de rede: registra e conclui', async () => {
      repo.setSetting('wa.groupMembersFetchedAt', String(NOW))
      await emit('connection.update', { connection: 'open' })
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

    it('500 (Stream Errored): reconecta pela política mantendo as chaves atuais (sem restaurar backup nem apagar)', async () => {
      await emit('connection.update', { connection: 'open' })
      const regId = last().config.auth.creds.registrationId
      await close(500, 'Stream Errored (ack)')
      expect(restoreSpy).not.toHaveBeenCalled()
      expect(repo.recentEvents(5).map((e) => e.kind)).toContain('wa_stream_error')
      await expectReconnectAfter(10_000)
      expect(last().config.auth.creds.registrationId).toBe(regId)
      await close(500, 'Stream Errored (ack)')
      expect(restoreSpy).not.toHaveBeenCalled()
      await expectReconnectAfter(30_000)
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

  describe('v0.8.3: vincular de novo e histórico dos grupos', () => {
    const ON_DEMAND = 6

    it('vincular de novo (removido no celular → QR → histórico): só auth apagada, nada duplicado nem baixado de novo, grupos antigos entram, nada escrito', async () => {
      repo.setSetting('wa.groupMembersFetchedAt', String(NOW))
      await emit('connection.update', { connection: 'open' })
      await emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [
          wamsg({ id: 'i1', ts: NOW - 10 * DAY, text: 'oi' }),
          wamsg({ id: 'au1', ts: NOW - 5 * DAY, audio: 12 }),
          wamsg({ id: 'g-new', jid: GRP, participant: JID2, ts: NOW - 2 * DAY })
        ]
      })
      // o áudio já foi transcrito; memória, configurações e fila do Copiloto existem
      repo.setTranscript('au1', 'transcrição pronta', 'done')
      repo.setSetting('copiloto.enabled', '1')
      repo.setSetting('settings.theme', 'dark')
      repo.copiloto.upsert('sz1:m:x', GRP, '{}', 'h')
      const jobsBefore = repo.listJobs('pending').length + repo.listJobs('done').length
      const seen: string[] = []
      client.on('message', (m: { id: string }) => seen.push(m.id))
      const history: unknown[] = []
      client.on('history', (h: unknown) => history.push(h))
      const paired = vi.fn()
      client.on('paired', paired)

      // o mentor remove o aparelho no celular
      await close(401)
      expect(statuses.at(-1)).toBe('stopped_logged_out')
      expect(existsSync(join(tmp, 'auth', 'creds.json'))).toBe(false)
      // nada além da sessão foi apagado
      expect(repo.listMessages(JID).map((m) => m.id)).toEqual(['i1', 'au1'])
      expect(repo.getMessage('au1')?.transcriptStatus).toBe('done')
      expect(repo.getSetting('settings.theme')).toBe('dark')
      expect(repo.copiloto.pendingCount()).toBe(1)

      // "Reconectar": QR novo, o mentor escaneia, o histórico chega de novo (com os grupos antigos agora)
      await client.manualReconnect()
      await emit('connection.update', { qr: '2@abc,def' })
      await emit('connection.update', { connection: 'open' })
      expect(paired).toHaveBeenCalledTimes(1)
      // os grupos (nomes e participantes) são consultados de novo, pela fila
      expect(repo.listJobs('pending').some((j) => j.key === 'wa:group_subjects')).toBe(true)
      await emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [
          wamsg({ id: 'i1', ts: NOW - 10 * DAY, text: 'oi' }),
          wamsg({ id: 'au1', ts: NOW - 5 * DAY, audio: 12 }),
          wamsg({ id: 'g-new', jid: GRP, participant: JID2, ts: NOW - 2 * DAY }),
          wamsg({ id: 'g-old1', jid: GRP, participant: JID2, ts: NOW - 20 * DAY }),
          wamsg({ id: 'g-old2', jid: GRP, fromMe: true, participant: OWN, ts: NOW - 29 * DAY }),
          wamsg({ id: 'g-too-old', jid: GRP, participant: JID2, ts: NOW - 33 * DAY })
        ]
      })
      // só as novas: ids iguais não entram de novo, o áudio transcrito não volta para a fila
      expect(seen).toEqual(['g-old1', 'g-old2'])
      expect(history).toEqual([{ inserted: 2, onDemand: false }])
      expect(repo.listMessages(GRP).map((m) => m.id)).toEqual(['g-old2', 'g-old1', 'g-new'])
      expect(repo.listMessages(JID).map((m) => m.id)).toEqual(['i1', 'au1'])
      expect(repo.getMessage('au1')).toMatchObject({ transcriptStatus: 'done', transcript: 'transcrição pronta' })
      const jobs = [...repo.listJobs('pending'), ...repo.listJobs('done')]
      expect(jobs.filter((j) => j.type === 'download_audio')).toHaveLength(1)
      expect(jobs.length).toBe(jobsBefore) // a consulta dos grupos é o mesmo job (volta para a fila)
      expect(jobs.some((j) => j.type === 'send_message')).toBe(false)
      expect(repo.getSetting('settings.theme')).toBe('dark')
    })

    it('reconectar sem QR (queda comum): não conta como vínculo novo', async () => {
      const paired = vi.fn()
      client.on('paired', paired)
      await emit('connection.update', { connection: 'open' })
      await close(428)
      await advance(10_000)
      await emit('connection.update', { connection: 'open' })
      expect(paired).not.toHaveBeenCalled()
    })

    describe('busca no celular (fetchMessageHistory)', () => {
      const run = () => JSON.parse(repo.getSetting('wa.groupHistoryRun') ?? 'null')
      const calls = () => last().fetchMessageHistory.mock.calls

      beforeEach(async () => {
        allowHistory = true
        repo.setSetting('wa.groupMembersFetchedAt', String(NOW))
        await emit('connection.update', { connection: 'open' })
        await emit('messages.upsert', {
          type: 'notify',
          messages: [
            wamsg({ id: 'g1', jid: GRP, participant: JID2, ts: NOW - 2 * DAY }),
            wamsg({ id: 'g2', jid: GRP, participant: JID2, ts: NOW - DAY }),
            wamsg({ id: 'h1', jid: GRP2, fromMe: true, participant: OWN, ts: NOW - 3 * DAY }),
            wamsg({ id: 'now', ts: NOW - 1000 })
          ]
        })
        // os grupos sem nome pedem a consulta dos grupos: ela roda primeiro (a fila só tem o histórico depois)
        last().groupFetchAllParticipating.mockResolvedValue({ [GRP]: { id: GRP, subject: 'Turma A' }, [GRP2]: { id: GRP2, subject: 'Turma B' } })
        await queue.tick()
        expect(last().groupFetchAllParticipating).toHaveBeenCalledTimes(1)
      })

      it('só com a conexão estável; um pedido por vez de 50 antes da mais antiga; a resposta entra pela ingestão (30 dias) até completar', async () => {
        const history: Array<{ inserted: number; onDemand: boolean }> = []
        client.on('history', (h: { inserted: number; onDemand: boolean }) => history.push(h))
        const view = client.startGroupHistory([GRP, GRP2], 1)
        expect(view).toMatchObject({ state: 'running', groups: 2, done: 0, noAnchor: 1 })
        // aberta há menos de 1 min: nada
        await queue.tick()
        expect(calls()).toHaveLength(0)
        await advance(61_000)
        expect(await queue.tick()).toBe('ran')
        expect(calls()).toEqual([[50, { remoteJid: GRP, id: 'g1', fromMe: false, participant: JID2 }, NOW - 2 * DAY]])
        // esperando a resposta: nenhum outro pedido
        await advance(30_000)
        await queue.tick()
        expect(calls()).toHaveLength(1)
        await emit('messaging-history.set', {
          syncType: ON_DEMAND,
          chats: [],
          contacts: [],
          messages: [wamsg({ id: 'o1', jid: GRP, participant: JID2, ts: NOW - 10 * DAY }), wamsg({ id: 'o2', jid: GRP, participant: '999@lid', ts: NOW - 12 * DAY })]
        })
        expect(repo.listMessages(GRP).map((m) => m.id)).toEqual(['o2', 'o1', 'g1', 'g2'])
        expect(history).toEqual([{ inserted: 2, onDemand: true }])
        expect(run()).toMatchObject({ received: 2, pending: null })
        await queue.tick()
        expect(calls()).toHaveLength(2)
        expect(calls()[1]).toEqual([50, { remoteJid: GRP, id: 'o2', fromMe: false, participant: '999@lid' }, NOW - 12 * DAY])
        // chegou antes dos 30 dias: o que passa da janela não entra e o grupo está completo
        await emit('messaging-history.set', {
          syncType: ON_DEMAND,
          chats: [],
          contacts: [],
          messages: [wamsg({ id: 'o3', jid: GRP, participant: JID2, ts: NOW - 25 * DAY }), wamsg({ id: 'o4', jid: GRP, participant: JID2, ts: NOW - 31 * DAY })]
        })
        expect(repo.getMessage('o3')).not.toBeNull()
        expect(repo.getMessage('o4')).toBeNull()
        // ritmo: 20 s entre pedidos
        await advance(5_000)
        await queue.tick()
        expect(calls()).toHaveLength(2)
        await advance(20_000)
        await queue.tick()
        expect(calls()[2]).toEqual([50, { remoteJid: GRP2, id: 'h1', fromMe: true }, NOW - 3 * DAY])
        // o celular não tem mais nada antes desta: grupo concluído
        await emit('messaging-history.set', { syncType: ON_DEMAND, chats: [], contacts: [], messages: [] })
        await advance(30_000)
        await queue.tick()
        expect(calls()).toHaveLength(3)
        expect(runView(repo, clock.now())).toMatchObject({ state: 'done', groups: 2, done: 2, requests: 3, received: 3, noAnchor: 1 })
        // clicar de novo depois de concluída: busca nova (só os grupos que ainda faltam)
        expect(client.startGroupHistory([], 1)).toMatchObject({ state: 'done', groups: 0 })
        expect(repo.listJobs('failed')).toHaveLength(0)
      })

      it('celular sem resposta: quieto; três perdidos seguidos param a busca (sem job com falha)', async () => {
        client.startGroupHistory([GRP, GRP2], 0)
        await advance(61_000)
        for (let i = 0; i < 3; i++) {
          await queue.tick()
          await advance(61_000)
        }
        await queue.tick()
        expect(calls().map((c) => c[1].id)).toEqual(['g1', 'g1', 'h1'])
        expect(run()).toMatchObject({ state: 'waiting_phone', pending: null })
        expect(run().groups[GRP].s).toBe('gave_up')
        await advance(10 * 60_000)
        await queue.tick()
        expect(calls()).toHaveLength(3)
        expect(repo.listJobs('failed')).toHaveLength(0)
      })

      it('limite de 60 pedidos por dia, gravado no banco: o resto fica para o dia seguinte', async () => {
        const today = new Date(NOW)
        const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
        repo.setSetting('wa.groupHistoryLog', JSON.stringify(Array.from({ length: 60 }, (_, i) => Math.max(dayStart, NOW - 3_600_000) + i)))
        client.startGroupHistory([GRP], 0)
        await advance(61_000)
        await queue.tick()
        expect(calls()).toHaveLength(0)
        expect(client.startGroupHistory([GRP], 0)).toMatchObject({ state: 'running', capped: true })
        const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime()
        await advance(tomorrow - clock.now() + 1000)
        // a conexão continua aberta: no dia seguinte, sozinho
        await queue.tick()
        expect(calls()).toHaveLength(1)
      })

      it('a busca em andamento continua ao reconectar, mesmo se o job tiver parado', async () => {
        client.startGroupHistory([GRP], 0)
        const job = repo.listJobs('pending').find((j) => j.type === 'fetch_history')!
        repo.markJobDone(job.id)
        await close(428)
        await advance(10_000)
        await emit('connection.update', { connection: 'open' })
        await advance(61_000)
        await queue.tick()
        expect(calls()).toHaveLength(1)
      })

      it('sem conexão aberta: nenhum pedido', async () => {
        client.startGroupHistory([GRP], 0)
        await close(428)
        await advance(5 * 60_000)
        await queue.tick()
        expect(calls()).toHaveLength(0)
      })
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
  describe('envio direto (o único caminho que escreve no WhatsApp)', () => {
    /** o contato escreveu por último pelo @lid: as respostas vão para o @lid (sem dispositivo) */
    const ANA_LID = '999@lid'
    let log: string[]

    const open = () => emit('connection.update', { connection: 'open' })
    /**
     * uma resposta aprovada + o envio na fila, como o serviço faz depois da confirmação: destino e citação presos na
     * confirmação e a geração da conexão no job
     */
    const queueSend = (jid: string, text: string, o: { quotedId?: string | null; gen?: number; idemKey?: string; forced?: boolean } = {}) => {
      const msgs = repo.listMessages(jid, 300)
      const q = isGroupJid(jid) && sendOpts.quoteInGroups ? pickQuote(msgs) : null
      const replyId = repo.insertApproved({ jid, contextText: 'ctx', originalSuggestion: text, finalText: text, provider: 'groq' })
      const { send } = repo.sends.enqueue({
        idemKey: o.idemKey ?? `${replyId}:x`,
        replyId,
        jid,
        text,
        address: sendAddress(msgs, jid),
        quotedId: o.quotedId !== undefined ? o.quotedId : (q?.id ?? null),
        forced: o.forced ?? false
      })
      queue.enqueue('send_message', sendJobKey(send), { sendId: send.id, attempt: send.attempt, gen: o.gen ?? client.connGen() }, 20)
      return send
    }
    /** roda um tick da fila deixando o "digitando…" passar */
    const runSend = async (ms = 20_000) => {
      const t = queue.tick()
      await vi.advanceTimersByTimeAsync(ms)
      return t
    }
    const spyLog = (s: FakeSocket) => {
      s.spies.sendPresenceUpdate.mockImplementation(async (type: string, jid?: string) => void log.push(`presence:${type}${jid ? `:${jid}` : ''}`))
      s.spies.sendMessage.mockImplementation(async (jid: string) => {
        log.push(`send:${jid}`)
        return { key: { id: 'WA-OUT-1' } }
      })
      s.spies.readMessages.mockImplementation(async (keys: any[]) => void log.push(`read:${keys.map((k) => k.id).join(',')}`))
    }
    const noWrites = () => {
      for (const sk of sockets) for (const name of SEND_PATH) expect(sk.spies[name], name).not.toHaveBeenCalled()
    }

    beforeEach(async () => {
      allowSendPath = true
      log = []
      await emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [
          wamsg({ id: 'c0', ts: NOW - 3 * 3_600_000, text: 'antes' }),
          wamsg({ id: 'm0', ts: NOW - 2 * 3_600_000, fromMe: true, text: 'resposta antiga' }),
          wamsg({ id: 'c1', ts: NOW - 3_600_000, text: 'pergunta 1' }),
          { ...wamsg({ id: 'c2', ts: NOW - 60_000, text: 'pergunta 2' }), key: { remoteJid: '999:2@lid', remoteJidAlt: JID, fromMe: false, id: 'c2' } },
          wamsg({ id: 'other', jid: JID2, ts: NOW - 60_000, text: 'outra conversa' }),
          wamsg({ id: 'g0', jid: GRP, participant: JID2, ts: NOW - 50_000, text: 'me ajuda @mentor?', contextInfo: { mentionedJid: [OWN] } }),
          wamsg({ id: 'g1', jid: GRP, participant: '888:1@lid', ts: NOW - 40_000, text: 'eu também' })
        ]
      })
    })

    it('a conexão cai com o envio esperando a vez: expira na hora e NUNCA sai depois de reconectar', async () => {
      await open()
      const s = queueSend(JID, 'Oi!')
      await close(408)
      expect(repo.sends.get(s.id)).toMatchObject({ status: 'expired', error: 'a conexão caiu antes de enviar' })
      expect(repo.jobCounts('send_message')).toMatchObject({ pending: 0, running: 0 })
      expect(diagLines.some(([k, d]) => k === 'send_expired' && d.includes(`send #${s.id}`))).toBe(true)
      // reconecta e abre de novo: nada sai
      await advance(15_000)
      await open()
      expect(client.getStatus()).toBe('open')
      for (let i = 0; i < 3; i++) await runSend(120_000)
      expect(repo.sends.get(s.id)!.status).toBe('expired')
      expect(repo.jobCounts('send_message').pending).toBe(0)
      noWrites()
    })

    it('Reconectar (socket refeito) e parar o app também expiram o que ainda não saiu', async () => {
      await open()
      const a = queueSend(JID, 'um')
      await client.manualReconnect()
      expect(repo.sends.get(a.id)!.status).toBe('expired')
      await open()
      const b = queueSend(JID2, 'dois')
      await client.stop()
      expect(repo.sends.get(b.id)!.status).toBe('expired')
      noWrites()
      await client.start()
    })

    it('job confirmado numa conexão anterior (geração diferente): expira sem escrever nada', async () => {
      await open()
      const s = queueSend(JID, 'velho', { gen: client.connGen() - 1 })
      expect(await runSend()).toBe('ran')
      expect(repo.sends.get(s.id)).toMatchObject({ status: 'expired', error: 'a conexão caiu antes de enviar' })
      noWrites()
    })

    it('tentativa do job diferente da linha (job velho): não faz nada', async () => {
      await open()
      const s = queueSend(JID, 'x')
      // a linha virou a tentativa 2 (nova confirmação) e o job da tentativa 1 ainda roda
      repo.sends.transition(s.id, 1, ['queued'], 'failed', { error: 't' })
      const again = repo.sends.enqueue({ idemKey: s.idemKey, replyId: s.replyId, jid: JID, text: 'x', address: s.address, quotedId: null })
      expect(again.send.attempt).toBe(2)
      expect(await runSend()).toBe('ran')
      expect(repo.sends.get(s.id)!.status).toBe('queued')
      noWrites()
    })

    it('1:1 que migrou para @lid: "digitando…", envio e citação nenhuma vão para o @lid; lidas só desta conversa; indisponível no fim', async () => {
      await open()
      spyLog(last())
      const text = 'Oi! Te respondo já.'
      const s = queueSend(JID, text)
      expect(s.address).toBe(ANA_LID)
      const t = queue.tick()
      await vi.advanceTimersByTimeAsync(0)
      expect(log).toEqual([`presence:composing:${ANA_LID}`])
      expect(repo.sends.get(s.id)!.status).toBe('typing')
      await vi.advanceTimersByTimeAsync(typingMs(text, 0.5) - 1)
      expect(log).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      await t
      expect(log).toEqual([`presence:composing:${ANA_LID}`, `presence:paused:${ANA_LID}`, `send:${ANA_LID}`, 'read:c1,c2', 'presence:unavailable'])
      const [, content, sendOpts2] = last().spies.sendMessage.mock.calls[0]
      expect(content).toEqual({ text })
      // id gerado pelo app (para conferir depois), sem citação na individual
      expect(sendOpts2).toEqual({ messageId: expect.stringMatching(/^3EB0[0-9A-F]{36}$/) })
      expect(repo.sends.get(s.id)!.msgIds).toEqual([sendOpts2.messageId])
      // a chave original (o @lid como veio), só as mensagens do contato depois da última resposta do mentor, só desta conversa
      expect(last().spies.readMessages).toHaveBeenCalledWith([
        { remoteJid: JID, id: 'c1', fromMe: false },
        { remoteJid: '999:2@lid', id: 'c2', fromMe: false }
      ])
      const after = repo.sends.get(s.id)!
      expect(after).toMatchObject({ status: 'sent', waMsgId: 'WA-OUT-1', error: null })
      expect(repo.getApproved(after.replyId!)!.sentText).toBe(text)
      // registro: uma linha por etapa, com o envio e a impressão da conversa; nunca o texto nem o jid
      const lines = diagLines.filter(([k]) => k.startsWith('send_'))
      expect(lines.map(([k]) => k)).toEqual(['send_typing', 'send_sent'])
      for (const [, d] of lines) {
        expect(d).toContain(`send #${s.id} chat=${chatHash(JID)}`)
        expect(d).not.toContain(text)
        expect(d).not.toMatch(/5547999998888|999@lid/)
      }
    })

    it('1:1 só por telefone: vai para o telefone; o eco (mesmo vindo do @lid) cai na conversa certa', async () => {
      await open()
      spyLog(last())
      const s = queueSend(JID2, 'Certo!')
      expect(s.address).toBe(JID2)
      await runSend()
      expect(log).toContain(`send:${JID2}`)
      const id = repo.sends.get(s.id)!.msgIds[0]
      // o eco chega pelo @lid (rc14): fica na conversa de onde a resposta saiu
      await emit('messages.upsert', { messages: [{ ...wamsg({ id, fromMe: true, ts: NOW + 5_000, text: 'Certo!' }), key: { remoteJid: '555:1@lid', fromMe: true, id } }] })
      expect(repo.getMessage(id)!.jid).toBe(JID2)
    })

    it('grupo: cita a mensagem confirmada (chave original) e marca como lidas só as do grupo', async () => {
      await open()
      spyLog(last())
      const s = queueSend(GRP, 'Claro, vamos ver isso!')
      expect(s.quotedId).toBe('g0')
      // chega mensagem nova depois da confirmação: a citação continua a que o mentor viu
      await emit('messages.upsert', { messages: [wamsg({ id: 'g9', jid: GRP, participant: JID2, ts: NOW - 1_000, text: 'nova', contextInfo: { mentionedJid: [OWN] } })] })
      await runSend()
      const [jid, content, opts] = last().spies.sendMessage.mock.calls[0]
      expect(jid).toBe(GRP)
      expect(content).toEqual({ text: 'Claro, vamos ver isso!' })
      expect(opts.quoted.key).toEqual({ remoteJid: GRP, id: 'g0', fromMe: false, participant: JID2 })
      expect(opts.quoted.message).toEqual({ conversation: 'me ajuda @mentor?' })
      expect(opts.messageId).toMatch(/^3EB0/)
      expect(last().spies.readMessages).toHaveBeenCalledWith([
        { remoteJid: GRP, id: 'g0', fromMe: false, participant: JID2 },
        { remoteJid: GRP, id: 'g1', fromMe: false, participant: '888:1@lid' },
        { remoteJid: GRP, id: 'g9', fromMe: false, participant: JID2 }
      ])
    })

    it('v0.6.0 mensagem avulsa no grupo: mesmo caminho ("digitando…", id gerado, lidas), nunca cita, nunca grava na memória', async () => {
      await open()
      spyLog(last())
      // mesmo pedindo uma citação, a avulsa vai sem (o repositório nem guarda)
      const { send } = repo.sends.enqueue({ idemKey: 'avulsa:g:d1:x', kind: 'avulsa', replyId: null, jid: GRP, text: 'Aviso geral.', address: GRP, quotedId: 'g0' })
      expect(send).toMatchObject({ kind: 'avulsa', replyId: null, quotedId: null })
      queue.enqueue('send_message', sendJobKey(send), { sendId: send.id, attempt: send.attempt, gen: client.connGen() }, 20)
      await runSend()
      expect(log[0]).toBe(`presence:composing:${GRP}`)
      expect(last().spies.sendMessage.mock.calls[0]).toEqual([GRP, { text: 'Aviso geral.' }, { messageId: expect.stringMatching(/^3EB0/) }])
      // marcar como lida vale igual às respostas (as do grupo depois da última mensagem do mentor)
      expect(last().spies.readMessages).toHaveBeenCalledTimes(1)
      expect(repo.sends.get(send.id)).toMatchObject({ status: 'sent', waMsgId: 'WA-OUT-1' })
      expect(repo.listApproved({ limit: 100 })).toHaveLength(0)
      expect(diagLines.some(([k, d]) => k === 'send_sent' && d.endsWith(' avulsa'))).toBe(true)
    })

    it('grupo: a mensagem citada sumiu → envia sem citar; opções desligadas: sem "digitando", sem marcar como lida', async () => {
      await open()
      spyLog(last())
      queueSend(GRP, 'Agora é a parte 2.', { quotedId: 'nao-existe' })
      await runSend()
      expect(last().spies.sendMessage.mock.calls[0][2]).toEqual({ messageId: expect.any(String) })

      sendOpts = { enabled: true, typing: false, markRead: false, quoteInGroups: false, schedule: DEFAULT_SEND_OPTIONS.schedule }
      log = []
      clock.advance(120_000)
      queueSend(GRP, 'Outra coisa.')
      await runSend(0)
      expect(log).toEqual([`send:${GRP}`, 'presence:unavailable'])
      expect(last().spies.sendMessage.mock.calls[1]).toEqual([GRP, { text: 'Outra coisa.' }, { messageId: expect.any(String) }])
    })

    it('nunca inicia conversa: sem mensagem do contato nos últimos 30 dias (uma reação não conta) → não envia', async () => {
      clock.advance(31 * DAY)
      await open()
      // uma reação recente do contato não é conversa (nem chega ao banco)
      await emit('messages.upsert', { messages: [{ key: { remoteJid: JID, fromMe: false, id: 'react' }, messageTimestamp: Math.floor(clock.now() / 1000), message: { reactionMessage: { text: '👍', key: { id: 'm0' } } } }] })
      const s = queueSend(JID, 'Oi, sumido!')
      await runSend()
      noWrites()
      expect(repo.sends.get(s.id)).toMatchObject({ status: 'failed' })
      expect(diagLines.some(([k]) => k === 'send_failed')).toBe(true)
    })

    it('mais de 10 min na fila, cancelado ou envio direto desligado: não envia', async () => {
      await open()
      const old = queueSend(JID, 'velho')
      clock.advance(10 * 60_000 + 1)
      await runSend()
      expect(repo.sends.get(old.id)!.status).toBe('expired')

      const c = queueSend(JID, 'cancelado')
      repo.sends.transition(c.id, 1, ['queued'], 'canceled')
      clock.advance(120_000)
      await runSend()
      expect(repo.sends.get(c.id)!.status).toBe('canceled')

      sendOpts = { ...sendOpts, enabled: false }
      const off = queueSend(JID, 'desligado')
      clock.advance(120_000)
      await runSend()
      expect(repo.sends.get(off.id)!.status).toBe('expired')
      noWrites()
    })

    describe('horário de envio (v0.4.1)', () => {
      /** hora local de hoje (NOW é segunda 13:00 em Brasília; o vitest.config fixa o fuso) */
      const todayAt = (h: number, mi = 0, sec = 0) => {
        const d = new Date(NOW)
        return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi, sec).getTime()
      }
      const goTo = (ts: number) => clock.advance(ts - clock.now())

      it('fora do horário, sem forçar: expira antes do "digitando…", nada é escrito, registro sem texto nem jid', async () => {
        await open()
        goTo(todayAt(19))
        await emit('messages.upsert', { messages: [wamsg({ id: 'late1', ts: clock.now() - 60_000, text: 'tá aí?' })] })
        const s = queueSend(JID, 'Resposta das 19h')
        await runSend()
        expect(repo.sends.get(s.id)).toMatchObject({ status: 'expired', error: 'fora do horário de envio' })
        noWrites()
        const lines = diagLines.filter(([k]) => k === 'send_outside_hours')
        expect(lines).toHaveLength(1)
        for (const [, d] of diagLines) {
          expect(d).not.toContain('5547999998888')
          expect(d).not.toContain('Resposta das 19h')
        }
      })

      it('fora do horário, com "Forçar envio": sai normalmente (digitando, envia, marca como lida)', async () => {
        await open()
        spyLog(last())
        goTo(todayAt(19))
        const s = queueSend(JID, 'Forçado às 19h', { forced: true })
        await runSend()
        expect(repo.sends.get(s.id)!.status).toBe('sent')
        expect(log[0]).toMatch(/^presence:composing:/)
        expect(log.some((l) => l.startsWith('send:'))).toBe(true)
      })

      it('o fim do horário chega durante o "digitando…": expira antes de enviar (nunca sai depois)', async () => {
        await open()
        goTo(todayAt(17, 59, 58))
        last().spies.sendPresenceUpdate.mockImplementation(async (type: string) => {
          // o "digitando…" leva alguns segundos: passa das 18:00
          if (type === 'composing') clock.advance(5_000)
        })
        const s = queueSend(JID, 'Quase no fim do dia')
        await runSend()
        expect(repo.sends.get(s.id)).toMatchObject({ status: 'expired', error: 'fora do horário de envio' })
        expect(last().spies.sendMessage).not.toHaveBeenCalled()
        expect(diagLines.some(([k, d]) => k === 'send_outside_hours' && d.includes('antes de enviar'))).toBe(true)
      })

      it('horário desligado: sai a qualquer hora', async () => {
        await open()
        goTo(todayAt(23, 30))
        sendOpts = { ...sendOpts, schedule: { ...sendOpts.schedule, enabled: false } }
        const s = queueSend(JID, 'Tarde da noite')
        await runSend()
        expect(repo.sends.get(s.id)!.status).toBe('sent')
      })
    })

    it('o WhatsApp não confirmou: desconhecido, erro sem número; o eco com o id gerado aparece → enviada', async () => {
      await open()
      last().spies.sendMessage.mockRejectedValue(Object.assign(new Error('Timed Out para 5547999998888@s.whatsapp.net'), { output: { statusCode: 408 } }))
      const s = queueSend(JID, 'Pode sim!')
      await runSend()
      const row = repo.sends.get(s.id)!
      expect(row).toMatchObject({ status: 'unknown', error: 'envio sem confirmação (Error 408)' })
      expect(diagLines.filter(([k]) => k === 'send_unknown')).toHaveLength(1)
      for (const [, d] of diagLines) expect(d).not.toContain('5547999998888@')
      clock.advance(3_600_000)
      await runSend()
      expect(last().spies.sendMessage).toHaveBeenCalledTimes(1)
      // o eco chega (horas depois, relógio do PC diferente): confere pelo id, não pelo horário
      await emit('messages.upsert', { messages: [wamsg({ id: row.msgIds[0], fromMe: true, ts: NOW - 5 * DAY, text: 'Pode sim!' })] })
      expect(verifyUnknownSend(repo, repo.sends.get(s.id)!)).toBe(true)
      expect(repo.sends.get(s.id)).toMatchObject({ status: 'sent', waMsgId: row.msgIds[0] })
    })

    it('nova tentativa depois de desconhecido: se a anterior já chegou, marca enviada sem enviar de novo', async () => {
      await open()
      last().spies.sendMessage.mockRejectedValueOnce(new Error('Timed Out'))
      const s = queueSend(JID, 'Uma vez só')
      await runSend()
      const first = repo.sends.get(s.id)!
      expect(first.status).toBe('unknown')
      // o mentor confirma de novo; enquanto isso o eco da 1ª tentativa chega
      clock.advance(120_000)
      const again = repo.sends.enqueue({ idemKey: s.idemKey, replyId: s.replyId, jid: JID, text: 'Uma vez só', address: s.address, quotedId: null })
      queue.enqueue('send_message', sendJobKey(again.send), { sendId: s.id, attempt: 2, gen: client.connGen() }, 20)
      await emit('messages.upsert', { messages: [wamsg({ id: first.msgIds[0], fromMe: true, ts: NOW + 60_000, text: 'Uma vez só' })] })
      await runSend()
      expect(last().spies.sendMessage).toHaveBeenCalledTimes(1)
      expect(repo.sends.get(s.id)).toMatchObject({ status: 'sent', attempt: 2, waMsgId: first.msgIds[0] })
    })

    it('a conexão cai no meio do envio: desconhecido na hora; o bloqueio acaba com a conexão; a fila nunca reenvia', async () => {
      await open()
      let release: (v: unknown) => void = () => {}
      last().spies.sendMessage.mockImplementation(() => new Promise((r) => (release = r)))
      const s = queueSend(JID, 'Já vai!')
      const t = queue.tick()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(repo.sends.get(s.id)!.status).toBe('sending')
      expect(client.isSendInFlight(s.id)).toBe(true)
      await close(408)
      expect(repo.sends.get(s.id)).toMatchObject({ status: 'unknown', error: 'a conexão caiu durante o envio' })
      // o pedido era do socket que caiu: o bloqueio de reenvio acaba com a conexão
      expect(client.isSendInFlight(s.id)).toBe(false)
      // a resposta atrasada do WhatsApp confirma: vira enviada
      release({ key: { id: 'late' } })
      await t
      expect(repo.sends.get(s.id)).toMatchObject({ status: 'sent', waMsgId: 'late' })
      clock.advance(3_600_000)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sockets[0].spies.sendMessage).toHaveBeenCalledTimes(1)
    })

    it('"digitando" falhou: não enviada; a conexão cai durante o "digitando": expira; "Pausar tudo" durante o "digitando": expira', async () => {
      await open()
      last().spies.sendPresenceUpdate.mockRejectedValueOnce(Object.assign(new Error('Connection Closed 5547999998888'), { output: { statusCode: 428 } }))
      const a = queueSend(JID, 'um')
      await runSend()
      expect(repo.sends.get(a.id)).toMatchObject({ status: 'failed', error: '"digitando" falhou (Error 428)' })

      clock.advance(120_000)
      const b = queueSend(JID, 'dois')
      const t = queue.tick()
      await vi.advanceTimersByTimeAsync(100)
      await close(408)
      expect(repo.sends.get(b.id)).toMatchObject({ status: 'expired', error: 'a conexão caiu antes de enviar' })
      await vi.advanceTimersByTimeAsync(10_000)
      await t

      await advance(15_000)
      await open()
      clock.advance(120_000)
      const c = queueSend(JID, 'três')
      const t2 = queue.tick()
      await vi.advanceTimersByTimeAsync(100)
      queue.pause()
      await vi.advanceTimersByTimeAsync(10_000)
      await t2
      expect(repo.sends.get(c.id)).toMatchObject({ status: 'expired', error: 'pausado' })
      queue.resume()
      for (const sk of sockets) expect(sk.spies.sendMessage).not.toHaveBeenCalled()
    })

    it('pedido sem resposta por 10 min (conexão de pé): desconhecido, mas segue bloqueando; o próximo envio espera sem gastar vaga', async () => {
      await open()
      let release: (v: unknown) => void = () => {}
      last().spies.sendMessage.mockImplementationOnce(() => new Promise((r) => (release = r)))
      const a = queueSend(JID, 'primeiro')
      const t = queue.tick()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(repo.sends.get(a.id)!.status).toBe('sending')
      // o job estoura o prazo (180 s), o pedido continua no ar
      await vi.advanceTimersByTimeAsync(180_000)
      await t
      expect(client.isSendInFlight(a.id)).toBe(true)
      // o próximo envio chega na vez: espera, sem vaga do limitador e sem tentativa
      clock.advance(120_000)
      const b = queueSend(JID2, 'segundo')
      const before = limiters.send_message!.nextAllowedAt()
      for (let i = 0; i < 3; i++) await queue.tick()
      expect(limiters.send_message!.nextAllowedAt()).toBe(before)
      expect(repo.jobCounts('send_message')).toMatchObject({ pending: 1, running: 0 })
      expect(repo.sends.get(b.id)!.status).toBe('queued')
      // se o handler rodar mesmo assim, ele adia (sem gastar tentativa)
      await expect((client as any).executeSend({ sendId: b.id, attempt: 1, gen: client.connGen() })).rejects.toThrow(/outro envio ainda em andamento/)
      // 10 min sem resposta: desconhecido, mas o bloqueio continua
      clock.advance(10 * 60_000 + 1_000)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(repo.sends.get(a.id)).toMatchObject({ status: 'unknown', error: 'o WhatsApp não respondeu em 10 min' })
      expect(client.isSendInFlight(a.id)).toBe(true)
      expect(last().spies.sendMessage).toHaveBeenCalledTimes(1)
      // o pedido termina: vira enviada e o próximo pode sair (o de 10 min atrás expirou na fila)
      release({ key: { id: 'slow' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(repo.sends.get(a.id)).toMatchObject({ status: 'sent', waMsgId: 'slow' })
      expect(client.isSendInFlight(a.id)).toBe(false)
      const c = queueSend(JID2, 'terceiro')
      for (let i = 0; i < 3 && repo.sends.get(c.id)!.status === 'queued'; i++) {
        await runSend()
        clock.advance(120_000)
      }
      expect(repo.sends.get(b.id)!.status).toBe('expired')
      expect(repo.sends.get(c.id)!.status).toBe('sent')
      expect(last().spies.sendMessage).toHaveBeenCalledTimes(2)
    })

    it('prazo do job esgotado (sinal abortado) antes de enviar: não envia', async () => {
      await open()
      const s = queueSend(JID, 'tarde')
      const ctrl = new AbortController()
      ctrl.abort()
      await (client as any).executeSend({ sendId: s.id, attempt: 1, gen: client.connGen() }, ctrl.signal)
      expect(repo.sends.get(s.id)).toMatchObject({ status: 'failed', error: 'tempo esgotado antes de enviar' })
      noWrites()
    })
  })
})
