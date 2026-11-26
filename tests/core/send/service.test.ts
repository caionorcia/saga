import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { sendJobKey } from '../../../src/core/db/sendRepo'
import { WhatsAppClient } from '../../../src/core/wa/client'
import { useAtomicAuthState } from '../../../src/core/wa/authState'
import type { LlmProvider } from '../../../src/core/ai/llm'
import { SettingsStore, type Cipher } from '../../../src/core/settings'
import { SagaService } from '../../../src/core/service'
import { chatHash } from '../../../src/core/send/logic'

const NOW = 1_764_000_000_000
const DAY = 86_400_000
const JID = '5547999998888@s.whatsapp.net'
const OLD = '5511988887777@s.whatsapp.net'
const OWN = '5547900000000:3@s.whatsapp.net'
const GOOD = JSON.stringify({ resumo: 'Quer saber o preço', sugestoes: ['Oi! Custa R$ 100.', 'Claro, te explico.'] })

/** tudo o que escreve no WhatsApp: só o caminho de envio pode chamar os três primeiros */
const WRITE_METHODS = ['sendMessage', 'sendPresenceUpdate', 'readMessages', 'sendReceipt', 'sendReceipts', 'chatModify', 'updateMediaMessage', 'logout'] as const

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s, 'utf8').reverse(),
  decrypt: (b) => Buffer.from(b).reverse().toString('utf8')
}

class FakeSocket {
  ev = new EventEmitter()
  end = vi.fn()
  spies: Record<string, ReturnType<typeof vi.fn>> = {}
  constructor(public config: any) {
    for (const name of WRITE_METHODS) {
      this.spies[name] = vi.fn(async () => (name === 'sendMessage' ? { key: { id: 'OUT' } } : undefined))
      ;(this as any)[name] = this.spies[name]
    }
  }
  emit(event: string, data: unknown): void {
    this.ev.emit(event, data)
  }
}

function wamsg(o: { id: string; jid?: string; fromMe?: boolean; ts: number; text?: string }): any {
  return {
    key: { remoteJid: o.jid ?? JID, fromMe: o.fromMe ?? false, id: o.id },
    messageTimestamp: Math.floor(o.ts / 1000),
    pushName: o.fromMe ? undefined : 'Ana',
    message: { conversation: o.text ?? 'oi' }
  }
}

