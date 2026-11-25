import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../../src/core/db/db'
import { Repo, type MessageRow } from '../../../src/core/db/repo'
import { FakeClock } from '../../../src/core/clock'
import { CostTracker } from '../../../src/core/ai/budget'
import type { LlmProvider } from '../../../src/core/ai/llm'
import { buildAlertPrompt, classifyChat, parseNeedsReply, type ClassifyDeps } from '../../../src/core/ai/classify'
import { CSV_REPLY_KIND, alertQuality, feedbackCsv, rateAlert, FeedbackError } from '../../../src/core/ai/alertFeedback'
import {
  RULE_REASON,
  ReplyFeedbackError,
  applyReplyRule,
  confirmNoReply,
  isAckOnly,
  renderReplyExamples,
  replyQuality,
  selectReplyExamples,
  setNeedsReply
} from '../../../src/core/ai/needsReply'
import type { NormalizedMessage } from '../../../src/core/types'

const NOW = 1_764_000_000_000
const DAY = 86_400_000
const A = '5547999998888@s.whatsapp.net'
const B = '5511988887777@s.whatsapp.net'
const G = '120363025555555555@g.us'

let clock: FakeClock
let repo: Repo

const add = (o: Partial<NormalizedMessage> & { id: string; minutesAgo: number }) =>
  repo.insertMessage({
    jid: A, fromMe: false, kind: 'text', text: `texto ${o.id}`, mediaKeyJson: null, durationSec: null,
    ...o, ts: NOW - o.minutesAgo * 60_000
  })

const contact = (jid = A) => repo.listContacts({ includeHidden: true }).find((c) => c.jid === jid)!

function msg(text: string | null, over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'x', jid: A, fromMe: false, ts: 1, kind: 'text', text, mediaKeyJson: null, durationSec: null,
    audioPath: null, transcript: null, transcriptStatus: null,
    senderJid: null, senderName: null, senderLabel: null, mentionsMe: false, ...over
  }
}

beforeEach(() => {
  clock = new FakeClock(NOW)
  repo = new Repo(openDb(':memory:'), clock)
  repo.upsertContact({ jid: A, pushName: 'Ana' })
  repo.upsertContact({ jid: B, pushName: 'Bia' })
})

describe('isAckOnly: agradecimento, ok, emoji ou figurinha (até 4 palavras, sem acento/maiúsculas)', () => {
  it.each([
    'ok', 'Ok!', 'OBRIGADO', 'Obrigada 🙏', 'muito obrigado pela ajuda', 'valeu', 'Vlw mentor', 'show', 'Top!!', 'beleza',
    'blz', '👍', '🙏🏻', '👏👏👏', '❤️', 'kkkk', 'KKKKK', 'hahaha', 'rsrs', 'Combinado!', 'Perfeito, obrigada', 'tchau', 'até mais',
    'Agradeço!', 'certo', 'Entendi, obrigado', 'Ótimo', 'Show de bola'.slice(0, 4)
  ])('"%s" → sim', (t) => expect(isAckOnly(msg(t))).toBe(true))

  it.each([
    'ok?', 'Obrigado! Mas e a planilha?', 'muito obrigado pela ajuda de ontem', 'Bom dia, mentor!', 'sim', 'pode me ligar',
    '😢', '😭😭', '❓', 'oi', 'preciso de ajuda', 'obrigado, vou desistir', ''
  ])('"%s" → não', (t) => expect(isAckOnly(msg(t))).toBe(false))

  it('figurinha sim; imagem, áudio e mensagem minha não', () => {
    expect(isAckOnly(msg('[figurinha]', { kind: 'other' }))).toBe(true)
    expect(isAckOnly(msg('[imagem]', { kind: 'other' }))).toBe(false)
    expect(isAckOnly(msg(null, { kind: 'audio' }))).toBe(false)
    expect(isAckOnly(msg('ok', { fromMe: true }))).toBe(false)
  })
})

