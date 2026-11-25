import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../../src/core/db/db'
import { Repo, type FeedbackRow } from '../../../src/core/db/repo'
import { FakeClock } from '../../../src/core/clock'
import { CostTracker } from '../../../src/core/ai/budget'
import type { LlmProvider } from '../../../src/core/ai/llm'
import { classifyChat, type ClassifyDeps } from '../../../src/core/ai/classify'
import {
  EXAMPLE_CONTEXT_MAX,
  FeedbackError,
  USER_ALERT_DETAIL,
  alertQuality,
  contextFor,
  csvCell,
  feedbackCsv,
  rateAlert,
  renderAlertExamples,
  reportMissedAlert,
  selectAlertExamples
} from '../../../src/core/ai/alertFeedback'
import type { NormalizedMessage } from '../../../src/core/types'

const NOW = 1_764_000_000_000
const DAY = 86_400_000
const A = '5547999998888@s.whatsapp.net'
const B = '5511988887777@s.whatsapp.net'
const C = '5521977776666@s.whatsapp.net'

let clock: FakeClock
let repo: Repo

const add = (o: Partial<NormalizedMessage> & { id: string; minutesAgo: number }) =>
  repo.insertMessage({
    jid: A, fromMe: false, kind: 'text', text: `texto ${o.id}`, mediaKeyJson: null, durationSec: null,
    ...o, ts: NOW - o.minutesAgo * 60_000
  })

const activeId = (jid: string, kind: string) => repo.listAlerts(jid).find((a) => a.kind === kind)!.id

beforeEach(() => {
  clock = new FakeClock(NOW)
  repo = new Repo(openDb(':memory:'), clock)
  for (const [jid, name] of [[A, 'Ana'], [B, 'Bruno'], [C, 'Carla']]) repo.upsertContact({ jid, pushName: name })
})

describe('migração v7', () => {
  it('alertas ganham id, origem e avaliação; "esperando" é de regra', () => {
    repo.upsertAlert({ jid: A, kind: 'urgente', detail: 'x', msgId: null })
    repo.upsertAlert({ jid: A, kind: 'esperando', detail: 'y', msgId: null })
    const list = repo.listAlerts(A)
    expect(list.map((a) => [a.kind, a.source, a.rating])).toEqual([
      ['urgente', 'ai', null],
      ['esperando', 'rule', null]
    ])
    expect(typeof list[0].id).toBe('number')
  })
})

describe('rateAlert', () => {
  beforeEach(() => {
    add({ id: 'a1', minutesAgo: 20, fromMe: true, text: 'Como vai?' })
    add({ id: 'a2', minutesAgo: 10, text: 'Preciso disso até amanhã kkk' })
    repo.upsertAlert({ jid: A, kind: 'urgente', detail: 'Prazo amanhã', msgId: 'a2', contextText: 'Mensagens novas:\n#1 Mentorado: Preciso disso até amanhã kkk', model: 'llama-x' })
  })

  it('👍 grava o exemplo completo e o alerta continua (com a avaliação)', () => {
    const id = activeId(A, 'urgente')
    expect(rateAlert(repo, id, 'up')).toBe(false)
    expect(repo.listAlerts(A)).toEqual([expect.objectContaining({ id, rating: 'up' })])
    expect(repo.listFeedback()).toEqual([
      expect.objectContaining({
        alertId: id, jid: A, kind: 'urgente', msgId: 'a2', verdict: 'up', reasonCode: null,
        contextText: 'Mensagens novas:\n#1 Mentorado: Preciso disso até amanhã kkk', detail: 'Prazo amanhã', model: 'llama-x', createdAt: NOW
      })
    ])
  })

  it('👎 com motivo resolve o alerta; mudar de ideia atualiza a mesma avaliação', () => {
    const id = activeId(A, 'urgente')
    rateAlert(repo, id, 'up')
    clock.advance(1000)
    expect(rateAlert(repo, id, 'down', { code: 'brincadeira', text: '  era   piada  ' })).toBe(true)
    expect(repo.listAlerts(A)).toEqual([])
    const fb = repo.listFeedback()
    expect(fb).toHaveLength(1)
    expect(fb[0]).toMatchObject({ verdict: 'down', reasonCode: 'brincadeira', reasonText: 'era piada', correctKind: null, createdAt: NOW + 1000 })
  })

  it('👎 "não é esse tipo" com o tipo certo cria esse alerta, marcado como do mentor', () => {
    const id = activeId(A, 'urgente')
    rateAlert(repo, id, 'down', { code: 'tipo_errado', correctKind: 'travado' })
    expect(repo.listAlerts(A)).toEqual([expect.objectContaining({ kind: 'travado', source: 'user', msgId: 'a2', detail: USER_ALERT_DETAIL })])
    expect(repo.listFeedback()[0]).toMatchObject({ reasonCode: 'tipo_errado', correctKind: 'travado' })
    // a IA não reescreve um alerta marcado pelo mentor
    expect(repo.upsertAlert({ jid: A, kind: 'travado', detail: 'outro', msgId: 'a2' })).toBe(false)
  })

  it('"Nenhum" como tipo certo: só resolve; tipo certo fora de "tipo_errado" é ignorado', () => {
    rateAlert(repo, activeId(A, 'urgente'), 'down', { code: 'tipo_errado', correctKind: null })
    expect(repo.listAlerts(A)).toEqual([])
    repo.upsertAlert({ jid: A, kind: 'desanimo', detail: 'triste', msgId: 'a2' })
    rateAlert(repo, activeId(A, 'desanimo'), 'down', { code: 'exagerado', correctKind: 'urgente' })
    expect(repo.listAlerts(A)).toEqual([])
    expect(repo.listFeedback()[0]).toMatchObject({ reasonCode: 'exagerado', correctKind: null })
  })

  it('alerta antigo sem janela guardada: monta o contexto na hora, até a mensagem do alerta', () => {
    repo.upsertAlert({ jid: A, kind: 'reuniao', detail: 'Pede ligação', msgId: 'a1' })
    add({ id: 'a3', minutesAgo: 5, text: 'depois' })
    rateAlert(repo, activeId(A, 'reuniao'), 'up')
    expect(repo.listFeedback()[0].contextText).toBe('Mentor: Como vai?')
  })

  it('alerta inexistente ou 👎 sem motivo: erro', () => {
    expect(() => rateAlert(repo, 999, 'up')).toThrow(FeedbackError)
    expect(() => rateAlert(repo, activeId(A, 'urgente'), 'down')).toThrow(FeedbackError)
  })
})

