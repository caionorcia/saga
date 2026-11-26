import { beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { LIMITS, RateLimiter } from '../../../src/core/queue/limiter'
import { CostTracker } from '../../../src/core/ai/budget'
import { InvalidKeyError } from '../../../src/core/ai/groqModels'
import { LlmRateLimitError, createLlm, generateAnalysis, type LlmName, type LlmProvider } from '../../../src/core/ai/llm'
import { InvalidOutputError } from '../../../src/core/ai/prompt'
import { MIN_LIMITED_MS, ProviderLimits, withFallback } from '../../../src/core/ai/fallback'
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_CHAT_URL,
  GEMINI_MODELS_URL,
  MISTRAL_CHAT_URL,
  pickGeminiFlash
} from '../../../src/core/ai/freeProviders'
import { testKey } from '../../../src/core/settings'

const T0 = 1_700_000_000_000
const GOOD = JSON.stringify({ resumo: 'r', sugestoes: ['a', 'b'] })
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const ok = (model: string) => json(200, { model, choices: [{ message: { content: GOOD } }], usage: { prompt_tokens: 7, completion_tokens: 3 } })

let clock: FakeClock
let repo: Repo
beforeEach(() => {
  clock = new FakeClock(T0)
  repo = new Repo(openDb(':memory:'), clock)
})

type Call = { url: string; init: any; body?: any }
function fake(handler: (url: string, body: any, calls: Call[]) => Response | Promise<Response>) {
  const calls: Call[] = []
  const impl = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), init, body })
    return handler(String(url), body, calls)
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('Gemini', () => {
  it('escolhe o Flash mais novo da lista ("models/" tirado) e manda o pedido no formato da OpenAI', async () => {
    const f = fake((url, body) => {
      if (url === GEMINI_MODELS_URL)
        return json(200, {
          object: 'list',
          data: ['models/gemini-2.0-flash', 'models/gemini-2.5-flash', 'models/gemini-2.5-flash-lite', 'models/gemini-2.5-pro'].map((id) => ({ id }))
        })
      return ok(body.model)
    })
    const llm = createLlm('gemini', 'GKEY', { repo, clock, fetchImpl: f.impl })
    expect(llm.name).toBe('gemini')
    const r = await llm.complete({ system: 'S', user: 'U', temperature: 0.2 })
    expect(r).toMatchObject({ text: GOOD, inputTokens: 7, outputTokens: 3, model: 'gemini-2.5-flash', provider: 'gemini' })
    const chat = f.calls.find((c) => c.url === GEMINI_CHAT_URL)!
    expect(chat.init.method).toBe('POST')
    expect(chat.init.headers.Authorization).toBe('Bearer GKEY')
    expect(chat.body).toEqual({
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'U' }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    })
    // lista guardada por 24 h
    await createLlm('gemini', 'GKEY', { repo, clock, fetchImpl: f.impl }).complete({ system: 'S', user: 'U' })
    expect(f.calls.filter((c) => c.url === GEMINI_MODELS_URL)).toHaveLength(1)
  })

  it('pickGeminiFlash: maior versão exata, senão qualquer flash de conversa; nunca lite/imagem/tts/live', () => {
    expect(pickGeminiFlash(['gemini-2.0-flash', 'gemini-3.0-flash', 'gemini-2.5-flash'])).toBe('gemini-3.0-flash')
    expect(pickGeminiFlash(['gemini-10-flash', 'gemini-9.5-flash'])).toBe('gemini-10-flash')
    expect(pickGeminiFlash(['gemini-2.5-flash-lite', 'gemini-2.5-flash-image', 'gemini-2.5-flash-preview-tts', 'gemini-live-2.5-flash', 'gemini-3-flash-preview'])).toBe(
      'gemini-3-flash-preview'
    )
    expect(pickGeminiFlash(['gemini-2.5-pro', 'gemini-2.5-flash-lite'])).toBeNull()
  })

  it('sem lista (rede): usa o padrão; 404 marca o modelo como ruim e escolhe outro', async () => {
    const f = fake((url, body) => {
      if (url === GEMINI_MODELS_URL) {
        const listed = f.calls.filter((c) => c.url === GEMINI_MODELS_URL).length
        return listed === 1 ? json(500, {}) : json(200, { data: [{ id: 'models/gemini-2.5-flash' }, { id: 'models/gemini-2.0-flash' }] })
      }
      if (body.model === DEFAULT_GEMINI_MODEL) return json(404, [{ error: { code: 404, message: 'models/gemini-2.5-flash is not found', status: 'NOT_FOUND' } }])
      return ok(body.model)
    })
    const r = await createLlm('gemini', 'K', { repo, clock, fetchImpl: f.impl }).complete({ system: 'S', user: 'U' })
    expect(r.model).toBe('gemini-2.0-flash')
    expect(f.calls.filter((c) => c.url === GEMINI_CHAT_URL).map((c) => c.body.model)).toEqual(['gemini-2.5-flash', 'gemini-2.0-flash'])
  })

  it('429 com retryDelay no corpo → LlmRateLimitError com a espera; 401/400 de chave → InvalidKeyError', async () => {
    const list = () => json(200, { data: [{ id: 'gemini-2.5-flash' }] })
    let f = fake((url) =>
      url === GEMINI_MODELS_URL
        ? list()
        : json(429, [{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '36s' }] } }])
    )
    const e = await createLlm('gemini', 'K', { repo, clock, fetchImpl: f.impl }).complete({ system: 'S', user: 'U' }).catch((x) => x)
    expect(e).toBeInstanceOf(LlmRateLimitError)
    expect(e.retryAfterMs).toBe(36_000)
    f = fake((url) => (url === GEMINI_MODELS_URL ? list() : json(400, [{ error: { message: 'API key not valid. Please pass a valid API key.' } }])))
    await expect(createLlm('gemini', 'K', { repo, clock, fetchImpl: f.impl }).complete({ system: 'S', user: 'U' })).rejects.toBeInstanceOf(InvalidKeyError)
  })
})