describe('regra sem IA e "Para responder" na lista', () => {
  it('só "obrigado" depois da resposta do mentor: sai da lista e da contagem, com o motivo da regra', () => {
    add({ id: 'a1', minutesAgo: 30, text: 'Como faço a planilha?' })
    add({ id: 'a2', minutesAgo: 20, fromMe: true, text: 'Assim e assim' })
    add({ id: 'a3', minutesAgo: 10, text: 'Valeu! 🙏' })
    expect(contact()).toMatchObject({ awaitingReply: true, needsReply: true, replyDecision: null })
    expect(repo.triageCounts().awaiting).toBe(1)
    expect(applyReplyRule(repo, A)).toBe(true)
    expect(contact()).toMatchObject({ awaitingReply: true, needsReply: false, replyDecision: { needed: false, by: 'rule', reason: RULE_REASON } })
    expect(repo.triageCounts().awaiting).toBe(0)
    expect(applyReplyRule(repo, A)).toBe(false) // nada mudou
  })

  it('pergunta antes do "obrigado" (sem resposta do mentor no meio): continua precisando', () => {
    add({ id: 'a1', minutesAgo: 30, text: 'Pode revisar meu texto?' })
    add({ id: 'a2', minutesAgo: 10, text: 'obrigado' })
    expect(applyReplyRule(repo, A)).toBe(false)
    expect(contact().needsReply).toBe(true)
  })

  it('mensagem nova do contato recomeça: volta para a lista até ser classificada de novo', () => {
    add({ id: 'a1', minutesAgo: 30, fromMe: true, text: 'Feito!' })
    add({ id: 'a2', minutesAgo: 20, text: 'ok' })
    applyReplyRule(repo, A)
    expect(contact().needsReply).toBe(false)
    add({ id: 'a3', minutesAgo: 5, text: 'Ah, e quando é a próxima aula?' })
    expect(contact()).toMatchObject({ needsReply: true, replyDecision: null })
    expect(applyReplyRule(repo, A)).toBe(false)
  })

  it('o mentor falou por último: nada a decidir', () => {
    add({ id: 'a1', minutesAgo: 30, text: 'ok' })
    add({ id: 'a2', minutesAgo: 20, fromMe: true, text: 'Abraço' })
    expect(applyReplyRule(repo, A)).toBe(false)
    expect(contact()).toMatchObject({ awaitingReply: false, needsReply: false, replyDecision: null })
  })

  it('não sobrescreve uma decisão da IA ou do mentor sobre a mesma mensagem', () => {
    add({ id: 'a1', minutesAgo: 20, text: 'ok' })
    repo.setAppReply({ jid: A, msgId: 'a1', needs: true, reason: 'Confirma a reunião e espera o link', source: 'ai' })
    expect(applyReplyRule(repo, A)).toBe(false)
    expect(contact().replyDecision).toMatchObject({ needed: true, by: 'ai' })
  })
})

