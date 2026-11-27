import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { WhatsAppClient } from '../../../src/core/wa/client'
import { useAtomicAuthState } from '../../../src/core/wa/authState'
import type { LlmProvider } from '../../../src/core/ai/llm'
import { SettingsStore, type Cipher } from '../../../src/core/settings'
import { SagaService } from '../../../src/core/service'
import { chatKey, rosterHash } from '../../../src/core/copiloto/identity'
import { CONVO_TEST } from '../../../src/shared/copiloto'

/**
 * v0.10.0 (contrato v2): follow-ups de conversa (onboarding e sumido) no serviço, com o WhatsApp falso, relógio falso,
 * IA falsa e o Copiloto falso. Números e textos fictícios; o link é de exemplo.
 */
const WEBHOOK = 'https://exemplo.supabase.co/functions/v1/sagazap-webhook'
const LINK = 'https://example.com/agenda'
const C1 = '66666666-6666-4666-8666-666666666666'
const C2 = '77777777-7777-4777-8777-777777777777'
const NOW = 1_764_000_000_000 // segunda 24/11 às 13:00 (horário de Brasília)
const MIN = 60_000
const DAY = 86_400_000
const ANA_PHONE = '5547999998888'
const ANA = `${ANA_PHONE}@s.whatsapp.net`
/** não é mentorada */
const BIA = '5511988887777@s.whatsapp.net'
const G = '120363000000000001@g.us'
const G_NEW = '120363000000000009@g.us'
const OWN = '5547900000000:3@s.whatsapp.net'
const local = (day: number, h: number, m = 0) => new Date(2025, 10, day, h, m).getTime()

let pending: unknown[] = []
let stopped: string[] = []
let updates: any[] = []
let updateResult: (u: any) => string = () => 'updated'
let pendingBodies: any[] = []
const fetchMock = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'))
  if (body.action === 'roster') return new Response(JSON.stringify({ version: 1, phones: [rosterHash(ANA_PHONE), rosterHash('554799998888')] }), { status: 200 })
  if (body.action === 'followups_pending') {
    pendingBodies.push(body)
    return new Response(JSON.stringify(body.accepts ? { version: 2, followups: pending, stopped } : { version: 1, followups: [] }), { status: 200 })
  }
  if (body.action === 'followup_update') {
    updates.push(...body.updates)
    return new Response(JSON.stringify({ results: body.updates.map((u: { id: string }) => ({ id: u.id, status: updateResult(u) })) }), { status: 200 })
  }
  if (body.action === 'search_pending') return new Response(JSON.stringify({ version: 1, searches: [], cancelled_ids: [] }), { status: 200 })
  return new Response(JSON.stringify({ results: [] }), { status: 200 })
})

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
  sendFails = false
  constructor(public config: any) {
    for (const name of WRITE_METHODS) {
      this.spies[name] = vi.fn(async () => {
        if (name === 'sendMessage' && this.sendFails) throw new Error('timeout')
        return name === 'sendMessage' ? { key: { id: 'OUT' } } : undefined
      })
      ;(this as any)[name] = this.spies[name]
    }
  }
  emit(event: string, data: unknown): void {
    this.ev.emit(event, data)
  }
}

function gmsg(o: { id: string; from?: string; fromMe?: boolean; ts: number; text?: string; jid?: string }): any {
  return {
    key: { remoteJid: o.jid ?? G, fromMe: o.fromMe ?? false, id: o.id, ...(o.fromMe ? {} : { participant: o.from ?? ANA }) },
    messageTimestamp: Math.floor(o.ts / 1000),
    pushName: o.fromMe ? undefined : 'Ana',
    message: { conversation: o.text ?? 'oi' }
  }
}