describe('Mistral', () => {
  it('pedido no formato da OpenAI com mistral-small-latest; modelo sumido → open-mistral-nemo', async () => {
    const f = fake((_url, body) =>
      body.model === 'mistral-small-latest' && f.calls.length > 1 ? json(400, { object: 'error', message: 'Invalid model: mistral-small-latest', type: 'invalid_model' }) : ok(body.model)
    )
    const llm = createLlm('mistral', 'MKEY', { repo, clock, fetchImpl: f.impl })
    const r = await llm.complete({ system: 'S', user: 'U' })
    expect(r).toMatchObject({ model: 'mistral-small-latest', provider: 'mistral' })
    expect(f.calls[0].url).toBe(MISTRAL_CHAT_URL)
    expect(f.calls[0].init.headers.Authorization).toBe('Bearer MKEY')
    expect(f.calls[0].body).toMatchObject({ model: 'mistral-small-latest', response_format: { type: 'json_object' }, temperature: 0.7 })
    const r2 = await llm.complete({ system: 'S', user: 'U' })
    expect(r2.model).toBe('open-mistral-nemo')
  })

  it('429 com retry-after → LlmRateLimitError', async () => {
    const f = fake(() => json(429, { message: 'Requests rate limit exceeded' }, { 'retry-after': '5' }))
    const e = await createLlm('mistral', 'K', { fetchImpl: f.impl }).complete({ system: 'S', user: 'U' }).catch((x) => x)
    expect(e).toBeInstanceOf(LlmRateLimitError)
    expect(e.retryAfterMs).toBe(5000)
  })
})

/** IA falsa: `plan` diz o que cada chamada faz (texto, 429 com espera, ou um erro). */
function scripted(name: LlmName, plan: Array<string | number | Error>): LlmProvider & { calls: number } {
  const p = {
    name,
    calls: 0,
    async complete() {
      const step = plan[Math.min(p.calls, plan.length - 1)]
      p.calls++
      if (typeof step === 'number') throw new LlmRateLimitError(step)
      if (step instanceof Error) throw step
      return { text: step, inputTokens: 1000, outputTokens: 1000, model: `${name}-m` }
    }
  }
  return p
}