describe('setNeedsReply / confirmNoReply / 👍 no "esperando"', () => {
  beforeEach(() => {
    add({ id: 'a1', minutesAgo: 3 * 24 * 60, text: 'Mentor, segue o relatório.' })
  })

  it('"Não precisa responder": tira da lista, resolve o "esperando" e grava o exemplo com o trecho e o motivo', () => {
    repo.upsertAlert({ jid: A, kind: 'esperando', detail: 'Sem resposta há mais de 2 dias.', msgId: 'a1' })
    const alertId = repo.listAlerts(A)[0].id
    expect(setNeedsReply(repo, A, false, { code: 'outro_meio', text: ' Liguei  pra ela ' })).toBe(true)
    expect(contact()).toMatchObject({ needsReply: false, replyDecision: { needed: false, by: 'user', reason: null } })
    expect(repo.listAlerts(A)).toEqual([])
    const [f] = repo.listReplyFeedback()
    expect(f).toMatchObject({
      jid: A, msgId: 'a1', alertId, verdict: 'reply_not_needed', appNeeds: null, reasonCode: 'outro_meio', reasonText: 'Liguei pra ela',
      contextText: 'Mentorado: Mentor, segue o relatório.'
    })
    // e o 👍 do "esperando" que já foi avaliado aparece como 👎
    expect(repo.getAlert(alertId)!.rating).toBe('down')
  })

  it('sem motivo: recusa; conversa em que o mentor falou por último: recusa', () => {
    expect(() => setNeedsReply(repo, A, false)).toThrow(ReplyFeedbackError)
    add({ id: 'a2', minutesAgo: 1, fromMe: true, text: 'Recebido' })
    expect(() => setNeedsReply(repo, A, false, { code: 'outro' })).toThrow(ReplyFeedbackError)
  })

  it('"Precisa sim" depois da IA dizer que não: volta para a lista e grava a correção (o Saga errou)', () => {
    repo.setAppReply({ jid: A, msgId: 'a1', needs: false, reason: 'Só mandou um arquivo', source: 'ai', model: 'm1' })
    expect(contact().needsReply).toBe(false)
    setNeedsReply(repo, A, true)
    expect(contact()).toMatchObject({ needsReply: true, replyDecision: { needed: true, by: 'user' } })
    expect(repo.listReplyFeedback()[0]).toMatchObject({ verdict: 'reply_needed', appNeeds: false, appReason: 'Só mandou um arquivo', appSource: 'ai', model: 'm1' })
    // a IA não desfaz a decisão do mentor para a mesma mensagem
    repo.setAppReply({ jid: A, msgId: 'a1', needs: false, reason: 'outra', source: 'ai' })
    expect(contact().needsReply).toBe(true)
  })

  it('👍 no "não precisa" do Saga grava reply_ok; sem decisão do Saga, recusa', () => {
    expect(() => confirmNoReply(repo, A)).toThrow(ReplyFeedbackError)
    repo.setAppReply({ jid: A, msgId: 'a1', needs: false, reason: 'Só informou', source: 'ai' })
    confirmNoReply(repo, A)
    expect(repo.listReplyFeedback()[0]).toMatchObject({ verdict: 'reply_ok', appNeeds: false })
    expect(contact().needsReply).toBe(false)
  })

  it('mudar de ideia na mesma mensagem atualiza a mesma avaliação', () => {
    setNeedsReply(repo, A, false, { code: 'encerrada' })
    setNeedsReply(repo, A, true)
    expect(repo.listReplyFeedback()).toEqual([expect.objectContaining({ verdict: 'reply_needed', reasonCode: null })])
    expect(contact().needsReply).toBe(true)
  })

  it('👍 no "esperando" = precisa mesmo (reply_needed com o alerta); 👎 direto no rateAlert é recusado', () => {
    repo.upsertAlert({ jid: A, kind: 'esperando', detail: 'Sem resposta há mais de 2 dias.', msgId: 'a1' })
    const id = repo.listAlerts(A)[0].id
    rateAlert(repo, id, 'up')
    expect(repo.listReplyFeedback()[0]).toMatchObject({ verdict: 'reply_needed', alertId: id, appNeeds: null })
    expect(repo.listFeedback()).toEqual([]) // não vira avaliação de alerta da IA
    expect(repo.listAlerts(A)[0].rating).toBe('up')
    expect(() => rateAlert(repo, id, 'down', { code: 'outro' })).toThrow(FeedbackError)
  })

  it('alerta marcado pelo mentor aceita 👍/👎, mas não entra no % de acerto da IA', () => {
    repo.upsertAlert({ jid: A, kind: 'urgente', detail: 'Marcado por você', msgId: 'a1', source: 'user' })
    rateAlert(repo, repo.listAlerts(A)[0].id, 'down', { code: 'exagerado' })
    expect(repo.listFeedback()).toHaveLength(1)
    expect(alertQuality(repo, NOW).kinds.find((k) => k.kind === 'urgente')).toMatchObject({ up: 0, down: 0 })
  })
})

