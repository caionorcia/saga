import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COPILOTO_LIMITS, CopilotoSync } from '../../../src/core/copiloto/sync'
import { chatKey, rosterHash } from '../../../src/core/copiloto/identity'
import { parseFollowup, parsePending, resolveTarget, shortReason } from '../../../src/core/copiloto/followups'
import { FOLLOWUP_LIMITS } from '../../../src/shared/copiloto'
import { ANA, ANA_PHONE, BIA, CAIO_LID, CAIO_PHONE, G_ANA, MIN, OLD, OLD_PHONE, ROSTER_PHONES, WEBHOOK, fakeCipher, rosterOf, setup } from './helpers'

const F1 = '11111111-1111-4111-8111-111111111111'
const F2 = '22222222-2222-4222-8222-222222222222'
const F3 = '33333333-3333-4333-8333-333333333333'
const iso = (ms: number) => new Date(ms).toISOString()

const individual = (phones: string[]) => ({ kind: 'individual', phone_hashes: phones.map(rosterHash) })
const item = (id: string, target: unknown, text = 'Oi! Como foi a semana?', o: Record<string, unknown> = {}) => ({
  id,
  target,
  text,
  author: 'Equipe · Fulana',
  created_at: '2026-11-26T12:00:00-03:00',
  ...o
})

describe('follow-ups: leitura da fila do Copiloto', () => {
  it('confere cada item: id, alvo, texto (≤ 4000), autor e data; itens fora do contrato ficam de fora', () => {
    expect(parseFollowup(item(F1, individual([ANA_PHONE])))).toMatchObject({ id: F1, text: 'Oi! Como foi a semana?', author: 'Equipe · Fulana', createdAt: Date.parse('2026-11-26T15:00:00Z') })
    expect(parseFollowup(item(F1, { kind: 'group', chat_key: chatKey(G_ANA) }))?.target).toEqual({ kind: 'group', chat_key: chatKey(G_ANA) })
    const bad = [
      item('x y', individual([ANA_PHONE])),
      item(F1, { kind: 'individual', phone_hashes: [] }),
      item(F1, { kind: 'individual', phone_hashes: ['5547999998888'] }),
      item(F1, { kind: 'group', chat_key: 'abc' }),
      item(F1, { kind: 'outro' }),
      item(F1, individual([ANA_PHONE]), '   '),
      item(F1, individual([ANA_PHONE]), 'a'.repeat(FOLLOWUP_LIMITS.textChars + 1)),
      item(F1, individual([ANA_PHONE]), 'oi', { created_at: 'ontem' }),
      item(F1, individual([ANA_PHONE]), 'oi', { author: 42 }),
      null,
      'texto'
    ]
    for (const b of bad) expect(parseFollowup(b)).toBeNull()
    expect(parseFollowup(item(F1, individual([ANA_PHONE]), 'a'.repeat(FOLLOWUP_LIMITS.textChars)))).not.toBeNull()
    expect(parseFollowup(item(F1, individual([ANA_PHONE]), 'oi', { author: null }))?.author).toBeNull()
  })

  it('v1.2 auto_send: só true vale; ausente, null ou outro tipo = false (o item continua valendo)', () => {
    const base = item(F1, individual([ANA_PHONE]))
    expect(parseFollowup(base)?.autoSend).toBe(false)
    expect(parseFollowup({ ...base, auto_send: true })?.autoSend).toBe(true)
    expect(parseFollowup({ ...base, auto_send: false })?.autoSend).toBe(false)
    for (const v of [null, 'true', 1, {}]) expect(parseFollowup({ ...base, auto_send: v })?.autoSend).toBe(false)
  })

  it('envelope: version 1 e a lista; ids repetidos valem uma vez; inválidos contados', () => {
    expect(parsePending({ version: 2, followups: [] })).toBeNull()
    expect(parsePending({ version: 1 })).toBeNull()
    expect(parsePending(null)).toBeNull()
    const r = parsePending({ version: 1, followups: [item(F1, individual([ANA_PHONE])), item(F1, individual([ANA_PHONE]), 'outro'), { id: F2 }] })
    expect(r?.items.map((f) => f.id)).toEqual([F1])
    expect(r?.items[0].text).toBe('Oi! Como foi a semana?')
    expect(r?.invalid).toBe(1)
  })

  it('motivo curto: uma linha, até 200 caracteres', () => {
    expect(shortReason('  já falei\ncom ela  ')).toBe('já falei com ela')
    expect([...shortReason('é'.repeat(300))!]).toHaveLength(200)
    expect(shortReason('   ')).toBeNull()
  })
})

