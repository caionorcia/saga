import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('SagaService', () => {
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

  describe('retryAt', () => {
    it('expõe quando a reconexão está agendada (e null sem espera)', async () => {
      await service.start()
      expect(service.state().retryAt).toBeNull()
      last().emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: Object.assign(new Error('x'), { output: { statusCode: 408 } }) }
      })
      await client().whenIdle()
      const st = service.state()
      expect(st.conn).toBe('waiting_retry')
      expect(st.retryAt).toBeGreaterThan(NOW)
      expect(st.retryAt).toBeLessThanOrEqual(NOW + 12_000)
    })
  })

  describe('start()', () => {
    it('recoverAfterCrash, aquecimento em todos os 4 limitadores, cliente e fila; nenhuma chamada de IA', async () => {
      const order: string[] = []
      const recover = vi.spyOn(JobQueue.prototype, 'recoverAfterCrash').mockImplementation(function () {
        order.push('recover')
        return 0
      })
      const warm = vi.spyOn(RateLimiter.prototype, 'startWarmup').mockImplementation(function () {
        order.push('warmup')
      })
      const qstart = vi.spyOn(JobQueue.prototype, 'start').mockImplementation(function () {
        order.push('queue.start')
      })
      vi.spyOn(WhatsAppClient.prototype, 'start').mockImplementation(async function () {
        order.push('wa.start')
      })
      settings.save({ groqKey: GROQ_KEY })
      await service.start()
      expect(recover).toHaveBeenCalledTimes(1)
      expect(warm).toHaveBeenCalledTimes(4)
      expect(qstart).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['recover', 'warmup', 'warmup', 'warmup', 'warmup', 'wa.start', 'queue.start'])
      expect(llmFactory).not.toHaveBeenCalled()
      expect(llm.calls).toBe(0)
    })

    it('200 áudios recebidos offline (histórico): 0 chamadas ao LLM e 200 pendentes na fila', async () => {
      settings.save({ groqKey: GROQ_KEY })
      await service.start()
      const messages = Array.from({ length: 200 }, (_, i) => wamsg({ id: `A${i}`, ts: NOW - (i + 1) * 60_000, audio: 12 }))
      await emit('messaging-history.set', { chats: [], contacts: [], messages })
      const st = await service.getState()
      expect(st.queue.pending).toBe(200)
      expect(repo.listJobs('pending').every((j) => j.type === 'download_audio')).toBe(true)
      expect(llmFactory).not.toHaveBeenCalled()
      expect(llm.calls).toBe(0)
    })

    it('todo limitador persiste em settings_kv com a chave limiter:<nome>', () => {
      for (const [name, lim] of Object.entries(service.limiters)) {
        lim.record()
        expect(repo.getSetting(`limiter:${name}`), name).not.toBeNull()
      }
      expect(Object.keys(service.limiters).sort()).toEqual(['groq_audio', 'llm', 'wa_media', 'wa_profile'])
    })
  })

  describe('estado', () => {
    it('setUpdate entra no estado e emite', async () => {
      const states: any[] = []
      service.onState((s) => states.push(s))
      expect((await service.getState()).update).toEqual({ status: 'none' })
      service.setUpdate({ status: 'available', version: '0.2.0' })
      expect((await service.getState()).update).toEqual({ status: 'available', version: '0.2.0' })
      await vi.waitFor(() => expect(states.at(-1)?.update.status).toBe('available'))
    })

    it('conn, qr, pausa, custo, provedor; setupDone = chave Groq + WhatsApp já conectou (persistido)', async () => {
      const states: any[] = []
      service.onState((s) => states.push(s))
      await service.start()
      let st = await service.getState()
      expect(st).toMatchObject({ conn: 'connecting', qr: null, paused: false, diskLow: false, costTodayUsd: 0, setupDone: false, provider: 'groq' })

      await emit('connection.update', { qr: '2@abc,def,ghi' })
      st = await service.getState()
      expect(st.conn).toBe('needs_qr')
      expect(st.qr).toMatch(/^data:image\/png;base64,/)

      await emit('connection.update', { connection: 'open' })
      st = await service.getState()
      expect(st.conn).toBe('open')
      expect(st.qr).toBeNull()
      expect(st.setupDone).toBe(false) // falta a chave

      settings.save({ groqKey: GROQ_KEY })
      expect((await service.getState()).setupDone).toBe(true)
      await vi.waitFor(() => expect(states.some((s) => s.conn === 'open')).toBe(true))

      await service.stop()
      service = make()
      expect((await service.getState()).setupDone).toBe(true)
    })

    it('pauseAll / resumeAll', async () => {
      await service.pauseAll()
      expect((await service.getState()).paused).toBe(true)
      await service.resumeAll()
      expect((await service.getState()).paused).toBe(false)
    })

    it('retryFailedJobs devolve os falhos à fila', async () => {
      repo.insertJobIgnore('fetch_profile', 'p', {}, 0)
      const [j] = repo.listJobs('pending')
      repo.markJobFailed(j.id, 3, 'x', null)
      expect((await service.getState()).queue.failed).toBe(1)
      expect(await service.retryFailedJobs()).toBe(1)
      expect((await service.getState()).queue).toMatchObject({ failed: 0, pending: 1 })
    })
  })

  describe('mensagens', () => {
    it('toda mensagem minha de texto ingerida passa por reconcileSent', async () => {
      await service.start()
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'c1', ts: NOW - 60_000, text: 'Quanto custa?' })] })
      settings.save({ groqKey: GROQ_KEY })
      await service.saveReply({ jid: JID, originalSuggestion: 'Oi! Custa R$ 100.', finalText: 'Oi! Custa R$ 100,00.' })
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'me1', fromMe: true, ts: NOW, text: 'Oi! Custa R$ 100,00 :)' })] })
      const [a] = repo.listApproved({ jid: JID, limit: 5 })
      expect(a.sentText).toBe('Oi! Custa R$ 100,00 :)')
    })

    it('avisa contatos e mensagens do contato quando chega mensagem', async () => {
      const contacts = vi.fn()
      const msgs = vi.fn()
      const other = vi.fn()
      service.onContactsChanged(contacts)
      service.onMessages(JID, msgs)
      const off = service.onMessages('5511000000000@s.whatsapp.net', other)
      off()
      await service.start()
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'c1', ts: NOW - 60_000, text: 'Oi' })] })
      await vi.waitFor(() => {
        expect(contacts).toHaveBeenCalled()
        expect(msgs).toHaveBeenCalled()
      })
      expect(other).not.toHaveBeenCalled()
      const list = await service.listMessages(JID)
      expect(list).toEqual([
        expect.objectContaining({ id: 'c1', text: 'Oi', fromMe: false, kind: 'text', hasAudio: false })
      ])
      expect(list[0]).not.toHaveProperty('mediaKeyJson')
      expect((await service.listContacts(false)).map((c) => c.jid)).toEqual([JID])
    })

    it('transcrição que falha 3 vezes termina como failed', async () => {
      transcriber = {
        transcribe: async () => {
          throw new Error('HTTP 500')
        }
      }
      settings.save({ groqKey: GROQ_KEY })
      repo.upsertContact({ jid: JID })
      repo.insertMessage({ id: 'au1', jid: JID, fromMe: false, ts: NOW, kind: 'audio', text: null, mediaKeyJson: null, durationSec: 5 })
      const file = join(tmp, 'au1.ogg')
      writeFileSync(file, 'OggS')
      repo.setAudioPath('au1', file)
      service.queue.enqueue('transcribe', 'transcribe:au1', { id: 'au1', durationSec: 5 })
      for (const wait of [0, 30_000, 120_000]) {
        clock.advance(wait)
        expect(await service.queue.tick()).toBe('ran')
      }
      expect(repo.getMessage('au1')!.transcriptStatus).toBe('failed')
    })

    it('audioUrl: só para áudio baixado', async () => {
      repo.upsertContact({ jid: JID })
      repo.insertMessage({ id: 'au.1', jid: JID, fromMe: false, ts: NOW, kind: 'audio', text: null, mediaKeyJson: null, durationSec: 5 })
      expect(await service.audioUrl('au.1')).toBeNull()
      repo.setAudioPath('au.1', join(tmp, 'media', 'au_1.ogg'))
      expect(await service.audioUrl('au.1')).toBe('saga-media://audio/au_1')
      expect(await service.audioUrl('nada')).toBeNull()
    })
  })

  describe('análise', () => {
    beforeEach(() => {
      repo.upsertContact({ jid: JID, pushName: 'Ana' })
      repo.insertMessage({ id: 'm1', jid: JID, fromMe: true, ts: NOW - 3000, kind: 'text', text: 'Olá!', mediaKeyJson: null, durationSec: null })
      repo.insertMessage({ id: 'm2', jid: JID, fromMe: false, ts: NOW - 2000, kind: 'text', text: 'Quanto custa?', mediaKeyJson: null, durationSec: null })
      repo.insertMessage({ id: 'm3', jid: JID, fromMe: false, ts: NOW - 1000, kind: 'text', text: 'É para minha filha', mediaKeyJson: null, durationSec: null })
    })

    it('sem chave do provedor → erro tipado missing_key, sem chamar a IA', async () => {
      const r = await service.getAnalysis(JID)
      expect(r).toMatchObject({ ok: false, code: 'missing_key', provider: 'groq' })
      expect(llmFactory).not.toHaveBeenCalled()
      settings.save({ groqKey: GROQ_KEY, provider: 'claude' })
      expect(await service.getAnalysis(JID)).toMatchObject({ ok: false, code: 'missing_key', provider: 'claude' })
    })

    it('gera sob demanda com o provedor da configuração, usa o cache e regenerate força', async () => {
      settings.save({ groqKey: GROQ_KEY })
      const r = await service.getAnalysis(JID)
      expect(r).toMatchObject({ ok: true, analysis: { summary: 'Quer saber o preço', provider: 'groq' } })
      expect(llmFactory).toHaveBeenCalledWith('groq', GROQ_KEY, expect.objectContaining({ repo }))
      expect(llm.calls).toBe(1)
      await service.getAnalysis(JID)
      expect(llm.calls).toBe(1)
      await service.regenerate(JID)
      expect(llm.calls).toBe(2)
    })

    it('chamadas simultâneas para o mesmo contato geram uma vez só', async () => {
      settings.save({ groqKey: GROQ_KEY })
      const [a, b] = await Promise.all([service.getAnalysis(JID), service.getAnalysis(JID)])
      expect(a.ok && b.ok).toBe(true)
      expect(llm.calls).toBe(1)
    })

    it('getAnalysis e regenerate simultâneos para o mesmo contato: uma chamada só', async () => {
      settings.save({ groqKey: GROQ_KEY })
      const [a, b] = await Promise.all([service.getAnalysis(JID), service.regenerate(JID)])
      expect(a.ok && b.ok).toBe(true)
      expect(llm.calls).toBe(1)
      const [c, d] = await Promise.all([service.regenerate(JID), service.getAnalysis(JID)])
      expect(c.ok && d.ok).toBe(true)
      expect(llm.calls).toBe(2)
    })

    it('regenerate durante um getAnalysis que só leu o cache: ainda gera de novo (uma vez)', async () => {
      settings.save({ groqKey: GROQ_KEY })
      await service.getAnalysis(JID)
      expect(llm.calls).toBe(1)
      const [a, b, c] = await Promise.all([service.getAnalysis(JID), service.regenerate(JID), service.regenerate(JID)])
      expect(a.ok && b.ok && c.ok).toBe(true)
      expect(llm.calls).toBe(2)
      // um getAnalysis que chega durante o regenerate pega o resultado novo, sem outra chamada
      const [d, e] = await Promise.all([service.regenerate(JID), service.getAnalysis(JID)])
      expect(d.ok && e.ok).toBe(true)
      expect(llm.calls).toBe(3)
    })

    it('erros da IA viram códigos para a interface', async () => {
      settings.save({ groqKey: GROQ_KEY })
      const { InvalidKeyError } = await import('../../src/core/ai/transcriber')
      llm.complete = async () => {
        throw new InvalidKeyError()
      }
      expect(await service.getAnalysis(JID)).toMatchObject({ ok: false, code: 'invalid_key' })
      const { ModelUnavailableError } = await import('../../src/core/ai/groqModels')
      llm.complete = async () => {
        throw new ModelUnavailableError('chat')
      }
      const r = await service.getAnalysis(JID)
      expect(r).toMatchObject({ ok: false, code: 'model_unavailable' })
      expect(!r.ok && r.message).toMatch(/Nenhum modelo de IA da Groq/)
      settings.save({ dailyCapUsd: 0 })
      expect(await service.getAnalysis(JID)).toMatchObject({ ok: false, code: 'budget_exceeded' })
    })

    it('trocar a chave da Groq ou o modelo esquece a lista de modelos guardada', async () => {
      repo.setSetting('groq.models.cache', JSON.stringify({ at: 1, ids: ['x'] }))
      repo.setSetting('groq.models.bad', JSON.stringify({ y: 1 }))
      await service.saveSettings({ groqModel: 'qwen/qwen3-32b' })
      expect(repo.getSetting('groq.models.cache')).toBeNull()
      expect(repo.getSetting('groq.models.bad')).toBeNull()
    })

    it('saveReply grava em approved_replies com context_text = mensagens novas do contato e o provedor', async () => {
      settings.save({ groqKey: GROQ_KEY })
      await service.getAnalysis(JID)
      const id = await service.saveReply({ jid: JID, originalSuggestion: 'Oi! Custa R$ 100.', finalText: 'Oi! Custa R$ 120.' })
      const [a] = repo.listApproved({ jid: JID, limit: 5 })
      expect(a.id).toBe(id)
      expect(a.contextText).toBe('Quanto custa?\nÉ para minha filha')
      expect(a.originalSuggestion).toBe('Oi! Custa R$ 100.')
      expect(a.finalText).toBe('Oi! Custa R$ 120.')
      expect(a.provider).toBe('groq')
    })
  })

  describe('revisão final', () => {
    const close = async (code: number) =>
      emit('connection.update', { connection: 'close', lastDisconnect: { error: Object.assign(new Error('x'), { output: { statusCode: code } }) } })
    const audio = (id: string, o: { file?: boolean; ts?: number } = {}) => {
      repo.upsertContact({ jid: JID })
      repo.insertMessage({ id, jid: JID, fromMe: false, ts: o.ts ?? NOW - 1000, kind: 'audio', text: null, mediaKeyJson: null, durationSec: 30 })
      if (o.file) {
        const f = join(tmp, `${id}.ogg`)
        writeFileSync(f, 'OggS')
        repo.setAudioPath(id, f)
      }
    }

    it('405 duas vezes → stopped_outdated, mas NÃO sobrevive ao reinício: conecta de novo com versão nova', async () => {
      await service.start()
      await close(405)
      await new Promise((r) => setTimeout(r, 5))
      await client().whenIdle()
      await close(405)
      expect(service.state().conn).toBe('stopped_outdated')
      await service.stop()
      const before = sockets.length
      service = make()
      await service.start()
      expect(sockets.length).toBe(before + 1)
      expect(service.state()).toMatchObject({ conn: 'connecting', paused: false })
      expect(repo.getSetting('wa.stoppedState')).toBeNull()
    })

    it('parada stopped_outdated guardada pela 0.1.0 é descartada ao iniciar', async () => {
      repo.setSetting('wa.stoppedState', 'stopped_outdated')
      await service.start()
      expect(sockets).toHaveLength(1)
      expect(service.state().conn).toBe('connecting')
      expect(repo.getSetting('wa.stoppedState')).toBeNull()
    })

    it('falha no início: evento start_error, registro de diagnóstico e startError no estado; Tentar de novo inicia de novo', async () => {
      const diag: string[] = []
      service = make({ diag: (k, d) => diag.push(`${k} ${d}`) })
      const spy = vi.spyOn(service.queue, 'recoverAfterCrash').mockImplementationOnce(() => {
        throw new Error('banco travado')
      })
      await expect(service.start()).rejects.toThrow('banco travado')
      expect(service.state().startError).toBe('banco travado')
      expect(repo.recentEvents(3).map((e) => e.kind)).toContain('start_error')
      expect(diag.some((l) => l.startsWith('start_error') && l.includes('banco travado'))).toBe(true)
      expect(sockets).toHaveLength(0)
      await service.manualReconnect()
      expect(spy).toHaveBeenCalledTimes(2)
      expect(service.state().startError).toBeUndefined()
      expect(sockets).toHaveLength(1)
    })

    it('repassa o registro de diagnóstico ao cliente do WhatsApp', async () => {
      const diag: string[] = []
      service = make({ diag: (k, d) => diag.push(`${k} ${d}`) })
      await service.start()
      expect(diag.some((l) => l.startsWith('wa_version WhatsApp Web 2.3000.1100000001'))).toBe(true)
    })

    it.each([
      [403, 'stopped_restricted'],
      [440, 'stopped_replaced']
    ])('código %i (%s) sobrevive ao reinício: não conecta, mostra o estado; Reconectar limpa', async (code, state) => {
      await service.start()
      await close(code)
      expect(service.state().conn).toBe(state)
      await service.stop()
      const before = sockets.length
      service = make()
      await service.start()
      expect(sockets.length).toBe(before)
      expect(service.state()).toMatchObject({ conn: state, paused: true })
      await service.manualReconnect()
      expect(sockets.length).toBe(before + 1)
      expect(service.state()).toMatchObject({ conn: 'connecting', paused: false })
      await service.stop()
      service = make()
      await service.start()
      expect(sockets.length).toBe(before + 2)
    })

    it('transcrição concluída depois da análise: a próxima leitura gera de novo', async () => {
      settings.save({ groqKey: GROQ_KEY })
      audio('au1')
      expect(await service.getAnalysis(JID)).toMatchObject({ ok: true, analysis: { pendingAudios: 1 } })
      await service.getAnalysis(JID)
      expect(llm.calls).toBe(1)
      repo.setTranscript('au1', 'quero saber o preço', 'done')
      expect(await service.getAnalysis(JID)).toMatchObject({ ok: true, analysis: { pendingAudios: 0 } })
      expect(llm.calls).toBe(2)
    })

    it('copiou, enviou e só depois salvou: contexto da análise e sent_text pela mensagem já enviada', async () => {
      settings.save({ groqKey: GROQ_KEY })
      repo.upsertContact({ jid: JID })
      repo.insertMessage({ id: 'q1', jid: JID, fromMe: false, ts: NOW - 60_000, kind: 'text', text: 'Quanto custa?', mediaKeyJson: null, durationSec: null })
      const r = await service.getAnalysis(JID)
      expect(r.ok && r.analysis.lastMsgId).toBe('q1')
      await service.start()
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'me1', fromMe: true, ts: NOW - 30_000, text: 'Oi! Custa R$ 120,00.' })] })
      await service.saveReply({ jid: JID, originalSuggestion: 'Oi! Custa R$ 100.', finalText: 'Oi! Custa R$ 120.', analysisLastMsgId: 'q1' })
      let [a] = repo.listApproved({ jid: JID, limit: 1 })
      expect(a.contextText).toBe('Quanto custa?')
      expect(a.sentText).toBe('Oi! Custa R$ 120,00.')
      // sem o id da análise vindo da interface: usa a análise guardada
      await service.saveReply({ jid: JID, originalSuggestion: null, finalText: 'Outra coisa totalmente diferente aqui' })
      ;[a] = repo.listApproved({ jid: JID, limit: 1 })
      expect(a.contextText).toBe('Quanto custa?')
      expect(a.sentText).toBeNull()
    })

    it('OpenAI: custo da transcrição entra no gasto de hoje; acima do teto pausa a transcrição com o motivo', async () => {
      settings.save({ groqKey: GROQ_KEY, openaiKey: 'sk-SEGREDO', transcriber: 'openai', dailyCapUsd: 0.001 })
      audio('t1', { file: true })
      audio('t2', { file: true })
      service.queue.enqueue('transcribe', 'transcribe:t1', { id: 't1', durationSec: 30 })
      expect(await service.queue.tick()).toBe('ran')
      expect(repo.getMessage('t1')!.transcriptStatus).toBe('done')
      expect(service.state().costTodayUsd).toBeCloseTo(0.003, 10)
      clock.advance(60_000)
      service.queue.enqueue('transcribe', 'transcribe:t2', { id: 't2', durationSec: 30 })
      expect(await service.queue.tick()).toBe('ran')
      expect(repo.getMessage('t2')!.transcriptStatus).toBeNull()
      expect(service.state()).toMatchObject({ transcribePaused: true, transcribePausedReason: 'budget' })
      await service.saveSettings({ dailyCapUsd: 5 })
      expect(service.state()).toMatchObject({ transcribePaused: false, transcribePausedReason: null })
    })

    it('progresso dos downloads: só download_audio do lote atual (pendentes + concluídos desde o início)', async () => {
      repo.insertJobIgnore('download_audio', 'antigo', { id: 'antigo' }, 0)
      repo.markJobDone(repo.listJobs('pending')[0].id)
      service = make()
      service.queue.register('download_audio', async () => {})
      service.queue.resumeType('download_audio')
      for (const k of ['d1', 'd2', 'd3']) service.queue.enqueue('download_audio', k, { id: k })
      service.queue.enqueue('transcribe', 'transcribe:x', { id: 'x', durationSec: 5 })
      expect(service.state().downloads).toEqual({ remaining: 3, done: 0 })
      service.queue.pauseType('transcribe')
      expect(await service.queue.tick()).toBe('ran')
      expect(service.state().downloads).toEqual({ remaining: 2, done: 1 })
      for (let i = 0; i < 2; i++) {
        clock.advance(60_000)
        expect(await service.queue.tick()).toBe('ran')
      }
      // lote terminou: o próximo começa do zero
      expect(service.state().downloads).toEqual({ remaining: 0, done: 0 })
    })

    it('mostrar de novo um contato escondido volta a baixar/transcrever os áudios dele', async () => {
      audio('h1')
      audio('h2', { file: true })
      audio('h3')
      repo.setTranscript('h3', 'já feito', 'done')
      await service.setHidden(JID, true)
      expect(repo.listJobs('pending')).toEqual([])
      await service.setHidden(JID, false)
      const keys = repo.listJobs('pending').map((j) => `${j.type}:${j.key}`).sort()
      expect(keys).toEqual(['download_audio:h1', 'transcribe:transcribe:h2'])
    })
  })

  describe('configurações', () => {
    it('getSettings nunca contém o texto da chave', async () => {
      const r = await service.saveSettings({ groqKey: GROQ_KEY, claudeKey: 'sk-ant-SEGREDO', openaiKey: 'sk-SEGREDO2' })
      expect(r.ok).toBe(true)
      const s = await service.getSettings()
      expect(s.keys).toEqual({ groq: true, claude: true, openai: true })
      const text = JSON.stringify(s) + JSON.stringify(r) + JSON.stringify(await service.getState())
      for (const k of [GROQ_KEY, 'sk-ant-SEGREDO', 'sk-SEGREDO2']) expect(text).not.toContain(k)
      const events = JSON.stringify(repo.recentEvents(100))
      expect(events).not.toContain(GROQ_KEY)
    })

    it('criptografia indisponível → erro tipado e a chave não é salva', async () => {
      service = make({ settings: new SettingsStore(repo, { ...cipher, isAvailable: () => false }) })
      const r = await service.saveSettings({ groqKey: GROQ_KEY })
      expect(r).toMatchObject({ ok: false, code: 'encryption_unavailable' })
      expect((await service.getSettings()).keys.groq).toBe(false)
    })

    it('salvar uma chave retoma as transcrições pausadas por falta de chave', async () => {
      service.queue.pauseType('transcribe')
      await service.saveSettings({ groqKey: GROQ_KEY })
      expect(service.queue.isTypePaused('transcribe')).toBe(false)
    })

    it('testKey usa o fetch injetado e não registra a chave', async () => {
      const f = vi.fn(async () => new Response('{"data":[]}', { status: 200 }))
      service = make({ fetchImpl: f as any })
      expect(await service.testKey('groq', GROQ_KEY)).toBe(true)
      expect(f).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(repo.recentEvents(100))).not.toContain(GROQ_KEY)
    })
  })

  describe('stop()', () => {
    it('prazo por etapa: um cliente do WhatsApp que não para também não segura a saída', async () => {
      await service.start()
      vi.spyOn(client(), 'stop').mockImplementation(() => new Promise<void>(() => {}))
      const t0 = Date.now()
      await service.stop({ timeoutMs: 100 })
      expect(Date.now() - t0).toBeLessThan(1_000)
    })

    it('job que termina depois do banco fechado não gera rejeição sem tratamento', async () => {
      const db = openDb(':memory:')
      repo = new Repo(db, clock)
      settings = new SettingsStore(repo, cipher)
      service = make()
      let release!: () => void
      await service.start()
      service.queue.register('fetch_profile', () => new Promise<void>((r) => (release = r)))
      service.queue.enqueue('fetch_profile', 'tarde', {})
      await vi.waitFor(() => expect(repo.listJobs('running')).toHaveLength(1))
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      try {
        await service.stop({ timeoutMs: 50 })
        db.close()
        release()
        await new Promise((r) => setTimeout(r, 200))
        expect(unhandled).not.toHaveBeenCalled()
      } finally {
        process.off('unhandledRejection', unhandled)
      }
    })

    it('para a fila esperando o job atual por no máximo o tempo dado, e para o cliente', async () => {
      await service.start()
      service.queue.register('fetch_profile', () => new Promise<void>(() => {}))
      service.queue.enqueue('fetch_profile', 'pendura', {})
      await vi.waitFor(() => expect(repo.listJobs('running')).toHaveLength(1))
      const waStop = vi.spyOn(client(), 'stop')
      const t0 = Date.now()
      await service.stop({ timeoutMs: 100 })
      expect(Date.now() - t0).toBeLessThan(2_000)
      expect(waStop).toHaveBeenCalled()
    })
  })
})