describe('envio direto no serviço', () => {
  let tmp: string
  let clock: FakeClock
  let repo: Repo
  let settings: SettingsStore
  let sockets: FakeSocket[]
  let service: SagaService
  let diag: Array<[string, string]>

  const last = () => sockets[sockets.length - 1]
  const client = () => (service as any).wa as WhatsAppClient
  const writes = (names: readonly string[] = WRITE_METHODS) => sockets.reduce((n, s) => n + names.reduce((m, k) => m + s.spies[k].mock.calls.length, 0), 0)
  const emit = async (event: string, data: unknown) => {
    last().emit(event, data)
    await client().whenIdle()
  }
  /** deixa a fila rodar (o "digitando…" leva até 8,5 s) */
  const drain = async (ms = 30_000) => {
    clock.advance(ms)
    await vi.advanceTimersByTimeAsync(ms)
    await client().whenIdle()
  }

  function make(): SagaService {
    const llm: LlmProvider = { name: 'groq', complete: async () => ({ text: GOOD, inputTokens: 1, outputTokens: 1 }) } as any
    return new SagaService({
      repo,
      settings,
      clock,
      rng: () => 0,
      paths: { authDir: join(tmp, 'auth'), backupDir: join(tmp, 'auth-backup'), mediaDir: join(tmp, 'media') },
      hasFreeSpace: async () => true,
      diag: (k, d) => diag.push([k, d]),
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
          }
        }),
      llmFactory: () => llm,
      transcriberFactory: () => ({ transcribe: async () => 'x' }) as any,
      fetchWaVersion: async () => ({ version: [2, 3000, 1_100_000_001], isLatest: true })
    })
  }

  async function startOpen(): Promise<void> {
    await service.start()
    await emit('connection.update', { connection: 'open' })
    await emit('messaging-history.set', {
      chats: [],
      contacts: [],
      messages: [
        wamsg({ id: 'a1', ts: NOW - 3_600_000, text: 'Quanto custa a mentoria?' }),
        wamsg({ id: 'o1', jid: OLD, ts: NOW - 29 * DAY, text: 'oi, faz tempo' })
      ]
    })
  }

  const prepare = async (jid: string, text: string) => {
    const r = await service.prepareSend({ jid, text })
    if (!r.ok) throw new Error(r.code)
    return r.preview
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    tmp = mkdtempSync(join(tmpdir(), 'saga-send-'))
    clock = new FakeClock(NOW)
    repo = new Repo(openDb(':memory:'), clock)
    settings = new SettingsStore(repo, cipher)
    settings.save({ groqKey: 'gsk_x' })
    sockets = []
    diag = []
    service = make()
  })

  afterEach(async () => {
    await service.stop()
    // nenhum método de escrita fora do caminho de envio, nunca
    for (const s of sockets) for (const k of WRITE_METHODS.slice(3)) expect(s.spies[k], k).not.toHaveBeenCalled()
    // registro de diagnóstico do envio: nunca o texto nem o número
    for (const [k, d] of diag) if (k.startsWith('send_')) expect(d).not.toMatch(/5547999998888|5511988887777|custa|Combinado/i)
    vi.useRealTimers()
    rmSync(tmp, { recursive: true, force: true })
  })

  describe('confirmação obrigatória', () => {
    it('sem token, token de outro texto/conversa, vencido ou já usado: nada vai para a fila, nada é escrito', async () => {
      await startOpen()
      const bad = async (input: Parameters<SagaService['sendReply']>[0]) => {
        const r = await service.sendReply(input)
        expect(r).toMatchObject({ ok: false, code: 'not_confirmed' })
      }
      await bad({ token: '00000000-0000-4000-8000-000000000000', jid: JID, text: 'Oi!' })
      const p1 = await prepare(JID, 'Oi!')
      await bad({ token: p1.token, jid: JID, text: 'Oi! (editado depois)' })
      const p2 = await prepare(JID, 'Oi!')
      await bad({ token: p2.token, jid: OLD, text: 'Oi!' })
      const p3 = await prepare(JID, 'Oi!')
      clock.advance(5 * 60_000)
      await bad({ token: p3.token, jid: JID, text: 'Oi!' })
      await drain()
      expect(repo.jobCounts('send_message')).toMatchObject({ pending: 0, running: 0, done: 0, failed: 0 })
      expect(repo.sends.counts().queued).toBe(0)
      expect(writes()).toBe(0)
      expect(diag.filter(([k]) => k === 'send_refused')).toHaveLength(4)

      const ok = await prepare(JID, 'Oi!')
      expect((await service.sendReply({ token: ok.token, jid: JID, text: 'Oi!' })).ok).toBe(true)
      // o mesmo token não serve de novo
      await bad({ token: ok.token, jid: JID, text: 'Oi!' })
    })

    it('prepareSend: para quem vai e as opções; recusa envio desligado, conversa sem mensagem recente e conversa desconhecida', async () => {
      await startOpen()
      const p = await prepare(JID, '  Oi!  ')
      expect(p).toMatchObject({ jid: JID, text: 'Oi!', recipient: { name: 'Ana', phone: '+55 47 99999-8888', isGroup: false }, quote: null })
      expect(p.options).toEqual({ enabled: true, typing: true, markRead: true, quoteInGroups: true })
      clock.advance(2 * DAY)
      expect(await service.prepareSend({ jid: OLD, text: 'Oi' })).toMatchObject({ ok: false, code: 'no_recent_contact' })
      expect(await service.prepareSend({ jid: 'x@s.whatsapp.net', text: 'Oi' })).toMatchObject({ ok: false, code: 'unknown_chat' })
      expect(await service.prepareSend({ jid: JID, text: '   ' })).toMatchObject({ ok: false, code: 'empty' })
      await service.saveSettings({ directSend: false })
      expect(await service.prepareSend({ jid: JID, text: 'Oi' })).toMatchObject({ ok: false, code: 'disabled' })
      expect(writes()).toBe(0)
    })

    it('token válido mas o envio foi desligado no meio: recusado', async () => {
      await startOpen()
      const p = await prepare(JID, 'Oi!')
      await service.saveSettings({ directSend: false })
      expect(await service.sendReply({ token: p.token, jid: JID, text: 'Oi!' })).toMatchObject({ ok: false, code: 'disabled' })
    })
  })

  it('confirmado: escolhe a sugestão (memória com as não escolhidas), envia uma vez e grava o texto enviado', async () => {
    await startOpen()
    const a = await service.getAnalysis(JID)
    if (!a.ok) throw new Error('sem análise')
    const text = 'Oi! Custa R$ 100.'
    const p = await prepare(JID, text)
    const r = await service.sendReply({ token: p.token, jid: JID, text, originalSuggestion: a.analysis.suggestions[0], analysisLastMsgId: a.analysis.lastMsgId, chosenIndex: 0 })
    if (!r.ok) throw new Error(r.code)
    expect(r.send).toMatchObject({ status: 'queued', jid: JID, text })
    expect(r.send.etaAt).toBeGreaterThanOrEqual(NOW)
    const stored = repo.getAnalysis(JID)!
    expect([stored.chosenIndex, stored.chosenReplyId]).toEqual([0, r.send.replyId])
    expect(repo.getApproved(r.send.replyId)).toMatchObject({ finalText: text, rejected: ['Claro, te explico.'] })
    expect(diag.find(([k]) => k === 'send_queued')![1]).toMatch(new RegExp(`^send #${r.send.id} job #\\d+ chat=${chatHash(JID)}$`))

    const events: string[] = []
    service.onSends(JID, () => events.push('sends'))
    await drain()
    expect(last().spies.sendMessage).toHaveBeenCalledTimes(1)
    expect(last().spies.sendMessage).toHaveBeenCalledWith(JID, { text }, undefined)
    const [view] = await service.listSends(JID)
    expect(view).toMatchObject({ id: r.send.id, status: 'sent', etaAt: null })
    expect(repo.getApproved(r.send.replyId)!.sentText).toBe(text)
    expect(events.length).toBeGreaterThan(0)
    expect(diag.map(([k]) => k).filter((k) => k.startsWith('send_'))).toEqual(['send_queued', 'send_typing', 'send_sent'])

    // o eco da mensagem enviada chega pela ingestão normal: a conversa sai de "Para responder"
    await emit('messages.upsert', { messages: [wamsg({ id: 'OUT', fromMe: true, ts: NOW + 30_000, text })] })
    expect((await service.listContacts(false)).find((c) => c.jid === JID)!.needsReply).toBe(false)
  })

  it('idempotente: a mesma resposta com o mesmo texto não vira dois envios; depois de falhar, só com nova confirmação', async () => {
    await startOpen()
    const text = 'Combinado!'
    const p1 = await prepare(JID, text)
    const r1 = await service.sendReply({ token: p1.token, jid: JID, text })
    if (!r1.ok) throw new Error('falhou')
    const p2 = await prepare(JID, text)
    const r2 = await service.sendReply({ token: p2.token, jid: JID, text, replyId: r1.send.replyId })
    if (!r2.ok) throw new Error('falhou')
    expect(r2.send.id).toBe(r1.send.id)
    expect(repo.jobCounts('send_message').pending).toBe(1)
    // falhou no "digitando": não volta sozinho para a fila
    last().spies.sendPresenceUpdate.mockRejectedValueOnce(new Error('Connection Closed'))
    await drain()
    expect(repo.sends.get(r1.send.id)!.status).toBe('failed')
    await drain(3_600_000)
    expect(last().spies.sendMessage).not.toHaveBeenCalled()
    expect(await service.retryFailedJobs()).toBe(0)
    // "tentar de novo" = nova confirmação: a mesma linha, tentativa 2, job novo
    const p3 = await prepare(JID, text)
    const r3 = await service.sendReply({ token: p3.token, jid: JID, text, replyId: r1.send.replyId })
    if (!r3.ok) throw new Error('falhou')
    expect(r3.send.id).toBe(r1.send.id)
    expect(repo.sends.get(r1.send.id)!.attempt).toBe(2)
    expect(repo.jobIdByKey(sendJobKey({ id: r1.send.id, attempt: 2 }))).not.toBeNull()
    await drain()
    expect(last().spies.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('"Pausar tudo" segura o envio; parado mais de 10 min volta a "aguardando confirmação" (expirado, nunca sai)', async () => {
    await startOpen()
    await service.pauseAll()
    const p = await prepare(JID, 'Depois')
    const r = await service.sendReply({ token: p.token, jid: JID, text: 'Depois' })
    if (!r.ok) throw new Error('falhou')
    expect(r.send.waitingFor).toBe('paused')
    await drain(5 * 60_000)
    expect(repo.sends.get(r.send.id)!.status).toBe('queued')
    await drain(5 * 60_000 + 20_000)
    expect(repo.sends.get(r.send.id)).toMatchObject({ status: 'expired', error: 'mais de 10 min na fila' })
    await service.resumeAll()
    await drain()
    expect(writes()).toBe(0)
  })

  it('"Cancelar envio" enquanto está na fila', async () => {
    await startOpen()
    await service.pauseAll()
    const p = await prepare(JID, 'Ops')
    const r = await service.sendReply({ token: p.token, jid: JID, text: 'Ops' })
    if (!r.ok) throw new Error('falhou')
    expect(await service.cancelSend(r.send.id)).toBe(true)
    expect(await service.cancelSend(r.send.id)).toBe(false)
    await service.resumeAll()
    await drain()
    expect(repo.sends.get(r.send.id)!.status).toBe('canceled')
    expect(writes()).toBe(0)
  })

  it('desligar o envio direto expira o que estava na fila', async () => {
    await startOpen()
    await service.pauseAll()
    const p = await prepare(JID, 'X')
    const r = await service.sendReply({ token: p.token, jid: JID, text: 'X' })
    if (!r.ok) throw new Error('falhou')
    await service.saveSettings({ directSend: false })
    expect(repo.sends.get(r.send.id)).toMatchObject({ status: 'expired', error: 'envio direto desligado' })
  })

  describe('depois de reiniciar: nada sai sozinho, nunca reenviar no escuro', () => {
    /** envios deixados no banco por uma execução que caiu */
    function seed(status: 'queued' | 'typing' | 'sending', text: string): number {
      repo.upsertContact({ jid: JID, pushName: 'Ana' })
      const replyId = repo.insertApproved({ jid: JID, contextText: 'c', originalSuggestion: null, finalText: text, provider: 'groq' })
      const { send } = repo.sends.enqueue({ idemKey: `${replyId}:h`, replyId, jid: JID, text })
      repo.insertJobIgnore('send_message', sendJobKey(send), { sendId: send.id }, 20)
      if (status !== 'queued') repo.sends.transition(send.id, ['queued'], 'typing', { startedAt: NOW - 60_000 })
      if (status === 'sending') repo.sends.transition(send.id, ['typing'], 'sending')
      if (status !== 'queued') repo.markJobRunning(repo.jobIdByKey(sendJobKey(send))!)
      return send.id
    }

    it('na fila / "digitando" → expirado; no meio do envio → desconhecido; nenhuma escrita depois de abrir', async () => {
      const q = seed('queued', 'um')
      const t = seed('typing', 'dois')
      const s = seed('sending', 'três')
      await startOpen()
      await drain(60_000)
      expect(repo.sends.get(q)).toMatchObject({ status: 'expired', error: 'o Saga fechou antes de enviar' })
      expect(repo.sends.get(t)).toMatchObject({ status: 'expired' })
      expect(repo.sends.get(s)).toMatchObject({ status: 'unknown', error: 'o Saga fechou durante o envio' })
      expect(repo.jobCounts('send_message')).toMatchObject({ pending: 0, running: 0 })
      expect(writes()).toBe(0)
      // "Conferir" sem a mensagem na conversa: continua desconhecido (o mentor decide se envia de novo)
      expect((await service.checkSend(s))!.status).toBe('unknown')
    })

    it('desconhecido e a mensagem já está na conversa (±10 min): vira enviada, com o texto enviado na memória', async () => {
      const s = seed('sending', 'Combinado!')
      repo.insertMessage({ id: 'echo', jid: JID, fromMe: true, ts: NOW - 30_000, kind: 'text', text: 'Combinado!', mediaKeyJson: null, durationSec: null })
      await startOpen()
      expect(repo.sends.get(s)).toMatchObject({ status: 'sent', waMsgId: 'echo', sentAt: NOW - 30_000 })
      expect(repo.getApproved(repo.sends.get(s)!.replyId)!.sentText).toBe('Combinado!')
      expect(writes()).toBe(0)
    })

    it('desconhecido e o eco chega depois pela ingestão: vira enviada sozinho', async () => {
      const s = seed('sending', 'Combinado!')
      await startOpen()
      expect(repo.sends.get(s)!.status).toBe('unknown')
      await emit('messages.upsert', { messages: [wamsg({ id: 'late-echo', fromMe: true, ts: NOW + 60_000, text: 'Combinado!' })] })
      expect(repo.sends.get(s)).toMatchObject({ status: 'sent', waMsgId: 'late-echo' })
    })
  })
})
