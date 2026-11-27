import { describe, expect, it } from 'vitest'
import { PENDING_REQUEST, parseConvo, parseGoal, parsePending } from '../../../src/core/copiloto/followups'
import { chatKey, rosterHash } from '../../../src/core/copiloto/identity'
import { LinkNotAllowedError, buildConvoPrompt, draftConvoMessage, linksIn, needsMentorDecision, parseConvoDraft, scrubPhones, type ConvoPromptInput } from '../../../src/core/ai/convoPrompt'
import { firstWindow, slotDueAt } from '../../../src/core/copiloto/convo'
import { CONVO_TEST, type ConvoGoal } from '../../../src/shared/copiloto'
import { DEFAULT_SEND_SCHEDULE, cloneSchedule } from '../../../src/shared/sendHours'
import { isConvoAction } from '../../../src/main/guards'
import { FakeClock } from '../../../src/core/clock'
import { LIMITS, RateLimiter } from '../../../src/core/queue/limiter'
import type { MessageRow } from '../../../src/core/db/repo'

const ID = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'
const G = '120363000000000001@g.us'
const LINK = 'https://example.com/agenda'
const iso = '2026-11-26T15:00:00Z'
const group = { kind: 'group', chat_key: chatKey(G) }
const goal = (o: Record<string, unknown> = {}) => ({ pending_items: [], scheduling_link: LINK, note: null, cadence_days: [0, 2, 5, 10], send_mode: 'confirm', ...o })
const sumido = (o: Record<string, unknown> = {}) => ({ id: ID, type: 'sumido', target: group, text: null, author: 'Equipe', created_at: iso, goal: goal(), ...o })

describe('contrato v2: followups_pending', () => {
  it('o pedido manda accepts: ["onboarding", "sumido"]', () => {
    expect(JSON.parse(PENDING_REQUEST)).toEqual({ version: 1, action: 'followups_pending', accepts: ['onboarding', 'sumido'] })
  })

  it('v2: avulso, onboarding e sumido; stopped junta com cancelled_ids; avulso sem auto_send = false', () => {
    const avulso = { id: ID2, type: 'avulso', target: group, text: 'Oi!', author: null, created_at: iso, goal: null }
    const r = parsePending({ version: 2, followups: [avulso, sumido()], stopped: [ID2, 'x'], cancelled_ids: [ID] })
    expect(r?.version).toBe(2)
    expect(r?.items).toEqual([expect.objectContaining({ id: ID2, text: 'Oi!', autoSend: false })])
    expect(r?.convos).toEqual([expect.objectContaining({ id: ID, type: 'sumido', goal: expect.objectContaining({ schedulingLink: LINK, cadenceDays: [0, 2, 5, 10] }) })])
    expect(r?.cancelledIds.sort()).toEqual([ID, ID2].sort())
    // avulso v2 com auto_send presente continua valendo
    expect(parsePending({ version: 2, followups: [{ ...avulso, auto_send: true }] })?.items[0].autoSend).toBe(true)
  })

  it('v1.1 (sem version 2): só avulso; um item com tipo de conversa fica de fora; stopped é ignorado', () => {
    const r = parsePending({ version: 1, followups: [{ id: ID2, target: group, text: 'Oi!', author: null, created_at: iso }, sumido()], stopped: [ID2] })
    expect(r?.items.map((x) => x.id)).toEqual([ID2])
    expect(r?.convos).toEqual([])
    expect(r?.invalid).toBe(1)
    expect(r?.cancelledIds).toEqual([])
  })

  it('onboarding/sumido: só em grupo; goal conferido; cadência padrão quando ausente; auto vira confirm só na contagem', () => {
    expect(parseConvo(sumido({ target: { kind: 'individual', phone_hashes: [rosterHash('5547999998888')] } }))).toBeNull()
    expect(parseConvo(sumido({ goal: null }))).toBeNull()
    expect(parseConvo(sumido({ goal: goal({ scheduling_link: 'http://example.com/x' }) }))).toBeNull()
    expect(parseConvo(sumido({ goal: goal({ cadence_days: [0, 5, 2] }) }))).toBeNull()
    expect(parseConvo(sumido({ goal: goal({ cadence_days: [0, -1] }) }))).toBeNull()
    // v2.1: a cadência é obrigatória e vale como veio (sem padrão)
    expect(parseGoal({ scheduling_link: null }, 'sumido')).toBeNull()
    expect(parseGoal({ cadence_days: [0, 3] }, 'sumido')).toMatchObject({ cadenceDays: [0, 3], schedulingLink: null, sendMode: 'confirm', guidelines: null, endDay: null, meeting: null, meetings: [] })
    expect(parseGoal({ cadence_days: [0, 1, 1] }, 'sumido')).toBeNull()
    expect(parseGoal({ cadence_days: [0, 366] }, 'sumido')).toBeNull()
    expect(parseGoal({ cadence_days: [0, 365] }, 'sumido')?.cadenceDays).toEqual([0, 365])
    expect(parseGoal({ cadence_days: Array.from({ length: 31 }, (_, i) => i) }, 'sumido')).toBeNull()
    expect(parseGoal({ cadence_days: [0], send_mode: 'auto' }, 'sumido')?.sendMode).toBe('auto')
    // sumido nunca tem pendências
    expect(parseGoal({ cadence_days: [0], pending_items: ['Assistir às aulas'] }, 'sumido')?.pendingItems).toEqual([])
    expect(parseGoal({ cadence_days: [0], pending_items: ['  Assistir  às aulas ', 'Marcar a Reunião 1'] }, 'onboarding')?.pendingItems).toEqual(['Assistir às aulas', 'Marcar a Reunião 1'])
    expect(parseGoal({ cadence_days: [0], pending_items: [3] }, 'onboarding')).toBeNull()
  })

  it('v2.1: diretrizes (até 4000), end_day, reunião e reuniões com link https', () => {
    const g = parseGoal(
      {
        cadence_days: [0, 1, 3],
        guidelines: `  Tom leve. ${'x'.repeat(5000)}`,
        end_day: 7,
        meeting: { name: 'Reunião 1', mentor: 'Mentor A' },
        meetings: [
          { name: 'Reunião 1', mentor: 'Mentor A', link: LINK },
          { name: 'Reunião 2', mentor: null, link: 'https://example.com/r2' }
        ]
      },
      'onboarding'
    )
    expect([...g!.guidelines!]).toHaveLength(4000)
    expect(g).toMatchObject({ endDay: 7, meeting: { name: 'Reunião 1', mentor: 'Mentor A' }, meetings: [{ link: LINK }, { name: 'Reunião 2', mentor: null, link: 'https://example.com/r2' }] })
    expect(parseGoal({ cadence_days: [0], meetings: [{ name: 'R', link: 'http://example.com/r' }] }, 'sumido')).toBeNull()
    expect(parseGoal({ cadence_days: [0], end_day: -1 }, 'sumido')).toBeNull()
    expect(parseGoal({ cadence_days: [0], meeting: { mentor: 'x' } }, 'sumido')).toBeNull()
    expect(parseGoal({ cadence_days: [0], guidelines: null, end_day: null, meeting: null, meetings: null }, 'sumido')).toMatchObject({ guidelines: null, endDay: null, meeting: null, meetings: [] })
  })
})