const goal = (o: Record<string, unknown> = {}) => ({ pending_items: [], scheduling_link: LINK, note: null, cadence_days: [0, 2, 5, 10], send_mode: 'confirm', ...o })
const sumido = (id = C1, o: Record<string, unknown> = {}) => ({
  id,
  type: 'sumido',
  target: { kind: 'group', chat_key: chatKey(G) },
  text: null,
  author: 'Equipe',
  created_at: new Date(NOW - 3_600_000).toISOString(),
  goal: goal(),
  ...o
})
const onboarding = (id = C2, items = ['Assistir às Aulas Essenciais', 'Compartilhar fotos no Drive', 'Marcar a Reunião 1'], o: Record<string, unknown> = {}) =>
  sumido(id, { type: 'onboarding', goal: goal({ pending_items: items, cadence_days: [0, 2, 4, 7, 10, 14, 21, 28] }), ...o })

/** A IA falsa: o que ela devolve e quantas vezes foi chamada (e o último pedido). */
let llmReply: (user: string) => Record<string, unknown> = () => ({})
let llmCalls: Array<{ system: string; user: string }> = []
const out = (o: Record<string, unknown>) => ({ acao: 'enviar', mensagem: 'Oi! Tudo bem por aí?', motivo: '', resumo: 'Primeira tentativa de retomar o contato.', reuniao_marcada: false, itens_cumpridos: [], ...o })

