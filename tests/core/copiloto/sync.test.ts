import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COPILOTO_KEYS, COPILOTO_LIMITS, CopilotoSync } from '../../../src/core/copiloto/sync'
import { chatKey, messageEventId } from '../../../src/core/copiloto/identity'
import { COPILOTO_TEXT } from '../../../src/shared/copiloto'
import { ANA, BIA, BIA_PHONE, CAIO, CAIO_PHONE, DAY, G_ANA, G_BIA, MIN, ROSTER_PHONES, WEBHOOK, fakeCipher, rosterOf, setup } from './helpers'

type Reply = { status: number; body?: unknown } | 'network'

let ctx: ReturnType<typeof setup>
let sync: CopilotoSync
let roster: string[]
/** respostas para os envios de eventos (a próxima sai da fila; vazia = 200 com "stored") */
let replies: Reply[]
let calls: Array<{ url: string; auth: string; body: any; raw: string }>

const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const raw = String(init?.body ?? '')
  const body = JSON.parse(raw)
  calls.push({ url: String(url), auth: String((init?.headers as Record<string, string>).Authorization), body, raw })
  if (body.action === 'roster') return new Response(JSON.stringify({ version: 1, phones: roster }), { status: 200 })
  // v0.7.0: a busca de follow-ups (nenhum aqui; os testes deles ficam em followups.test.ts)
  if (body.action === 'followups_pending') return new Response(JSON.stringify({ version: 1, followups: [] }), { status: 200 })
  const r = replies.shift() ?? { status: 200 }
  if (r === 'network') throw new TypeError('fetch failed')
  const out = r.status === 200 && r.body === undefined ? { results: body.events.map((e: { id: string }) => ({ id: e.id, status: 'stored' })) } : (r.body ?? {})
  return new Response(JSON.stringify(out), { status: r.status })
})

const eventCalls = () => calls.filter((c) => c.body.events)
const outbox = () => ctx.repo.copiloto
const advance = (ms: number) => ctx.clock.advance(ms)

/** Liga a integração (endereço + código) e roda até a fila esvaziar ou parar. */
async function enable(): Promise<string> {
  expect(sync.save({ url: WEBHOOK }).ok).toBe(true)
  const r = sync.generateCode()
  if (!r.ok) throw new Error('sem código')
  expect(sync.save({ enabled: true }).ok).toBe(true)
  return r.code
}

async function drain(max = 30): Promise<void> {
  for (let i = 0; i < max; i++) {
    const next = await sync.tick()
    if (next === null) return
    if (outbox().pendingCount() === 0 && outbox().dirtyCount() === 0 && i > 0) return
    advance(Math.max(next, COPILOTO_LIMITS.gapMs))
  }
}

beforeEach(() => {
  ctx = setup()
  roster = rosterOf([...ROSTER_PHONES, CAIO_PHONE])
  replies = []
  calls = []
  fetchMock.mockClear()
  sync = new CopilotoSync({ repo: ctx.repo, cipher: fakeCipher, clock: ctx.clock, fetchImpl: fetchMock as unknown as typeof fetch })
})