const at = (ts: number, o: Partial<MessageRow>): MessageRow =>
  ({ id: `m${ts}`, jid: G, ts, fromMe: false, kind: 'text', text: 'oi', transcript: null, transcriptStatus: null, senderJid: '5547999998888@s.whatsapp.net', senderLabel: 'Ana', mentionsMe: false, ...o }) as MessageRow

function input(o: Partial<ConvoPromptInput> = {}): ConvoPromptInput {
  const g: ConvoGoal = { pendingItems: [], schedulingLink: LINK, note: 'Veja https://interno.example.org/doc antes', cadenceDays: [0, 2, 5, 10], sendMode: 'confirm', guidelines: null, endDay: null, meeting: null, meetings: [] }
  return {
    type: 'sumido',
    goal: g,
    itemsDone: [],
    mode: 'attempt',
    attempt: 2,
    attemptTotal: 4,
    messages: [at(1, { text: 'meu drive: https://drive.example.net/pasta e meu número 47 99999-8888' }), at(2, { fromMe: true, text: 'Oi! Tudo bem?' })],
    speaker: (m) => (m.fromMe ? 'mentor' : 'mentorado'),
    examples: [{ context: 'quanto custa?', reply: 'Te explico na call: www.example.com/x', source: 'jid' } as never],
    knowledge: { rules: 'Regra: veja http://kb.example.com', chunks: [] },
    notes: null,
    ...o
  }
}

