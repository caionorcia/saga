import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { FakeClock } from '../../../src/core/clock'
import { confirmNoReply, replyCsvDetail, setNeedsReply } from '../../../src/core/ai/needsReply'
import { feedbackCsv } from '../../../src/core/ai/alertFeedback'
import { participantJids } from '../../../src/core/wa/normalize'
import { GROUP_ANSWER_MAX_MEMBERS } from '../../../src/shared/triage'
import type { NormalizedMessage } from '../../../src/core/types'

const SCHEMA_DIR = join(import.meta.dirname, '../../../src/core/db')
const NOW = 1_764_000_000_000
const MIN = 60_000
const ANA = '5547999998888@s.whatsapp.net'
const ANA_LID = '111222333444555@lid'
const BIA = '5511988887777@s.whatsapp.net'
const G_ANA = '120363000000000001@g.us'
const G_TURMA = '120363000000000002@g.us'
const G_OUTRO = '120363000000000003@g.us'

let repo: Repo

let seq = 0
const add = (jid: string, o: Partial<NormalizedMessage> & { minutesAgo: number }) =>
  repo.insertMessage({
    id: `m${++seq}`,
    jid,
    fromMe: false,
    kind: 'text',
    text: 'texto',
    mediaKeyJson: null,
    durationSec: null,
    ...(jid.endsWith('@g.us') ? { isGroup: true } : {}),
    ...o,
    ts: NOW - o.minutesAgo * MIN
  })
const contact = (jid: string) => repo.listContacts({ includeHidden: true }).find((c) => c.jid === jid)!

beforeEach(() => {
  seq = 0
  repo = new Repo(openDb(':memory:'), new FakeClock(NOW))
  repo.upsertContact({ jid: ANA, pushName: 'Ana' })
  repo.upsertContact({ jid: BIA, pushName: 'Bia' })
  repo.upsertContact({ jid: G_ANA, pushName: 'Mentoria Ana', isGroup: true })
  repo.upsertContact({ jid: G_TURMA, pushName: 'Turma 3', isGroup: true })
  repo.upsertContact({ jid: G_OUTRO, pushName: 'Outro grupo', isGroup: true })
})