describe('follow-ups: a conversa local do alvo', () => {
  const chats = [
    { jid: ANA, isGroup: false, lastTs: 10 },
    { jid: OLD, isGroup: false, lastTs: 5 },
    { jid: BIA, isGroup: false, lastTs: 7 },
    { jid: G_ANA, isGroup: true, lastTs: 8 },
    { jid: CAIO_LID, isGroup: false, lastTs: 9 }
  ]
  const phoneOf = (jid: string) => (jid === CAIO_LID ? CAIO_PHONE : jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null)

  it('grupo: pelo chat.key', () => {
    expect(resolveTarget({ kind: 'group', chat_key: chatKey(G_ANA) }, chats, phoneOf)).toBe(G_ANA)
    expect(resolveTarget({ kind: 'group', chat_key: chatKey('120363999999999999@g.us') }, chats, phoneOf)).toBeNull()
  })

  it('individual: pelo hash do telefone, nas duas formas do 9º dígito; @lid pelo telefone conhecido', () => {
    // o Copiloto manda só a forma com o 9; a conta é antiga (sem o 9)
    expect(resolveTarget({ kind: 'individual', phone_hashes: [rosterHash('5547988887777')] }, chats, phoneOf)).toBe(OLD)
    // só a forma sem o 9; a conversa tem o 9
    expect(resolveTarget({ kind: 'individual', phone_hashes: [rosterHash('554799998888')] }, chats, phoneOf)).toBe(ANA)
    expect(resolveTarget({ kind: 'individual', phone_hashes: rosterOf(ROSTER_PHONES.slice(0, 2)) }, chats, phoneOf)).toBe(ANA)
    expect(resolveTarget({ kind: 'individual', phone_hashes: [rosterHash(CAIO_PHONE)] }, chats, phoneOf)).toBe(CAIO_LID)
    // nunca casa com grupo, e número desconhecido não casa
    expect(resolveTarget({ kind: 'individual', phone_hashes: [rosterHash('5521900000000')] }, chats, phoneOf)).toBeNull()
  })

  it('a mesma pessoa em duas conversas (telefone e @lid): a de mensagem mais recente', () => {
    const two = [
      { jid: `${CAIO_PHONE}@s.whatsapp.net`, isGroup: false, lastTs: 1 },
      { jid: CAIO_LID, isGroup: false, lastTs: 9 }
    ]
    expect(resolveTarget({ kind: 'individual', phone_hashes: [rosterHash(CAIO_PHONE)] }, two, phoneOf)).toBe(CAIO_LID)
  })
})

type Reply = { status: number; body?: unknown } | 'network'