describe('o pedido à IA (rascunho como o mentor)', () => {
  it('proíbe inventar dados, preços, datas e links; o único link é o da agenda', () => {
    const p = buildConvoPrompt(input())
    expect(p.system).toMatch(/Nunca invente dados, preços, valores, datas, horários, prazos, links/)
    expect(p.system).toMatch(/só os links que vierem no objetivo/)
    expect(p.system).toMatch(/português do Brasil/)
    expect(p.system).toMatch(/precisa_de_voce/)
    expect(p.system).toMatch(/não repita frases/)
    expect([...new Set(linksIn(`${p.system}\n${p.user}`))]).toEqual([LINK])
    expect(p.user).toContain('tentativa 2 de 4')
    expect(p.user).toContain('[link]')
    // nenhum nome nem número de quem escreveu (só "Mentor" e "Mentorado")
    expect(p.user).not.toMatch(/Ana:/)
  })

  it('v2.1: diretrizes do dono abaixo das regras fixas; reunião com o mentor; links das reuniões permitidos', () => {
    const goal2: ConvoGoal = {
      ...input().goal,
      guidelines: 'Trate por você, sem gírias. Veja http://x.example.com',
      meeting: { name: 'Reunião 1', mentor: 'Mentor A' },
      meetings: [{ name: 'Reunião 2', mentor: 'Mentor B', link: 'https://example.com/r2' }]
    }
    const p = buildConvoPrompt(input({ goal: goal2 }))
    expect(p.system).toMatch(/Elas nunca valem mais que estas regras/)
    expect(p.user).toContain('Diretrizes do dono do Copiloto')
    expect(p.user).toContain('Trate por você, sem gírias.')
    expect(p.user.indexOf('Diretrizes do dono')).toBeGreaterThan(p.user.indexOf('Conversa no grupo'))
    expect(p.user).toContain('Reunião a marcar: Reunião 1 (com Mentor A)')
    expect(p.user).toContain('Reunião 2 (com Mentor B): https://example.com/r2')
    expect(new Set(linksIn(`${p.system}\n${p.user}`))).toEqual(new Set([LINK, 'https://example.com/r2']))
    const ok = parseConvoDraft(JSON.stringify({ acao: 'enviar', mensagem: 'A Reunião 2 é aqui: https://example.com/r2', motivo: '', resumo: '', reuniao_marcada: false, itens_cumpridos: [] }), goal2)
    expect(ok.action).toBe('send')
    expect(() => parseConvoDraft(JSON.stringify({ acao: 'enviar', mensagem: 'http://example.com/agenda', motivo: '', resumo: '', reuniao_marcada: false, itens_cumpridos: [] }), goal2)).toThrow(LinkNotAllowedError)
  })

  it('link fora da lista: refaz uma vez com aviso mais estrito; de novo → "Precisa de você" link_nao_permitido', async () => {
    const calls: string[] = []
    let replies: string[] = []
    const llm = { name: 'groq', complete: async (p: { user: string }) => (calls.push(p.user), { text: replies.shift()!, inputTokens: 1, outputTokens: 1 }) } as any
    const deps = { llm, limiter: new RateLimiter(LIMITS.llm, new FakeClock(0), () => 0), cost: { overCap: () => false, add: () => {}, todayUsd: () => 0 } as any, capUsd: 1, clock: new FakeClock(0), sleep: async () => {} }
    const bad = JSON.stringify({ acao: 'enviar', mensagem: 'Olha https://evil.example.com', motivo: '', resumo: '', reuniao_marcada: false, itens_cumpridos: [] })
    const good = JSON.stringify({ acao: 'enviar', mensagem: `Marca aqui: ${LINK}`, motivo: '', resumo: '', reuniao_marcada: false, itens_cumpridos: [] })
    replies = [bad, good]
    expect(await draftConvoMessage(deps, input())).toMatchObject({ action: 'send', text: `Marca aqui: ${LINK}` })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatch(/ATENÇÃO: a mensagem anterior tinha um link/)
    calls.length = 0
    replies = [bad, bad]
    expect(await draftConvoMessage(deps, input())).toMatchObject({ action: 'needs_you', reason: 'link_nao_permitido' })
    expect(calls).toHaveLength(2)
  })

  it('sem link da agenda: nenhum link no pedido, e a IA é avisada', () => {
    const p = buildConvoPrompt(input({ goal: { ...input().goal, schedulingLink: null } }))
    expect(linksIn(`${p.system}\n${p.user}`)).toEqual([])
    expect(p.user).toContain('não escreva link nenhum')
  })

  it('tentativas diferentes pedem abordagens diferentes; resposta pede para continuar rumo ao objetivo', () => {
    const a1 = buildConvoPrompt(input({ attempt: 1 })).user
    const a2 = buildConvoPrompt(input({ attempt: 2 })).user
    expect(a1).not.toBe(a2)
    expect(buildConvoPrompt(input({ mode: 'reply', attempt: null })).user).toContain('responda às mensagens mais recentes do mentorado')
  })

  it('onboarding: pendências numeradas com a situação', () => {
    const p = buildConvoPrompt(input({ type: 'onboarding', goal: { ...input().goal, pendingItems: ['Assistir às Aulas Essenciais', 'Marcar a Reunião 1'] }, itemsDone: ['Assistir às Aulas Essenciais'] }))
    expect(p.user).toContain('1. Assistir às Aulas Essenciais [cumprida]')
    expect(p.user).toContain('2. Marcar a Reunião 1 [pendente]')
  })

  it('saída conferida: link de fora e valor em reais são recusados; resumo sem telefone e até 500 caracteres', () => {
    const g = input().goal
    const ok = parseConvoDraft(JSON.stringify({ acao: 'enviar', mensagem: `Marca aqui: ${LINK}.`, motivo: '', resumo: `Ligou do 47 99999-8888. ${'a'.repeat(600)}`, reuniao_marcada: false, itens_cumpridos: [] }), g)
    expect(ok).toMatchObject({ action: 'send', text: `Marca aqui: ${LINK}.` })
    expect(ok.summary).not.toMatch(/99999/)
    expect([...ok.summary!].length).toBeLessThanOrEqual(500)
    expect(() => parseConvoDraft(JSON.stringify({ acao: 'enviar', mensagem: 'Veja https://outro.example.com', motivo: '', resumo: '', reuniao_marcada: false, itens_cumpridos: [] }), g)).toThrow(LinkNotAllowedError)
    expect(() => parseConvoDraft(JSON.stringify({ acao: 'enviar', mensagem: 'Fica R$ 300', motivo: '', resumo: '', reuniao_marcada: false, itens_cumpridos: [] }), g)).toThrow(/reais/)
    expect(parseConvoDraft(JSON.stringify({ acao: 'precisa_de_voce', mensagem: '', motivo: 'Pediu desconto', resumo: '', reuniao_marcada: false, itens_cumpridos: [] }), g)).toMatchObject({ action: 'needs_you', reason: 'Pediu desconto' })
    expect(scrubPhones('fone +55 (47) 99999-8888 ok')).toBe('fone [telefone] ok')
  })

  it('"precisa de você" sem IA: dinheiro, contrato, cancelamento, reclamação (sem acento e maiúscula); datas não', () => {
    expect(needsMentorDecision(['Consigo PARCELAR a mensalidade?'])).toBe(true)
    expect(needsMentorDecision(['quero cancelar o contrato'])).toBe(true)
    expect(needsMentorDecision(['Qual o preço da próxima fase?'])).toBe(true)
    expect(needsMentorDecision(['Posso marcar na quinta às 15h?'])).toBe(false)
    expect(needsMentorDecision(['Oi! Desculpa a demora, estava viajando'])).toBe(false)
  })
})