describe('reportMissedAlert', () => {
  it('grava "missed" com as mensagens recentes e cria o alerta do mentor', () => {
    add({ id: 'a1', minutesAgo: 30, text: 'Não consigo abrir a planilha' })
    add({ id: 'a2', minutesAgo: 20, text: 'Tentei de tudo' })
    expect(reportMissedAlert(repo, A, 'travado', 'a1', 'Está travada há dias')).toBe(true)
    expect(repo.listAlerts(A)).toEqual([expect.objectContaining({ kind: 'travado', source: 'user', msgId: 'a1', detail: 'Está travada há dias' })])
    expect(repo.listFeedback()[0]).toMatchObject({ alertId: null, verdict: 'missed', kind: 'travado', msgId: 'a1', reasonText: 'Está travada há dias', contextText: 'Mentorado: Não consigo abrir a planilha' })
    reportMissedAlert(repo, A, 'urgente', null, null)
    expect(repo.listFeedback()[0].contextText).toBe('Mentorado: Não consigo abrir a planilha\nMentorado: Tentei de tudo')
  })

  it('tipo "esperando" ou mensagem de outra conversa: erro', () => {
    add({ id: 'b1', jid: B, minutesAgo: 5 })
    expect(() => reportMissedAlert(repo, A, 'esperando', null, null)).toThrow(FeedbackError)
    expect(() => reportMissedAlert(repo, A, 'urgente', 'b1', null)).toThrow(FeedbackError)
  })

  it('contextFor: no máximo 8 mensagens', () => {
    for (let i = 0; i < 12; i++) add({ id: `m${i}`, minutesAgo: 60 - i })
    expect(contextFor(repo, A, null).split('\n')).toHaveLength(8)
  })
})