describe('withFallback', () => {
  const P = { system: 'S', user: 'U' }

  it('principal respondeu: sem reserva, provider = principal', async () => {
    const groq = scripted('groq', [GOOD])
    const gem = scripted('gemini', [GOOD])
    const r = await withFallback(groq, [gem], { repo, clock }).complete(P)
    expect(r.provider).toBe('groq')
    expect(gem.calls).toBe(0)
  })

  it('ordem: Groq no limite → Gemini; Gemini no limite → Mistral; cada um marcado "no limite"', async () => {
    const diag: string[] = []
    const groq = scripted('groq', [60_000])
    const gem = scripted('gemini', [30_000])
    const mis = scripted('mistral', [GOOD])
    const llm = withFallback(groq, [gem, mis], { repo, clock, diag: (k, d) => diag.push(`${k} ${d}`) })
    const r = await llm.complete(P)
    expect(r).toMatchObject({ provider: 'mistral', model: 'mistral-m' })
    expect([groq.calls, gem.calls, mis.calls]).toEqual([1, 1, 1])
    // 429 do Gemini: fora por no mínimo 2 min, guardado no banco (vale para a próxima corrente)
    expect(new ProviderLimits(repo, clock).until('gemini')).toBe(T0 + MIN_LIMITED_MS)
    const again = withFallback(scripted('groq', [60_000]), [gem, mis], { repo, clock })
    await again.complete(P)
    expect(gem.calls).toBe(1)
    expect(mis.calls).toBe(2)
    // passou o tempo: o Gemini volta
    clock.advance(MIN_LIMITED_MS)
    gem.calls = 0
    const g2 = scripted('gemini', [GOOD])
    expect((await withFallback(scripted('groq', [60_000]), [g2, mis], { repo, clock }).complete(P)).provider).toBe('gemini')
    expect(diag.join('\n')).not.toMatch(/\bU\b|\bS\b/)
  })

  it('todas no limite: LlmRateLimitError com a espera até o primeiro que volta', async () => {
    const llm = withFallback(scripted('groq', [600_000]), [scripted('gemini', [200_000]), scripted('mistral', [10_000])], { repo, clock })
    const e = await llm.complete(P).catch((x) => x)
    expect(e).toBeInstanceOf(LlmRateLimitError)
    expect(e.retryAfterMs).toBe(MIN_LIMITED_MS)
  })

  it('sem reservas: a própria principal (comportamento antigo)', () => {
    const groq = scripted('groq', [GOOD])
    expect(withFallback(groq, [], { repo, clock })).toBe(groq)
  })

  it('erro que não é limite na principal sobe sem tocar nas reservas', async () => {
    const gem = scripted('gemini', [GOOD])
    await expect(withFallback(scripted('groq', [new InvalidKeyError()]), [gem], { repo, clock }).complete(P)).rejects.toBeInstanceOf(InvalidKeyError)
    expect(gem.calls).toBe(0)
  })

  it('chave da reserva recusada ou rede fora: passa para a próxima; saída inválida sobe', async () => {
    const mis = scripted('mistral', [GOOD])
    const r = await withFallback(scripted('groq', [1]), [scripted('gemini', [new InvalidKeyError()]), mis], { repo, clock }).complete(P)
    expect(r.provider).toBe('mistral')
    expect(new ProviderLimits(repo, clock).until('gemini')).not.toBeNull()
    const r2 = await withFallback(scripted('groq', [1]), [scripted('mistral', [new TypeError('fetch failed')])], { repo: undefined, clock }).complete(P).catch((x) => x)
    expect(r2).toBeInstanceOf(LlmRateLimitError)
    await expect(
      withFallback(scripted('groq', [1]), [scripted('gemini', [new InvalidOutputError('x')])], { clock }).complete(P)
    ).rejects.toBeInstanceOf(InvalidOutputError)
  })

  it('generateAnalysis grava quem respondeu (gemini) e não cobra nada', async () => {
    const JID = '5547999990001@s.whatsapp.net'
    repo.upsertContact({ jid: JID })
    repo.insertMessage({ id: 'm1', jid: JID, fromMe: false, ts: T0, kind: 'text', text: 'oi', mediaKeyJson: null, durationSec: null })
    const cost = new CostTracker(repo, clock)
    const llm = withFallback(scripted('claude', [60_000]), [scripted('gemini', [GOOD])], { repo, clock })
    const a = await generateAnalysis({ repo, llm, limiter: new RateLimiter(LIMITS.llm, clock, () => 0), cost, capUsd: 1, clock, sleep: async () => {} }, JID)
    expect(a.provider).toBe('gemini')
    expect(cost.todayUsd()).toBe(0)
  })
})

describe('Groq com todos os modelos no limite', () => {
  it('vira LlmRateLimitError (não "modelo aposentado"), sem chamar o chat', async () => {
    const f = fake((url) => (url.endsWith('/models') ? json(200, { data: [{ id: 'llama-3.1-8b-instant', active: true }] }) : json(429, {}, { 'retry-after': '600' })))
    const groq = createLlm('groq', 'K', { repo, clock, fetchImpl: f.impl })
    await expect(groq.complete({ system: 'S', user: 'U' })).rejects.toBeInstanceOf(LlmRateLimitError)
    const chats = f.calls.filter((c) => c.url.endsWith('/chat/completions')).length
    const e = await groq.complete({ system: 'S', user: 'U' }).catch((x) => x)
    expect(e).toBeInstanceOf(LlmRateLimitError)
    expect(e.retryAfterMs).toBe(600_000)
    expect(f.calls.filter((c) => c.url.endsWith('/chat/completions')).length).toBe(chats)
  })
})

describe('testKey das reservas', () => {
  it('Gemini e Mistral: lista de modelos com Bearer', async () => {
    const f = fake(() => json(200, { data: [] }))
    expect(await testKey('gemini', ' G ', { fetchImpl: f.impl })).toBe(true)
    expect(await testKey('mistral', 'M', { fetchImpl: f.impl })).toBe(true)
    expect(f.calls.map((c) => [c.url, c.init.headers.Authorization])).toEqual([
      [GEMINI_MODELS_URL, 'Bearer G'],
      ['https://api.mistral.ai/v1/models', 'Bearer M']
    ])
  })
})
