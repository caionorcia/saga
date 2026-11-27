import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COPILOTO_KEYS, COPILOTO_LIMITS, CopilotoSync } from '../../../src/core/copiloto/sync'
import { chatKey, messageEventId, replyStateEventId, summaryEventId } from '../../../src/core/copiloto/identity'
import { groupHistoryLine, groupRepairLine } from '../../../src/shared/copiloto'
import { ANA, ANA_PHONE, BIA, BIA_PHONE, CAIO, CAIO_LID, CAIO_PHONE, G_ANA, G_BIA, ROSTER_PHONES, WEBHOOK, fakeCipher, rosterOf, setup } from './helpers'

/**
 * v0.8.1: grupos de mentorados que nunca chegavam ao Copiloto (a participação ficou conhecida depois da carga inicial) e
 * o reenvio único do histórico dos grupos.
 */

let ctx: ReturnType<typeof setup>
let sync: CopilotoSync
let calls: Array<{ body: any; raw: string }>
let lidKnown: boolean
let ready: boolean
const roster = rosterOf([...ROSTER_PHONES, CAIO_PHONE])

const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
  const raw = String(init?.body ?? '')
  const body = JSON.parse(raw)
  calls.push({ body, raw })
  if (body.action === 'roster') return new Response(JSON.stringify({ version: 1, phones: roster }), { status: 200 })
  if (body.action === 'followups_pending') return new Response(JSON.stringify({ version: 1, followups: [] }), { status: 200 })
  return new Response(JSON.stringify({ results: body.events.map((e: { id: string }) => ({ id: e.id, status: 'stored' })) }), { status: 200 })
})

const sent = () => calls.filter((c) => c.body.events).flatMap((c) => c.body.events)
const groupMsgs = (jid: string) => sent().filter((e: any) => e.type === 'message' && e.chat.key === chatKey(jid))
const outbox = () => ctx.repo.copiloto