describe('exemplos para o prompt', () => {
  const fb = (jid: string, kind: FeedbackRow['kind'], verdict: FeedbackRow['verdict'], over: Partial<FeedbackRow> = {}) => {
    clock.advance(1000)
    return repo.saveFeedback({
      alertId: null, jid, kind, msgId: null, verdict, reasonCode: verdict === 'down' ? 'brincadeira' : null, reasonText: null,
      correctKind: null, contextText: `ctx ${jid.slice(2, 4)} ${kind} ${verdict}`, detail: '', model: null, ...over
    })
  }

  it('mesma conversa primeiro, depois as outras alternando os tipos; no máximo 6, com até 2 👍', () => {
    fb(B, 'urgente', 'down')
    fb(B, 'urgente', 'down')
    fb(C, 'reuniao', 'missed')
    fb(B, 'desanimo', 'down')
    fb(B, 'travado', 'up')
    fb(C, 'urgente', 'up')
    fb(C, 'desanimo', 'up')
    fb(A, 'travado', 'down')
    fb(A, 'urgente', 'missed')
    const ex = selectAlertExamples(repo, A)
    expect(ex).toHaveLength(6)
    expect(ex.filter((f) => f.verdict === 'up')).toHaveLength(2)
    // as duas da mesma conversa vêm primeiro (mais novas primeiro)
    expect(ex.slice(0, 2).map((f) => [f.jid, f.kind])).toEqual([[A, 'urgente'], [A, 'travado']])
    // depois um de cada tipo das outras conversas, antes de repetir um tipo
    expect(ex.slice(2, 4).map((f) => f.kind).sort()).toEqual(['desanimo', 'reuniao'])
  })

  it('"Já foi resolvido" não vira exemplo; sem avaliações, nada', () => {
    expect(selectAlertExamples(repo, A)).toEqual([])
    expect(renderAlertExamples([])).toBe('')
    fb(A, 'urgente', 'down', { reasonCode: 'resolvido' })
    expect(selectAlertExamples(repo, A)).toEqual([])
  })

  it('texto compacto, trecho cortado em 400 caracteres (fica o fim)', () => {
    const long = `Mentorado: ${'bla '.repeat(200)}FIM`
    const rows = [
      { id: 1, alertId: 1, jid: A, kind: 'urgente', msgId: null, verdict: 'down', reasonCode: 'brincadeira', reasonText: 'só zoeira', correctKind: null, contextText: long, detail: '', model: null, createdAt: 1 },
      { id: 2, alertId: 2, jid: A, kind: 'urgente', msgId: null, verdict: 'down', reasonCode: 'tipo_errado', reasonText: null, correctKind: 'travado', contextText: 'Mentorado: não sei fazer\nMentor: calma', detail: '', model: null, createdAt: 1 },
      { id: 3, alertId: null, jid: A, kind: 'reuniao', msgId: null, verdict: 'missed', reasonText: null, reasonCode: null, correctKind: null, contextText: 'Mentorado: me liga?', detail: '', model: null, createdAt: 1 },
      { id: 4, alertId: 3, jid: A, kind: 'desanimo', msgId: null, verdict: 'up', reasonText: null, reasonCode: null, correctKind: null, contextText: 'Mentorado: vou desistir', detail: '', model: null, createdAt: 1 }
    ] as FeedbackRow[]
    const text = renderAlertExamples(rows)
    const lines = text.split('\n')
    expect(lines).toHaveLength(5)
    expect(lines[1]).toMatch(/^Exemplo: mensagens "….*FIM" → alerta "urgente" estava ERRADO porque: era brincadeira\/ironia \(comentário do mentor: "só zoeira"\)\.$/)
    expect(lines[1].match(/"(…[^"]*)"/)![1].length).toBeLessThanOrEqual(EXAMPLE_CONTEXT_MAX)
    expect(lines[2]).toBe('Exemplo: mensagens "Mentorado: não sei fazer / Mentor: calma" → alerta "urgente" estava ERRADO porque: não é esse tipo de alerta; o certo seria "travado".')
    expect(lines[3]).toBe('Exemplo: mensagens "Mentorado: me liga?" → deveria ter alertado "reuniao".')
    expect(lines[4]).toBe('Exemplo: mensagens "Mentorado: vou desistir" → alerta "desanimo" estava CERTO.')
  })
})

describe('classifyChat com avaliações', () => {
  let calls: Array<{ system: string; user: string }>
  let reply: string
  let deps: ClassifyDeps

  beforeEach(() => {
    calls = []
    reply = JSON.stringify({ alerts: [{ kind: 'urgente', detail: 'Prazo amanhã', messageId: 1 }] })
    const llm: LlmProvider = {
      name: 'groq',
      async complete(p) {
        calls.push(p)
        return { text: reply, inputTokens: 1, outputTokens: 1, model: 'llama-test' }
      }
    }
    deps = { repo, clock, getLlm: () => llm, cost: new CostTracker(repo, clock), getCapUsd: () => 1, diag: () => {}, onChanged: () => {} }
  })

  it('guarda no alerta a janela que a IA viu e o modelo; o 👎 vira exemplo no próximo prompt', async () => {
    add({ id: 'a1', minutesAgo: 30, fromMe: true, text: 'Oi Ana' })
    add({ id: 'a2', minutesAgo: 10, text: 'Preciso até amanhã kkkk' })
    await classifyChat(deps, A)
    const id = activeId(A, 'urgente')
    expect(repo.getAlert(id)).toMatchObject({ source: 'ai', model: 'llama-test', contextText: 'Conversa anterior (só contexto):\nMentor: Oi Ana\n\nMensagens novas:\n#1 Mentorado: Preciso até amanhã kkkk' })
    expect(calls[0].user).not.toContain('Exemplo:')
    rateAlert(repo, id, 'down', { code: 'brincadeira' })
    expect(repo.listFeedback()[0].contextText).toContain('#1 Mentorado: Preciso até amanhã kkkk')
    add({ id: 'a3', minutesAgo: 5, text: 'Outra coisa' })
    reply = '{"alerts": []}'
    await classifyChat(deps, A)
    expect(calls[1].user).toContain('Avaliações anteriores do mentor')
    expect(calls[1].user).toContain('→ alerta "urgente" estava ERRADO porque: era brincadeira/ironia.')
    // os exemplos vêm antes das mensagens a analisar
    expect(calls[1].user.indexOf('Exemplo:')).toBeLessThan(calls[1].user.indexOf('Mensagens novas:\n#1 Mentorado: Outra coisa'))
  })

  it('depois de um 👎, não recria o mesmo tipo para a mesma mensagem (outro tipo pode)', async () => {
    add({ id: 'a2', minutesAgo: 10, text: 'Preciso até amanhã' })
    await classifyChat(deps, A)
    rateAlert(repo, activeId(A, 'urgente'), 'down', { code: 'exagerado' })
    // a janela é lida de novo (ex.: o id guardado sumiu) e a IA insiste no mesmo alerta
    repo.setAlertCheck(A, 'sumiu', NOW - 60 * 60_000)
    reply = JSON.stringify({ alerts: [{ kind: 'urgente', detail: 'Prazo', messageId: 1 }, { kind: 'travado', detail: 'Não sabe', messageId: 1 }] })
    await classifyChat(deps, A)
    expect(calls).toHaveLength(2)
    expect(repo.listAlerts(A).map((a) => a.kind)).toEqual(['travado'])
  })
})