describe('Copiloto: configurações', () => {
  it('vem desligado; ligar exige endereço e código; endereço precisa ser https e terminar no webhook', () => {
    expect(sync.status()).toMatchObject({ enabled: false, url: null, hasCode: false, pending: 0 })
    expect(sync.save({ enabled: true })).toEqual({ ok: false, message: COPILOTO_TEXT.needsSetup })
    for (const bad of ['http://exemplo.supabase.co/functions/v1/sagazap-webhook', 'https://exemplo.supabase.co/functions/v1/outra', 'https://exemplo.supabase.co/functions/v1/sagazap-webhook?x=1', 'nada']) {
      expect(sync.save({ url: bad })).toEqual({ ok: false, message: COPILOTO_TEXT.invalidUrl })
    }
    expect(sync.save({ url: WEBHOOK }).ok).toBe(true)
    expect(sync.save({ enabled: true }).ok).toBe(false)
  })

  it('o código é guardado cifrado e nunca aparece no status', () => {
    const r = sync.generateCode()
    expect(r.ok).toBe(true)
    const code = (r as { code: string }).code
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(ctx.repo.getSetting(COPILOTO_KEYS.code)).not.toContain(code)
    expect(sync.status().hasCode).toBe(true)
    expect(JSON.stringify(sync.status())).not.toContain(code)
  })

  it('sem criptografia do sistema, não gera código', () => {
    const s = new CopilotoSync({ repo: ctx.repo, cipher: { ...fakeCipher, isAvailable: () => false }, clock: ctx.clock })
    expect(s.generateCode()).toEqual({ ok: false, message: COPILOTO_TEXT.encryption })
  })

  it('desligado, nada é anotado nem enviado', async () => {
    ctx.add(ANA)
    expect(outbox().dirtyCount()).toBe(0)
    expect(await sync.tick()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('"Testar conexão" conta os telefones do roster e as conversas daqui', async () => {
    ctx.add(ANA)
    ctx.add(BIA)
    sync.save({ url: WEBHOOK })
    sync.generateCode()
    expect(await sync.test()).toEqual({ ok: true, phones: roster.length, chats: 1 })
    expect(calls[0].body).toEqual({ action: 'roster' })
  })
})

describe('Copiloto: carga inicial e filtro', () => {
  it('ao ligar: roster, depois os últimos 30 dias só das conversas de mentorados', async () => {
    ctx.add(ANA, { text: 'mensagem antiga', minutesAgo: 40 * 24 * 60 })
    const recent = ctx.add(ANA, { text: 'mensagem recente', minutesAgo: 60 })
    ctx.add(BIA, { text: 'não é mentorada' })
    ctx.repo.setGroupMembers(G_ANA, [ANA, BIA])
    ctx.add(G_ANA, { senderJid: BIA, senderName: 'Bia', text: 'oi turma' })
    ctx.repo.setGroupMembers(G_BIA, [BIA])
    ctx.add(G_BIA, { senderJid: BIA, text: 'grupo sem mentorado' })
    const code = await enable()
    await drain()
    expect(calls[0]).toMatchObject({ url: WEBHOOK, auth: `Bearer ${code}`, body: { action: 'roster' } })
    const sent = eventCalls().flatMap((c) => c.body.events)
    expect(eventCalls().every((c) => c.body.version === 1)).toBe(true)
    const keys = new Set(sent.map((e: any) => e.chat.key))
    expect(keys).toEqual(new Set([chatKey(ANA), chatKey(G_ANA)]))
    expect(sent.some((e: any) => e.id === messageEventId(ANA, recent.id))).toBe(true)
    expect(sent.some((e: any) => e.text === 'mensagem antiga')).toBe(false)
    // telefone de quem não é mentorado nunca sai do computador
    for (const c of calls) expect(c.raw).not.toContain(BIA_PHONE)
    expect(sync.status()).toMatchObject({ enabled: true, pending: 0, chats: 2, lastError: null })
    expect(sync.status().lastSentAt).not.toBeNull()
  })

  it('não mentorado nunca entra na fila, nem depois de ligado', async () => {
    await enable()
    await drain()
    ctx.add(BIA, { text: 'oi' })
    ctx.repo.setGroupMembers(G_BIA, [BIA])
    ctx.add(G_BIA, { senderJid: BIA })
    sync.processDirty(new Set(roster))
    expect(outbox().pendingCount()).toBe(0)
    expect(outbox().dirtyCount()).toBe(0)
  })

  it('mentorado novo no roster: a conversa dele ganha a carga dos 30 dias', async () => {
    ctx.add(CAIO, { text: 'antes de entrar no roster', minutesAgo: 3 * 24 * 60 })
    roster = rosterOf(ROSTER_PHONES)
    await enable()
    await drain()
    expect(eventCalls().length).toBe(0)
    roster = rosterOf([...ROSTER_PHONES, CAIO_PHONE])
    advance(COPILOTO_LIMITS.rosterEveryMs)
    await drain()
    const sent = eventCalls().flatMap((c) => c.body.events)
    expect(sent.some((e: any) => e.text === 'antes de entrar no roster')).toBe(true)
  })

  it('roster a cada 6 h', async () => {
    await enable()
    await drain()
    const rosterCalls = () => calls.filter((c) => c.body.action === 'roster').length
    expect(rosterCalls()).toBe(1)
    advance(COPILOTO_LIMITS.rosterEveryMs - MIN)
    await sync.tick()
    expect(rosterCalls()).toBe(1)
    advance(MIN)
    await sync.tick()
    expect(rosterCalls()).toBe(2)
  })
})

describe('Copiloto: fila de saída', () => {
  it('upsert pelo id: o áudio que ganhou transcrição troca o pendente; o mesmo estado não volta', async () => {
    await enable()
    await drain()
    const m = ctx.add(ANA, { kind: 'audio', text: null })
    const set = new Set(roster)
    sync.processDirty(set)
    const id = messageEventId(ANA, m.id)
    const pending = () => outbox().due(Number.MAX_SAFE_INTEGER, 100).filter((r) => r.eventId === id)
    expect(pending()).toHaveLength(1)
    expect(JSON.parse(pending()[0].payloadJson).transcription_status).toBe('pending')
    ctx.repo.setTranscript(m.id, 'texto do áudio', 'done')
    sync.processDirty(set)
    expect(pending()).toHaveLength(1)
    expect(JSON.parse(pending()[0].payloadJson)).toMatchObject({ text: 'texto do áudio', is_transcription: true })
    await drain()
    expect(outbox().pendingCount()).toBe(0)
    // nada mudou: a mesma mensagem anotada de novo não volta para a fila
    outbox().addDirty([{ ref: `m:${m.id}`, jid: ANA }])
    sync.processDirty(set)
    expect(outbox().pendingCount()).toBe(0)
  })

  it('upsert direto: conteúdo novo do mesmo id volta a pendente com as tentativas zeradas', () => {
    expect(outbox().upsert('sz1:a:1', ANA, '{"a":1}', 'h1')).toBe(true)
    expect(outbox().upsert('sz1:a:1', ANA, '{"a":1}', 'h1')).toBe(false)
    outbox().retryLater([{ eventId: 'sz1:a:1', payloadHash: 'h1' }], NOW_PLUS(), '503')
    expect(outbox().due(Number.MAX_SAFE_INTEGER, 10)[0].attempts).toBe(1)
    expect(outbox().upsert('sz1:a:1', ANA, '{"a":2}', 'h2')).toBe(true)
    const [row] = outbox().due(0, 10)
    expect(row).toMatchObject({ eventId: 'sz1:a:1', payloadJson: '{"a":2}', attempts: 0 })
    expect(outbox().pendingCount()).toBe(1)
  })

  it('uma versão nova que chega durante o envio continua pendente', () => {
    outbox().upsert('sz1:a:2', ANA, '{"v":1}', 'h1')
    const [sent] = outbox().due(0, 10)
    outbox().upsert('sz1:a:2', ANA, '{"v":2}', 'h2')
    outbox().finish([sent], 'done', () => 'stored')
    expect(outbox().due(0, 10)[0].payloadJson).toBe('{"v":2}')
  })

  it('desligar apaga a fila local', async () => {
    replies = ['network']
    ctx.add(ANA)
    await enable()
    await drain(2)
    expect(outbox().pendingCount()).toBeGreaterThan(0)
    sync.save({ enabled: false })
    expect(sync.status()).toMatchObject({ enabled: false, pending: 0, chats: 0 })
    expect(outbox().dirtyCount()).toBe(0)
  })
})

const NOW_PLUS = () => ctx.clock.now() + 1

describe('Copiloto: envio por código de resposta', () => {
  async function ready(messages = 3) {
    for (let i = 0; i < messages; i++) ctx.add(ANA, { text: `mensagem ${i}`, minutesAgo: 10 + i })
    await enable()
    await sync.tick() // roster
    advance(COPILOTO_LIMITS.gapMs)
  }

  it('200: todos do lote concluídos, seja qual for o status', async () => {
    await ready()
    replies = [{ status: 200, body: { results: [{ id: 'x', status: 'skipped_unmatched' }] } }]
    await sync.tick()
    expect(eventCalls()).toHaveLength(1)
    expect(outbox().pendingCount()).toBe(0)
  })

  it('no máximo 100 eventos por lote e ≥ 2 s entre requisições', async () => {
    await ready(150)
    await sync.tick()
    expect(eventCalls()[0].body.events).toHaveLength(100)
    expect(eventCalls()[0].raw.length).toBeLessThanOrEqual(COPILOTO_LIMITS.batchBytes)
    advance(COPILOTO_LIMITS.gapMs - 1)
    await sync.tick()
    expect(eventCalls()).toHaveLength(1)
    advance(1)
    await sync.tick()
    expect(eventCalls()).toHaveLength(2)
  })

  it('512 KB por lote', async () => {
    const big = 'x'.repeat(100 * 1024)
    for (let i = 0; i < 8; i++) ctx.add(ANA, { text: big, minutesAgo: 10 + i })
    await enable()
    await drain()
    expect(eventCalls().length).toBeGreaterThan(1)
    for (const c of eventCalls()) expect(Buffer.byteLength(c.raw)).toBeLessThanOrEqual(COPILOTO_LIMITS.batchBytes)
    expect(outbox().pendingCount()).toBe(0)
  })

  it('401: para e mostra "Código do Copiloto inválido" até gerar outro código', async () => {
    await ready()
    replies = [{ status: 401 }]
    expect(await sync.tick()).toBeNull()
    expect(sync.status()).toMatchObject({ authFailed: true, lastError: COPILOTO_TEXT.invalidCode })
    advance(DAY)
    expect(await sync.tick()).toBeNull()
    expect(eventCalls()).toHaveLength(1)
    sync.generateCode()
    expect(sync.status().authFailed).toBe(false)
    await drain()
    expect(outbox().pendingCount()).toBe(0)
  })

  it('400: o lote inteiro fica inválido (não reenvia)', async () => {
    await ready()
    replies = [{ status: 400 }]
    await sync.tick()
    expect(outbox().pendingCount()).toBe(0)
    advance(DAY)
    await sync.tick()
    expect(eventCalls()).toHaveLength(1)
  })

  it('413: divide o lote', async () => {
    await ready(4)
    replies = [{ status: 413 }]
    await sync.tick()
    const first = eventCalls()[0].body.events.length
    advance(COPILOTO_LIMITS.gapMs)
    await sync.tick()
    expect(eventCalls()[1].body.events.length).toBe(Math.floor(first / 2))
    await drain()
    expect(outbox().pendingCount()).toBe(0)
  })

  it('429, 5xx e rede: espera crescente de 1 min até 30 min', async () => {
    await ready()
    replies = [{ status: 429 }, { status: 503 }, 'network', { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]
    const waits: number[] = []
    for (let i = 0; i < 7; i++) {
      await sync.tick()
      const next = outbox().nextDueAt()! - ctx.clock.now()
      waits.push(next)
      // antes da hora, nada sai
      advance(next - 1)
      const before = eventCalls().length
      await sync.tick()
      expect(eventCalls().length).toBe(before)
      advance(1)
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 30, 30].map((m) => m * MIN))
    expect(sync.status().lastError).toMatch(/Copiloto/)
    await sync.tick()
    expect(outbox().pendingCount()).toBe(0)
    expect(sync.status().lastError).toBeNull()
  })

  it('nunca registra conteúdo, telefone, endereço nem código', async () => {
    const logged: string[] = []
    const origLog = ctx.repo.logEvent.bind(ctx.repo)
    ctx.repo.logEvent = (k, d) => {
      logged.push(`${k} ${d}`)
      origLog(k, d)
    }
    sync = new CopilotoSync({ repo: ctx.repo, cipher: fakeCipher, clock: ctx.clock, fetchImpl: fetchMock as unknown as typeof fetch, diag: (k, d) => logged.push(`${k} ${d}`) })
    ctx.add(ANA, { text: 'conteúdo secreto' })
    replies = [{ status: 503 }, { status: 401 }]
    const code = await enable()
    await drain(5)
    const all = logged.join('\n')
    expect(logged.length).toBeGreaterThan(2)
    for (const bad of ['conteúdo secreto', '5547999998888', WEBHOOK, 'exemplo.supabase.co', code]) expect(all).not.toContain(bad)
  })
})
