import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECENT_WINDOW_MS } from '../../src/core/recent'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock } from '../../src/core/clock'
import { openDb } from '../../src/core/db/db'
import { Repo } from '../../src/core/db/repo'
import { JobQueue } from '../../src/core/queue/queue'
import { RateLimiter } from '../../src/core/queue/limiter'
import { WhatsAppClient } from '../../src/core/wa/client'
import { useAtomicAuthState } from '../../src/core/wa/authState'
import type { LlmProvider } from '../../src/core/ai/llm'
import type { Transcriber } from '../../src/core/ai/transcriber'
import { SettingsStore, type Cipher } from '../../src/core/settings'
import { SagaService, type SagaServiceOpts } from '../../src/core/service'

const NOW = 1_764_000_000_000
const JID = '5547999998888@s.whatsapp.net'
const OWN = '5547900000000:3@s.whatsapp.net'
const GROQ_KEY = 'gsk_TESTE_SEGREDO_abc123'
const GOOD = JSON.stringify({ resumo: 'Quer saber o preço', sugestoes: ['Oi! Custa R$ 100.', 'Claro, te explico.'] })

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s, 'utf8').reverse(),
  decrypt: (b) => Buffer.from(b).reverse().toString('utf8')
}

class FakeSocket {
  ev = new EventEmitter()
  end = vi.fn()
  constructor(public config: any) {}
  emit(event: string, data: unknown): void {
    this.ev.emit(event, data)
  }
}

function wamsg(o: { id: string; fromMe?: boolean; ts: number; text?: string; audio?: number }): any {
  const message =
    o.audio !== undefined
      ? { audioMessage: { url: 'https://mmg.whatsapp.net/x.enc', directPath: '/x.enc', mediaKey: Buffer.alloc(32, 1), seconds: o.audio, ptt: true } }
      : { conversation: o.text ?? 'oi' }
  return {
    key: { remoteJid: JID, fromMe: o.fromMe ?? false, id: o.id },
    messageTimestamp: Math.floor(o.ts / 1000),
    pushName: o.fromMe ? undefined : 'Ana',
    message
  }
}

function fakeLlm(): LlmProvider & { calls: number } {
  const p = {
    name: 'groq' as const,
    calls: 0,
    async complete() {
      p.calls++
      return { text: GOOD, inputTokens: 10, outputTokens: 10 }
    }
  }
  return p
}

/**
 * v0.9.0 (contrato v1.3): histórico completo guardado; a janela de 30 dias vale para a IA, os alertas, o "Para responder",
 * o download automático dos áudios e a transcrição. Áudio antigo: "Transcrever" sob pedido. Conversa em páginas.
 */
const DAY = 86_400_000
const BIA = '5511988887777@s.whatsapp.net'

