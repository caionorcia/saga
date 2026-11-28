import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COPILOTO_KEYS, CopilotoSync } from '../../../src/core/copiloto/sync'
import { MEMBERSHIP_SETTINGS, checkedAt, memberHashes, parseMembershipResponse } from '../../../src/core/copiloto/membership'
import { rosterHash } from '../../../src/core/copiloto/identity'
import { saveGroupKinds } from '../../../src/core/wa/groupKinds'
import { DEFAULT_SEND_SCHEDULE, cloneSchedule } from '../../../src/shared/sendHours'
import { MEMBERSHIP_KEYS, MEMBERSHIP_LIMITS, MEMBERSHIP_SLOTS, membershipLine } from '../../../src/shared/membership'
import { ANA, ANA_PHONE, BIA, BIA_PHONE, CAIO, CAIO_LID, CAIO_PHONE, MIN, OLD, OLD_PHONE, ROSTER_PHONES, WEBHOOK, fakeCipher, rosterOf, setup } from './helpers'

/** Adendo v1.4 (v0.11.0): conferência dos grupos da mentoria. Números e grupos fictícios. */

const G_SAGA = '120363050000000001@g.us'
const G_AVISOS = '120363050000000002@g.us'
const G_SOS = '120363050000000003@g.us'
const COM = '120363050000000010@g.us'
const COM_ANN = '120363050000000011@g.us'
const UNKNOWN_LID = '777777777777777@lid'
/** o roster: os mentorados nas duas formas e o CAIO só na forma com o 9 */
const roster = rosterOf([...ROSTER_PHONES, CAIO_PHONE])
const H = (p: string) => rosterHash(p)
/** os hashes esperados de ANA (duas formas), OLD (duas formas) e CAIO (pelo @lid, só a forma do roster) */
const ANA_H = [H(ANA_PHONE), H('554799998888')]
const OLD_H = [H(OLD_PHONE), H('5547988887777')]
const CAIO_H = [H(CAIO_PHONE)]

let ctx: ReturnType<typeof setup>
let sync: CopilotoSync
let calls: Array<{ body: any }>
let reply: (body: any) => Response
let diag: Array<[string, string]>
let meta: string[]
let schedule = cloneSchedule(DEFAULT_SEND_SCHEDULE)

const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? ''))
  calls.push({ body })
  if (body.action === 'roster') return new Response(JSON.stringify({ version: 1, phones: roster }), { status: 200 })
  if (body.action === 'followups_pending') return new Response(JSON.stringify({ version: 1, followups: [] }), { status: 200 })
  if (body.action === 'search_pending') return new Response(JSON.stringify({ version: 1, searches: [], cancelled_ids: [] }), { status: 200 })
  if (body.action === 'group_membership') return reply(body)
  return new Response(JSON.stringify({ results: (body.events ?? []).map((e: { id: string }) => ({ id: e.id, status: 'stored' })) }), { status: 200 })
})

const storedReply = (body: any) =>
  new Response(
    JSON.stringify({
      status: 'stored',
      groups: Object.fromEntries(Object.entries(body.groups).map(([k, g]: [string, any]) => [k, { received: g.members.length, matched: g.members.length, marked: 1 }]))
    }),
    { status: 200 }
  )

const membershipCalls = () => calls.filter((c) => c.body.action === 'group_membership').map((c) => c.body)

/** segunda-feira, 30/11/2026, às `h:m` (hora de Brasília, o fuso dos testes) */
const monday = (h: number, m = 0) => new Date(2026, 10, 30, h, m).getTime()

function goTo(ts: number): void {
  ctx.clock.advance(ts - ctx.clock.now())
}

/** algumas voltas, andando o relógio só os 2 s entre as requisições */
async function spin(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) {
    const next = await sync.tick()
    if (next === null) return
    ctx.clock.advance(2_000)
  }
}

