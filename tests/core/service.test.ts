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
    it('recoverAfterCrash, aquecimento em todos os 6 limitadores, cliente e fila; nenhuma chamada de IA', async () => {
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
      expect(warm).toHaveBeenCalledTimes(6)
      expect(qstart).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['recover', 'warmup', 'warmup', 'warmup', 'warmup', 'warmup', 'warmup', 'wa.start', 'queue.start'])
      expect(llmFactory).not.toHaveBeenCalled()
      expect(llm.calls).toBe(0)
    })

    it('200 áudios recebidos offline (histórico): 0 chamadas ao LLM, 200 downloads e 1 procura de alertas na fila', async () => {
      settings.save({ groqKey: GROQ_KEY })
      await service.start()
      const messages = Array.from({ length: 200 }, (_, i) => wamsg({ id: `A${i}`, ts: NOW - (i + 1) * 60_000, audio: 12 }))
      await emit('messaging-history.set', { chats: [], contacts: [], messages })
      const st = await service.getState()
      expect(st.queue.pending).toBe(201)
      const pending = repo.listJobs('pending')
      expect(pending.filter((j) => j.type === 'download_audio')).toHaveLength(200)
      // uma por conversa (não por mensagem), e ela espera o limitador próprio: nada roda em rajada
      expect(pending.filter((j) => j.type === 'classify')).toHaveLength(1)
      expect(llmFactory).not.toHaveBeenCalled()
      expect(llm.calls).toBe(0)
    })

    it('todo limitador persiste em settings_kv com a chave limiter:<nome>', () => {
      for (const [name, lim] of Object.entries(service.limiters)) {
        lim.record()
        expect(repo.getSetting(`limiter:${name}`), name).not.toBeNull()
      }
      expect(Object.keys(service.limiters).sort()).toEqual(['classify', 'groq_audio', 'llm', 'wa_media', 'wa_profile', 'wa_send'])
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

    it('grupos: listContacts filtra por tipo e listMessages traz o nome de quem mandou e a menção', async () => {
      const GRP = '120363025555555555@g.us'
      repo.upsertContact({ jid: JID })
      repo.insertMessage({ id: 'i1', jid: JID, fromMe: false, ts: NOW - 2000, kind: 'text', text: 'oi', mediaKeyJson: null, durationSec: null })
      repo.upsertContact({ jid: GRP, isGroup: true })
      repo.insertMessage({
        id: 'g1', jid: GRP, fromMe: false, ts: NOW - 1000, kind: 'text', text: 'Mentor?', mediaKeyJson: null, durationSec: null,
        isGroup: true, senderJid: '5511988887777@s.whatsapp.net', senderName: 'Bruno', mentionsMe: true
      })
      expect((await service.listContacts(false)).map((c) => c.jid)).toEqual([GRP, JID])
      expect((await service.listContacts(false, 'all')).map((c) => c.jid)).toEqual([GRP, JID])
      expect((await service.listContacts(false, 'group')).map((c) => [c.jid, c.isGroup])).toEqual([[GRP, true]])
      expect((await service.listContacts(false, 'individual')).map((c) => c.jid)).toEqual([JID])
      const [g] = await service.listMessages(GRP)
      expect(g).toMatchObject({ id: 'g1', senderJid: '5511988887777@s.whatsapp.net', senderName: 'Bruno', mentionsMe: true })
      expect((await service.listMessages(JID))[0]).toMatchObject({ senderJid: null, senderName: null, mentionsMe: false })
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

    it('escolher uma sugestão guarda a escolha na análise e as outras em rejected_json; análise nova limpa a escolha', async () => {
      settings.save({ groqKey: GROQ_KEY })
      repo.upsertContact({ jid: JID })
      repo.insertMessage({ id: 'q1', jid: JID, fromMe: false, ts: NOW - 60_000, kind: 'text', text: 'Quanto custa?', mediaKeyJson: null, durationSec: null })
      const r = await service.getAnalysis(JID)
      if (!r.ok) throw new Error('sem análise')
      const sugs = r.analysis.suggestions
      expect(r.analysis.chosenIndex).toBeNull()
      const id = await service.saveReply({ jid: JID, originalSuggestion: sugs[0], finalText: 'versão final', analysisLastMsgId: r.analysis.lastMsgId, chosenIndex: 0 })
      const [a] = repo.listApproved({ jid: JID, limit: 1 })
      expect(a.rejected).toEqual(sugs.slice(1))
      const stored = repo.getAnalysis(JID)!
      expect([stored.chosenIndex, stored.chosenReplyId]).toEqual([0, id])
      // sem chosenIndex (resposta escrita do zero): nada de rejected
      await service.saveReply({ jid: JID, originalSuggestion: null, finalText: 'outra totalmente diferente' })
      expect(repo.listApproved({ jid: JID, limit: 1 })[0].rejected).toEqual([])
      const again = await service.regenerate(JID)
      expect(again.ok && again.analysis.chosenIndex).toBeNull()
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

    it('v0.3.0: ao iniciar, os áudios das conversas que estavam escondidas (migração v11) voltam à fila uma vez', async () => {
      audio('u1')
      audio('u2', { file: true })
      repo.setSetting('migration.unhidden_jids', JSON.stringify([JID]))
      await service.start()
      const keys = repo.listJobs('pending').map((j) => `${j.type}:${j.key}`).sort()
      expect(keys).toEqual(['download_audio:u1', 'transcribe:transcribe:u2'])
      expect(repo.getSetting('migration.unhidden_jids')).toBeNull()
      const ev = repo.recentEvents(20).find((e) => e.kind === 'unhidden_requeue')!
      expect(ev.detail).toBe('1 conversa(s) voltaram a aparecer; 2 áudio(s) de volta à fila')
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

  describe('fila do dia e alertas', () => {
    const H = 3_600_000
    const ins = (id: string, ts: number, fromMe = false, text = 'oi') =>
      repo.upsertContact({ jid: JID }) ?? repo.insertMessage({ id, jid: JID, fromMe, ts, kind: 'text', text, mediaKeyJson: null, durationSec: null })
    const classifyJobs = () => [...repo.listJobs('pending'), ...repo.listJobs('running')].filter((j) => j.type === 'classify')
    const alertLlm = (alerts: unknown[]) => {
      const p = {
        name: 'groq' as const,
        calls: [] as string[],
        async complete(x: { user: string }) {
          p.calls.push(x.user)
          return { text: JSON.stringify({ alerts }), inputTokens: 1, outputTokens: 1 }
        }
      }
      return p
    }

    it('limitador próprio (20–40 s, 60/h, 400/dia) e sem rajada ao iniciar', async () => {
      const { LIMITS } = await import('../../src/core/queue/limiter')
      expect(LIMITS.classify).toEqual({ minGapMs: 20_000, maxGapMs: 40_000, perHour: 60, perDay: 400 })
      await service.start()
      // aquecimento: o primeiro job de alertas só sai depois de um intervalo (dobrado)
      expect(service.limiters.classify.nextAllowedAt() - clock.now()).toBeGreaterThanOrEqual(40_000)
    })

    it('mensagem nova do contato agenda a classificação só com chave da Groq; mensagens antigas e escondidos não', async () => {
      await service.start()
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'c1', ts: NOW - 60_000, text: 'Oi' })] })
      expect(classifyJobs()).toHaveLength(0)
      settings.save({ groqKey: GROQ_KEY })
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'c0', ts: NOW - 10 * 24 * H, text: 'antiga' })] })
      expect(classifyJobs()).toHaveLength(0)
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'c2', ts: NOW - 30_000, text: 'Oi de novo' })] })
      expect(classifyJobs()).toEqual([expect.objectContaining({ key: `classify:${JID}`, payload: { jid: JID, ts: NOW - 30_000 } })])
      repo.markJobDone(classifyJobs()[0].id)
      await service.setHidden(JID, true)
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'c3', ts: NOW - 20_000, text: 'escondido' })] })
      expect(classifyJobs()).toHaveLength(0)
    })

    it('usa a Groq mesmo com o Claude escolhido para as sugestões; sem chave da Groq, nunca chama o Claude', async () => {
      const groq = alertLlm([{ kind: 'reuniao', detail: 'Pede uma ligação amanhã', messageId: 1 }])
      llmFactory.mockImplementation(() => groq)
      settings.save({ claudeKey: 'sk-ant-SEGREDO', provider: 'claude' })
      ins('c1', NOW - 60_000, false, 'Pode me ligar amanhã?')
      service.queue.enqueue('classify', `classify:${JID}`, { jid: JID, ts: NOW - 60_000 })
      expect(await service.queue.tick()).toBe('ran')
      expect(llmFactory).not.toHaveBeenCalled()
      expect(repo.listAlerts(JID)).toEqual([])

      settings.save({ groqKey: GROQ_KEY })
      service.queue.requeue('classify', `classify:${JID}`, { jid: JID, ts: NOW - 60_000 })
      clock.advance(60_000)
      expect(await service.queue.tick()).toBe('ran')
      expect(llmFactory).toHaveBeenCalledTimes(1)
      expect(llmFactory).toHaveBeenCalledWith('groq', GROQ_KEY, expect.anything())
      expect(groq.calls).toHaveLength(1)
      expect(await service.listAlerts(JID)).toEqual([expect.objectContaining({ kind: 'reuniao', msgId: 'c1' })])
    })

    it('registro de diagnóstico: uma linha por job de alertas, sem texto nem jid', async () => {
      const lines: string[] = []
      await service.stop()
      service = make({ diag: (k, d) => lines.push(`${k} ${d}`) })
      llmFactory.mockImplementation(() => alertLlm([{ kind: 'urgente', detail: 'Prazo de amanhã', messageId: 1 }]))
      settings.save({ groqKey: GROQ_KEY })
      ins('c1', NOW - 60_000, false, 'Preciso até amanhã!!')
      service.queue.enqueue('classify', `classify:${JID}`, { jid: JID, ts: NOW - 60_000 })
      await service.queue.tick()
      const mine = lines.filter((l) => l.startsWith('classify '))
      expect(mine).toEqual([expect.stringMatching(/^classify result=ok alerts=1 ms=\d+$/)])
      expect(lines.join('\n')).not.toMatch(/amanhã|5547999998888|SEGREDO|gsk_/)
    })

    it('resposta do mentor resolve urgente/travado/reunião/esperando; desânimo fica até resolver à mão', async () => {
      await service.start()
      ins('c1', NOW - 60_000)
      for (const kind of ['urgente', 'travado', 'reuniao', 'esperando', 'desanimo'] as const) {
        repo.upsertAlert({ jid: JID, kind, detail: kind, msgId: 'c1' })
      }
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'me1', fromMe: true, ts: NOW, text: 'Respondi' })] })
      expect((await service.listAlerts(JID)).map((a) => a.kind)).toEqual(['desanimo'])
      const changed = vi.fn()
      service.onContactsChanged(changed)
      await service.dismissAlert(JID, 'desanimo')
      expect(await service.listAlerts(JID)).toEqual([])
      await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    })

    it('"esperando" nasce por regra depois de 48 h sem resposta; resolvido à mão não volta na mesma espera', async () => {
      repo.upsertContact({ jid: JID, pushName: 'Ana' })
      ins('m0', NOW - 50 * H, true)
      ins('c1', NOW - 47 * H)
      let [c] = await service.listContacts(false)
      expect(c.waitingSince).toBe(NOW - 47 * H)
      expect(c.alerts).toEqual([])
      clock.advance(2 * H)
      ;[c] = await service.listContacts(false)
      expect(c.alerts).toEqual(['esperando'])
      expect(service.state().triage).toEqual({ awaiting: 1, withAlerts: 1 })
      await service.dismissAlert(JID, 'esperando')
      ;[c] = await service.listContacts(false)
      expect(c.alerts).toEqual([])
      // o mentor responde e o contato escreve de novo: nova espera, novo alerta depois de 48 h
      ins('m1', clock.now(), true)
      ins('c2', clock.now() + 1000)
      clock.advance(49 * H)
      expect((await service.listAlerts(JID)).map((a) => a.kind)).toEqual(['esperando'])
      // escondido: fora dos alertas e da contagem
      await service.setHidden(JID, true)
      expect(await service.listAlerts()).toEqual([])
      expect(service.state().triage).toEqual({ awaiting: 0, withAlerts: 0 })
    })

    it('job de alertas que falha de vez não aparece como falha na barra de status', async () => {
      repo.upsertContact({ jid: JID })
      repo.insertJobIgnore('classify', `classify:${JID}`, { jid: JID, ts: NOW }, -1)
      repo.markJobRunning(repo.listJobs('pending')[0].id)
      const [job] = repo.listJobs('running')
      repo.markJobFailed(job.id, 2, 'x', 0)
      repo.markJobRunning(job.id)
      service.queue.recoverAfterCrash()
      expect(service.state().queue.failed).toBe(0)
      expect(repo.listJobs('done').map((j) => j.type)).toEqual(['classify'])
    })

    it('grupo: "esperando" só quando alguém mencionou o mentor na espera', async () => {
      const GRP = '120363025555555555@g.us'
      repo.upsertContact({ jid: GRP, isGroup: true })
      const g = (id: string, ts: number, mentionsMe: boolean) =>
        repo.insertMessage({ id, jid: GRP, fromMe: false, ts, kind: 'text', text: 'x', mediaKeyJson: null, durationSec: null, isGroup: true, senderJid: '5511@s.whatsapp.net', mentionsMe })
      g('g1', NOW - 60 * H, false)
      expect((await service.listContacts(false)).find((c) => c.jid === GRP)!.alerts).toEqual([])
      g('g2', NOW - 59 * H, true)
      expect((await service.listContacts(false)).find((c) => c.jid === GRP)!.alerts).toEqual(['esperando'])
    })
  })

  describe('"Para responder" (needsReply)', () => {
    const H = 3_600_000
    const ins = (id: string, ts: number, fromMe = false, text = 'oi') =>
      repo.insertMessage({ id, jid: JID, fromMe, ts, kind: 'text', text, mediaKeyJson: null, durationSec: null })
    const classifyJobs = () => repo.listJobs('pending').filter((j) => j.type === 'classify')

    it('"obrigado" que chega pelo WhatsApp sai da lista na hora, sem IA (mesmo sem chave) e sem job de alertas', async () => {
      await service.start()
      settings.save({ groqKey: GROQ_KEY })
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'me1', fromMe: true, ts: NOW - 120_000, text: 'Te mandei o link' })] })
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'c1', ts: NOW - 60_000, text: 'Obrigado!! 🙏' })] })
      const [c] = await service.listContacts(false)
      expect(c).toMatchObject({ awaitingReply: true, needsReply: false, replyDecision: { by: 'rule' } })
      expect(service.state().triage.awaiting).toBe(0)
      expect(classifyJobs()).toHaveLength(0)
      // pergunta nova: volta e vai para a IA
      await emit('messages.upsert', { type: 'notify', messages: [wamsg({ id: 'c2', ts: NOW - 30_000, text: 'Ah, e a aula de quinta?' })] })
      expect((await service.listContacts(false))[0].needsReply).toBe(true)
      expect(classifyJobs()).toHaveLength(1)
    })

    it('"Não precisa responder" resolve o "esperando" e ele não volta; "Precisa sim" devolve; registro sem texto', async () => {
      const lines: string[] = []
      await service.stop()
      service = make({ diag: (k, d) => lines.push(`${k} ${d}`) })
      repo.upsertContact({ jid: JID, pushName: 'Ana' })
      ins('m0', NOW - 60 * H, true)
      ins('c1', NOW - 50 * H, false, 'Segue o relatório da semana')
      expect((await service.listContacts(false))[0].alerts).toEqual(['esperando'])
      const changed = vi.fn()
      service.onContactsChanged(changed)
      await service.setNeedsReply(JID, false, { code: 'ligacao', text: 'liguei pra Ana' })
      await vi.waitFor(() => expect(changed).toHaveBeenCalled())
      let [c] = await service.listContacts(false)
      expect(c).toMatchObject({ needsReply: false, alerts: [] })
      clock.advance(H)
      expect((await service.listAlerts(JID))).toEqual([])
      expect(service.state().triage).toEqual({ awaiting: 0, withAlerts: 0 })
      await service.setNeedsReply(JID, true)
      ;[c] = await service.listContacts(false)
      expect(c.needsReply).toBe(true)
      expect((await service.alertQuality()).reply).toEqual({ removed: 0, restored: 0, confirmed: 1, correctRate: 1 })
      expect(service.alertFeedbackCsv({ anonymize: true }).rows).toBe(1)
      expect(lines.filter((l) => l.startsWith('reply_feedback'))).toEqual([
        'reply_feedback verdict=reply_not_needed reason=ligacao',
        'reply_feedback verdict=reply_needed'
      ])
      expect(lines.join('\n')).not.toMatch(/relatório|liguei|Ana|5547999998888/)
    })

    it('decisão da IA "não precisa": sem "esperando" e o ativo some; confirmNoReply (👍) grava reply_ok', async () => {
      repo.upsertContact({ jid: JID, pushName: 'Ana' })
      ins('c1', NOW - 50 * H, false, 'Segue o comprovante')
      expect((await service.listContacts(false))[0].alerts).toEqual(['esperando'])
      repo.setAppReply({ jid: JID, msgId: 'c1', needs: false, reason: 'Só informou', source: 'ai' })
      expect((await service.listContacts(false))[0]).toMatchObject({ needsReply: false, alerts: [] })
      await service.confirmNoReply(JID)
      expect(repo.listReplyFeedback()[0].verdict).toBe('reply_ok')
    })
  })

  describe('avaliação dos alertas', () => {
    const ins = (id: string, ts: number, fromMe = false, text = 'oi') =>
      repo.insertMessage({ id, jid: JID, fromMe, ts, kind: 'text', text, mediaKeyJson: null, durationSec: null })

    it('👍/👎 e "faltou": avisa a lista, a qualidade conta e o registro só tem veredito e tipo', async () => {
      const lines: string[] = []
      await service.stop()
      service = make({ diag: (k, d) => lines.push(`${k} ${d}`) })
      repo.upsertContact({ jid: JID, pushName: 'Ana' })
      ins('c1', NOW - 60_000, false, 'Preciso até amanhã kkk')
      repo.upsertAlert({ jid: JID, kind: 'urgente', detail: 'Prazo amanhã', msgId: 'c1' })
      const changed = vi.fn()
      service.onContactsChanged(changed)
      const [a] = await service.listAlerts(JID)
      await service.rateAlert(a.id, 'up')
      expect((await service.listAlerts(JID))[0].rating).toBe('up')
      await service.rateAlert(a.id, 'down', { code: 'tipo_errado', correctKind: 'reuniao', text: 'só brincou' })
      expect((await service.listAlerts(JID)).map((x) => [x.kind, x.source])).toEqual([['reuniao', 'user']])
      await service.reportMissedAlert(JID, 'desanimo', 'c1', 'Ela está cansada')
      await vi.waitFor(() => expect(changed).toHaveBeenCalled())
      const q = await service.alertQuality()
      expect(q.kinds.find((k) => k.kind === 'urgente')).toEqual({ kind: 'urgente', up: 0, down: 1, missed: 0, correctRate: 0 })
      expect(q.kinds.find((k) => k.kind === 'desanimo')!.missed).toBe(1)
      const { csv, rows } = service.alertFeedbackCsv({ anonymize: true })
      expect(rows).toBe(2)
      expect(csv).toContain('"Contato 1"')
      expect(csv).not.toContain('Ana')
      expect(service.alertFeedbackCsv({ anonymize: false }).csv).toContain('"Ana"')
      const mine = lines.filter((l) => l.startsWith('alert_feedback'))
      expect(mine).toEqual([
        'alert_feedback verdict=up',
        'alert_feedback verdict=down reason=tipo_errado',
        'alert_feedback verdict=missed kind=desanimo',
        'alert_feedback_export rows=2 anonymized=true',
        'alert_feedback_export rows=2 anonymized=false'
      ])
      expect(lines.join('\n')).not.toMatch(/amanhã|brincou|cansada|Ana|5547999998888/)
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
      // consultas ao WhatsApp ficam pausadas até a conexão abrir; aqui o job só serve para pendurar a fila
      service.queue.resumeType('fetch_profile')
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
      service.queue.resumeType('fetch_profile')
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
