import { beforeEach, describe, expect, it, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { LIMITS, RateLimiter } from '../../../src/core/queue/limiter'
import { InvalidKeyError } from '../../../src/core/ai/transcriber'
import { BudgetExceededError, CostTracker } from '../../../src/core/ai/budget'
import {
  LlmRateLimitError,
  LlmRefusalError,
  createLlm,
  generateAnalysis,
  type LlmProvider
} from '../../../src/core/ai/llm'
import { InvalidOutputError } from '../../../src/core/ai/prompt'

const T0 = 1_700_000_000_000
const JID = '5547999990001@s.whatsapp.net'
const GOOD = JSON.stringify({ resumo: 'Quer ajuda', sugestoes: ['Oi!', 'Conta mais?'] })

let clock: FakeClock
let repo: Repo

function fakeLlm(outputs: string[]): LlmProvider & { calls: Array<{ system: string; user: string }> } {
  const calls: Array<{ system: string; user: string }> = []
  return {
    name: 'groq',
    calls,
    async complete(p) {
      calls.push(p)
      return { text: outputs[Math.min(calls.length - 1, outputs.length - 1)], inputTokens: 100, outputTokens: 50 }
    }
  }
}

function deps(llm: LlmProvider, capUsd = 1) {
  const limiter = new RateLimiter(LIMITS.llm, clock, () => 0)
  const cost = new CostTracker(repo, clock)
  const sleep = async (ms: number) => clock.advance(ms)
  return { repo, llm, limiter, cost, capUsd, clock, sleep }
}

function addMsg(id: string, fromMe: boolean, text: string, ts = T0 + Number(id.slice(1)) * 1000) {
  repo.insertMessage({ id, jid: JID, fromMe, ts, kind: 'text', text, mediaKeyJson: null, durationSec: null })
}

beforeEach(() => {
  clock = new FakeClock(T0)
  repo = new Repo(openDb(':memory:'), clock)
  repo.upsertContact({ jid: JID })
  addMsg('m1', true, 'Olá!')
  addMsg('m2', false, 'Preciso de ajuda com preços')
})

describe('generateAnalysis', () => {
  it('lixo e depois JSON válido: sucesso com 2 chamadas e salva', async () => {
    const llm = fakeLlm(['lixo', GOOD])
    const a = await generateAnalysis(deps(llm), JID)
    expect(llm.calls).toHaveLength(2)
    expect(a.suggestions).toEqual(['Oi!', 'Conta mais?'])
    expect(repo.getAnalysis(JID)).toMatchObject({ lastMsgId: 'm2', provider: 'groq', summary: 'Quer ajuda' })
  })
  it('lixo duas vezes: erro e nada salvo', async () => {
    const llm = fakeLlm(['lixo'])
    await expect(generateAnalysis(deps(llm), JID)).rejects.toBeInstanceOf(InvalidOutputError)
    expect(llm.calls).toHaveLength(2)
    expect(repo.getAnalysis(JID)).toBeNull()
  })
  it('cache válido: 0 chamadas; force ignora o cache', async () => {
    repo.saveAnalysis(JID, 'm2', 'groq', 's', ['a', 'b'])
    const llm = fakeLlm([GOOD])
    const a = await generateAnalysis(deps(llm), JID)
    expect(llm.calls).toHaveLength(0)
    expect(a.summary).toBe('s')
    await generateAnalysis(deps(llm), JID, { force: true })
    expect(llm.calls).toHaveLength(1)
  })
  it('separa novas (após o último fromMe) e anteriores no prompt', async () => {
    const llm = fakeLlm([GOOD])
    await generateAnalysis(deps(llm), JID)
    expect(llm.calls[0].user).toContain('Preciso de ajuda com preços')
  })
  it('último fromMe: ainda gera', async () => {
    addMsg('m3', true, 'Claro, me conta mais')
    const llm = fakeLlm([GOOD])
    await generateAnalysis(deps(llm), JID)
    expect(llm.calls).toHaveLength(1)
    expect(repo.getAnalysis(JID)?.lastMsgId).toBe('m3')
  })
  it('sem mensagens: erro claro', async () => {
    repo.upsertContact({ jid: 'x@s.whatsapp.net' })
    await expect(generateAnalysis(deps(fakeLlm([GOOD])), 'x@s.whatsapp.net')).rejects.toThrow(/sem mensagens/)
  })
  it('teto de gasto: BudgetExceededError sem chamar a IA', async () => {
    const d = deps(fakeLlm([GOOD]))
    d.cost.add('claude', 10_000_000, 0, 'claude-opus-5-5') // US$ 40
    d.llm = Object.assign(fakeLlm([GOOD]), { name: 'claude' as const })
    await expect(generateAnalysis({ ...d, capUsd: 1 }, JID)).rejects.toBeInstanceOf(BudgetExceededError)
  })
  it('espera o limitador antes de chamar', async () => {
    const d = deps(fakeLlm([GOOD, GOOD]))
    await generateAnalysis(d, JID)
    const before = clock.now()
    await generateAnalysis(d, JID, { force: true })
    expect(clock.now()).toBeGreaterThanOrEqual(before)
  })
})

describe('CostTracker', () => {
  it('groq = 0, claude pela tabela, modelo desconhecido usa Opus, zera no dia seguinte', () => {
    const c = new CostTracker(repo, clock)
    c.add('groq', 1_000_000, 1_000_000)
    expect(c.todayUsd()).toBe(0)
    c.add('claude', 1_000_000, 1_000_000, 'claude-sonnet-5-5')
    expect(c.todayUsd()).toBeCloseTo(12)
    c.add('claude', 1_000_000, 0, 'claude-futuro-9')
    expect(c.todayUsd()).toBeCloseTo(16)
    expect(c.overCap(15)).toBe(true)
    expect(c.overCap(20)).toBe(false)
    clock.advance(48 * 3_600_000)
    expect(c.todayUsd()).toBe(0)
  })
})

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers })
}

