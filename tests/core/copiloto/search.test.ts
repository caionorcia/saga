import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COPILOTO_LIMITS, CopilotoSync } from '../../../src/core/copiloto/sync'
import { COPILOTO_SEARCH_LIMITS, parseSearchPending, resolveSearchChats, runCopilotoSearch, type PendingSearch } from '../../../src/core/copiloto/search'
import { chatKey, phoneOfJid, rosterHash } from '../../../src/core/copiloto/identity'
import { searchesLine } from '../../../src/shared/copiloto'
import { ANA, ANA_PHONE, BIA, BIA_PHONE, CAIO, CAIO_LID, CAIO_PHONE, DAY, G_ANA, G_BIA, MIN, OLD, OLD_PHONE, ROSTER_PHONES, WEBHOOK, fakeCipher, rosterOf, setup } from './helpers'

/**
 * v0.9.0 (contrato v1.3): a pesquisa do Copiloto no histórico completo guardado neste computador. Só leitura; nunca toca
 * no WhatsApp. Nunca telefone de quem não é mentorado; nunca mídia.
 */

const ANA_HASHES = ['5547999998888', '554799998888'].map(rosterHash)
const SEARCH_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'

let ctx: ReturnType<typeof setup>
let lidKnown = true
const phoneOf = (jid: string) => phoneOfJid(jid) ?? (lidKnown && jid === CAIO_LID ? CAIO_PHONE : null)

function search(o: Partial<PendingSearch> = {}): PendingSearch {
  return { id: SEARCH_ID, phoneHashes: ANA_HASHES, chatKeys: [], query: 'preço', from: null, to: null, invalid: null, ...o }
}

beforeEach(() => {
  ctx = setup()
  lidKnown = true
})

describe('pedido (search_pending)', () => {
  it('lê o contrato; pedido fora dele vira erro com motivo curto; cancelados ausentes = []', () => {
    const ok = {
      id: SEARCH_ID,
      target: { phone_hashes: ANA_HASHES, chat_keys: [chatKey(G_ANA)] },
      query: '  preço do pacote ',
      from: '2026-01-01T00:00:00-03:00',
      to: null,
      created_at: '2026-11-27T10:00:00Z'
    }
    const p = parseSearchPending({ version: 1, searches: [ok, { ...ok, id: 'b', query: '' }, { ...ok, id: 'c', from: 'ontem' }, { ...ok, id: 'd', target: {} }, { id: 'x y' }, ok] })!
    expect(p.cancelledIds).toEqual([])
    expect(p.items.map((s) => [s.id, s.invalid])).toEqual([
      [SEARCH_ID, null],
      ['b', 'consulta_invalida'],
      ['c', 'periodo_invalido'],
      ['d', 'alvo_invalido']
    ])
    expect(p.items[0]).toMatchObject({ query: 'preço do pacote', from: Date.parse('2026-01-01T03:00:00Z'), to: null, chatKeys: [chatKey(G_ANA)] })
    expect(parseSearchPending({ version: 1, searches: [], cancelled_ids: ['a', 3, 'b'] })!.cancelledIds).toEqual(['a', 'b'])
    expect(parseSearchPending({ version: 2, searches: [] })).toBeNull()
    expect(parseSearchPending({ version: 1 })).toBeNull()
    expect(parseSearchPending({ version: 1, searches: [{ ...ok, query: 'x'.repeat(201) }] })!.items[0].invalid).toBe('consulta_invalida')
    expect(parseSearchPending({ version: 1, searches: [{ ...ok, from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }] })!.items[0].invalid).toBe('periodo_invalido')
  })
})

describe('as conversas do mentorado', () => {
  it('individual pelas duas formas do 9º dígito, @lid com telefone conhecido, grupos por participante e chat_keys', () => {
    ctx.add(ANA)
    ctx.add(OLD)
    ctx.add(BIA)
    ctx.add(CAIO_LID)
    ctx.repo.setGroupMembers(G_ANA, [ANA, BIA])
    ctx.add(G_ANA, { senderJid: BIA })
    ctx.add(G_BIA, { senderJid: BIA })
    const G_SENDER = '120363000000000005@g.us'
    ctx.add(G_SENDER, { senderJid: ANA })
    // ANA (13 dígitos): a conversa e os grupos dela; o grupo de BIA só pela chave
    expect(resolveSearchChats(ctx.repo, { phoneHashes: ANA_HASHES, chatKeys: [chatKey(G_BIA)] }, phoneOf).sort()).toEqual([ANA, G_ANA, G_BIA, G_SENDER].sort())
    // conta antiga (12 dígitos, sem o 9): o Copiloto manda as duas formas; a do cadastro com o 9 também acha
    expect(resolveSearchChats(ctx.repo, { phoneHashes: [rosterHash('5547988887777')], chatKeys: [] }, phoneOf)).toEqual([OLD])
    // @lid: pelo telefone que o app conhece
    expect(resolveSearchChats(ctx.repo, { phoneHashes: [rosterHash(CAIO_PHONE)], chatKeys: [] }, phoneOf)).toEqual([CAIO_LID])
    lidKnown = false
    expect(resolveSearchChats(ctx.repo, { phoneHashes: [rosterHash(CAIO_PHONE)], chatKeys: [] }, phoneOf)).toEqual([])
  })
})

