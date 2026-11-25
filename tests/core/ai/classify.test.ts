import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../../src/core/db/db'
import { Repo, type MessageRow } from '../../../src/core/db/repo'
import { FakeClock } from '../../../src/core/clock'
import { CostTracker } from '../../../src/core/ai/budget'
import { InvalidOutputError } from '../../../src/core/ai/prompt'
import { LlmRateLimitError, type LlmProvider } from '../../../src/core/ai/llm'
import { DeferJobError } from '../../../src/core/queue/queue'
import {
  CLASSIFY_MAX_AGE_MS,
  buildAlertPrompt,
  classifyChat,
  classifyWindow,
  parseAlerts,
  type ClassifyDeps
} from '../../../src/core/ai/classify'
import type { NormalizedMessage } from '../../../src/core/types'

const NOW = 1_764_000_000_000
const A = '5547999998888@s.whatsapp.net'
const G = '120363025555555555@g.us'

function row(id: string, fromMe: boolean, over: Partial<MessageRow> = {}): MessageRow {
  return {
    id, jid: A, fromMe, ts: 1, kind: 'text', text: `texto ${id}`, mediaKeyJson: null, durationSec: null,
    audioPath: null, transcript: null, transcriptStatus: null,
    senderJid: null, senderName: null, senderLabel: null, mentionsMe: false, ...over
  }
}

describe('buildAlertPrompt', () => {
  it('numera as mensagens novas, usa transcrições e pede só JSON com os 4 tipos', () => {
    const p = buildAlertPrompt({
      contactName: 'Ana',
      isGroup: false,
      prior: [row('p1', true, { text: 'Como foi a semana?' })],
      newMessages: [
        row('n1', false, { text: 'Preciso disso até amanhã!' }),
        row('n2', false, { kind: 'audio', text: null, transcript: 'tô pensando em desistir', transcriptStatus: 'done' })
      ]
    })
    expect(p.system).toContain('pt-BR')
    for (const k of ['urgente', 'desanimo', 'reuniao', 'travado']) expect(p.system).toContain(`"${k}"`)
    expect(p.system).toContain('"alerts"')
    expect(p.user).toContain('Mentor: Como foi a semana?')
    expect(p.user).toContain('#1 Mentorado: Preciso disso até amanhã!')
    expect(p.user).toContain('#2 Mentorado: [áudio transcrito] tô pensando em desistir')
    expect(p.user).not.toContain('#1 Mentor:')
  })

  it('grupo: nome de quem mandou e regra de só marcar o que é dirigido ao mentor', () => {
    const p = buildAlertPrompt({
      contactName: 'Turma 3',
      isGroup: true,
      prior: [],
      newMessages: [row('g1', false, { jid: G, senderJid: 'x', senderLabel: 'Bruno', mentionsMe: true, text: '@Mentor me liga?' })]
    })
    expect(p.user).toContain('#1 Bruno (menciona você): @Mentor me liga?')
    expect(p.system).toMatch(/dirigid[oa]s? ao mentor/)
  })
})

describe('parseAlerts', () => {
  const msgs = [row('n1', false), row('n2', false)]

  it('aceita o formato pedido e liga messageId (#) à mensagem', () => {
    const out = parseAlerts(
      JSON.stringify({ alerts: [{ kind: 'urgente', detail: ' Prazo amanhã ', messageId: 2 }, { kind: 'reuniao', detail: 'Quer ligação', messageId: '#1' }] }),
      msgs
    )
    expect(out).toEqual([
      { kind: 'urgente', detail: 'Prazo amanhã', msgId: 'n2' },
      { kind: 'reuniao', detail: 'Quer ligação', msgId: 'n1' }
    ])
  })

  it('descarta tipos desconhecidos, "esperando", detalhe vazio e repetidos; corta o detalhe em 120', () => {
    const long = 'x'.repeat(300)
    const out = parseAlerts(
      '```json\n' +
        JSON.stringify({
          alerts: [
            { kind: 'spam', detail: 'a' },
            { kind: 'esperando', detail: 'b' },
            { kind: 'travado', detail: '' },
            { kind: 'travado', detail: long, messageId: 99 },
            { kind: 'travado', detail: 'de novo' },
            'lixo',
            null
          ]
        }) +
        '\n```',
      msgs
    )
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('travado')
    expect(out[0].detail.length).toBeLessThanOrEqual(120)
    expect(out[0].msgId).toBeNull()
  })

  it('lista vazia é válida; JSON inválido ou sem "alerts" lança InvalidOutputError', () => {
    expect(parseAlerts('{"alerts": []}', msgs)).toEqual([])
    expect(() => parseAlerts('não sei', msgs)).toThrow(InvalidOutputError)
    expect(() => parseAlerts('{"x": 1}', msgs)).toThrow(InvalidOutputError)
  })
})