describe('"Respondido no grupo": a regra', () => {
  it('contato no grupo e o mentor escreveu lá DEPOIS da espera: sai de "Para responder", com o grupo e a hora', () => {
    repo.setGroupMembers(G_ANA, [ANA])
    add(ANA, { minutesAgo: 60, text: 'Mentor, pode ver meu plano?' })
    add(G_ANA, { minutesAgo: 30, fromMe: true, text: 'Ana, vi seu plano: está ótimo.' })
    const c = contact(ANA)
    expect(c.awaitingReply).toBe(true)
    expect(c.needsReply).toBe(false)
    expect(c.replyDecision).toEqual({
      needed: false,
      by: 'group',
      reason: 'Respondido no grupo Mentoria Ana',
      group: { jid: G_ANA, name: 'Mentoria Ana', ts: NOW - 30 * MIN }
    })
    expect(repo.triageCounts().awaiting).toBe(0)
    expect(repo.groupAnswer(ANA)).toEqual({ jid: G_ANA, name: 'Mentoria Ana', ts: NOW - 30 * MIN })
  })

  it('o mentor escreveu no grupo ANTES da mensagem do contato: continua em "Para responder"', () => {
    repo.setGroupMembers(G_ANA, [ANA])
    add(G_ANA, { minutesAgo: 90, fromMe: true })
    add(ANA, { minutesAgo: 60 })
    expect(contact(ANA).needsReply).toBe(true)
    expect(contact(ANA).replyDecision).toBeNull()
    expect(repo.triageCounts().awaiting).toBe(1)
  })

  it('vale a PRIMEIRA mensagem sem resposta (waitingSince): resposta no grupo entre duas mensagens do contato também conta', () => {
    repo.setGroupMembers(G_ANA, [ANA])
    add(ANA, { minutesAgo: 60 })
    add(G_ANA, { minutesAgo: 45, fromMe: true })
    add(ANA, { minutesAgo: 10, text: 'obrigada!' })
    expect(contact(ANA).replyDecision?.by).toBe('group')
  })

  it('contato que não participa do grupo: continua em "Para responder"', () => {
    repo.setGroupMembers(G_OUTRO, [BIA])
    add(ANA, { minutesAgo: 60 })
    add(G_OUTRO, { minutesAgo: 30, fromMe: true })
    expect(contact(ANA).needsReply).toBe(true)
    expect(repo.groupAnswer(ANA)).toBeNull()
  })

  it('participante também por ter mandado mensagem num grupo pequeno (a lista de participantes ainda sem ele)', () => {
    repo.setGroupMembers(G_TURMA, [BIA])
    add(G_TURMA, { minutesAgo: 200, senderJid: ANA, senderName: 'Ana' })
    add(ANA, { minutesAgo: 60 })
    add(G_TURMA, { minutesAgo: 20, fromMe: true })
    expect(contact(ANA).replyDecision).toMatchObject({ by: 'group', group: { jid: G_TURMA, name: 'Turma 3' } })
    // quem não participa do grupo (nem pela lista nem por ter mandado mensagem) não conta
    const CAR = '5521977776666@s.whatsapp.net'
    repo.upsertContact({ jid: CAR, pushName: 'Carla' })
    add(CAR, { minutesAgo: 50 })
    expect(contact(CAR).needsReply).toBe(true)
  })

  it('vários grupos: vale a resposta mais recente do mentor', () => {
    repo.setGroupMembers(G_ANA, [ANA])
    repo.setGroupMembers(G_TURMA, [ANA, BIA])
    add(ANA, { minutesAgo: 60 })
    add(G_ANA, { minutesAgo: 40, fromMe: true })
    add(G_TURMA, { minutesAgo: 15, fromMe: true })
    add(G_ANA, { minutesAgo: 10, senderJid: ANA })
    expect(contact(ANA).replyDecision?.group).toEqual({ jid: G_TURMA, name: 'Turma 3', ts: NOW - 15 * MIN })
  })

  it('conversa de grupo não usa a regra (só individuais)', () => {
    repo.setGroupMembers(G_ANA, [ANA])
    add(G_TURMA, { minutesAgo: 60, senderJid: BIA })
    add(G_ANA, { minutesAgo: 30, fromMe: true })
    expect(contact(G_TURMA).needsReply).toBe(true)
  })

  it('o mentor disse "Precisa sim": volta para a lista e grava a avaliação (o SagaZap tinha tirado pelo grupo)', () => {
    repo.setGroupMembers(G_ANA, [ANA])
    add(ANA, { minutesAgo: 60 })
    add(G_ANA, { minutesAgo: 30, fromMe: true })
    expect(setNeedsReply(repo, ANA, true)).toBe(true)
    const c = contact(ANA)
    expect(c.needsReply).toBe(true)
    expect(c.replyDecision).toEqual({ needed: true, by: 'user', reason: null })
    expect(repo.triageCounts().awaiting).toBe(1)
    const [f] = repo.listReplyFeedback()
    expect(f).toMatchObject({ verdict: 'reply_needed', appNeeds: false, appSource: 'group', appReason: 'Respondido no grupo Mentoria Ana' })
    expect(replyCsvDetail(f)).toBe('SagaZap (grupo): não precisa responder — Respondido no grupo Mentoria Ana')
  })

  it('👍 na decisão do grupo grava "reply_ok"', () => {
    repo.setGroupMembers(G_ANA, [ANA])
    add(ANA, { minutesAgo: 60 })
    add(G_ANA, { minutesAgo: 30, fromMe: true })
    confirmNoReply(repo, ANA)
    expect(repo.listReplyFeedback()[0]).toMatchObject({ verdict: 'reply_ok', appNeeds: false, appSource: 'group' })
    expect(contact(ANA).needsReply).toBe(false)
  })

  it('mensagem nova do contato depois da resposta no grupo: volta para a lista', () => {
    repo.setGroupMembers(G_ANA, [ANA])
    add(ANA, { minutesAgo: 60 })
    add(G_ANA, { minutesAgo: 30, fromMe: true })
    add(ANA, { minutesAgo: 5 })
    // waitingSince ainda é a de 60 min: a resposta no grupo veio depois dela
    expect(contact(ANA).needsReply).toBe(false)
    // o mentor responde no privado e o contato escreve de novo: espera nova, sem resposta no grupo depois dela
    add(ANA, { minutesAgo: 4, fromMe: true })
    add(ANA, { minutesAgo: 2 })
    expect(contact(ANA).needsReply).toBe(true)
  })
})