function makeSync(): CopilotoSync {
  return new CopilotoSync({
    repo: ctx.repo,
    cipher: fakeCipher,
    clock: ctx.clock,
    fetchImpl: fetchMock as unknown as typeof fetch,
    pnForLid: (lid) => (lid === CAIO_LID ? CAIO : null),
    diag: (k, d) => diag.push([k, d]),
    schedule: () => schedule,
    rng: () => 0,
    requestGroupMeta: (j) => meta.push(j),
    waReady: () => true
  })
}

async function enable(): Promise<void> {
  expect(sync.save({ url: WEBHOOK }).ok).toBe(true)
  expect(sync.generateCode().ok).toBe(true)
  expect(sync.save({ enabled: true }).ok).toBe(true)
  // o reenvio único dos grupos e o dos remetentes não entram aqui
  ctx.repo.setSetting(COPILOTO_KEYS.groupRepairDone, '1')
  ctx.repo.setSetting(COPILOTO_KEYS.senderRepairDone, '1')
}

beforeEach(async () => {
  ctx = setup()
  calls = []
  diag = []
  meta = []
  schedule = cloneSchedule(DEFAULT_SEND_SCHEDULE)
  reply = storedReply
  fetchMock.mockClear()
  goTo(monday(7))
  sync = makeSync()
  ctx.repo.setGroupMembers(G_SAGA, [ANA, BIA, OLD, CAIO_LID, UNKNOWN_LID])
  ctx.repo.setGroupMembers(G_AVISOS, [ANA])
  ctx.repo.setGroupSubject(G_SAGA, 'Turma de exemplo')
  ctx.repo.setGroupSubject(G_AVISOS, 'Avisos de exemplo')
  await enable()
  await spin()
  calls = []
})

describe('hashes dos participantes', () => {
  it('só os do roster, as duas formas do 9º dígito, @lid pelo telefone conhecido; sem telefone e fora do roster ficam de fora', () => {
    const set = new Set(roster)
    const r = memberHashes([ANA, BIA, OLD, CAIO_LID, UNKNOWN_LID, ANA, 'lixo'], set, (l) => (l === CAIO_LID ? CAIO : null))
    expect(r.hashes).toEqual([...ANA_H, ...OLD_H, ...CAIO_H])
    expect(r.hashes.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true)
    expect(r.hashes).not.toContain(H(BIA_PHONE))
    expect(r.capped).toBe(false)
    // o @lid com dispositivo também resolve
    expect(memberHashes(['123456789012345:7@lid'], set, (l) => (l === CAIO_LID ? CAIO : null)).hashes).toEqual(CAIO_H)
  })

  it('no máximo 1500 por grupo: os primeiros vão e o corte fica marcado', () => {
    const phones = Array.from({ length: 1600 }, (_, i) => `5547${String(900000000 + i)}`)
    const set = new Set(phones.map(H))
    const r = memberHashes(phones.map((p) => `${p}@s.whatsapp.net`), set)
    expect(r.hashes).toHaveLength(MEMBERSHIP_LIMITS.membersMax)
    expect(r.hashes[0]).toBe(H(phones[0]))
    expect(r.capped).toBe(true)
  })

  it('checked_at: ISO com fuso, sem milissegundos, nunca no futuro', () => {
    const now = Date.UTC(2026, 10, 28, 12, 0, 0, 999)
    expect(checkedAt(now)).toBe('2026-11-28T12:00:00Z')
    expect(Date.parse(checkedAt(now))).toBeLessThanOrEqual(now)
  })
})