describe('a busca', () => {
  it('sem acento e maiúscula, no texto e nas transcrições, em todo o histórico, mais recentes primeiro, dentro do período', () => {
    const a1 = ctx.add(ANA, { text: 'Qual o PRECO do pacote?', minutesAgo: 400 * 24 * 60 })
    const a2 = ctx.add(ANA, { fromMe: true, text: 'O preço é R$ 100.', minutesAgo: 399 * 24 * 60 })
    const au = ctx.add(ANA, { kind: 'audio', text: null, durationSec: 20, minutesAgo: 60 })
    ctx.repo.setTranscript(au.id, 'achei o preço alto, sinceramente', 'done')
    ctx.add(ANA, { text: 'sem relação', minutesAgo: 30 })
    ctx.add(BIA, { text: 'preço para outra pessoa', minutesAgo: 10 })
    const r = runCopilotoSearch(ctx.repo, search(), { phoneOf, roster: new Set() })
    expect(r).toMatchObject({ version: 1, action: 'search_result', id: SEARCH_ID, status: 'done', total_found: 3, truncated: false, error: null })
    expect(r.results.map((x) => x.sent_at)).toEqual([au, a2, a1].map((m) => new Date(m.ts).toISOString()))
    expect(r.results[0]).toEqual({
      chat: { key: chatKey(ANA), kind: 'individual', name: null },
      sent_at: new Date(au.ts).toISOString(),
      from_mentor: false,
      sender: 'mentorado',
      sender_name: null,
      message_type: 'audio',
      is_transcription: true,
      excerpt: 'achei o preço alto, sinceramente'
    })
    expect(r.results[1]).toMatchObject({ from_mentor: true, sender: 'mentor', sender_name: null, message_type: 'text', is_transcription: false })
    // período inclusivo nas duas pontas
    const only = runCopilotoSearch(ctx.repo, search({ from: a2.ts, to: au.ts }), { phoneOf, roster: new Set() })
    expect(only.results.map((x) => x.sent_at)).toEqual([au, a2].map((m) => new Date(m.ts).toISOString()))
    // nada combina com todas as palavras: qualquer uma delas
    expect(runCopilotoSearch(ctx.repo, search({ query: 'preço xyzabc' }), { phoneOf, roster: new Set() }).total_found).toBe(3)
    // só palavras vazias: nada
    expect(runCopilotoSearch(ctx.repo, search({ query: 'quem falou sobre' }), { phoneOf, roster: new Set() })).toMatchObject({ status: 'done', total_found: 0, results: [] })
  })

  it('no máximo 50, total_found e truncated; trecho de até 400 caracteres em volta do termo', () => {
    for (let i = 0; i < 60; i++) ctx.add(ANA, { text: `mensagem ${i} sobre o preço`, minutesAgo: 1000 + i })
    const long = `${'começo '.repeat(120)}aqui está o preço combinado ${'fim '.repeat(150)}`
    ctx.add(ANA, { text: long, minutesAgo: 1 })
    const r = runCopilotoSearch(ctx.repo, search(), { phoneOf, roster: new Set() })
    expect(r.results).toHaveLength(COPILOTO_SEARCH_LIMITS.maxResults)
    expect(r).toMatchObject({ total_found: 61, truncated: true })
    const ex = r.results[0].excerpt
    expect([...ex].length).toBeLessThanOrEqual(400)
    expect(ex.startsWith('…')).toBe(true)
    expect(ex.endsWith('…')).toBe(true)
    expect(ex).toContain('preço combinado')
  })

  it('quem mandou: mentor, mentorado (este ou da lista, inclusive segunda cadeira) e outro com o nome; nunca telefone', () => {
    ctx.repo.upsertContact({ jid: BIA, pushName: 'Bia Exemplo' })
    ctx.repo.upsertContact({ jid: CAIO, pushName: '+55 11 97777-6666' })
    ctx.repo.setGroupMembers(G_ANA, [ANA, BIA, CAIO, OLD])
    ctx.add(G_ANA, { senderJid: ANA, senderName: 'Ana', text: 'preço 1', minutesAgo: 5 })
    ctx.add(G_ANA, { senderJid: OLD, senderName: 'Segunda Cadeira', text: 'preço 2', minutesAgo: 4 })
    ctx.add(G_ANA, { senderJid: BIA, text: 'preço 3', minutesAgo: 3 })
    ctx.add(G_ANA, { senderJid: CAIO, senderName: '5511977776666', text: 'preço 4', minutesAgo: 2 })
    ctx.add(G_ANA, { fromMe: true, text: 'preço 5', minutesAgo: 1 })
    ctx.repo.setGroupSubject(G_ANA, 'Turma Exemplo')
    // a lista de mentorados tem a segunda cadeira (OLD); BIA e CAIO não
    const r = runCopilotoSearch(ctx.repo, search(), { phoneOf, roster: new Set(rosterOf(ROSTER_PHONES)) })
    expect(r.results.map((x) => [x.excerpt, x.sender, x.sender_name, x.from_mentor])).toEqual([
      ['preço 5', 'mentor', null, true],
      ['preço 4', 'outro', null, false],
      ['preço 3', 'outro', 'Bia Exemplo', false],
      ['preço 2', 'mentorado', 'Segunda Cadeira', false],
      ['preço 1', 'mentorado', 'Ana', false]
    ])
    expect(r.results[0].chat).toEqual({ key: chatKey(G_ANA), kind: 'group', name: 'Turma Exemplo' })
    const raw = JSON.stringify(r)
    for (const phone of [ANA_PHONE, BIA_PHONE, CAIO_PHONE, OLD_PHONE, '97777-6666', '@s.whatsapp.net', '@g.us']) expect(raw).not.toContain(phone)
  })

  it('v0.10.1: remetente @lid com o telefone guardado na mensagem: mentorado, com o nome do contato do telefone', () => {
    ctx.repo.upsertContact({ jid: OLD, pushName: 'Segunda Cadeira' })
    ctx.repo.setGroupMembers(G_ANA, [ANA])
    ctx.add(G_ANA, { senderJid: '246802468024680@lid', senderPn: OLD, text: 'preço 9', minutesAgo: 2 })
    const r = runCopilotoSearch(ctx.repo, search(), { phoneOf, roster: new Set(rosterOf(ROSTER_PHONES)) })
    expect(r.results.map((x) => [x.excerpt, x.sender, x.sender_name])).toEqual([['preço 9', 'mentorado', 'Segunda Cadeira']])
    expect(JSON.stringify(r)).not.toContain('@lid')
  })

  it('pedido inválido responde erro sem procurar; sem conversa do mentorado, nada', () => {
    ctx.add(ANA, { text: 'preço' })
    expect(runCopilotoSearch(ctx.repo, search({ invalid: 'periodo_invalido' }), { phoneOf, roster: new Set() })).toMatchObject({ status: 'error', error: 'periodo_invalido', results: [], total_found: 0 })
    expect(runCopilotoSearch(ctx.repo, search({ phoneHashes: [rosterHash('5521900000000')] }), { phoneOf, roster: new Set() })).toMatchObject({ status: 'done', total_found: 0 })
  })
})