describe('aprendizado, qualidade e CSV', () => {
  const seed = () => {
    add({ id: 'a1', minutesAgo: 60, text: 'Obrigada pelo material!' })
    setNeedsReply(repo, A, false, { code: 'agradecimento' })
    repo.insertMessage({ id: 'b1', jid: B, fromMe: false, ts: NOW - 50 * 60_000, kind: 'text', text: 'Segue o comprovante', mediaKeyJson: null, durationSec: null })
    repo.setAppReply({ jid: B, msgId: 'b1', needs: false, reason: 'Só informou', source: 'ai' })
    clock.advance(1000)
    setNeedsReply(repo, B, true)
  }

  it('exemplos: primeiro os da mesma conversa; "já respondi por outro meio" não ensina', () => {
    seed()
    expect(selectReplyExamples(repo, A).map((f) => f.jid)).toEqual([A, B])
    expect(selectReplyExamples(repo, B).map((f) => f.jid)).toEqual([B, A])
    const text = renderReplyExamples(selectReplyExamples(repo, A))
    expect(text).toContain('Exemplo: mensagens "Mentorado: Obrigada pelo material!" → o mentor NÃO precisava responder: era só agradecimento / ok / emoji.')
    expect(text).toContain('"Mentorado: Segue o comprovante" → o mentor PRECISAVA responder.')
    add({ id: 'a2', minutesAgo: 1, text: 'Pode ver o arquivo?' })
    setNeedsReply(repo, A, false, { code: 'outro_meio' })
    expect(selectReplyExamples(repo, A)).toHaveLength(2)
    expect(renderReplyExamples([])).toBe('')
  })

  it('qualidade: removidos, devolvidos, confirmados e % de acerto (últimos 30 dias)', () => {
    seed()
    // A: o Saga deixou na lista e o mentor tirou (errou); B: a IA tirou e o mentor devolveu (errou)
    expect(replyQuality(repo, NOW)).toEqual({ removed: 1, restored: 1, confirmed: 0, correctRate: 0 })
    repo.insertMessage({ id: 'b2', jid: B, fromMe: true, ts: NOW - 20 * 60_000, kind: 'text', text: 'Recebido!', mediaKeyJson: null, durationSec: null })
    repo.insertMessage({ id: 'b3', jid: B, fromMe: false, ts: NOW - 10 * 60_000, kind: 'text', text: 'valeu', mediaKeyJson: null, durationSec: null })
    applyReplyRule(repo, B)
    confirmNoReply(repo, B)
    expect(replyQuality(repo, NOW + 2000)).toEqual({ removed: 1, restored: 1, confirmed: 1, correctRate: 1 / 3 })
    expect(alertQuality(repo, NOW + 2000).reply.removed).toBe(1)
    expect(replyQuality(repo, NOW + 40 * DAY)).toEqual({ removed: 0, restored: 0, confirmed: 0, correctRate: null })
  })

  it('CSV: as linhas do "Para responder" com tipo para_responder, motivo e o que o Saga achava', () => {
    seed()
    const csv = feedbackCsv(repo.listFeedback(), () => 'X', true, repo.listReplyFeedback())
    const lines = csv.split('\r\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain(`"${CSV_REPLY_KIND}";"Não precisa responder";"Era só agradecimento / ok / emoji"`)
    expect(lines[1]).toContain('"Contato 1";"Mentorado: Obrigada pelo material!";"Saga: deixou em ""Para responder"""')
    expect(lines[2]).toContain('"para_responder";"Precisa responder";""')
    expect(lines[2]).toContain('"Saga (IA): não precisa responder — Só informou"')
  })
})

describe('classify: needsReply da IA', () => {
  let calls: Array<{ system: string; user: string }>
  let reply: string
  let diag: string[]
  let deps: ClassifyDeps

  beforeEach(() => {
    calls = []
    diag = []
    reply = JSON.stringify({ alerts: [], needsReply: false, reason: 'Só enviou o comprovante, sem pedir nada' })
    const llm: LlmProvider = {
      name: 'groq',
      async complete(p) {
        calls.push(p)
        return { text: reply, inputTokens: 10, outputTokens: 5, model: 'llama-x' }
      }
    }
    deps = {
      repo, clock, getLlm: () => llm, cost: new CostTracker(repo, clock), getCapUsd: () => 1,
      diag: (k, d) => diag.push(`${k} ${d}`), onChanged: () => {}
    }
  })

  it('o prompt pede needsReply/reason (na dúvida, true) e leva as correções do mentor', () => {
    const p = buildAlertPrompt({ contactName: 'Ana', isGroup: false, prior: [], newMessages: [msg('oi')], replyExamples: 'Correções anteriores: X' })
    expect(p.system).toContain('"needsReply": boolean')
    expect(p.system).toContain('Na dúvida, true')
    expect(p.system).toMatch(/grupo\) conversa entre participantes/)
    expect(p.user).toContain('Correções anteriores: X')
  })

  it('parseNeedsReply: booleano (ou "true"/"false"), motivo cortado em 100; sem o campo → null', () => {
    expect(parseNeedsReply('{"alerts":[],"needsReply":true,"reason":" Pergunta  da aula "}')).toEqual({ needsReply: true, reason: 'Pergunta da aula' })
    expect(parseNeedsReply('{"needsReply":"false"}')).toEqual({ needsReply: false, reason: null })
    expect(parseNeedsReply(`{"needsReply":false,"reason":"${'x'.repeat(200)}"}`)!.reason).toHaveLength(100)
    expect(parseNeedsReply('{"alerts":[]}')).toBeNull()
    expect(parseNeedsReply('{"needsReply":"talvez"}')).toBeNull()
    expect(parseNeedsReply('lixo')).toBeNull()
  })

  it('grava a decisão para a última mensagem do contato; o registro diz reply=no, sem texto', async () => {
    add({ id: 'a1', minutesAgo: 10, text: 'Segue o comprovante do pagamento' })
    await classifyChat(deps, A)
    expect(contact()).toMatchObject({ needsReply: false, replyDecision: { needed: false, by: 'ai', reason: 'Só enviou o comprovante, sem pedir nada' } })
    expect(repo.getReplyCheck(A)).toMatchObject({ msgId: 'a1', model: 'llama-x' })
    expect(diag[0]).toMatch(/^classify result=ok alerts=0 reply=no ms=\d+$/)
  })

  it('só agradecimento/ok/emoji: decide pela regra sem chamar a IA', async () => {
    add({ id: 'a1', minutesAgo: 20, fromMe: true, text: 'Te mandei o link' })
    add({ id: 'a2', minutesAgo: 10, text: 'Obrigado!! 👍' })
    await classifyChat(deps, A)
    expect(calls).toHaveLength(0)
    expect(contact().replyDecision).toMatchObject({ needed: false, by: 'rule' })
    expect(diag[0]).toMatch(/^classify result=skip reason=ack_only alerts=0 reply=no ms=\d+$/)
    expect(repo.getAlertCheck(A)!.lastMsgId).toBe('a2')
  })

  it('leva as correções do "Para responder" no prompt (primeiro da mesma conversa)', async () => {
    add({ id: 'a1', minutesAgo: 60, text: 'Obrigada pelo material, ajudou demais na apresentação de ontem' })
    setNeedsReply(repo, A, false, { code: 'agradecimento' })
    add({ id: 'a2', minutesAgo: 5, text: 'Qual o horário da mentoria?' })
    reply = JSON.stringify({ alerts: [], needsReply: true, reason: 'Pergunta o horário' })
    await classifyChat(deps, A)
    expect(calls[0].user).toContain('Correções anteriores do mentor sobre precisar ou não de resposta')
    expect(calls[0].user).toContain('o mentor NÃO precisava responder')
    expect(contact().needsReply).toBe(true)
  })

  it('a resposta sem needsReply não decide nada (fica na lista)', async () => {
    reply = JSON.stringify({ alerts: [] })
    add({ id: 'a1', minutesAgo: 10, text: 'Segue o comprovante' })
    await classifyChat(deps, A)
    expect(contact()).toMatchObject({ needsReply: true, replyDecision: null })
  })

  it('grupo: conversa entre participantes que a IA marcou como não sendo com o mentor', async () => {
    repo.upsertContact({ jid: G, pushName: 'Turma', isGroup: true })
    repo.insertMessage({ id: 'g1', jid: G, fromMe: false, ts: NOW - 60_000, kind: 'text', text: 'Alguém tem o modelo?', mediaKeyJson: null, durationSec: null, isGroup: true, senderJid: 'x@s.whatsapp.net', senderName: 'Bruno' })
    reply = JSON.stringify({ alerts: [], needsReply: false, reason: 'Pergunta para o grupo, não para você' })
    await classifyChat(deps, G)
    expect(contact(G)).toMatchObject({ needsReply: false, replyDecision: { by: 'ai' } })
  })
})
