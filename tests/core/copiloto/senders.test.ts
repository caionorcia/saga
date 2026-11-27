import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COPILOTO_KEYS, COPILOTO_LIMITS, CopilotoSync } from '../../../src/core/copiloto/sync'
import { EventBuilder } from '../../../src/core/copiloto/events'
import { chatKey, messageEventId } from '../../../src/core/copiloto/identity'
import { senderRepairLine } from '../../../src/shared/copiloto'
import { ANA, BIA, CAIO, CAIO_LID, CAIO_PHONE, DAY, G_ANA, ROSTER_PHONES, WEBHOOK, fakeCipher, rosterOf, setup } from './helpers'

/**
 * v0.10.1: nos grupos dos mentorados, quem mandou chegava como @lid sem telefone conhecido e o evento ia com
 * `sender.phone` null (o Copiloto marcava "desconhecido"). Números fictícios.
 */

let ctx: ReturnType<typeof setup>
let sync: CopilotoSync
let calls: Array<{ body: any }>
const roster = rosterOf([...ROSTER_PHONES, CAIO_PHONE])
/** um @lid de alguém que não está no roster e cujo telefone ninguém sabe */
const STRANGER_LID = '987654321098765@lid'

const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? ''))
  calls.push({ body })
  if (body.action === 'roster') return new Response(JSON.stringify({ version: 1, phones: roster }), { status: 200 })
  if (body.action === 'followups_pending') return new Response(JSON.stringify({ version: 1, followups: [] }), { status: 200 })
  if (body.action === 'search_pending') return new Response(JSON.stringify({ version: 1, searches: [], cancelled_ids: [] }), { status: 200 })
  return new Response(JSON.stringify({ results: body.events.map((e: { id: string }) => ({ id: e.id, status: 'stored' })) }), { status: 200 })
})

const sent = () => calls.filter((c) => c.body.events).flatMap((c) => c.body.events)
const eventOf = (jid: string, id: string) => sent().filter((e: any) => e.id === messageEventId(jid, id)).at(-1)

function makeSync(): CopilotoSync {
  return new CopilotoSync({
    repo: ctx.repo,
    cipher: fakeCipher,
    clock: ctx.clock,
    fetchImpl: fetchMock as unknown as typeof fetch,
    // como no serviço: o cliente do WhatsApp (aqui ausente) e depois os pares guardados no banco
    pnForLid: (lid) => ctx.repo.pnForLid(lid),
    waReady: () => true
  })
}

async function enable(): Promise<void> {
  expect(sync.save({ url: WEBHOOK }).ok).toBe(true)
  expect(sync.generateCode().ok).toBe(true)
  expect(sync.save({ enabled: true }).ok).toBe(true)
}

async function drain(max = 40): Promise<void> {
  for (let i = 0; i < max; i++) {
    const next = await sync.tick()
    if (next === null) return
    if (ctx.repo.copiloto.pendingCount() === 0 && ctx.repo.copiloto.dirtyCount() === 0 && i > 2) return
    ctx.clock.advance(Math.max(next, COPILOTO_LIMITS.gapMs))
  }
}

/** O grupo da Ana (mentorada pelos participantes) com uma mensagem de outro mentorado que chegou como @lid. */
function groupWithLidSender() {
  ctx.repo.upsertContact({ jid: G_ANA, isGroup: true, pushName: 'Turma de exemplo', nameRank: 2 })
  ctx.repo.setGroupMembers(G_ANA, [ANA, BIA, CAIO_LID])
  const fromLid = ctx.add(G_ANA, { senderJid: CAIO_LID, senderName: 'Caio', text: 'pergunta do mentorado', minutesAgo: 30 })
  const stranger = ctx.add(G_ANA, { senderJid: STRANGER_LID, senderName: 'Visitante', text: 'oi pessoal', minutesAgo: 20 })
  const mine = ctx.add(G_ANA, { fromMe: true, text: 'resposta do mentor', minutesAgo: 10 })
  return { fromLid, stranger, mine }
}

beforeEach(() => {
  ctx = setup()
  calls = []
  fetchMock.mockClear()
  sync = makeSync()
})

