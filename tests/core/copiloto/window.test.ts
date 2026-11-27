import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COPILOTO_LIMITS, CopilotoSync } from '../../../src/core/copiloto/sync'
import { chatKey, messageEventId, replyStateEventId } from '../../../src/core/copiloto/identity'
import { ANA, BIA, CAIO_PHONE, DAY, G_ANA, ROSTER_PHONES, WEBHOOK, fakeCipher, rosterOf, setup } from './helpers'

/**
 * v0.9.0 (contrato v1.3): o SagaZap guarda todo o histórico, mas o Copiloto só recebe os últimos 30 dias. Nenhum
 * caminho (carga inicial, captura por gatilho, transcrição nova, reenvio dos grupos, grupo que passou a casar, nome novo de
 * grupo) manda uma mensagem mais antiga como evento `message`.
 */

let ctx: ReturnType<typeof setup>
let sync: CopilotoSync
let calls: Array<{ body: any; raw: string }>
const roster = rosterOf([...ROSTER_PHONES, CAIO_PHONE])

const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
  const raw = String(init?.body ?? '')
  const body = JSON.parse(raw)
  calls.push({ body, raw })
  if (body.action === 'roster') return new Response(JSON.stringify({ version: 1, phones: roster }), { status: 200 })
  if (body.action === 'followups_pending') return new Response(JSON.stringify({ version: 1, followups: [] }), { status: 200 })
  if (body.action === 'search_pending') return new Response(JSON.stringify({ version: 1, searches: [], cancelled_ids: [] }), { status: 200 })
  return new Response(JSON.stringify({ results: body.events.map((e: { id: string }) => ({ id: e.id, status: 'stored' })) }), { status: 200 })
})

const events = () => calls.filter((c) => c.body.events).flatMap((c) => c.body.events)
const messageIds = () => events().filter((e: any) => e.type === 'message').map((e: any) => e.id)
const outbox = () => ctx.repo.copiloto
const daysAgo = (d: number) => ({ minutesAgo: d * 24 * 60 })

async function enable(): Promise<void> {
  expect(sync.save({ url: WEBHOOK }).ok).toBe(true)
  expect(sync.generateCode().ok).toBe(true)
  expect(sync.save({ enabled: true }).ok).toBe(true)
}

async function drain(max = 40): Promise<void> {
  for (let i = 0; i < max; i++) {
    const next = await sync.tick()
    if (next === null) return
    if (outbox().pendingCount() === 0 && outbox().dirtyCount() === 0 && i > 2) return
    ctx.clock.advance(Math.max(next, COPILOTO_LIMITS.gapMs))
  }
}

/** nenhum evento `message` com `sent_at` de mais de 30 dias antes de agora */
function noOldMessages(): void {
  const limit = ctx.clock.now() - 30 * DAY
  for (const e of events()) if (e.type === 'message') expect(Date.parse(e.sent_at)).toBeGreaterThanOrEqual(limit)
}

beforeEach(() => {
  ctx = setup()
  calls = []
  fetchMock.mockClear()
  sync = new CopilotoSync({ repo: ctx.repo, cipher: fakeCipher, clock: ctx.clock, fetchImpl: fetchMock as unknown as typeof fetch })
})

describe('v0.9.0: o Copiloto nunca recebe mensagem com mais de 30 dias', () => {
  it('carga inicial: só os últimos 30 dias; o "Para responder" não aponta para mensagem antiga', async () => {
    const ancient = ctx.add(ANA, { text: 'muito antiga', ...daysAgo(400) })
    const old = ctx.add(ANA, { text: 'antiga', ...daysAgo(31) })
    const recent = ctx.add(ANA, { text: 'recente', fromMe: true, ...daysAgo(10) })
    await enable()
    await drain()
    expect(messageIds()).toEqual([messageEventId(ANA, recent.id)])
    expect(messageIds()).not.toContain(messageEventId(ANA, old.id))
    expect(messageIds()).not.toContain(messageEventId(ANA, ancient.id))
    noOldMessages()
  })

  it('captura (gatilho): histórico antigo que chega depois (busca no celular) fica só aqui; o novo vai', async () => {
    ctx.add(ANA, { text: 'oi', ...daysAgo(1) })
    await enable()
    await drain()
    calls = []
    const old = ctx.add(ANA, { text: 'do ano passado', ...daysAgo(300) })
    const fresh = ctx.add(ANA, { text: 'de hoje', minutesAgo: 1 })
    await drain()
    expect(messageIds()).toEqual([messageEventId(ANA, fresh.id)])
    expect(messageIds()).not.toContain(messageEventId(ANA, old.id))
    noOldMessages()
  })

  it('transcrição de um áudio antigo ("Transcrever" sob pedido) não manda o áudio ao Copiloto', async () => {
    const au = ctx.add(ANA, { kind: 'audio', text: null, durationSec: 9, ...daysAgo(90) })
    ctx.add(ANA, { text: 'oi', ...daysAgo(1) })
    await enable()
    await drain()
    calls = []
    ctx.repo.setTranscript(au.id, 'conteúdo do áudio antigo', 'done')
    await drain()
    expect(messageIds()).toEqual([])
    for (const c of calls) expect(c.raw).not.toContain('conteúdo do áudio antigo')
  })

  it('reenvio dos grupos, grupo que passou a casar e nome novo: nada de mais de 30 dias', async () => {
    const g45 = ctx.add(G_ANA, { fromMe: true, text: 'antiga do grupo', ...daysAgo(45) })
    await enable()
    await drain()
    expect(messageIds()).toEqual([])
    // passou a casar (participante conhecido depois)
    ctx.repo.setGroupMembers(G_ANA, [ANA])
    sync.membershipChanged()
    ctx.clock.advance(COPILOTO_LIMITS.regroupEveryMs)
    await drain()
    expect(messageIds()).toEqual([])
    // nome novo: a mais recente é antiga, não vai
    ctx.repo.setGroupSubject(G_ANA, 'Turma de exemplo')
    await drain()
    expect(messageIds()).toEqual([])
    // reenvio pelo botão
    expect(sync.repairGroupsNow(new Set(roster))).toMatchObject({ groups: 0, messages: 0, empty: 1 })
    await drain()
    expect(messageIds()).not.toContain(messageEventId(G_ANA, g45.id))
    // uma recente entra normalmente (e só ela)
    const g1 = ctx.add(G_ANA, { fromMe: true, text: 'recente do grupo', ...daysAgo(1) })
    await drain()
    expect(messageIds()).toEqual([messageEventId(G_ANA, g1.id)])
    expect(events().filter((e: any) => e.type === 'message').every((e: any) => e.chat.key === chatKey(G_ANA))).toBe(true)
    noOldMessages()
  })

  it('conversa parada há mais de 30 dias (o contato falou por último): "Para responder" desligado, sem apontar mensagem', async () => {
    ctx.add(ANA, { text: 'pode me ajudar?', ...daysAgo(40) })
    // a janela conta pelo horário das mensagens do WhatsApp: há mensagens de hoje em outra conversa
    ctx.add(BIA, { text: 'oi', minutesAgo: 1 })
    await enable()
    await drain()
    const rs = events().find((e: any) => e.id === replyStateEventId(ANA))
    expect(rs).toMatchObject({ needs_reply: false, last_inbound_message_id: null, resolution: 'not_needed', decided_by: 'rule' })
    expect(messageIds()).toEqual([])
  })
})