describe('qualidade e exportação', () => {
  it('por tipo nos últimos 30 dias: 👍, 👎, faltou e % de acerto', () => {
    const save = (kind: FeedbackRow['kind'], verdict: FeedbackRow['verdict']) =>
      repo.saveFeedback({ alertId: null, jid: A, kind, msgId: null, verdict, reasonCode: null, reasonText: null, correctKind: null, contextText: 'x', detail: '', model: null })
    save('urgente', 'up') // fora da janela
    clock.advance(40 * DAY)
    save('urgente', 'up')
    save('urgente', 'up')
    save('urgente', 'up')
    save('urgente', 'down')
    save('reuniao', 'missed')
    const q = alertQuality(repo, clock.now())
    expect(q.days).toBe(30)
    expect(q.kinds.map((k) => k.kind)).toEqual(['urgente', 'desanimo', 'travado', 'reuniao'])
    expect(q.kinds[0]).toEqual({ kind: 'urgente', up: 3, down: 1, missed: 0, correctRate: 0.75 })
    expect(q.kinds[3]).toEqual({ kind: 'reuniao', up: 0, down: 0, missed: 1, correctRate: null })
  })

  it('CSV com BOM, ";", aspas, nomes anonimizados por conversa e proteção contra fórmulas', () => {
    const base = { msgId: null, model: 'llama', detail: 'Prazo', createdAt: new Date(2026, 10, 25, 14, 3).getTime() }
    const rows: FeedbackRow[] = [
      { ...base, id: 2, alertId: 2, jid: B, kind: 'urgente', verdict: 'down', reasonCode: 'tipo_errado', reasonText: 'disse "já"', correctKind: null, contextText: 'Mentorado: =1+1\nMentor: ok' },
      { ...base, id: 1, alertId: 1, jid: A, kind: 'desanimo', verdict: 'up', reasonCode: null, reasonText: null, correctKind: null, contextText: 'Mentorado: cansei' },
      { ...base, id: 3, alertId: null, jid: A, kind: 'reuniao', verdict: 'missed', reasonCode: null, reasonText: null, correctKind: null, contextText: 'x', model: null }
    ]
    const names: Record<string, string> = { [A]: 'Ana', [B]: 'Bruno' }
    const csv = feedbackCsv(rows, (j) => names[j], true)
    expect(csv.startsWith('﻿data;tipo;avaliação;motivo;motivo_texto;tipo_correto;conversa;trecho;detalhe;modelo\r\n')).toBe(true)
    const lines = csv.slice(1).trimEnd().split('\r\n')
    expect(lines).toHaveLength(4)
    expect(lines[1]).toBe('"2026-11-25 14:03";"Desânimo";"Correto";"";"";"";"Contato 1";"Mentorado: cansei";"Prazo";"llama"')
    expect(lines[2]).toBe('"2026-11-25 14:03";"Urgente";"Errado";"Não é esse tipo de alerta";"disse ""já""";"Nenhum";"Contato 2";"Mentorado: =1+1\nMentor: ok";"Prazo";"llama"')
    expect(lines[3]).toContain('"Faltou"')
    expect(lines[3]).toContain('"Contato 1"')
    expect(csv).not.toMatch(/Ana|Bruno/)
    expect(feedbackCsv(rows, (j) => names[j], false)).toContain('"Bruno"')
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"')
    expect(csvCell('-5')).toBe('"\'-5"')
  })
})