describe('grupos grandes: só com @ ou citação', () => {
  const big = (n: number) => Array.from({ length: n }, (_, i) => `55119000${String(i).padStart(5, '0')}@s.whatsapp.net`)

  it(`grupo pequeno (até ${GROUP_ANSWER_MAX_MEMBERS} participantes): qualquer mensagem do mentor conta`, () => {
    repo.setGroupMembers(G_TURMA, [ANA, ...big(GROUP_ANSWER_MAX_MEMBERS - 1)])
    add(ANA, { minutesAgo: 60 })
    add(G_TURMA, { minutesAgo: 30, fromMe: true, text: 'Bom dia, turma!' })
    expect(contact(ANA).replyDecision?.by).toBe('group')
  })

  it('grupo grande: mensagem comum do mentor não conta', () => {
    repo.setGroupMembers(G_TURMA, [ANA, ...big(GROUP_ANSWER_MAX_MEMBERS)])
    add(ANA, { minutesAgo: 60 })
    add(G_TURMA, { minutesAgo: 30, fromMe: true, text: 'Lembrete: aula quinta' })
    expect(contact(ANA).needsReply).toBe(true)
    expect(repo.triageCounts().awaiting).toBe(1)
  })

  it('grupo grande: mensagem do mentor que menciona (@) o contato conta', () => {
    repo.setGroupMembers(G_TURMA, [ANA, ...big(30)])
    add(ANA, { minutesAgo: 60 })
    add(G_TURMA, { minutesAgo: 30, fromMe: true, targets: [ANA] })
    expect(contact(ANA).replyDecision).toMatchObject({ by: 'group', group: { jid: G_TURMA } })
    expect(repo.triageCounts().awaiting).toBe(0)
    // a menção a outra pessoa não conta para a Ana
    add(BIA, { minutesAgo: 50 })
    expect(contact(BIA).needsReply).toBe(true)
  })

  it('grupo grande: mensagem do mentor que cita uma mensagem do contato conta (pelo @lid também)', () => {
    repo.setGroupMembers(G_TURMA, [ANA, ...big(30)])
    add(ANA, { minutesAgo: 60 })
    add(G_TURMA, { minutesAgo: 30, fromMe: true, targets: [ANA_LID, ANA] })
    expect(contact(ANA).replyDecision?.by).toBe('group')
  })

  it('tamanho desconhecido (sem os participantes do grupo): só com menção ou citação', () => {
    add(G_OUTRO, { minutesAgo: 200, senderJid: ANA })
    add(ANA, { minutesAgo: 60 })
    add(G_OUTRO, { minutesAgo: 30, fromMe: true })
    expect(contact(ANA).needsReply).toBe(true)
    add(G_OUTRO, { minutesAgo: 20, fromMe: true, targets: [ANA] })
    expect(contact(ANA).replyDecision?.group).toMatchObject({ jid: G_OUTRO, ts: NOW - 20 * MIN })
  })

  it('menções só são guardadas nas mensagens do mentor', () => {
    add(G_OUTRO, { minutesAgo: 200, senderJid: BIA, targets: [ANA] })
    add(ANA, { minutesAgo: 300 })
    expect(contact(ANA).needsReply).toBe(true)
  })

  it('setGroupMembers guarda o número de participantes (cada um pode ter duas formas)', () => {
    expect(repo.setGroupMembers(G_ANA, [ANA, ANA_LID], 1)).toBe(true)
    expect(repo.setGroupMembers(G_ANA, [ANA, ANA_LID], 1)).toBe(false)
    expect(repo.setGroupMembers(G_ANA, [ANA, ANA_LID], 15)).toBe(true)
    add(ANA, { minutesAgo: 60 })
    add(G_ANA, { minutesAgo: 30, fromMe: true })
    expect(contact(ANA).needsReply).toBe(true)
  })
})