describe('classifyChat', () => {
  let clock: FakeClock
  let repo: Repo
  let calls: Array<{ system: string; user: string; temperature?: number }>
  let reply: string | (() => never)
  let diag: string[]
  let changed: string[]
  let llm: LlmProvider | null
  let deps: ClassifyDeps

  const add = (o: Partial<NormalizedMessage> & { id: string; minutesAgo: number }) =>
    repo.insertMessage({
      jid: A, fromMe: false, kind: 'text', text: `texto ${o.id}`, mediaKeyJson: null, durationSec: null,
      ...o, ts: NOW - o.minutesAgo * 60_000
    })

  beforeEach(() => {
    clock = new FakeClock(NOW)
    repo = new Repo(openDb(':memory:'), clock)
    repo.upsertContact({ jid: A, pushName: 'Ana' })
    calls = []
    diag = []
    changed = []
    reply = JSON.stringify({ alerts: [{ kind: 'urgente', detail: 'Precisa da planilha até amanhã', messageId: 1 }] })
    llm = {
      name: 'groq',
      async complete(p) {
        calls.push(p)
        if (typeof reply === 'function') reply()
        return { text: reply as string, inputTokens: 10, outputTokens: 5 }
      }
    }
    deps = {
      repo,
      clock,
      getLlm: () => llm,
      cost: new CostTracker(repo, clock),
      getCapUsd: () => 1,
      diag: (k, d) => diag.push(`${k} ${d}`),
      onChanged: (jid) => changed.push(jid)
    }
  })

  it('sem chave da Groq: não chama a IA e registra o motivo', async () => {
    llm = null
    add({ id: 'a1', minutesAgo: 10, text: 'urgente!' })
    await classifyChat(deps, A)
    expect(calls).toHaveLength(0)
    expect(repo.listAlerts(A)).toEqual([])
    expect(diag).toEqual([expect.stringMatching(/^classify result=skip reason=no_groq_key alerts=0 ms=\d+$/)])
  })

  it('classifica as mensagens novas, grava o alerta e a janela; o registro não tem texto nem jid', async () => {
    add({ id: 'a1', minutesAgo: 30, fromMe: true, text: 'Oi Ana' })
    add({ id: 'a2', minutesAgo: 10, text: 'Preciso da planilha até amanhã, é urgente' })
    await classifyChat(deps, A)
    expect(calls).toHaveLength(1)
    expect(calls[0].temperature).toBeLessThanOrEqual(0.3)
    expect(calls[0].user).toContain('#1 Mentorado: Preciso da planilha')
    expect(repo.listAlerts(A)).toEqual([expect.objectContaining({ kind: 'urgente', msgId: 'a2' })])
    expect(repo.getAlertCheck(A)!.lastMsgId).toBe('a2')
    expect(changed).toEqual([A])
    expect(diag).toHaveLength(1)
    expect(diag[0]).toMatch(/^classify result=ok alerts=1 ms=\d+$/)
    expect(diag.join()).not.toMatch(/planilha|5547|Ana/)
  })

  it('idempotente: sem mensagem nova do contato não chama de novo; com nova, só ela entra como nova', async () => {
    add({ id: 'a1', minutesAgo: 10, text: 'primeira' })
    await classifyChat(deps, A)
    await classifyChat(deps, A)
    expect(calls).toHaveLength(1)
    add({ id: 'a2', minutesAgo: 5, fromMe: true, text: 'resposta' })
    await classifyChat(deps, A)
    expect(calls).toHaveLength(1)
    add({ id: 'a3', minutesAgo: 1, text: 'segunda' })
    await classifyChat(deps, A)
    expect(calls).toHaveLength(2)
    expect(calls[1].user).toContain('#1 Mentorado: segunda')
    expect(calls[1].user).not.toContain('#1 Mentorado: primeira')
    expect(calls[1].user).toContain('Mentorado: primeira') // contexto anterior
  })

  it('contato escondido: não classifica', async () => {
    add({ id: 'a1', minutesAgo: 10 })
    repo.setHidden(A, true)
    await classifyChat(deps, A)
    expect(calls).toHaveLength(0)
    expect(diag[0]).toMatch(/reason=hidden/)
  })

  it('mensagens antigas (fora da janela de dias) não vão para a IA', async () => {
    add({ id: 'a1', minutesAgo: CLASSIFY_MAX_AGE_MS / 60_000 + 60 })
    await classifyChat(deps, A)
    expect(calls).toHaveLength(0)
    expect(repo.getAlertCheck(A)!.lastMsgId).toBe('a1')
  })

  it('saída inválida: nenhum alerta, registrado, janela marcada (não repete)', async () => {
    reply = 'não é json'
    add({ id: 'a1', minutesAgo: 10 })
    await classifyChat(deps, A)
    expect(repo.listAlerts(A)).toEqual([])
    expect(diag[0]).toMatch(/result=invalid_output alerts=0/)
    await classifyChat(deps, A)
    expect(calls).toHaveLength(1)
  })

  it('o mentor já respondeu depois: só "desanimo" fica', async () => {
    reply = JSON.stringify({
      alerts: [
        { kind: 'urgente', detail: 'u', messageId: 1 },
        { kind: 'desanimo', detail: 'Diz que pensa em desistir', messageId: 1 }
      ]
    })
    add({ id: 'a1', minutesAgo: 10, text: 'acho que vou desistir, é urgente' })
    add({ id: 'a2', minutesAgo: 5, fromMe: true, text: 'calma' })
    await classifyChat(deps, A)
    expect(repo.listAlerts(A).map((a) => a.kind)).toEqual(['desanimo'])
  })

  it('áudio recente ainda sem transcrição: espera (DeferJobError) sem chamar a IA', async () => {
    add({ id: 'a1', minutesAgo: 2, kind: 'audio', text: null, durationSec: 10 })
    await expect(classifyChat(deps, A)).rejects.toBeInstanceOf(DeferJobError)
    expect(calls).toHaveLength(0)
  })

  it('429 da IA: devolve à fila com a espera pedida', async () => {
    reply = () => {
      throw new LlmRateLimitError(30_000)
    }
    add({ id: 'a1', minutesAgo: 2 })
    const err = await classifyChat(deps, A).catch((e) => e)
    expect(err).toBeInstanceOf(DeferJobError)
    expect(err.delayMs).toBe(30_000)
    expect(repo.getAlertCheck(A)).toBeNull()
  })

  it('erro inesperado da IA: registra e não lança (não vira "falha" na barra de status)', async () => {
    reply = () => {
      throw new Error('HTTP 500 conteúdo secreto')
    }
    add({ id: 'a1', minutesAgo: 2 })
    await expect(classifyChat(deps, A)).resolves.toBeUndefined()
    expect(diag[0]).toMatch(/result=error/)
    expect(diag[0]).not.toContain('secreto')
  })

  it('teto diário de gasto atingido: espera até amanhã sem chamar a IA', async () => {
    deps.getCapUsd = () => 0
    add({ id: 'a1', minutesAgo: 2 })
    await expect(classifyChat(deps, A)).rejects.toBeInstanceOf(DeferJobError)
    expect(calls).toHaveLength(0)
  })

  it('classifyWindow: no máximo 20 novas; id guardado sumiu → usa o horário', () => {
    for (let i = 0; i < 30; i++) add({ id: `x${i}`, minutesAgo: 100 - i })
    expect(classifyWindow(repo, A, NOW).newMessages).toHaveLength(20)
    repo.setAlertCheck(A, 'sumiu', NOW - 80 * 60_000)
    const w = classifyWindow(repo, A, NOW)
    expect(w.newMessages.map((m) => m.id)).toEqual(['x21', 'x22', 'x23', 'x24', 'x25', 'x26', 'x27', 'x28', 'x29'])
  })
})