describe('a fila das pesquisas (search_pending a cada 60 s, search_result até confirmar)', () => {
  type Reply = { status: number; body?: unknown } | 'network'
  let sync: CopilotoSync
  let calls: Array<{ body: any; raw: string; at: number }>
  let pending: unknown[]
  let cancelled: string[]
  let pollReplies: Reply[]
  let resultReplies: Reply[]
  const roster = rosterOf([...ROSTER_PHONES, CAIO_PHONE])

  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const raw = String(init?.body ?? '')
    const body = JSON.parse(raw)
    calls.push({ body, raw, at: ctx.clock.now() })
    const reply = (r: Reply | undefined, ok: unknown) => {
      if (r === 'network') throw new TypeError('fetch failed')
      return new Response(JSON.stringify(r?.body ?? ok), { status: r?.status ?? 200 })
    }
    if (body.action === 'roster') return new Response(JSON.stringify({ version: 1, phones: roster }), { status: 200 })
    if (body.action === 'followups_pending') return new Response(JSON.stringify({ version: 1, followups: [] }), { status: 200 })
    if (body.action === 'search_pending') return reply(pollReplies.shift(), { version: 1, searches: pending, cancelled_ids: cancelled })
    if (body.action === 'search_result') return reply(resultReplies.shift(), { status: 'stored' })
    return new Response(JSON.stringify({ results: body.events.map((e: { id: string }) => ({ id: e.id, status: 'stored' })) }), { status: 200 })
  })
  const polls = () => calls.filter((c) => c.body.action === 'search_pending')
  const results = () => calls.filter((c) => c.body.action === 'search_result')
  const item = (id = SEARCH_ID, query = 'preço') => ({ id, target: { phone_hashes: ANA_HASHES, chat_keys: [] }, query, from: null, to: null, created_at: new Date(ctx.clock.now()).toISOString() })

  async function run(ms: number): Promise<void> {
    const end = ctx.clock.now() + ms
    while (ctx.clock.now() < end) {
      const next = await sync.tick()
      if (next === null) return
      ctx.clock.advance(Math.min(Math.max(next, COPILOTO_LIMITS.gapMs), end - ctx.clock.now() || COPILOTO_LIMITS.gapMs))
    }
  }

  beforeEach(async () => {
    calls = []
    pending = []
    cancelled = []
    pollReplies = []
    resultReplies = []
    fetchMock.mockClear()
    sync = new CopilotoSync({ repo: ctx.repo, cipher: fakeCipher, clock: ctx.clock, fetchImpl: fetchMock as unknown as typeof fetch })
    expect(sync.save({ url: WEBHOOK }).ok).toBe(true)
    expect(sync.generateCode().ok).toBe(true)
  })

  it('desligada: nunca consulta; ligada: a cada 60 s; responde, conta as respondidas e não refaz um já respondido', async () => {
    await run(5 * MIN)
    expect(calls).toHaveLength(0)
    ctx.add(ANA, { text: 'qual o preço da mentoria?', minutesAgo: 500 * 24 * 60 })
    expect(sync.save({ enabled: true }).ok).toBe(true)
    await run(10_000)
    expect(polls()).toHaveLength(1)
    pending = [item()]
    await run(61_000)
    expect(polls()).toHaveLength(2)
    expect(results()).toHaveLength(1)
    const body = results()[0].body
    expect(body).toMatchObject({ version: 1, action: 'search_result', id: SEARCH_ID, status: 'done', total_found: 1, truncated: false, error: null })
    expect(body.results[0]).toMatchObject({ sender: 'mentorado', excerpt: 'qual o preço da mentoria?' })
    expect(results()[0].raw).not.toContain(ANA_PHONE)
    expect(sync.status().searches).toEqual({ today: 1, lastAt: expect.any(Number) })
    expect(searchesLine(sync.status().searches, ctx.clock.now())).toMatch(/^Pesquisas do Copiloto: 1 respondida hoje · última às \d\d:\d\d$/)
    // veio de novo (o Copiloto ainda não tinha gravado): não refaz nem reenvia
    await run(2 * 60_000)
    expect(polls().length).toBeGreaterThanOrEqual(4)
    expect(results()).toHaveLength(1)
    // dia seguinte: a contagem recomeça
    ctx.clock.advance(DAY)
    expect(sync.status().searches.today).toBe(0)
  })

  it('rede, 5xx e 429: tenta de novo com espera crescente até o Copiloto confirmar; expired acaba sem contar', async () => {
    ctx.add(ANA, { text: 'preço', minutesAgo: 60 })
    pending = [item()]
    resultReplies = ['network', { status: 503 }, { status: 429 }]
    expect(sync.save({ enabled: true }).ok).toBe(true)
    await run(30_000)
    pending = []
    await run(10 * MIN)
    // a primeira e três novas tentativas: 1 min, 2 min e 4 min depois (a última confirmada)
    const at = results().map((c) => c.at)
    expect(at).toHaveLength(4)
    const gaps = at.slice(1).map((t, i) => t - at[i])
    gaps.forEach((g, i) => {
      expect(g).toBeGreaterThanOrEqual(MIN * 2 ** i)
      expect(g).toBeLessThan(MIN * 2 ** i + 10_000)
    })
    expect(sync.status().searches.today).toBe(1)
    // outro pedido, que o Copiloto já tinha expirado: acaba, não conta, não volta
    pending = [item('a1b2c3d4-0000-4000-8000-000000000001')]
    resultReplies = [{ status: 200, body: { status: 'expired' } }]
    await run(2 * MIN)
    pending = []
    await run(5 * MIN)
    expect(results()).toHaveLength(5)
    expect(results()[4].body.id).toBe('a1b2c3d4-0000-4000-8000-000000000001')
    expect(sync.status().searches.today).toBe(1)
  })

  it('cancelado antes de sair: o resultado não vai; 401 para tudo; consulta que falha espera mais', async () => {
    ctx.add(ANA, { text: 'preço', minutesAgo: 60 })
    pending = [item()]
    resultReplies = ['network']
    expect(sync.save({ enabled: true }).ok).toBe(true)
    await run(30_000)
    expect(results()).toHaveLength(1)
    pending = []
    cancelled = [SEARCH_ID]
    await run(3 * MIN)
    expect(results()).toHaveLength(1)
    // a consulta falha: 1 min, depois 2 min
    const before = polls().length
    pollReplies = [{ status: 500 }, { status: 500 }]
    await run(4 * MIN)
    expect(polls().length - before).toBeLessThanOrEqual(3)
    // 401: para (nem consulta, nem eventos)
    pollReplies = [{ status: 401 }]
    await run(5 * MIN)
    const n = calls.length
    expect(sync.status().authFailed).toBe(true)
    await run(10 * MIN)
    expect(calls.length).toBe(n)
  })

  it('nunca registra o texto procurado, os trechos nem telefones (só contagens)', async () => {
    const logged: string[] = []
    const origLog = ctx.repo.logEvent.bind(ctx.repo)
    ctx.repo.logEvent = (k, d) => {
      logged.push(`${k} ${d}`)
      origLog(k, d)
    }
    sync = new CopilotoSync({ repo: ctx.repo, cipher: fakeCipher, clock: ctx.clock, fetchImpl: fetchMock as unknown as typeof fetch, diag: (k, d) => logged.push(`${k} ${d}`) })
    ctx.add(ANA, { text: 'conteúdo secreto sobre orçamento', minutesAgo: 60 })
    pending = [item(SEARCH_ID, 'orçamento sigiloso')]
    resultReplies = [{ status: 500 }]
    expect(sync.save({ enabled: true }).ok).toBe(true)
    await run(3 * MIN)
    expect(results().length).toBeGreaterThanOrEqual(2)
    const all = logged.join('\n')
    expect(all).toMatch(/copiloto_search/)
    for (const bad of ['orçamento', 'sigiloso', 'conteúdo secreto', ANA_PHONE, WEBHOOK]) expect(all).not.toContain(bad)
  })

  it('a carga inicial (muitos eventos) não segura as pesquisas: no máximo 2 min entre consultas', { timeout: 60_000 }, async () => {
    ctx.repo.transaction(() => {
      for (let i = 0; i < 12_000; i++) ctx.add(ANA, { text: `mensagem ${i}`, minutesAgo: 10 + i })
    })
    expect(sync.save({ enabled: true }).ok).toBe(true)
    const at: number[] = []
    for (let i = 0; i < 400 && (i < 3 || ctx.repo.copiloto.pendingCount() + ctx.repo.copiloto.dirtyCount() > 0); i++) {
      const n = polls().length
      const next = await sync.tick()
      if (polls().length > n) at.push(ctx.clock.now())
      ctx.clock.advance(Math.max(next ?? COPILOTO_LIMITS.gapMs, COPILOTO_LIMITS.gapMs))
    }
    expect(calls.filter((c) => c.body.events).length).toBeGreaterThan(100)
    expect(at.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeLessThanOrEqual(COPILOTO_SEARCH_LIMITS.maxPollDelayMs + 3 * COPILOTO_LIMITS.gapMs)
  })
})

describe('a linha de Configurações', () => {
  it('só contagens e a hora da última', () => {
    const now = new Date(2026, 10, 27, 15, 0).getTime()
    expect(searchesLine({ today: 0, lastAt: null }, now)).toBe('Pesquisas do Copiloto: 0 respondidas hoje')
    expect(searchesLine({ today: 1, lastAt: new Date(2026, 10, 27, 9, 5).getTime() }, now)).toBe('Pesquisas do Copiloto: 1 respondida hoje · última às 09:05')
    expect(searchesLine({ today: 0, lastAt: new Date(2026, 10, 25, 18, 30).getTime() }, now)).toBe('Pesquisas do Copiloto: 0 respondidas hoje · última às 18:30 de 25/11')
  })
})