describe('SagaService: histórico completo (v0.9.0)', () => {
  let tmp: string
  let clock: FakeClock
  let repo: Repo
  let settings: SettingsStore
  let sockets: FakeSocket[]
  let llm: ReturnType<typeof fakeLlm>
  let llmFactory: ReturnType<typeof vi.fn>
  let transcriber: Transcriber
  let service: SagaService

  const last = () => sockets[sockets.length - 1]
  const client = () => (service as any).wa as WhatsAppClient
  const emit = async (event: string, data: unknown) => {
    last().emit(event, data)
    await client().whenIdle()
  }

  function make(extra: Partial<SagaServiceOpts> = {}): SagaService {
    return new SagaService({
      repo,
      settings,
      clock,
      rng: () => 0,
      paths: { authDir: join(tmp, 'auth'), backupDir: join(tmp, 'auth-backup'), mediaDir: join(tmp, 'media') },
      hasFreeSpace: async () => true,
      waClientFactory: (deps) =>
        new WhatsAppClient({
          ...deps,
          socketFactory: (cfg) => {
            const s = new FakeSocket(cfg)
            sockets.push(s)
            return s as any
          },
          authStateFactory: async (dir, backup) => {
            const a = await useAtomicAuthState(dir, backup)
            a.state.creds.me = { id: OWN, name: 'Mentor' }
            return a
          },
          download: async () => Buffer.from('OggS')
        }),
      llmFactory: llmFactory as any,
      transcriberFactory: () => transcriber,
      fetchWaVersion: async () => ({ version: [2, 3000, 1_100_000_001], isLatest: true }),
      ...extra
    })
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'saga-svc-'))
    clock = new FakeClock(NOW)
    repo = new Repo(openDb(':memory:'), clock)
    settings = new SettingsStore(repo, cipher)
    sockets = []
    llm = fakeLlm()
    llmFactory = vi.fn(() => llm)
    transcriber = { transcribe: async () => 'transcrito' }
    service = make()
  })

  afterEach(async () => {
    await service.stop()
    vi.restoreAllMocks()
    rmSync(tmp, { recursive: true, force: true })
  })


  const open = async () => {
    await service.start()
    await emit('connection.update', { connection: 'open' })
  }
  const tickAll = async (n = 10) => {
    for (let i = 0; i < n; i++) {
      await service.queue.tick()
      clock.advance(7_000)
      await client().whenIdle()
    }
  }

  it('guarda mensagens de qualquer data; as antigas não geram alerta, "Para responder", IA nem download', async () => {
    settings.save({ groqKey: GROQ_KEY })
    await open()
    await emit('messaging-history.set', {
      chats: [],
      contacts: [],
      messages: [
        wamsg({ id: 'velha', ts: NOW - 400 * DAY, text: 'preciso urgente de ajuda!' }),
        wamsg({ id: 'au-velho', ts: NOW - 200 * DAY, audio: 20 }),
        wamsg({ id: 'mes', ts: NOW - 31 * DAY, text: 'alguém me responde?' })
      ]
    })
    // uma mensagem de hoje em outra conversa: o "agora" do WhatsApp
    repo.upsertContact({ jid: BIA })
    repo.insertMessage({ id: 'b1', jid: BIA, fromMe: true, ts: NOW - 1000, kind: 'text', text: 'oi', mediaKeyJson: null, durationSec: null })
    expect(repo.messageCount(JID)).toBe(3)
    const jobs = [...repo.listJobs('pending'), ...repo.listJobs('running')]
    expect(jobs.filter((j) => j.type === 'download_audio' || j.type === 'transcribe' || j.type === 'classify')).toEqual([])
    const ana = (await service.listContacts(false)).find((c) => c.jid === JID)!
    expect(ana).toMatchObject({ awaitingReply: false, needsReply: false, alerts: [] })
    expect(repo.triageCounts().awaiting).toBe(0)
    // a IA (resumo/sugestões) só olha os últimos 30 dias: sem mensagem nesse tempo, não é chamada
    const r = await service.getAnalysis(JID)
    expect(r.ok).toBe(false)
    expect(llm.calls).toBe(0)
  })

  it('mensagem recente segue como antes (alerta/IA/download) mesmo com histórico antigo na mesma conversa', async () => {
    settings.save({ groqKey: GROQ_KEY })
    await open()
    await emit('messaging-history.set', {
      chats: [],
      contacts: [],
      messages: [wamsg({ id: 'velha', ts: NOW - 400 * DAY, text: 'antiga' }), wamsg({ id: 'au-novo', ts: NOW - DAY, audio: 8 })]
    })
    expect(repo.listJobs('pending').filter((j) => j.type === 'download_audio').map((j) => j.key)).toEqual(['au-novo'])
    expect((await service.listContacts(false))[0]).toMatchObject({ awaitingReply: true, needsReply: true })
    const r = await service.getAnalysis(JID)
    expect(r.ok).toBe(true)
  })

  it('áudio antigo: "🎤 áudio" com Transcrever; o pedido baixa e transcreve só ele, pela fila (com prioridade)', async () => {
    settings.save({ groqKey: GROQ_KEY })
    await open()
    await emit('messaging-history.set', {
      chats: [],
      contacts: [],
      messages: [wamsg({ id: 'au-velho', ts: NOW - 90 * DAY, audio: 15 }), wamsg({ id: 'au-velho2', ts: NOW - 91 * DAY, audio: 15 }), wamsg({ id: 'hoje', ts: NOW - 1000 })]
    })
    let page = await service.listMessagesPage(JID, 200)
    expect(page.messages.filter((m) => m.onDemand).map((m) => m.id).sort()).toEqual(['au-velho', 'au-velho2'])
    expect(await service.transcribeAudio('hoje')).toBe(false)
    expect(await service.transcribeAudio('au-velho')).toBe(true)
    expect(repo.listJobs('pending').find((j) => j.key === 'au-velho')).toMatchObject({ type: 'download_audio', priority: 10, payload: { manual: true } })
    // na fila: sai do "Transcrever" (vira "Transcrevendo…")
    page = await service.listMessagesPage(JID, 200)
    expect(page.messages.find((m) => m.id === 'au-velho')!.onDemand).toBeUndefined()
    expect(page.messages.find((m) => m.id === 'au-velho2')!.onDemand).toBe(true)
    await tickAll(40)
    expect(repo.getMessage('au-velho')).toMatchObject({ transcriptStatus: 'done', transcript: 'transcrito' })
    // só ele: o outro áudio antigo continua esperando o pedido
    expect(repo.getMessage('au-velho2')).toMatchObject({ transcriptStatus: null, audioPath: null })
  })

  it('"Transcrever" respeita o limite de gasto do dia (a transcrição pausa, o áudio fica esperando)', async () => {
    settings.save({ groqKey: GROQ_KEY, openaiKey: 'sk-SEGREDO', transcriber: 'openai', dailyCapUsd: 0.000001 })
    await open()
    await emit('messaging-history.set', { chats: [], contacts: [], messages: [wamsg({ id: 'au-velho', ts: NOW - 90 * DAY, audio: 600 }), wamsg({ id: 'hoje', ts: NOW - 1000 })] })
    // o gasto de hoje já passou do teto
    ;(service as any).cost.addUsd(1)
    expect(await service.transcribeAudio('au-velho')).toBe(true)
    await tickAll(40)
    expect(repo.getMessage('au-velho')!.transcriptStatus).toBeNull()
    expect(service.state()).toMatchObject({ transcribePaused: true, transcribePausedReason: 'budget' })
  })

  it('conversa em páginas: as mais novas primeiro, "mais antigas" aos poucos, e até uma mensagem pedida', async () => {
    repo.upsertContact({ jid: JID })
    repo.transaction(() => {
      for (let i = 0; i < 450; i++) repo.insertMessage({ id: `p${i}`, jid: JID, fromMe: i % 3 === 0, ts: NOW - (450 - i) * 60_000, kind: 'text', text: `m${i}`, mediaKeyJson: null, durationSec: null })
    })
    let p = await service.listMessagesPage(JID, 200)
    expect(p.messages).toHaveLength(200)
    expect(p.messages[0].id).toBe('p250')
    expect(p.messages[199].id).toBe('p449')
    expect(p.hasMore).toBe(true)
    p = await service.listMessagesPage(JID, 400)
    expect(p.messages[0].id).toBe('p50')
    p = await service.listMessagesPage(JID, 600)
    expect(p).toMatchObject({ hasMore: false })
    expect(p.messages).toHaveLength(450)
    // até a mensagem pedida (mais 20 antes dela)
    p = await service.listMessagesPage(JID, 200, 'p10')
    expect(p.messages[0].id).toBe('p0')
    p = await service.listMessagesPage(JID, 200, 'p100')
    expect(p.messages[0].id).toBe('p80')
    expect(p.hasMore).toBe(true)
    // listMessages (sugestões) continua com as mais novas
    expect((await service.listMessages(JID)).length).toBe(300)
    expect(RECENT_WINDOW_MS).toBe(30 * DAY)
  })
})