describe('conferência diária', () => {
  it('nada antes do horário; no começo do horário de envio + alguns minutos vai o pedido no formato do contrato; uma vez por dia', async () => {
    sync.membership.setGroup('comunidade_saga', G_SAGA)
    sync.membership.setGroup('grupo_avisos', G_AVISOS)
    goTo(monday(9, 2))
    await spin()
    expect(membershipCalls()).toHaveLength(0)
    goTo(monday(9, 3))
    await spin()
    const reqs = membershipCalls()
    expect(reqs).toHaveLength(1)
    const b = reqs[0]
    expect(Object.keys(b).sort()).toEqual(['action', 'checked_at', 'groups', 'version'])
    expect(b.version).toBe(1)
    expect(b.action).toBe('group_membership')
    expect(b.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(Date.parse(b.checked_at)).toBeLessThanOrEqual(ctx.clock.now())
    // só os escolhidos (os não escolhidos não vão), só chaves do contrato
    expect(Object.keys(b.groups).sort()).toEqual(['comunidade_saga', 'grupo_avisos'])
    expect(Object.keys(b.groups).every((k) => (MEMBERSHIP_KEYS as readonly string[]).includes(k))).toBe(true)
    expect(b.groups.comunidade_saga).toEqual({ members: [...CAIO_H, ...OLD_H, ...ANA_H] })
    expect(b.groups.grupo_avisos).toEqual({ members: ANA_H })
    // a tela mostra o que o Copiloto respondeu
    const v = sync.status().membership
    const saga = v.slots.find((s) => s.key === 'comunidade_saga')!
    expect(saga.name).toBe('Turma de exemplo')
    expect(saga.last).toMatchObject({ received: 5, matched: 5, marked: 1, capped: false })
    expect(membershipLine(saga.last!)).toBe('Última conferência 30/11 09:03 — recebidos 5, reconhecidos 5, marcados agora 1')
    // o mesmo dia: não vai de novo
    goTo(monday(15))
    await spin()
    expect(membershipCalls()).toHaveLength(1)
    // no dia seguinte, de novo
    goTo(monday(9, 3) + 24 * 60 * MIN)
    await spin()
    expect(membershipCalls()).toHaveLength(2)
  })

  it('grupo vazio de mentorados vai com a lista vazia; nenhum escolhido = nenhum pedido', async () => {
    goTo(monday(10))
    await spin()
    expect(membershipCalls()).toHaveLength(0)
    ctx.repo.setGroupMembers(G_SOS, [BIA])
    sync.membership.setGroup('grupo_sos_trafego', G_SOS)
    await spin()
    expect(membershipCalls().map((b) => b.groups)).toEqual([{ grupo_sos_trafego: { members: [] } }])
  })

  it('segue o horário de envio do mentor (início às 13:00) e não confere nos dias sem envio', async () => {
    for (const d of schedule.days) d.start = '13:00'
    sync.membership.setGroup('grupo_avisos', G_AVISOS)
    goTo(monday(12, 59))
    await spin()
    expect(membershipCalls()).toHaveLength(0)
    goTo(monday(13, 3))
    await spin()
    expect(membershipCalls()).toHaveLength(1)
    // sábado (sem envio no horário padrão): nada
    goTo(new Date(2026, 11, 5, 14, 0).getTime())
    await spin()
    expect(membershipCalls()).toHaveLength(1)
  })

  it('comunidade: vale quem está na comunidade e no grupo de avisos dela', async () => {
    saveGroupKinds(ctx.repo, [{ id: COM, isCommunity: true }, { id: COM_ANN, isCommunityAnnounce: true, linkedParent: COM }, { id: G_SAGA }], true, ctx.clock.now())
    ctx.repo.setGroupMembers(COM, [OLD])
    ctx.repo.setGroupMembers(COM_ANN, [ANA, BIA])
    ctx.repo.setGroupSubject(COM, 'Comunidade de exemplo')
    sync.membership.setGroup('comunidade_saga', COM)
    const opts = sync.membership.options()
    expect(opts.find((o) => o.jid === COM)).toEqual({ jid: COM, name: 'Comunidade de exemplo', kind: 'community' })
    expect(opts.find((o) => o.jid === COM_ANN)).toEqual({ jid: COM_ANN, name: 'Comunidade de exemplo › avisos', kind: 'announce' })
    // depois da consulta dos grupos, só os de que a conta participa (o G_AVISOS sumiu da lista)
    expect(opts.some((o) => o.jid === G_AVISOS)).toBe(false)
    goTo(monday(9, 30))
    await spin()
    expect(membershipCalls()[0].groups.comunidade_saga.members.sort()).toEqual([...ANA_H, ...OLD_H].sort())
    // entrou alguém no grupo de avisos da comunidade: a comunidade é conferida de novo
    expect(sync.membership.onJoin(COM_ANN)).toBe(true)
    expect(sync.membership.onJoin(G_SOS)).toBe(false)
  })

  it('grupo escolhido sem participantes conhecidos: pede a consulta dele (uma vez) e espera até 5 min; depois vai sem ele', async () => {
    sync.membership.setGroup('grupo_avisos', G_AVISOS)
    sync.membership.setGroup('grupo_sos_trafego', G_SOS)
    goTo(monday(9, 5))
    await spin()
    expect(meta).toEqual([G_SOS])
    expect(membershipCalls()).toHaveLength(0)
    goTo(monday(9, 10) + 1000)
    await spin()
    expect(meta).toEqual([G_SOS])
    expect(membershipCalls().map((b) => Object.keys(b.groups))).toEqual([['grupo_avisos']])
  })
})

describe('entrada num grupo escolhido', () => {
  it('espera 2 min sem entrada nova e manda só aquele grupo, com os participantes guardados (já com quem entrou)', async () => {
    sync.membership.setGroup('comunidade_saga', G_SAGA)
    sync.membership.setGroup('grupo_avisos', G_AVISOS)
    goTo(monday(9, 30))
    await spin()
    calls = []
    // o cliente já guardou quem entrou (group-participants.update) e avisou
    ctx.repo.changeGroupMembers(G_AVISOS, 'add', [OLD], 1)
    expect(sync.membership.onJoin(G_AVISOS)).toBe(true)
    ctx.clock.advance(MIN)
    await spin(3)
    ctx.repo.changeGroupMembers(G_AVISOS, 'add', [CAIO_LID], 1)
    sync.membership.onJoin(G_AVISOS)
    ctx.clock.advance(MIN + 30_000)
    await spin(3)
    expect(membershipCalls()).toHaveLength(0)
    ctx.clock.advance(30_000)
    await spin()
    const reqs = membershipCalls()
    expect(reqs).toHaveLength(1)
    expect(Object.keys(reqs[0].groups)).toEqual(['grupo_avisos'])
    // em ordem de JID: o @lid (numérico) e depois os telefones
    expect(reqs[0].groups.grupo_avisos.members).toEqual([...CAIO_H, ...OLD_H, ...ANA_H])
    // entrada em grupo que não foi escolhido: nada
    expect(sync.membership.onJoin(G_SOS)).toBe(false)
  })

  it('entradas seguidas: no máximo 10 min de espera desde a primeira', async () => {
    sync.membership.setGroup('grupo_avisos', G_AVISOS)
    goTo(monday(9, 30))
    await spin()
    calls = []
    for (let i = 0; i < 12; i++) {
      sync.membership.onJoin(G_AVISOS)
      ctx.clock.advance(MIN)
      await spin(1)
    }
    expect(membershipCalls()).toHaveLength(1)
  })
})

describe('respostas do Copiloto', () => {
  beforeEach(() => {
    sync.membership.setGroup('grupo_avisos', G_AVISOS)
  })

  it('500 e rede: tenta de novo com espera crescente; depois guarda o resultado', async () => {
    let n = 0
    reply = (b) => (++n === 1 ? new Response('{}', { status: 500 }) : n === 2 ? (() => { throw new Error('rede') })() : storedReply(b))
    goTo(monday(9, 5))
    await spin()
    expect(membershipCalls()).toHaveLength(1)
    expect(sync.status().membership.lastProblem).toMatch(/não respondeu/)
    ctx.clock.advance(MIN)
    await spin()
    expect(membershipCalls()).toHaveLength(2)
    ctx.clock.advance(MIN)
    await spin()
    expect(membershipCalls()).toHaveLength(2)
    ctx.clock.advance(MIN)
    await spin()
    expect(membershipCalls()).toHaveLength(3)
    expect(sync.status().membership.slots.find((s) => s.key === 'grupo_avisos')!.last).toMatchObject({ received: 2, marked: 1 })
    expect(sync.status().membership.lastProblem).toBeNull()
  })

  it('invalid: a mesma conferência não vai de novo (registro só com a contagem); mudou, vai', async () => {
    reply = () => new Response(JSON.stringify({ status: 'invalid' }), { status: 200 })
    goTo(monday(9, 5))
    await spin()
    expect(membershipCalls()).toHaveLength(1)
    expect(sync.status().membership.lastProblem).toMatch(/recusou/)
    expect(ctx.repo.recentEvents(50).some((e) => e.detail === 'conferência dos grupos recusada (200 invalid): grupos=1; a mesma não vai de novo')).toBe(true)
    // dia seguinte, os mesmos participantes: não vai
    goTo(monday(9, 30) + 24 * 60 * MIN)
    await spin()
    expect(membershipCalls()).toHaveLength(1)
    // mudou quem participa: vai
    ctx.repo.changeGroupMembers(G_AVISOS, 'add', [OLD], 1)
    goTo(monday(9, 30) + 48 * 60 * MIN)
    await spin()
    expect(membershipCalls()).toHaveLength(2)
  })

  it('401 para tudo, como as outras ações', async () => {
    reply = () => new Response('{}', { status: 401 })
    goTo(monday(9, 5))
    await spin()
    expect(membershipCalls()).toHaveLength(1)
    expect(ctx.repo.getSetting(COPILOTO_KEYS.authFailed)).toBe('1')
    expect(await sync.tick()).toBeNull()
    expect(sync.status().authFailed).toBe(true)
  })

  it('413 com vários grupos: um grupo por pedido', async () => {
    sync.membership.setGroup('comunidade_saga', G_SAGA)
    let n = 0
    reply = (b) => (++n === 1 ? new Response('{}', { status: 413 }) : storedReply(b))
    goTo(monday(9, 5))
    await spin()
    expect(membershipCalls().map((b) => Object.keys(b.groups))).toEqual([['comunidade_saga', 'grupo_avisos'], ['comunidade_saga'], ['grupo_avisos']])
  })

  it('a resposta é lida com cuidado: números inválidos e chaves fora do contrato são ignorados', () => {
    const r = parseMembershipResponse({ status: 'stored', groups: { grupo_avisos: { received: 3, matched: 2, marked: 1 }, outro: { received: 1, matched: 1, marked: 1 }, grupo_sos_trafego: { received: -1, matched: 0, marked: 0 } } })
    expect(r).toEqual({ status: 'stored', groups: { grupo_avisos: { received: 3, matched: 2, marked: 1, outsideRule: null } } })
    expect(parseMembershipResponse(null).status).toBe('sem_status')
    // v1.4: outside_rule (opcional) = reconhecidos num grupo que não é deles
    const o = parseMembershipResponse({ status: 'stored', groups: { grupo_avisos: { received: 30, matched: 28, marked: 3, outside_rule: 1 }, grupo_sos_trafego: { received: 2, matched: 2, marked: 0, outside_rule: -1 } } })
    expect(o.groups.grupo_avisos).toEqual({ received: 30, matched: 28, marked: 3, outsideRule: 1 })
    expect(o.groups.grupo_sos_trafego).toEqual({ received: 2, matched: 2, marked: 0, outsideRule: null })
  })
})

describe('"Conferir agora" e privacidade', () => {
  it('no máximo uma vez a cada 10 min; pede com a integração ligada e algum grupo escolhido', async () => {
    goTo(monday(8))
    expect(sync.checkMembershipNow()).toMatchObject({ ok: false, message: expect.stringMatching(/Escolha/) })
    sync.membership.setGroup('grupo_avisos', G_AVISOS)
    const r = sync.checkMembershipNow()
    expect(r.ok).toBe(true)
    await spin()
    expect(membershipCalls()).toHaveLength(1)
    expect(sync.checkMembershipNow()).toMatchObject({ ok: false, message: expect.stringMatching(/Aguarde \d+ min/) })
    expect(sync.status().membership.manualAvailableAt).toBe(monday(8) + 10 * MIN)
    ctx.clock.advance(10 * MIN)
    expect(sync.checkMembershipNow().ok).toBe(true)
    sync.save({ enabled: false })
    expect(sync.checkMembershipNow()).toMatchObject({ ok: false, message: expect.stringMatching(/Ligue/) })
  })

  it('nada de participantes, hashes, telefones, nomes ou JIDs no registro', async () => {
    sync.membership.setGroup('comunidade_saga', G_SAGA)
    sync.membership.setGroup('grupo_avisos', G_AVISOS)
    sync.membership.setGroup('grupo_sos_trafego', G_SOS)
    ctx.repo.setGroupMembers(G_SOS, [BIA, CAIO_LID])
    let n = 0
    reply = (b) => (++n === 1 ? new Response('{}', { status: 500 }) : n === 2 ? new Response(JSON.stringify({ status: 'invalid' }), { status: 200 }) : storedReply(b))
    goTo(monday(9, 5))
    await spin()
    goTo(monday(9, 20))
    await spin()
    sync.membership.onJoin(G_SAGA)
    ctx.repo.changeGroupMembers(G_SAGA, 'add', ['5547911112222@s.whatsapp.net'], 1)
    ctx.clock.advance(3 * MIN)
    await spin()
    expect(membershipCalls().length).toBeGreaterThanOrEqual(3)
    const logs = JSON.stringify([diag, ctx.repo.recentEvents(500)])
    const secrets = [...ANA_H, ...OLD_H, ...CAIO_H, ANA_PHONE, OLD_PHONE, CAIO_PHONE, BIA_PHONE, '120363050', 'Turma de exemplo', 'Avisos de exemplo', ...MEMBERSHIP_SLOTS.map((s) => s.label)]
    for (const s of secrets) expect(logs).not.toContain(s)
    expect(logs).toContain('conferência')
  })

  it('escolha guardada pelo JID; trocar o grupo apaga o resultado antigo; JID fora do formato é recusado', () => {
    expect(sync.membership.setGroup('grupo_avisos', G_AVISOS)).toBe(true)
    expect(JSON.parse(ctx.repo.getSetting(MEMBERSHIP_SETTINGS.groups)!)).toEqual({ grupo_avisos: G_AVISOS })
    ctx.repo.setSetting(MEMBERSHIP_SETTINGS.results, JSON.stringify({ grupo_avisos: { at: 1, received: 1, matched: 1, marked: 0 } }))
    expect(sync.status().membership.slots.find((s) => s.key === 'grupo_avisos')!.last).not.toBeNull()
    sync.membership.setGroup('grupo_avisos', G_SOS)
    expect(sync.status().membership.slots.find((s) => s.key === 'grupo_avisos')!.last).toBeNull()
    expect(sync.membership.setGroup('grupo_avisos', ANA)).toBe(false)
    expect(sync.membership.setGroup('grupo_avisos', null)).toBe(true)
    expect(sync.membership.chosen()).toEqual({})
  })
})

describe('membershipLine: fora da regra (v1.4)', () => {
  it('mostra "fora da regra N" só quando o Copiloto informou', async () => {
    const { membershipLine } = await import('../../../src/shared/membership')
    const at = new Date(2026, 10, 28, 9, 5).getTime()
    expect(membershipLine({ at, received: 30, matched: 28, marked: 3, outsideRule: 1, capped: false })).toMatch(/marcados agora 3, fora da regra 1$/)
    expect(membershipLine({ at, received: 30, matched: 28, marked: 3, outsideRule: null, capped: false })).toMatch(/marcados agora 3$/)
  })
})