describe('participantes: @lid × telefone', () => {
  it('participantJids: telefone e @lid sem dispositivo; o telefone de um @lid conhecido', () => {
    expect(participantJids({ id: ANA_LID, phoneNumber: '5547999998888:12@s.whatsapp.net' }).sort()).toEqual([ANA_LID, ANA].sort())
    expect(participantJids({ id: '111222333444555:3@lid' }, (l) => (l === ANA_LID ? ANA : null)).sort()).toEqual([ANA_LID, ANA].sort())
    expect(participantJids({ id: ANA })).toEqual([ANA])
    expect(participantJids({ id: 'status@broadcast' })).toEqual([])
    expect(participantJids(null)).toEqual([])
  })

  it('grupo com participantes em @lid casa com a conversa individual pelo telefone (e vice-versa)', () => {
    repo.setGroupMembers(G_ANA, participantJids({ id: ANA_LID, phoneNumber: ANA }))
    add(ANA, { minutesAgo: 60 })
    add(G_ANA, { minutesAgo: 30, fromMe: true })
    expect(contact(ANA).replyDecision?.by).toBe('group')

    // conversa individual que só tem o @lid (sem telefone conhecido)
    repo.upsertContact({ jid: ANA_LID, pushName: 'Ana (lid)' })
    add(ANA_LID, { minutesAgo: 50 })
    expect(contact(ANA_LID).replyDecision?.by).toBe('group')
  })

  it('setGroupMembers troca a lista; `false` quando nada mudou', () => {
    expect(repo.setGroupMembers(G_ANA, [ANA, ANA_LID])).toBe(true)
    expect(repo.setGroupMembers(G_ANA, [ANA_LID, ANA])).toBe(false)
    expect(repo.setGroupMembers(G_ANA, [BIA])).toBe(true)
    expect(repo.groupMembers(G_ANA)).toEqual([BIA])
  })
})

describe('CSV: motivos novos', () => {
  it('"Respondi no grupo dele" e "Respondi por ligação/pessoalmente" no CSV', () => {
    add(ANA, { minutesAgo: 60 })
    setNeedsReply(repo, ANA, false, { code: 'respondi_grupo' })
    add(BIA, { minutesAgo: 50 })
    setNeedsReply(repo, BIA, false, { code: 'ligacao' })
    const csv = feedbackCsv([], () => 'X', false, repo.listReplyFeedback())
    expect(csv).toContain('"Respondi no grupo dele"')
    expect(csv).toContain('"Respondi por ligação/pessoalmente"')
  })
})

describe('migração v9', () => {
  it('"outro_meio" (v0.2.2) vira "respondi_grupo"; cria group_members', async () => {
    const files = ['schema.sql', ...[2, 3, 4, 5, 6, 7, 8].map((v) => `schema-v${v}.sql`)]
    const db = new DatabaseSync(':memory:')
    for (const f of files) db.exec(readFileSync(join(SCHEMA_DIR, f), 'utf8'))
    db.prepare(
      `INSERT INTO reply_feedback(jid, msg_id, verdict, reason_code, context_text, created_at) VALUES ('a', 'm', 'reply_not_needed', 'outro_meio', '', 1)`
    ).run()
    db.exec(readFileSync(join(SCHEMA_DIR, 'schema-v9.sql'), 'utf8'))
    expect((db.prepare('SELECT reason_code FROM reply_feedback').get() as { reason_code: string }).reason_code).toBe('respondi_grupo')
    db.prepare(`INSERT INTO group_members(group_jid, member_jid) VALUES ('g@g.us', 'a@s.whatsapp.net')`).run()
  })
})
