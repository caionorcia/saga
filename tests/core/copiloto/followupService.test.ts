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
import { DEFAULT_SEND_SCHEDULE, cloneSchedule } from '../../../src/shared/sendHours'
import { rosterHash } from '../../../src/core/copiloto/identity'


const WEBHOOK = 'https://exemplo.supabase.co/functions/v1/sagazap-webhook'
const FU = '44444444-4444-4444-8444-444444444444'
const FU_OLD = '55555555-5555-4555-8555-555555555555'
let pending: unknown[] = []
let updates: any[] = []
const fetchMock = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'))
  if (body.action === 'roster') return new Response(JSON.stringify({ version: 1, phones: [] }), { status: 200 })
  if (body.action === 'followups_pending') return new Response(JSON.stringify({ version: 1, followups: pending }), { status: 200 })
  if (body.action === 'followup_update') {
    updates.push(...body.updates)
    return new Response(JSON.stringify({ results: body.updates.map((u: { id: string }) => ({ id: u.id, status: 'updated' })) }), { status: 200 })
  }
  return new Response(JSON.stringify({ results: [] }), { status: 200 })
})
const target = (phone: string) => ({ kind: 'individual', phone_hashes: [rosterHash(phone)] })

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

describe('follow-up do Copiloto no serviço (v0.7.0)', () => {
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
      cipher,
      fetchImpl: fetchMock as unknown as typeof fetch,
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


  /** liga a integração e deixa a busca trazer os follow-ups */
  async function withFollowups(): Promise<void> {
    pending = [
      { id: FU, target: target('5547999998888'), text: 'Oi! Como foi a semana?', author: 'Equipe', created_at: new Date(NOW - 3_600_000).toISOString() },
      { id: FU_OLD, target: target('5511988887777'), text: 'Faz tempo! Tudo bem?', author: null, created_at: new Date(NOW - 3_600_000).toISOString() }
    ]
    updates = []
    service.copiloto.save({ url: WEBHOOK })
    service.copiloto.generateCode()
    service.copiloto.save({ enabled: true })
    for (let i = 0; i < 4; i++) await service.copiloto.tick().then((n) => clock.advance(n ?? 2_000))
  }
  const report = async () => {
    for (let i = 0; i < 4; i++) await service.copiloto.tick().then((n) => clock.advance(n ?? 2_000))
  }
  const prepareAvulsa = async (jid: string, text: string) => {
    const r = await service.prepareSend({ jid, text, kind: 'avulsa' })
    if (!r.ok) throw new Error(r.code)
    return r.preview
  }

  it('abrir → editar → confirmar → envia uma vez pela fila da avulsa e relata "sent" com o texto editado; nada na memória', async () => {
    await startOpen()
    await withFollowups()
    const list = await service.listFollowups()
    expect(list.map((f) => [f.id, f.jid, f.status])).toEqual([[FU, JID, 'waiting'], [FU_OLD, OLD, 'waiting']])
    const opened = await service.followupOpen(FU)
    expect(opened).toMatchObject({ ok: true, followup: { id: FU, text: 'Oi! Como foi a semana?' } })
    const before = repo.listApproved({ limit: 100 }).length
    const text = 'Oi, Ana! Como foi a semana?'
    const r = await service.sendAvulsa({ token: (await prepareAvulsa(JID, text)).token, jid: JID, text, draftId: FU })
    if (!r.ok) throw new Error(r.code)
    expect(repo.followups.get(FU)).toMatchObject({ status: 'sending', sendId: r.send.id })
    // de novo, mesmo com outro texto: nunca um segundo envio do mesmo follow-up
    expect(await service.sendAvulsa({ token: (await prepareAvulsa(JID, 'outro')).token, jid: JID, text: 'outro', draftId: FU })).toMatchObject({ ok: false, code: 'in_flight' })
    await drain()
    const row = repo.sends.get(r.send.id)!
    expect(row.status).toBe('sent')
    expect(last().spies.sendMessage).toHaveBeenCalledTimes(1)
    // nunca cita, mesmo que fosse grupo; e o eco confirma
    expect(last().spies.sendMessage).toHaveBeenCalledWith(JID, { text }, { messageId: row.msgIds[0] })
    await emit('messages.upsert', { messages: [wamsg({ id: row.msgIds[0], fromMe: true, ts: NOW + 40_000, text })] })
    await vi.advanceTimersByTimeAsync(1_000)
    await report()
    expect(repo.followups.get(FU)).toMatchObject({ status: 'sent', finalText: text, reported: true })
    expect(updates).toContainEqual({ id: FU, status: 'sent', final_text: text, sent_at: new Date(NOW + 40_000).toISOString(), reason: null })
    expect(repo.listApproved({ limit: 100 })).toHaveLength(before)
    expect(await service.sendAvulsa({ token: (await prepareAvulsa(JID, text)).token, jid: JID, text, draftId: FU })).toMatchObject({ ok: false, code: 'followup_done' })
    expect(await service.followupOpen(FU)).toMatchObject({ ok: false, code: 'done' })
  })

  it('regra dos 30 dias: "Abrir para enviar" recusa e o follow-up vai ao Copiloto como "fora_30_dias"', async () => {
    await startOpen()
    await withFollowups()
    clock.advance(2 * DAY)
    expect(await service.followupOpen(FU_OLD)).toMatchObject({ ok: false, code: 'fora_30_dias' })
    expect(repo.followups.get(FU_OLD)).toMatchObject({ status: 'failed', reason: 'fora_30_dias' })
    await report()
    expect(updates).toContainEqual({ id: FU_OLD, status: 'failed', final_text: null, sent_at: null, reason: 'fora_30_dias' })
    expect(writes()).toBe(0)
  })

  it('recusar com motivo; texto acima de 4000 recusado; follow-up de outra conversa recusado', async () => {
    await startOpen()
    await withFollowups()
    const long = 'a'.repeat(4001)
    expect(await service.sendAvulsa({ token: (await prepareAvulsa(JID, long)).token, jid: JID, text: long, draftId: FU })).toMatchObject({ ok: false, code: 'too_long' })
    expect(await service.sendAvulsa({ token: (await prepareAvulsa(JID, 'oi')).token, jid: JID, text: 'oi', draftId: FU_OLD })).toMatchObject({ ok: false, code: 'unknown_chat' })
    expect(await service.followupDecline(FU, ' já falei com ela por telefone ')).toBe(true)
    expect(await service.followupDecline(FU, null)).toBe(false)
    await report()
    expect(updates).toContainEqual({ id: FU, status: 'declined', final_text: null, sent_at: null, reason: 'já falei com ela por telefone' })
    expect((await service.listFollowups()).map((f) => f.id)).toEqual([FU_OLD])
    expect(writes()).toBe(0)
  })
})