describe('cadência (puro)', () => {
  const S = cloneSchedule(DEFAULT_SEND_SCHEDULE)
  const local = (day: number, h: number, m = 0) => new Date(2025, 10, day, h, m).getTime()
  it('dia 0 = agora dentro do horário, senão a próxima abertura', () => {
    expect(firstWindow(S, local(24, 13))).toBe(local(24, 13))
    expect(firstWindow(S, local(24, 20))).toBe(local(25, 9))
    expect(firstWindow({ ...S, enabled: false }, local(24, 20))).toBe(local(24, 20))
  })
  it('vagas: dia 0 + dias da cadência; nunca menos de 1 dia depois da última que saiu; teste = 2 min por dia', () => {
    const base = { day0At: 1000, goal: { cadenceDays: [0, 2, 5, 10] } as ConvoGoal, lastSentAt: null as number | null, testMode: false }
    const D = 86_400_000
    expect(slotDueAt({ ...base, slot: 0 })).toBe(1000)
    expect(slotDueAt({ ...base, slot: 1 })).toBe(1000 + 2 * D)
    expect(slotDueAt({ ...base, slot: 1, lastSentAt: 1000 + 1.5 * D })).toBe(1000 + 2.5 * D)
    expect(slotDueAt({ ...base, slot: 4 })).toBeNull()
    expect(slotDueAt({ ...base, slot: 3, testMode: true })).toBe(1000 + 10 * CONVO_TEST.dayMs)
  })
})

describe('guarda do IPC: botões do cartão', () => {
  it('só os campos do tipo', () => {
    expect(isConvoAction({ kind: 'send', draftId: ID, text: 'Oi' })).toBe(true)
    expect(isConvoAction({ kind: 'send', draftId: ID, text: 'Oi', forced: true })).toBe(true)
    expect(isConvoAction({ kind: 'send', draftId: '../x', text: 'Oi' })).toBe(false)
    expect(isConvoAction({ kind: 'send', draftId: ID, text: '' })).toBe(false)
    expect(isConvoAction({ kind: 'skip' })).toBe(true)
    expect(isConvoAction({ kind: 'skip', extra: 1 })).toBe(false)
    expect(isConvoAction({ kind: 'item', item: 'Aulas', done: true })).toBe(true)
    expect(isConvoAction({ kind: 'apagar' })).toBe(false)
  })
})