function makeSync(): CopilotoSync {
  return new CopilotoSync({
    repo: ctx.repo,
    cipher: fakeCipher,
    clock: ctx.clock,
    fetchImpl: fetchMock as unknown as typeof fetch,
    pnForLid: (lid) => (lidKnown && lid === CAIO_LID ? CAIO : null),
    waReady: () => ready
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
    if (outbox().pendingCount() === 0 && outbox().dirtyCount() === 0 && i > 2) return
    ctx.clock.advance(Math.max(next, COPILOTO_LIMITS.gapMs))
  }
}

beforeEach(() => {
  ctx = setup()
  calls = []
  lidKnown = false
  ready = true
  fetchMock.mockClear()
  sync = makeSync()
})

describe('v0.8.1: grupo que passa a ser de mentorado depois da carga inicial', () => {
  it('participantes conhecidos depois (consulta dos grupos atrasada): o histórico do grupo vai, sem esperar o roster de 6 h', async () => {
    ctx.repo.upsertContact({ jid: G_ANA, isGroup: true, pushName: 'Turma de exemplo', nameRank: 2 })
    // só o mentor escreveu no grupo nos últimos dias: nenhum remetente casa com o roster
    const old = ctx.add(G_ANA, { fromMe: true, text: 'aviso antigo', minutesAgo: 10 * 24 * 60 })
    const recent = ctx.add(G_ANA, { fromMe: true, text: 'aviso recente', minutesAgo: 60 })
    ctx.add(ANA, { text: 'oi' })
    await enable()
    await drain()
    expect(groupMsgs(G_ANA)).toHaveLength(0)
    // a consulta dos grupos chega depois da carga (na v0.8.0 o grupo só entrava com mensagem nova ou no roster de 6 h)
    ctx.repo.setGroupMembers(G_ANA, [ANA, BIA])
    ;(sync as { membershipChanged?: () => void }).membershipChanged?.()
    ctx.clock.advance(COPILOTO_LIMITS.idleMs)
    await drain()
    const ids = groupMsgs(G_ANA).map((e: any) => e.id)
    expect(ids).toEqual(expect.arrayContaining([messageEventId(G_ANA, old.id), messageEventId(G_ANA, recent.id)]))
    expect(groupMsgs(G_ANA)[0].chat).toEqual({ key: chatKey(G_ANA), kind: 'group', name: 'Turma de exemplo', phones: [ANA_PHONE] })
    for (const c of calls) expect(c.raw).not.toContain(BIA_PHONE)
  })

  it('mentorado só como @lid: o grupo entra quando o telefone do @lid fica conhecido (memória ou guardado)', async () => {
    ctx.repo.upsertContact({ jid: G_ANA, isGroup: true })
    ctx.repo.setGroupMembers(G_ANA, [CAIO_LID, BIA])
    const m = ctx.add(G_ANA, { senderJid: CAIO_LID, senderName: 'Caio', text: 'pergunta', minutesAgo: 3 * 24 * 60 })
    await enable()
    await drain()
    expect(groupMsgs(G_ANA)).toHaveLength(0)
    lidKnown = true
    sync.membershipChanged()
    ctx.clock.advance(COPILOTO_LIMITS.gapMs)
    await drain()
    const [e] = groupMsgs(G_ANA)
    expect(e).toMatchObject({ id: messageEventId(G_ANA, m.id), chat: { phones: [CAIO_PHONE] }, sender: { phone: CAIO_PHONE, is_mentor: false } })

    // guardado (sem o mapa da memória, como depois de reiniciar): o par vira forma do participante
    const ctx2 = setup()
    ctx2.repo.upsertContact({ jid: G_ANA, isGroup: true })
    ctx2.repo.setGroupMembers(G_ANA, [CAIO_LID])
    expect(ctx2.repo.linkLidPhone(CAIO_LID, CAIO)).toBe(1)
    expect(ctx2.repo.copiloto.groupParticipants(G_ANA)).toContain(CAIO)
  })

  it('a carga anotada se perde se o grupo deixa de casar antes de virar evento: agora é refeita quando ele volta a casar', async () => {
    ctx.repo.upsertContact({ jid: G_ANA, isGroup: true })
    ctx.repo.setGroupMembers(G_ANA, [CAIO_LID])
    const m = ctx.add(G_ANA, { fromMe: true, text: 'aviso', minutesAgo: 2 * 24 * 60 })
    lidKnown = true
    await enable()
    await sync.tick() // roster: a carga do grupo fica anotada
    expect(outbox().isBackfilled(G_ANA)).toBe(true)
    lidKnown = false // o app reiniciou: o mapa do @lid ainda não carregou
    ctx.clock.advance(COPILOTO_LIMITS.gapMs)
    await drain()
    expect(outbox().isBackfilled(G_ANA)).toBe(false)
    lidKnown = true
    sync.membershipChanged()
    ctx.clock.advance(COPILOTO_LIMITS.gapMs)
    await drain()
    expect(groupMsgs(G_ANA).map((e: any) => e.id)).toEqual([messageEventId(G_ANA, m.id)])
  })

  it('v0.9.0 (contrato v1.3): grupo sem mensagem nos últimos 30 dias não manda nenhuma mensagem (nem a mais recente)', async () => {
    ctx.repo.setGroupMembers(G_ANA, [ANA])
    ctx.add(G_ANA, { fromMe: true, text: 'bem antiga', minutesAgo: 80 * 24 * 60 })
    ctx.add(G_ANA, { fromMe: true, text: 'antiga', minutesAgo: 45 * 24 * 60 })
    await enable()
    await drain()
    expect(groupMsgs(G_ANA)).toEqual([])
    expect(sync.repairGroupsNow(new Set(roster))).toMatchObject({ groups: 0, messages: 0, empty: 1 })
    await drain()
    expect(groupMsgs(G_ANA)).toEqual([])
  })

  it('grupo sem mentorado nunca entra (nem na conferência, nem no reenvio)', async () => {
    ctx.repo.setGroupMembers(G_BIA, [BIA])
    ctx.add(G_BIA, { senderJid: BIA, text: 'oi' })
    await enable()
    await drain()
    sync.membershipChanged()
    expect(sync.matchNewGroups(new Set(roster))).toBe(0)
    expect(sync.repairGroupsNow(new Set(roster))).toMatchObject({ groups: 0, messages: 0, empty: 0 })
    await drain()
    expect(sent().some((e: any) => e.chat.key === chatKey(G_BIA))).toBe(false)
    for (const c of calls) expect(c.raw).not.toContain(BIA_PHONE)
  })

  it('o grupo ganha nome depois de enviado: a mensagem mais recente volta à fila com o nome novo', async () => {
    ctx.repo.setGroupMembers(G_ANA, [ANA])
    ctx.add(G_ANA, { fromMe: true, text: 'primeira', minutesAgo: 120 })
    const last = ctx.add(G_ANA, { fromMe: true, text: 'segunda', minutesAgo: 60 })
    await enable()
    await drain()
    expect(groupMsgs(G_ANA).every((e: any) => e.chat.name === null)).toBe(true)
    calls = []
    expect(ctx.repo.setGroupSubject(G_ANA, 'Turma de exemplo')).toBe(true)
    await drain()
    expect(groupMsgs(G_ANA).map((e: any) => [e.id, e.chat.name])).toEqual([[messageEventId(G_ANA, last.id), 'Turma de exemplo']])
  })
})

describe('v0.8.1: reenvio do histórico dos grupos (uma vez depois da atualização, e pelo botão)', () => {
  /** Uma instalação da v0.8.0: ligada, carga feita, e o reenvio nunca rodou. */
  async function oldInstall(): Promise<{ ids: string[] }> {
    ctx.repo.upsertContact({ jid: G_ANA, isGroup: true, pushName: 'Turma de exemplo', nameRank: 2 })
    ctx.repo.setGroupMembers(G_ANA, [ANA, BIA])
    const a = ctx.add(G_ANA, { senderJid: ANA, senderName: 'Ana', text: 'dúvida', minutesAgo: 5 * 24 * 60 })
    const b = ctx.add(G_ANA, { senderJid: BIA, senderName: 'Bia', text: 'eu também', minutesAgo: 5 * 24 * 60 - 1 })
    const c = ctx.add(G_ANA, { fromMe: true, text: 'respondo amanhã', minutesAgo: 4 * 24 * 60 })
    ctx.add(G_ANA, { senderJid: ANA, text: 'fora da janela', minutesAgo: 40 * 24 * 60 })
    ctx.repo.saveAnalysis(G_ANA, c.id, 'groq', 'Resumo de exemplo.', ['x'])
    await enable()
    await drain()
    ctx.repo.deleteSetting(COPILOTO_KEYS.groupRepairDone)
    calls = []
    return { ids: [a, b, c].map((m) => messageEventId(G_ANA, m.id)) }
  }

  it('roda sozinho uma vez, com o WhatsApp de pé; mesmos ids e formato da captura normal; contagens no status e no registro', async () => {
    const { ids } = await oldInstall()
    // grupo de mentorado conhecido só pelos participantes (nenhuma mensagem aqui): conta, sem inventar mensagem
    ctx.repo.setGroupMembers('120363000000000009@g.us', [CAIO])
    const normal = new Map(outbox().due(Number.MAX_SAFE_INTEGER, 1000).map((r) => [r.eventId, r.payloadJson]))
    expect(normal.size).toBe(0)
    ready = false
    await sync.tick()
    expect(sync.status().groupRepair).toBeNull()
    ready = true
    ctx.clock.advance(COPILOTO_LIMITS.gapMs)
    await drain()
    const msgs = groupMsgs(G_ANA)
    expect(msgs.map((e: any) => e.id).sort()).toEqual([...ids].sort())
    const byId = Object.fromEntries(msgs.map((e: any) => [e.id, e]))
    expect(byId[ids[0]].sender).toEqual({ phone: ANA_PHONE, name: 'Ana', is_mentor: false })
    expect(byId[ids[1]].sender).toEqual({ phone: null, name: 'Bia', is_mentor: false })
    expect(byId[ids[2]].sender).toEqual({ phone: null, name: null, is_mentor: true })
    expect(byId[ids[0]].chat).toEqual({ key: chatKey(G_ANA), kind: 'group', name: 'Turma de exemplo', phones: [ANA_PHONE] })
    const other = sent().filter((e: any) => e.type !== 'message').map((e: any) => e.id)
    expect(other).toEqual(expect.arrayContaining([replyStateEventId(G_ANA), summaryEventId(G_ANA)]))
    const st = sync.status()
    expect(st.groupRepair).toMatchObject({ groups: 1, messages: 3, empty: 1 })
    expect(groupRepairLine(st.groupRepair!)).toBe('Grupos: 1 grupo(s) e 3 mensagem(ns) colocados na fila para o Copiloto (1 grupo(s) sem nenhuma mensagem neste computador)')
    expect(st.pending).toBe(0)
    const log = ctx.repo.recentEvents(50).filter((e) => e.kind === 'copiloto_groups')
    expect(log.map((e) => e.detail)).toEqual(['reenvio dos grupos: 1 grupo(s), 3 mensagem(ns) na fila; 1 grupo(s) sem nenhuma mensagem neste computador'])
    for (const c of calls) expect(c.raw).not.toContain(BIA_PHONE)
    // uma vez só
    calls = []
    ctx.clock.advance(COPILOTO_LIMITS.rosterEveryMs)
    await drain()
    expect(groupMsgs(G_ANA)).toHaveLength(0)
  })

  it('rodar de novo (botão) não duplica: a mesma linha por id, o mesmo conteúdo, de volta a pendente', async () => {
    await oldInstall()
    const r1 = sync.repairGroupsNow(new Set(roster))
    const first = outbox().due(Number.MAX_SAFE_INTEGER, 1000).map((r) => [r.eventId, r.payloadHash])
    await drain()
    const r2 = await sync.repairGroups()
    expect(r2.ok).toBe(true)
    const second = outbox().due(Number.MAX_SAFE_INTEGER, 1000).map((r) => [r.eventId, r.payloadHash])
    expect(second.sort()).toEqual(first.sort())
    expect(sync.status().groupRepair).toMatchObject({ groups: r1.groups, messages: r1.messages })
    await drain()
    const ids = groupMsgs(G_ANA).map((e: any) => e.id)
    expect(new Set(ids).size * 2).toBe(ids.length)
  })

  it('o botão com a integração desligada não faz nada; sem roster ainda, fica pedido até ele chegar', async () => {
    expect(await sync.repairGroups()).toMatchObject({ ok: false })
    ctx.repo.setGroupMembers(G_ANA, [ANA])
    ctx.add(G_ANA, { fromMe: true, minutesAgo: 10 })
    await enable()
    const r = await sync.repairGroups()
    expect(r.ok && r.status.groupRepairPending).toBe(true)
    await drain()
    expect(sync.status()).toMatchObject({ groupRepairPending: false, groupRepair: { groups: 1, messages: 1 } })
  })

  it('ligar a integração agora não precisa do reenvio (a carga já segue a regra nova)', async () => {
    ctx.repo.setGroupMembers(G_ANA, [ANA])
    ctx.add(G_ANA, { fromMe: true, minutesAgo: 10 })
    await enable()
    await drain()
    expect(sync.status().groupRepair).toBeNull()
    expect(groupMsgs(G_ANA)).toHaveLength(1)
  })
})

describe('v0.8.3: histórico antigo dos grupos chegando depois (vincular de novo ou busca no celular)', () => {
  it('as mensagens antigas que chegam vão ao Copiloto pela captura de sempre, com os mesmos ids; nada duplica; o status conta', async () => {
    ctx.repo.upsertContact({ jid: G_ANA, isGroup: true, pushName: 'Turma de exemplo', nameRank: 2 })
    ctx.repo.setGroupMembers(G_ANA, [ANA, BIA])
    const recent = ctx.add(G_ANA, { senderJid: ANA, text: 'desde o dia 25', minutesAgo: 2 * 24 * 60 })
    await enable()
    await drain()
    expect(groupMsgs(G_ANA).map((e: any) => e.id)).toEqual([messageEventId(G_ANA, recent.id)])
    expect(sync.status().groupHistory).toEqual({ oldestTs: recent.ts, groups: 1, messages: 1, pending: 0 })
    calls = []
    // o vínculo novo (ou a resposta do celular) grava as anteriores
    const old1 = ctx.add(G_ANA, { senderJid: BIA, text: 'antiga', minutesAgo: 20 * 24 * 60 })
    const old2 = ctx.add(G_ANA, { fromMe: true, text: 'mais antiga', minutesAgo: 29 * 24 * 60 })
    expect(sync.status().groupHistory.pending).toBe(0) // ainda só anotadas
    await drain()
    expect(groupMsgs(G_ANA).map((e: any) => e.id).sort()).toEqual([messageEventId(G_ANA, old1.id), messageEventId(G_ANA, old2.id)].sort())
    const st = sync.status()
    expect(st.groupHistory).toEqual({ oldestTs: old2.ts, groups: 1, messages: 3, pending: 0 })
    expect(groupHistoryLine(st.groupHistory)).toMatch(/^Histórico dos grupos: mensagem mais antiga em \d\d\/\d\d; 1 grupo\(s\), 3 mensagem\(ns\) enviadas ao Copiloto$/)
    // o reenvio depois usa os mesmos ids (o servidor faz upsert; aqui, uma linha por id)
    const r = sync.repairGroupsNow(new Set(roster))
    expect(r).toMatchObject({ groups: 1, messages: 3 })
    const ids = outbox().due(Number.MAX_SAFE_INTEGER, 1000).filter((x) => x.eventId.startsWith('sz1:m:')).map((x) => x.eventId)
    expect(ids.sort()).toEqual([recent, old1, old2].map((m) => messageEventId(G_ANA, m.id)).sort())
    for (const c of calls) expect(c.raw).not.toContain(BIA_PHONE)
  })

  it('v0.9.0: candidatos da busca no celular: conversas individuais e grupos de mentorados com mensagem (todo o histórico), menos os que o celular já esgotou; grupo sem mensagem só conta', async () => {
    expect(sync.historyCandidates()).toBeNull() // sem roster
    ctx.add(ANA, { text: 'oi', minutesAgo: 1 })
    ctx.add(BIA, { text: 'não é mentorada', minutesAgo: 1 })
    ctx.repo.setGroupMembers(G_ANA, [ANA])
    ctx.add(G_ANA, { fromMe: true, minutesAgo: 2 * 24 * 60 })
    // o celular já disse que não tem nada antes da mais antiga deste: fica de fora
    const G_FULL = '120363000000000003@g.us'
    ctx.repo.setGroupMembers(G_FULL, [ANA])
    const oldest = ctx.add(G_FULL, { fromMe: true, minutesAgo: 400 * 24 * 60 })
    ctx.repo.setSetting('wa.historyExhausted', JSON.stringify({ [G_FULL]: oldest.id }))
    // de mentorado, sem nenhuma mensagem aqui
    ctx.repo.setGroupMembers('120363000000000009@g.us', [CAIO])
    // não é de mentorado
    ctx.repo.setGroupMembers(G_BIA, [BIA])
    ctx.add(G_BIA, { senderJid: BIA, minutesAgo: 60 })
    await enable()
    await drain()
    expect(sync.historyCandidates()).toEqual({ jids: [ANA, G_ANA], noAnchor: 1 })
  })

  it('histórico importado segura o envio automático: só os follow-ups recebidos depois de 24 h saem sozinhos', async () => {
    await enable()
    expect(sync.save({ autoFollowups: true }).ok).toBe(true)
    const on = sync.autoFollowupsAt()
    expect(on).toBe(ctx.clock.now())
    sync.holdAutoFollowups()
    expect(sync.autoFollowupsAt()).toBe(ctx.clock.now() + COPILOTO_LIMITS.historyHoldMs)
    // só estende
    ctx.clock.advance(60_000)
    sync.holdAutoFollowups()
    expect(sync.autoFollowupsAt()).toBe(ctx.clock.now() + COPILOTO_LIMITS.historyHoldMs)
    // desligar e ligar a opção não encurta a espera
    sync.save({ autoFollowups: false })
    sync.save({ autoFollowups: true })
    expect(sync.autoFollowupsAt()).toBe(ctx.clock.now() + COPILOTO_LIMITS.historyHoldMs)
    expect(ctx.repo.recentEvents(20).filter((e) => e.kind === 'copiloto_auto' && /histórico importado/.test(e.detail))).toHaveLength(1)
  })
})