describe('follow-ups de conversa no serviço (v0.10.0, contrato v2)', () => {
  let tmp: string
  let clock: FakeClock
  let repo: Repo
  let settings: SettingsStore
  let sockets: FakeSocket[]
  let service: SagaService
  let diag: Array<[string, string]>

  const last = () => sockets[sockets.length - 1]
  const client = () => (service as any).wa as WhatsAppClient
  const sentCount = () => sockets.reduce((n, s) => n + s.spies.sendMessage.mock.calls.length, 0)
  const emit = async (event: string, data: unknown) => {
    last().emit(event, data)
    await client().whenIdle()
  }
  /** deixa o tempo passar (a varredura de 15 s, a fila, o "digitando…" e a IA) */
  const drain = async (ms = 30_000) => {
    for (let left = ms; left > 0; left -= 5_000) {
      const step = Math.min(5_000, left)
      clock.advance(step)
      await vi.advanceTimersByTimeAsync(step)
      await client().whenIdle()
    }
  }
  /** salta um tempo grande de uma vez (e deixa a varredura rodar) */
  const jump = async (ms: number) => {
    clock.advance(ms)
    await drain(30_000)
  }
  /** a fila do Copiloto: relatórios, busca */
  const sync = async (n = 6) => {
    for (let i = 0; i < n; i++) await service.copiloto.tick().then((x) => clock.advance(x ?? 2_000))
  }
  const poll = async () => {
    ;(service.copiloto as any).followupPollAt = 0
    await sync()
  }
  const convo = (id = C1) => repo.convos.get(id)!
  const view = async (id = C1) => (await service.listConvos()).find((c) => c.id === id)

  function make(): SagaService {
    const llm: LlmProvider = {
      name: 'groq',
      complete: async (p: { system: string; user: string }) => {
        // outras IAs do app ("Para responder", alertas) respondem o formato delas; só as do follow-up contam
        if (!p.system.startsWith('Você escreve, como o próprio mentor')) return { text: JSON.stringify({ precisa_responder: true, motivo: 'x', alertas: [] }), inputTokens: 1, outputTokens: 1 }
        llmCalls.push({ system: p.system, user: p.user })
        return { text: JSON.stringify(out(llmReply(p.user))), inputTokens: 1, outputTokens: 1 }
      }
    } as any
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

  /** O grupo da mentorada: a última conversa foi há 40 dias (sumida), com mensagem do mentor guardada. */
  async function startOpen(extra: any[] = []): Promise<void> {
    await service.start()
    await emit('connection.update', { connection: 'open' })
    await emit('messaging-history.set', {
      chats: [],
      contacts: [],
      messages: [gmsg({ id: 'g1', ts: NOW - 41 * DAY, text: 'Vou ver e te falo' }), gmsg({ id: 'g2', fromMe: true, ts: NOW - 40 * DAY, text: 'Combinado, fico no aguardo!' }), ...extra]
    })
    repo.upsertContact({ jid: G, isGroup: true })
  }

  async function deliver(items: unknown[]): Promise<void> {
    pending = items
    service.copiloto.save({ url: WEBHOOK })
    service.copiloto.generateCode()
    service.copiloto.save({ enabled: true })
    await sync(8)
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    tmp = mkdtempSync(join(tmpdir(), 'saga-convo-'))
    clock = new FakeClock(NOW)
    repo = new Repo(openDb(':memory:'), clock)
    settings = new SettingsStore(repo, cipher)
    settings.save({ groqKey: 'gsk_x' })
    sockets = []
    diag = []
    pending = []
    stopped = []
    updates = []
    pendingBodies = []
    updateResult = () => 'updated'
    llmCalls = []
    llmReply = () => ({})
    service = make()
  })

  afterEach(async () => {
    await service.stop()
    for (const s of sockets) for (const k of WRITE_METHODS.slice(3)) expect(s.spies[k], k).not.toHaveBeenCalled()
    // registro: nunca o texto das mensagens nem o número
    for (const [k, d] of diag) if (k.startsWith('send_') || k.startsWith('copiloto')) expect(d).not.toMatch(/5547999998888|Tudo bem|agenda|parcelar/i)
    vi.useRealTimers()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('a busca manda accepts e guarda o sumido; dia 0 no horário → uma chamada à IA, rascunho "tentativa 1 de 4"; sem nova chamada enquanto ele espera', async () => {
    await startOpen()
    await deliver([sumido()])
    expect(pendingBodies[0]).toEqual({ version: 1, action: 'followups_pending', accepts: ['onboarding', 'sumido'] })
    expect(convo()).toMatchObject({ status: 'active', jid: G, day0At: expect.any(Number), slot: 0, attempts: 0 })
    await drain(30_000)
    expect(llmCalls).toHaveLength(1)
    const v = await view()
    expect(v?.draft).toMatchObject({ kind: 'attempt', attempt: 1, state: 'ready', text: 'Oi! Tudo bem por aí?' })
    expect(v?.attemptTotal).toBe(4)
    // o pedido leva o objetivo e só o link dado
    expect(llmCalls[0].user).toContain(LINK)
    expect(llmCalls[0].system).toMatch(/Nunca invente/)
    await jump(DAY)
    await jump(DAY)
    expect(llmCalls).toHaveLength(1)
    expect(sentCount()).toBe(0)
  })

  it('"Enviar" com o texto editado: sai uma vez pela avulsa (sem citar, digitando, lida) mesmo com mais de 30 dias de silêncio no grupo; relata running', async () => {
    await startOpen()
    await deliver([sumido()])
    await drain(30_000)
    const d = (await view())!.draft!
    const edited = `Oi, sumida! Bora marcar uma conversa? ${LINK}`
    const r = await service.convoAction(C1, { kind: 'send', draftId: d.id, text: edited })
    expect(r.ok).toBe(true)
    await drain(90_000)
    expect(sentCount()).toBe(1)
    const [row] = repo.sends.listForJid(G)
    expect(row).toMatchObject({ kind: 'avulsa', auto: false, forced: false, quotedId: null, replyId: null, text: edited })
    expect(last().spies.sendMessage).toHaveBeenCalledWith(G, { text: edited }, { messageId: row.msgIds[0] })
    expect(last().spies.sendPresenceUpdate).toHaveBeenCalledWith('composing', G)
    await emit('messages.upsert', { messages: [gmsg({ id: row.msgIds[0], fromMe: true, ts: clock.now(), text: edited })] })
    await drain(20_000)
    expect(convo()).toMatchObject({ attempts: 1, slot: 1, awaitingReply: true, draftId: null })
    expect((await view())!.nextAttemptAt).toBe(convo().day0At + 2 * DAY)
    await sync()
    expect(updates).toContainEqual(
      expect.objectContaining({ id: C1, status: 'running', attempts: 1, final_text: edited, last_attempt_at: expect.any(String), sent_at: expect.any(String), summary: expect.any(String) })
    )
    // nunca duas vezes: o mesmo rascunho não existe mais
    expect(await service.convoAction(C1, { kind: 'send', draftId: d.id, text: edited })).toMatchObject({ ok: false })
    await drain(5 * MIN)
    expect(sentCount()).toBe(1)
    // a regra dos 30 dias continua valendo para a mensagem avulsa comum nesse grupo
    expect(await service.prepareSend({ jid: G, text: 'Oi', kind: 'avulsa' })).toMatchObject({ ok: false, code: 'no_recent_contact' })
    // dia 2 sem resposta: a IA escreve a tentativa 2 (outra chamada só agora)
    await sync()
    await jump(2 * DAY)
    expect(llmCalls).toHaveLength(2)
    expect(llmCalls[1].user).toContain('tentativa 2 de 4')
    expect((await view())!.draft).toMatchObject({ kind: 'attempt', attempt: 2 })
  })

  it('resposta: só mensagem da mentorada conta (não a de outra pessoa do grupo); relata responded e a IA responde rumo ao objetivo', async () => {
    await startOpen()
    await deliver([sumido()])
    await drain(30_000)
    await service.convoAction(C1, { kind: 'send', draftId: (await view())!.draft!.id, text: 'Oi! Tudo bem?' })
    await drain(90_000)
    const [row] = repo.sends.listForJid(G)
    await emit('messages.upsert', { messages: [gmsg({ id: row.msgIds[0], fromMe: true, ts: clock.now(), text: 'Oi! Tudo bem?' })] })
    await drain(20_000)
    // outra pessoa do grupo escreve: não é resposta
    await emit('messages.upsert', { messages: [gmsg({ id: 'b1', from: BIA, ts: clock.now(), text: 'bom dia pessoal' })] })
    await drain(2 * MIN)
    expect(convo().status).toBe('active')
    expect(llmCalls).toHaveLength(1)
    // a mentorada responde
    llmReply = () => ({ mensagem: `Que bom te ver! Escolhe um horário aqui: ${LINK}`, resumo: 'Respondeu depois da 1ª tentativa; link da agenda enviado.' })
    const repliedTs = clock.now()
    await emit('messages.upsert', { messages: [gmsg({ id: 'a1', ts: repliedTs, text: 'Oi! Desculpa a demora, estava viajando' })] })
    await drain(20_000)
    expect(convo()).toMatchObject({ status: 'responded', repliedAt: repliedTs })
    // 1 min de silêncio antes de pedir à IA (uma chamada só)
    expect(llmCalls).toHaveLength(1)
    await drain(70_000)
    expect(llmCalls).toHaveLength(2)
    expect(llmCalls[1].user).toContain('responda às mensagens mais recentes')
    expect((await view())!.draft).toMatchObject({ kind: 'reply', attempt: null, text: expect.stringContaining(LINK) })
    await sync()
    expect(updates).toContainEqual(expect.objectContaining({ id: C1, status: 'responded', replied_at: new Date(repliedTs).toISOString(), attempts: 1 }))
  })

  it('"Precisa de você": pedido de dinheiro não chama a IA nem escreve rascunho; "Gerar rascunho mesmo assim" chama', async () => {
    await startOpen([gmsg({ id: 'a0', ts: NOW - 10 * MIN, text: 'Oi! Consigo parcelar a mensalidade?' })])
    await deliver([sumido()])
    await drain(2 * MIN)
    expect(llmCalls).toHaveLength(0)
    const v = await view()
    expect(v?.needsYou).toMatch(/só você pode decidir/)
    expect(v?.draft).toBeNull()
    await drain(10 * MIN)
    expect(llmCalls).toHaveLength(0)
    // a IA também pode dizer que precisa do mentor
    llmReply = () => ({ acao: 'precisa_de_voce', mensagem: '', motivo: 'Pediu uma exceção no contrato.' })
    await service.convoAction(C1, { kind: 'retry' })
    await drain(30_000)
    expect(llmCalls).toHaveLength(1)
    expect((await view())?.needsYou).toBe('Pediu uma exceção no contrato.')
    // o mentor responde ele mesmo no WhatsApp: o aviso sai, sem rascunho nem IA
    await emit('messages.upsert', { messages: [gmsg({ id: 'm1', fromMe: true, ts: clock.now(), text: 'Vou ver isso e te falo!' })] })
    await drain(30_000)
    expect((await view())?.needsYou).toBeNull()
    expect((await view())?.draft).toBeNull()
    expect(llmCalls).toHaveLength(1)
    expect(sentCount()).toBe(0)
  })

  it('fora do horário: "Enviar" agenda para a abertura + 7..25 min; "Forçar envio" no cartão sai já', async () => {
    clock.advance(6 * 3_600_000) // segunda 19:00
    await startOpen()
    await deliver([sumido()])
    // dia 0 = a próxima abertura (terça 09:00)
    expect(convo().day0At).toBe(local(25, 9))
    await drain(2 * MIN)
    expect(llmCalls).toHaveLength(0)
    clock.advance(local(25, 9) - clock.now())
    await drain(30_000)
    expect(llmCalls).toHaveLength(1)
    await service.convoAction(C1, { kind: 'send', draftId: (await view())!.draft!.id, text: 'Oi! Tudo bem?' })
    await drain(30_000)
    // rng = 0 → abertura + 7 min
    expect((await view())!.draft).toMatchObject({ state: 'approved', at: local(25, 9, 7) })
    expect(sentCount()).toBe(0)
    await drain(8 * MIN)
    expect(sentCount()).toBe(1)
    expect(repo.sends.listForJid(G)[0].startedAt!).toBeGreaterThanOrEqual(local(25, 9, 7))
  })

  it('"Forçar envio" do cartão fora do horário', async () => {
    clock.advance(6 * 3_600_000)
    await startOpen()
    await service.copilotoSave({ url: WEBHOOK })
    await deliver([sumido()])
    // o mentor testa à noite: puxa o dia 0 para agora
    repo.convos.patch(C1, { day0At: clock.now() })
    await drain(30_000)
    const v = await view()
    expect(v?.outsideHours).toBe(true)
    await service.convoAction(C1, { kind: 'send', draftId: v!.draft!.id, text: 'Oi! Tudo bem?', forced: true })
    await drain(90_000)
    expect(sentCount()).toBe(1)
    expect(repo.sends.listForJid(G)[0]).toMatchObject({ forced: true, auto: false })
  })

  it('estado desconhecido nunca é reenviado', async () => {
    await startOpen()
    await deliver([sumido()])
    await drain(30_000)
    await drain(60_000)
    last().sendFails = true
    await service.convoAction(C1, { kind: 'send', draftId: (await view())!.draft!.id, text: 'Oi! Tudo bem?' })
    await drain(60_000)
    expect(sentCount()).toBe(1)
    expect(repo.sends.listForJid(G)[0].status).toBe('unknown')
    expect((await view())!.draft?.state).toBe('unknown')
    await jump(3 * DAY)
    expect(sentCount()).toBe(1)
    expect(convo().attempts).toBe(0)
  })

  it('"Reunião marcada" (sugerida pela IA, confirmada pelo mentor) → scheduled com os campos; "Encerrar" → declined', async () => {
    await startOpen([gmsg({ id: 'a0', ts: NOW - 10 * MIN, text: 'Marquei pelo link pra quinta!' })])
    llmReply = () => ({ mensagem: 'Perfeito, te vejo lá!', reuniao_marcada: true, resumo: 'Marcou a reunião pelo link.' })
    await deliver([sumido(), sumido(C2, { target: { kind: 'group', chat_key: chatKey(G) } })])
    await drain(2 * MIN)
    const v = await view()
    expect(v?.suggestScheduled).toBe(true)
    // nunca final sozinho
    expect(v?.status).toBe('responded')
    await service.convoAction(C1, { kind: 'scheduled' })
    expect(convo().status).toBe('scheduled')
    await service.convoAction(C2, { kind: 'decline' })
    expect(convo(C2)).toMatchObject({ status: 'declined', reason: 'recusado_pelo_mentor' })
    await sync()
    expect(updates).toContainEqual(expect.objectContaining({ id: C1, status: 'scheduled', attempts: 0, replied_at: expect.any(String), summary: 'Marcou a reunião pelo link.' }))
    expect(updates).toContainEqual(expect.objectContaining({ id: C2, status: 'declined', reason: 'recusado_pelo_mentor' }))
  })

  it('modo de teste: 1 dia = 2 min; 4 tentativas puladas + 2 dias de folga → no_reply; desliga sozinho em 2 h', async () => {
    await startOpen()
    await service.copilotoSave({ followupTest: true })
    expect((await service.getState()).followupTestUntil).toBe(clock.now() + CONVO_TEST.durationMs)
    await deliver([sumido()])
    expect(convo().testMode).toBe(true)
    for (let i = 1; i <= 4; i++) {
      await drain(30_000)
      const d = (await view())!.draft
      expect(d).toMatchObject({ kind: 'attempt', attempt: i })
      await service.convoAction(C1, { kind: 'skip' })
      if (i < 4) {
        expect(convo().status).toBe('active')
        await drain(2 * MIN * 3)
      }
    }
    expect(llmCalls).toHaveLength(4)
    expect(convo().slot).toBe(4)
    // 10 "dias" (20 min) + 2 de folga (4 min) depois do dia 0
    await drain(10 * MIN)
    expect(convo().status).toBe('no_reply')
    await sync()
    expect(updates).toContainEqual(expect.objectContaining({ id: C1, status: 'no_reply', attempts: 0 }))
    clock.advance(CONVO_TEST.durationMs)
    expect(service.copiloto.followupTestOn()).toBe(false)
    expect(service.copiloto.status().followupTestUntil).toBeNull()
  })

  it('stopped (equipe parou): para já, sem relatório; o envio só na fila é cancelado', async () => {
    await startOpen()
    await deliver([sumido()])
    await drain(30_000)
    await service.convoAction(C1, { kind: 'send', draftId: (await view())!.draft!.id, text: 'Oi! Tudo bem?' })
    stopped = [C1]
    pending = []
    await poll()
    expect(convo().status).toBe('cancelled')
    await drain(3 * MIN)
    expect(sentCount()).toBe(0)
    await sync()
    expect(updates.filter((u) => u.id === C1)).toEqual([])
  })

  it('relatório "cancelled" para a conversa (a equipe parou depois da entrega); "duplicate" também; "invalid" não volta', async () => {
    await startOpen()
    updateResult = (u) => (u.id === C1 && u.status === 'running' ? 'cancelled' : u.id === C2 ? 'duplicate' : 'updated')
    await deliver([sumido(), onboarding()])
    await drain(60_000)
    await drain(60_000)
    const d1 = (await view(C1))!.draft!
    await service.convoAction(C1, { kind: 'send', draftId: d1.id, text: 'Oi! Tudo bem?' })
    await drain(90_000)
    const [row] = repo.sends.listForJid(G)
    await emit('messages.upsert', { messages: [gmsg({ id: row.msgIds[0], fromMe: true, ts: clock.now(), text: 'Oi! Tudo bem?' })] })
    await drain(20_000)
    await sync()
    expect(convo(C1).status).toBe('cancelled')
    // onboarding: o mentor encerra; o Copiloto já tinha um final ("duplicate"): fica encerrado, nada volta
    await service.convoAction(C2, { kind: 'decline' })
    await sync()
    expect(repo.convos.reportsOf(C2).every((r) => r.done && r.lastResult === 'duplicate')).toBe(true)
    updateResult = () => 'invalid'
    await jump(3 * DAY)
    const before = updates.length
    await sync()
    expect(updates.length).toBe(before)
    expect(repo.convos.pendingReports()).toBe(0)
  })

  it('não dá para conduzir: grupo não encontrado, mentor fora do grupo, sem mensagem do mentor → failed com o motivo', async () => {
    await startOpen()
    repo.upsertContact({ jid: G_NEW, isGroup: true })
    repo.insertMessage({ id: 'n1', jid: G_NEW, fromMe: false, kind: 'text', text: 'oi', mediaKeyJson: null, durationSec: null, isGroup: true, senderJid: ANA, ts: NOW - 5 * MIN } as any)
    const G3 = '120363000000000003@g.us'
    repo.upsertContact({ jid: G3, isGroup: true })
    repo.insertMessage({ id: 'n3', jid: G3, fromMe: true, kind: 'text', text: 'oi', mediaKeyJson: null, durationSec: null, isGroup: true, ts: NOW - 5 * MIN } as any)
    repo.setGroupMembers(G3, [ANA], 1)
    const C3 = '88888888-8888-4888-8888-888888888888'
    await deliver([
      sumido(C1, { target: { kind: 'group', chat_key: chatKey('120363000000000077@g.us') } }),
      sumido(C2, { target: { kind: 'group', chat_key: chatKey(G_NEW) } }),
      sumido(C3, { target: { kind: 'group', chat_key: chatKey(G3) } })
    ])
    expect(convo(C1)).toMatchObject({ status: 'failed', reason: 'conversa_nao_encontrada' })
    expect(convo(C2)).toMatchObject({ status: 'failed', reason: 'sem_historico_do_mentor' })
    expect(convo(C3)).toMatchObject({ status: 'failed', reason: 'mentor_fora_do_grupo' })
    await sync()
    expect(updates).toContainEqual(expect.objectContaining({ id: C1, status: 'failed', reason: 'conversa_nao_encontrada' }))
    expect(updates).toContainEqual(expect.objectContaining({ id: C3, status: 'failed', reason: 'mentor_fora_do_grupo' }))
    await drain(MIN)
    expect(llmCalls).toHaveLength(0)
  })

  it('onboarding: o mesmo id com menos pendências atualiza o objetivo; todas confirmadas → completed', async () => {
    await startOpen()
    await deliver([onboarding()])
    await service.convoAction(C2, { kind: 'item', item: 'Compartilhar fotos no Drive', done: true })
    expect(convo(C2).itemsDone).toEqual(['Compartilhar fotos no Drive'])
    pending = [onboarding(C2, ['Compartilhar fotos no Drive', 'Marcar a Reunião 1'])]
    await poll()
    expect(convo(C2).goal.pendingItems).toEqual(['Compartilhar fotos no Drive', 'Marcar a Reunião 1'])
    expect(convo(C2).itemsDone).toEqual(['Compartilhar fotos no Drive'])
    await service.convoAction(C2, { kind: 'item', item: 'Marcar a Reunião 1', done: true })
    expect(convo(C2).status).toBe('completed')
    await sync()
    expect(updates).toContainEqual(expect.objectContaining({ id: C2, status: 'completed' }))
  })

  it('onboarding sem cumprir em 30 dias (modo de teste: 60 min) → no_reply', async () => {
    await startOpen()
    await service.copilotoSave({ followupTest: true })
    await deliver([onboarding()])
    await drain(30_000)
    await service.convoAction(C2, { kind: 'skip' })
    await drain(61 * MIN)
    expect(convo(C2).status).toBe('no_reply')
  })

  it('com o follow-up andando, o grupo não gera sugestões sozinho (o cartão cuida)', async () => {
    await startOpen([gmsg({ id: 'a0', ts: NOW - 10 * MIN, text: 'Oi! Voltei' })])
    await deliver([sumido()])
    const r = await service.getAnalysis(G, { onlyIfNeeded: true })
    expect(r).toMatchObject({ ok: false, code: 'not_needed' })
  })
})