describe('v0.10.1: sender.phone das mensagens de grupo', () => {
  it('reproduz: @lid sem telefone conhecido → sender.phone null (nunca o @lid); o par aprendido depois reenvia o mesmo id com o telefone', async () => {
    const { fromLid } = groupWithLidSender()
    await enable()
    await drain()
    const before = eventOf(G_ANA, fromLid.id)
    expect(before.sender).toEqual({ phone: null, name: 'Caio', is_mentor: false })
    expect(JSON.stringify(sent())).not.toContain('@lid')
    // o cliente aprende o par (participantAlt de outra mensagem, lid-mapping.update, contatos, participantes, Baileys)
    ctx.repo.linkLidPhone(CAIO_LID, CAIO)
    expect(ctx.repo.getMessage(fromLid.id)?.senderPn).toBe(CAIO)
    await drain()
    const after = eventOf(G_ANA, fromLid.id)
    expect(after.id).toBe(before.id)
    expect(after.sender).toEqual({ phone: CAIO_PHONE, name: 'Caio', is_mentor: false })
    expect(after.chat.phones).toContain(CAIO_PHONE)
  })

  it('o telefone guardado na própria mensagem (da chave) vale mesmo sem o par @lid → telefone', () => {
    ctx.repo.upsertContact({ jid: G_ANA, isGroup: true })
    ctx.repo.setGroupMembers(G_ANA, [ANA])
    const m = ctx.add(G_ANA, { senderJid: CAIO_LID, senderPn: CAIO, text: 'oi' })
    const b = new EventBuilder({ repo: ctx.repo, roster: new Set(roster), pnForLid: () => null })
    expect(b.message(ctx.repo.getMessage(m.id)!)!.event).toMatchObject({ sender: { phone: CAIO_PHONE, is_mentor: false } })
    // sem nenhuma fonte: null, e nunca o número do @lid
    const n = ctx.add(G_ANA, { senderJid: STRANGER_LID, text: 'oi' })
    expect((b.message(ctx.repo.getMessage(n.id)!)!.event as any).sender.phone).toBeNull()
  })

  it('o par guardado sobrevive ao reinício (outro EventBuilder, nenhum cliente do WhatsApp)', () => {
    ctx.repo.upsertContact({ jid: G_ANA, isGroup: true })
    ctx.repo.setGroupMembers(G_ANA, [ANA])
    const m = ctx.add(G_ANA, { senderJid: CAIO_LID, text: 'oi' })
    ctx.repo.saveLidPn(CAIO_LID, CAIO)
    const b = new EventBuilder({ repo: ctx.repo, roster: new Set(roster), pnForLid: (l) => ctx.repo.pnForLid(l) })
    expect((b.message(ctx.repo.getMessage(m.id)!)!.event as any).sender.phone).toBe(CAIO_PHONE)
  })

  it('reenvio único depois da atualização: as do grupo dos últimos 30 dias que não são do mentor, mesmos ids, com o telefone; mais antigas só ganham o sender_pn', async () => {
    const { fromLid, stranger, mine } = groupWithLidSender()
    const old = ctx.add(G_ANA, { senderJid: CAIO_LID, text: 'mensagem antiga', minutesAgo: 40 * 24 * 60 })
    await enable()
    await drain()
    expect(eventOf(G_ANA, fromLid.id).sender.phone).toBeNull()
    // como um banco da v0.10.0: o par conhecido (sem as mensagens corrigidas) e o reenvio ainda não feito
    ctx.repo.saveLidPn(CAIO_LID, CAIO)
    ctx.repo.deleteSetting(COPILOTO_KEYS.senderRepairDone)
    calls = []
    await drain()
    const ids = sent().map((e: any) => e.id)
    expect(ids).toContain(messageEventId(G_ANA, fromLid.id))
    expect(ids).toContain(messageEventId(G_ANA, stranger.id))
    expect(ids).not.toContain(messageEventId(G_ANA, mine.id))
    expect(ids).not.toContain(messageEventId(G_ANA, old.id))
    expect(eventOf(G_ANA, fromLid.id).sender.phone).toBe(CAIO_PHONE)
    expect(eventOf(G_ANA, stranger.id).sender.phone).toBeNull()
    expect(ctx.repo.getMessage(old.id)?.senderPn).toBe(CAIO)
    expect(ctx.repo.getMessage(stranger.id)?.senderPn ?? null).toBeNull()
    const st = sync.status().senderRepair!
    expect(st).toMatchObject({ messages: 2, unresolved: 1 })
    expect(senderRepairLine(st)).toBe('Remetentes dos grupos: 2 mensagens reenviadas; 1 ainda sem telefone identificado')
    // registro: só contagens
    const log = ctx.repo.recentEvents(50).filter((e) => e.kind === 'copiloto_senders')
    expect(log).toHaveLength(1)
    expect(log[0].detail).toBe('remetentes dos grupos: 2 mensagem(ns) reenviada(s); 1 ainda sem telefone identificado')
    // uma vez só
    calls = []
    await drain()
    expect(sent()).toHaveLength(0)
  })

  it('grupo sem mensagem nos últimos 30 dias: a mais recente (de quando for) vai de novo, se não é do mentor', async () => {
    ctx.repo.upsertContact({ jid: G_ANA, isGroup: true })
    ctx.repo.setGroupMembers(G_ANA, [ANA, CAIO_LID])
    const latest = ctx.add(G_ANA, { senderJid: CAIO_LID, text: 'mensagem antiga', minutesAgo: 40 * 24 * 60 })
    await enable()
    await drain()
    ctx.repo.saveLidPn(CAIO_LID, CAIO)
    ctx.repo.deleteSetting(COPILOTO_KEYS.senderRepairDone)
    calls = []
    await drain()
    expect(eventOf(G_ANA, latest.id).sender.phone).toBe(CAIO_PHONE)
    expect(sync.status().senderRepair).toMatchObject({ messages: 1, unresolved: 0 })
    expect(ctx.clock.now() - latest.ts).toBeGreaterThan(30 * DAY)
  })

  it('o botão "Reenviar histórico dos grupos" também corrige os remetentes e mostra as contagens', async () => {
    groupWithLidSender()
    await enable()
    await drain()
    ctx.repo.saveLidPn(CAIO_LID, CAIO)
    const r = await sync.repairGroups()
    expect(r.ok).toBe(true)
    expect(sync.status().senderRepair).toMatchObject({ messages: 2, unresolved: 1 })
    calls = []
    await drain()
    expect(sent().some((e: any) => e.type === 'message' && e.chat.key === chatKey(G_ANA) && e.sender.phone === CAIO_PHONE)).toBe(true)
  })

  it('ligar a integração agora (carga nova) não precisa do reenvio único', async () => {
    await enable()
    expect(ctx.repo.getSetting(COPILOTO_KEYS.senderRepairDone)).toBe('1')
    expect(sync.status().senderRepair).toBeNull()
  })
})