describe('createLlm groq', () => {
  it('envia response_format json_object, auth e modelo; lê tokens', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const f = (async (url: any, init: any) => {
      calls.push({ url: String(url), init })
      return jsonRes(200, { choices: [{ message: { content: GOOD } }], usage: { prompt_tokens: 7, completion_tokens: 3 } })
    }) as unknown as typeof fetch
    const llm = createLlm('groq', 'KEY', { fetchImpl: f, repo })
    const r = await llm.complete({ system: 'S', user: 'U' })
    const body = JSON.parse(calls[0].init.body)
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }])
    expect(calls[0].init.headers.Authorization).toBe('Bearer KEY')
    expect(r).toMatchObject({ text: GOOD, inputTokens: 7, outputTokens: 3 })
  })
  it('modelo vem das settings', async () => {
    repo.setSetting('llm.groq.model', 'meu-modelo')
    let body: any
    const f = (async (_u: any, init: any) => {
      body = JSON.parse(init.body)
      return jsonRes(200, { choices: [{ message: { content: GOOD } }] })
    }) as unknown as typeof fetch
    await createLlm('groq', 'K', { fetchImpl: f, repo }).complete({ system: 's', user: 'u' })
    expect(body.model).toBe('meu-modelo')
  })
  it('401 -> InvalidKeyError; 429 -> LlmRateLimitError com retryAfterMs', async () => {
    const mk = (res: () => Response) => createLlm('groq', 'K', { fetchImpl: (async () => res()) as unknown as typeof fetch })
    await expect(mk(() => jsonRes(401, {})).complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(InvalidKeyError)
    const e = await mk(() => jsonRes(429, {}, { 'retry-after': '12' })).complete({ system: 's', user: 'u' }).catch((x) => x)
    expect(e).toBeInstanceOf(LlmRateLimitError)
    expect(e.retryAfterMs).toBe(12_000)
  })
})

describe('createLlm claude', () => {
  function fakeClient(impl: (args: any) => Promise<any>) {
    const create = vi.fn(impl)
    return { client: { beta: { messages: { create } } } as unknown as Anthropic, create }
  }
  it('chama beta.messages.create com os parâmetros certos', async () => {
    const { client, create } = fakeClient(async () => ({
      stop_reason: 'end_turn', model: 'claude-opus-5-5',
      content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: GOOD }],
      usage: { input_tokens: 11, output_tokens: 22 }
    }))
    const r = await createLlm('claude', 'K', { client, repo }).complete({ system: 'S', user: 'U' })
    const a = create.mock.calls[0][0]
    expect(a).toMatchObject({
      model: 'claude-opus-5-5', max_tokens: 4000, betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', output_config: { effort: 'medium', format: { type: 'json_schema' } },
      system: 'S', messages: [{ role: 'user', content: 'U' }]
    })
    for (const k of ['thinking', 'temperature', 'top_p', 'top_k']) expect(a).not.toHaveProperty(k)
    expect(r).toMatchObject({ text: GOOD, inputTokens: 11, outputTokens: 22, model: 'claude-opus-5-5' })
  })
  it('refusal -> LlmRefusalError', async () => {
    const { client } = fakeClient(async () => ({ stop_reason: 'refusal', content: [], usage: { input_tokens: 1, output_tokens: 0 } }))
    await expect(createLlm('claude', 'K', { client }).complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(LlmRefusalError)
  })
  it('erros tipados do SDK: 401 e 429', async () => {
    const h = new Headers({ 'retry-after': '5' })
    const c401 = fakeClient(async () => { throw new Anthropic.AuthenticationError(401, {}, 'x', new Headers()) })
    await expect(createLlm('claude', 'K', { client: c401.client }).complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(InvalidKeyError)
    const c429 = fakeClient(async () => { throw new Anthropic.RateLimitError(429, {}, 'x', h) })
    const e = await createLlm('claude', 'K', { client: c429.client }).complete({ system: 's', user: 'u' }).catch((x) => x)
    expect(e).toBeInstanceOf(LlmRateLimitError)
    expect(e.retryAfterMs).toBe(5000)
  })
})