describe('follow-ups: busca, relatórios e cancelamento (fila do Copiloto)', () => {
  let ctx: ReturnType<typeof setup>
  let sync: CopilotoSync
  let pending: unknown[]
  /** respostas do followup_update (vazia = 200 com "updated" para todos) */
  let updateReplies: Reply[]
  let pendingReplies: Reply[]
  let calls: Array<{ body: any; raw: string }>
  let changed: number

  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const raw = String(init?.body ?? '')
    const body = JSON.parse(raw)
    calls.push({ body, raw })
    if (body.action === 'roster') return new Response(JSON.stringify({ version: 1, phones: rosterOf(ROSTER_PHONES) }), { status: 200 })
    if (body.action === 'followups_pending') {
      const r = pendingReplies.shift()
      if (r === 'network') throw new TypeError('fetch failed')
      if (r) return new Response(JSON.stringify(r.body ?? {}), { status: r.status })
      return new Response(JSON.stringify({ version: 1, followups: pending }), { status: 200 })
    }
    if (body.action === 'followup_update') {
      const r = updateReplies.shift()
      if (r === 'network') throw new TypeError('fetch failed')
      if (r) return new Response(JSON.stringify(r.body ?? {}), { status: r.status })
      return new Response(JSON.stringify({ results: body.updates.map((u: { id: string }) => ({ id: u.id, status: 'updated' })) }), { status: 200 })
    }
    return new Response(JSON.stringify({ results: body.events.map((e: { id: string }) => ({ id: e.id, status: 'stored' })) }), { status: 200 })
  })

  const make = () =>
    new CopilotoSync({ repo: ctx.repo, cipher: fakeCipher, clock: ctx.clock, fetchImpl: fetchMock as unknown as typeof fetch, onFollowups: () => changed++ })
  const of = (action: string) => calls.filter((c) => c.body.action === action)
  const updates = () => of('followup_update').flatMap((c) => c.body.updates)
  const fu = (id: string) => ctx.repo.followups.get(id)

  /** roda as voltas (respeitando o tempo que cada uma pede) */
  async function run(n = 30): Promise<void> {
    for (let i = 0; i < n; i++) {
      const next = await sync.tick()
      if (next === null) return
      ctx.clock.advance(Math.max(next, COPILOTO_LIMITS.gapMs))
    }
  }

  /** um envio avulso do follow-up, como o serviço faz (id do rascunho = id do follow-up) */
  function enqueueSend(id: string, jid: string, text: string) {
    const { send } = ctx.repo.sends.enqueue({ idemKey: `avulsa:${jid}:${id}:h${text.length}`, kind: 'avulsa', replyId: null, jid, text, address: jid, quotedId: null })
    ctx.repo.followups.transition(id, ['waiting'], 'sending', { sendId: send.id })
    return send
  }
  function confirmSent(sendId: number, echo = true) {
    const s = ctx.repo.sends.get(sendId)!
    ctx.repo.sends.transition(s.id, s.attempt, ['queued'], 'sending', { newMsgId: `OUT${sendId}` })
    ctx.repo.sends.transition(s.id, s.attempt, ['sending'], 'sent', { sentAt: ctx.clock.now(), waMsgId: `OUT${sendId}` })
    if (echo) ctx.add(s.jid, { id: `OUT${sendId}`, fromMe: true, text: s.text, minutesAgo: 0 })
  }

  beforeEach(async () => {
    ctx = setup()
    ctx.add(ANA, { text: 'oi', minutesAgo: 60 })
    ctx.add(OLD, { text: 'oi', minutesAgo: 90 })
    ctx.repo.setGroupMembers(G_ANA, [ANA, BIA])
    ctx.add(G_ANA, { senderJid: ANA, text: 'bom dia', minutesAgo: 30 })
    pending = [item(F1, individual([ANA_PHONE])), item(F2, { kind: 'group', chat_key: chatKey(G_ANA) }, 'Lembrete do encontro'), item(F3, individual(['5521900000000']))]
    updateReplies = []
    pendingReplies = []
    calls = []
    changed = 0
    fetchMock.mockClear()
    sync = make()
    sync.save({ url: WEBHOOK })
    sync.generateCode()
    sync.save({ enabled: true })
  })

  it('ao ligar busca os follow-ups (na mesma fila, com o código) e guarda com a conversa local; sem conversa → "conversa_nao_encontrada"', async () => {
    await run(6)
    expect(of('followups_pending')).toHaveLength(1)
    expect(of('followups_pending')[0].body).toEqual({ version: 1, action: 'followups_pending' })
    expect(fu(F1)).toMatchObject({ jid: ANA, status: 'waiting', text: 'Oi! Como foi a semana?', author: 'Equipe · Fulana' })
    expect(fu(F2)).toMatchObject({ jid: G_ANA, status: 'waiting' })
    expect(fu(F3)).toMatchObject({ jid: null, status: 'failed', reason: 'conversa_nao_encontrada' })
    expect(changed).toBeGreaterThan(0)
    // o "não encontrada" vai logo ao Copiloto (e só ele)
    expect(updates()).toEqual([{ id: F3, status: 'failed', final_text: null, sent_at: null, reason: 'conversa_nao_encontrada' }])
    expect(fu(F3)).toMatchObject({ reported: true, lastResult: 'updated' })
    // nada de telefone em claro nos pedidos de follow-up
    for (const c of calls.filter((x) => x.body.action)) expect(c.raw).not.toContain(ANA_PHONE)
  })

  it('a cada 5 min busca de novo; o mesmo id vindo de novo não duplica nem volta a esperar', async () => {
    await run(6)
    expect(sync.finishFollowup(F1, 'declined', 'recusado_pelo_mentor')).toBe(true)
    await run(3)
    ctx.clock.advance(FOLLOWUP_LIMITS.pollEveryMs)
    await run(3)
    expect(of('followups_pending').length).toBeGreaterThanOrEqual(2)
    expect(fu(F1)!.status).toBe('declined')
    expect(ctx.repo.followups.listVisible(FOLLOWUP_LIMITS.recentMs).filter((f) => f.id === F1)).toHaveLength(0)
    expect(updates().filter((u: { id: string }) => u.id === F1)).toHaveLength(1)
  })

  it('recusar: vai como "declined" com o motivo digitado (≤ 200) ou recusado_pelo_mentor', async () => {
    await run(6)
    sync.finishFollowup(F1, 'declined', `  ${'motivo '.repeat(50)}`)
    sync.finishFollowup(F2, 'declined', 'recusado_pelo_mentor')
    await run(3)
    const u = updates().filter((x: { status: string }) => x.status === 'declined')
    expect(u.find((x: { id: string }) => x.id === F1).reason).toHaveLength(200)
    expect(u.find((x: { id: string }) => x.id === F2)).toEqual({ id: F2, status: 'declined', final_text: null, sent_at: null, reason: 'recusado_pelo_mentor' })
    // só o que espera pode ser recusado
    expect(sync.finishFollowup(F1, 'declined', 'de novo')).toBe(false)
  })

  it('enviado: espera o eco, relata o texto que saiu (editado) e a hora do eco; o mesmo follow-up não relata duas vezes', async () => {
    await run(6)
    const s = enqueueSend(F1, ANA, 'Oi! Como foi a semana? (editado)')
    sync.reconcileFollowups()
    expect(fu(F1)!.status).toBe('sending')
    confirmSent(s.id, false)
    // sem o eco ainda: continua "saindo"
    sync.reconcileFollowups()
    expect(fu(F1)!.status).toBe('sending')
    ctx.add(ANA, { id: `OUT${s.id}`, fromMe: true, text: 'Oi! Como foi a semana? (editado)', minutesAgo: 0 })
    const echoTs = ctx.repo.getMessage(`OUT${s.id}`)!.ts
    expect(sync.reconcileFollowups()).toBe(true)
    expect(fu(F1)).toMatchObject({ status: 'sent', finalText: 'Oi! Como foi a semana? (editado)', sentAt: echoTs, sendId: s.id })
    await run(3)
    expect(updates().filter((u: { id: string }) => u.id === F1)).toEqual([
      { id: F1, status: 'sent', final_text: 'Oi! Como foi a semana? (editado)', sent_at: iso(echoTs), reason: null }
    ])
    expect(fu(F1)!.reported).toBe(true)
  })

  it('o eco não chega: depois de 2 min vale a hora do envio', async () => {
    await run(6)
    const s = enqueueSend(F1, ANA, 'Oi!')
    confirmSent(s.id, false)
    const at = ctx.repo.sends.get(s.id)!.sentAt
    ctx.clock.advance(COPILOTO_LIMITS.echoWaitMs)
    sync.reconcileFollowups()
    expect(fu(F1)).toMatchObject({ status: 'sent', sentAt: at })
  })

  it('o envio não saiu (falhou, expirou, cancelado): volta a esperar o mentor, com o motivo; nada vai ao Copiloto', async () => {
    await run(6)
    const s = enqueueSend(F1, ANA, 'Oi!')
    ctx.repo.sends.transition(s.id, s.attempt, ['queued'], 'expired', { error: 'fora do horário de envio' })
    sync.reconcileFollowups()
    expect(fu(F1)).toMatchObject({ status: 'waiting', sendError: 'fora do horário de envio', sendId: null })
    const before = updates().length
    await run(3)
    expect(updates()).toHaveLength(before)
  })

  it('reiniciar no meio do envio: um SagaZap novo acha o envio pelo id do rascunho e relata certo', async () => {
    await run(6)
    const s = enqueueSend(F1, ANA, 'Texto final')
    // o app fecha; a ligação está no banco (send_id e o id do rascunho na chave)
    sync.stop()
    sync = make()
    sync.start()
    confirmSent(s.id)
    await run(4)
    expect(fu(F1)).toMatchObject({ status: 'sent', finalText: 'Texto final', reported: true })
    expect(updates().filter((u: { id: string }) => u.id === F1)).toHaveLength(1)
  })

  it('desligar e ligar de novo: o Copiloto manda de novo um já enviado daqui; não volta a ser oferecido', async () => {
    await run(6)
    const s = enqueueSend(F1, ANA, 'Texto final')
    confirmSent(s.id)
    sync.save({ enabled: false })
    expect(fu(F1)).toBeNull()
    sync.save({ enabled: true })
    await run(6)
    expect(fu(F1)).toMatchObject({ status: 'sent', finalText: 'Texto final' })
  })

  it('"cancelled": tira o aviso de um que não saiu; um já enviado fica enviado (conta como confirmado)', async () => {
    await run(6)
    const s = enqueueSend(F2, G_ANA, 'Lembrete do encontro')
    confirmSent(s.id)
    sync.reconcileFollowups()
    sync.finishFollowup(F1, 'declined', 'recusado_pelo_mentor')
    updateReplies = [{ status: 200, body: { results: [{ id: F1, status: 'cancelled' }, { id: F2, status: 'cancelled' }] } }]
    await run(3)
    expect(fu(F1)).toMatchObject({ status: 'cancelled', reported: true })
    expect(fu(F2)).toMatchObject({ status: 'sent', reported: true, lastResult: 'cancelled' })
    expect(ctx.repo.followups.listVisible(FOLLOWUP_LIMITS.recentMs).map((f) => f.id)).toEqual([F2])
  })

  it('"duplicate" e "invalid" por item: concluídos, nunca reenviados; 400 também conclui', async () => {
    await run(6)
    sync.finishFollowup(F1, 'declined', 'x')
    sync.finishFollowup(F2, 'declined', 'y')
    updateReplies = [{ status: 200, body: { results: [{ id: F1, status: 'duplicate' }, { id: F2, status: 'invalid' }] } }]
    await run(3)
    expect(fu(F1)).toMatchObject({ reported: true, lastResult: 'duplicate' })
    expect(fu(F2)).toMatchObject({ reported: true, lastResult: 'invalid' })
    const n = of('followup_update').length
    ctx.clock.advance(60 * MIN)
    await run(5)
    expect(of('followup_update')).toHaveLength(n)
  })

  it('429, 5xx e rede: o relatório volta com espera crescente até ser confirmado; 401 para tudo', async () => {
    pending = [item(F1, individual([ANA_PHONE]))]
    await run(6)
    sync.finishFollowup(F1, 'declined', 'x')
    updateReplies = [{ status: 503 }, 'network', { status: 429 }]
    await run(2)
    expect(fu(F1)).toMatchObject({ reported: false, reportAttempts: 1 })
    expect(fu(F1)!.nextReportAt).toBeGreaterThan(ctx.clock.now())
    for (let i = 0; i < 6; i++) {
      ctx.clock.advance(COPILOTO_LIMITS.retryMaxMs)
      await run(2)
    }
    expect(fu(F1)).toMatchObject({ reported: true, lastResult: 'updated' })
    expect(of('followup_update')).toHaveLength(4)
    // 401 na busca: para tudo, como no envio de eventos
    pendingReplies = [{ status: 401 }]
    ctx.clock.advance(FOLLOWUP_LIMITS.pollEveryMs)
    await run(3)
    expect(sync.status().authFailed).toBe(true)
  })

  it('a busca falha (rede ou servidor ainda sem follow-up): espera crescente, sem erro na tela', async () => {
    pendingReplies = ['network', { status: 400, body: { error: 'acao desconhecida' } }]
    await run(6)
    expect(of('followups_pending')).toHaveLength(1)
    ctx.clock.advance(COPILOTO_LIMITS.retryMinMs)
    await run(3)
    expect(of('followups_pending')).toHaveLength(2)
    expect(sync.status().lastError).toBeNull()
    ctx.clock.advance(2 * COPILOTO_LIMITS.retryMinMs)
    await run(3)
    expect(fu(F1)!.status).toBe('waiting')
  })

  it('o texto enviado vai cortado em 10000 caracteres (o servidor recusaria)', async () => {
    await run(6)
    const big = 'a'.repeat(COPILOTO_LIMITS.finalTextMax + 50)
    const s = enqueueSend(F1, ANA, big)
    confirmSent(s.id)
    sync.reconcileFollowups()
    await run(3)
    expect(updates().find((u: { id: string }) => u.id === F1).final_text).toHaveLength(COPILOTO_LIMITS.finalTextMax)
  })
})
