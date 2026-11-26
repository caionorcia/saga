import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { GroqModels, ModelUnavailableError, resetGroqModelCache } from '../../../src/core/ai/groqModels'
import { InvalidKeyError, createTranscriber } from '../../../src/core/ai/transcriber'
import { createLlm, SETTING_GROQ_MODEL } from '../../../src/core/ai/llm'

const T0 = 1_700_000_000_000
const MODELS = 'https://api.groq.com/openai/v1/models'
const CHAT = 'https://api.groq.com/openai/v1/chat/completions'
const AUDIO = 'https://api.groq.com/openai/v1/audio/transcriptions'
const GOOD = JSON.stringify({ resumo: 'r', sugestoes: ['a', 'b'] })

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Groq falsa: lista `ids` (com `active`), e os modelos em `gone` respondem 404. */
function fakeGroq(o: { ids: Array<string | { id: string; active: boolean }>; gone?: string[]; listStatus?: number; listThrows?: boolean }) {
  const calls: Array<{ url: string; model?: string }> = []
  const impl = (async (url: any, init: any) => {
    const u = String(url)
    if (u === MODELS) {
      calls.push({ url: u })
      if (o.listThrows) throw new TypeError('fetch failed')
      if (o.listStatus) return json(o.listStatus, {})
      return json(200, { object: 'list', data: o.ids.map((x) => (typeof x === 'string' ? { id: x, active: true } : x)) })
    }
    const model = u === CHAT ? JSON.parse(init.body).model : (init.body as FormData).get('model')
    calls.push({ url: u, model })
    if (o.gone?.includes(model)) {
      return json(404, { error: { message: `The model \`${model}\` does not exist`, type: 'invalid_request_error', code: 'model_not_found' } })
    }
    if (u === CHAT) return json(200, { choices: [{ message: { content: GOOD } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    return new Response('texto', { status: 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('GroqModels', () => {
  let clock: FakeClock
  let repo: Repo
  let diag: string[]
  beforeEach(() => {
    clock = new FakeClock(T0)
    repo = new Repo(openDb(':memory:'), clock)
    diag = []
  })
  const mk = (f: typeof fetch) => new GroqModels({ apiKey: 'K', fetchImpl: f, repo, clock, diag: (k, d) => diag.push(`${k} ${d}`) })

  it('escolhe o primeiro da preferência que a Groq lista (pulando os inativos)', async () => {
    const g = fakeGroq({ ids: [{ id: 'openai/gpt-oss-120b', active: false }, 'qwen/qwen3-32b', 'llama-3.1-8b-instant', 'whisper-large-v3'] })
    expect(await mk(g.impl).pick('chat')).toBe('qwen/qwen3-32b')
    expect(await mk(g.impl).pick('transcribe')).toBe('whisper-large-v3')
    expect(diag).toContain('groq_model chat: qwen/qwen3-32b (preferência)')
  })

  it('nenhum da preferência: o primeiro modelo de conversa (nunca whisper/tts/guard)', async () => {
    const g = fakeGroq({ ids: ['whisper-large-v3', 'playai-tts', 'meta-llama/llama-guard-4-12b', 'novo/modelo-x'] })
    expect(await mk(g.impl).pick('chat')).toBe('novo/modelo-x')
  })

  it('lista guardada por 24 h em settings_kv', async () => {
    const g = fakeGroq({ ids: ['llama-3.1-8b-instant'] })
    await mk(g.impl).pick('chat')
    await mk(g.impl).pick('chat')
    expect(g.calls.filter((c) => c.url === MODELS)).toHaveLength(1)
    clock.advance(24 * 3_600_000)
    await mk(g.impl).pick('chat')
    expect(g.calls.filter((c) => c.url === MODELS)).toHaveLength(2)
  })

  it('modelo configurado é respeitado, mesmo fora da lista', async () => {
    const g = fakeGroq({ ids: ['llama-3.1-8b-instant'] })
    expect(await mk(g.impl).pick('chat', 'meu/modelo')).toBe('meu/modelo')
    expect(g.calls).toHaveLength(0)
  })

  it('sem lista (rede): o primeiro da preferência; 401 na lista: InvalidKeyError', async () => {
    expect(await mk(fakeGroq({ ids: [], listThrows: true }).impl).pick('chat')).toBe('openai/gpt-oss-120b')
    await expect(mk(fakeGroq({ ids: [], listStatus: 401 }).impl).pick('chat')).rejects.toBeInstanceOf(InvalidKeyError)
  })

  it('lista vazia: ModelUnavailableError', async () => {
    await expect(mk(fakeGroq({ ids: [] }).impl).pick('chat')).rejects.toBeInstanceOf(ModelUnavailableError)
  })

  it('resetGroqModelCache esquece a lista e os modelos ruins', async () => {
    const g = fakeGroq({ ids: ['qwen/qwen3-32b'] })
    const m = mk(g.impl)
    m.markBad('meu/modelo')
    await m.pick('chat')
    resetGroqModelCache(repo)
    expect(await mk(g.impl).pick('chat', 'meu/modelo')).toBe('meu/modelo')
  })
})

describe('createLlm groq: modelo aposentado', () => {
  let clock: FakeClock
  let repo: Repo
  beforeEach(() => {
    clock = new FakeClock(T0)
    repo = new Repo(openDb(':memory:'), clock)
  })

  it('404 do modelo escolhido: invalida a lista, escolhe outro e tenta de novo uma vez', async () => {
    const g = fakeGroq({ ids: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'], gone: ['openai/gpt-oss-120b'] })
    const r = await createLlm('groq', 'K', { fetchImpl: g.impl, repo, clock }).complete({ system: 's', user: 'u' })
    expect(r.model).toBe('llama-3.3-70b-versatile')
    expect(g.calls.map((c) => c.model ?? 'lista')).toEqual(['lista', 'openai/gpt-oss-120b', 'lista', 'llama-3.3-70b-versatile'])
    // próxima análise: o modelo ruim fica de fora (sem 404 de novo)
    g.calls.length = 0
    await createLlm('groq', 'K', { fetchImpl: g.impl, repo, clock }).complete({ system: 's', user: 'u' })
    expect(g.calls.map((c) => c.model ?? 'lista')).toEqual(['llama-3.3-70b-versatile'])
  })

  it('modelo configurado que dá 404: cai para a escolha automática', async () => {
    repo.setSetting(SETTING_GROQ_MODEL, 'llama-3.3-70b-versatile')
    const g = fakeGroq({ ids: ['qwen/qwen3-32b'], gone: ['llama-3.3-70b-versatile'] })
    const r = await createLlm('groq', 'K', { fetchImpl: g.impl, repo, clock }).complete({ system: 's', user: 'u' })
    expect(r.model).toBe('qwen/qwen3-32b')
  })

  it('400 model_decommissioned também troca de modelo', async () => {
    let n = 0
    const f = (async (url: any, init: any) => {
      if (String(url) === MODELS) return json(200, { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'qwen/qwen3-32b' }] })
      n++
      if (JSON.parse(init.body).model === 'openai/gpt-oss-120b') return json(400, { error: { code: 'model_decommissioned' } })
      return json(200, { choices: [{ message: { content: GOOD } }] })
    }) as unknown as typeof fetch
    const r = await createLlm('groq', 'K', { fetchImpl: f, repo, clock }).complete({ system: 's', user: 'u' })
    expect(r.model).toBe('qwen/qwen3-32b')
    expect(n).toBe(2)
  })

  it('nenhum modelo funciona: ModelUnavailableError (no máximo 2 tentativas)', async () => {
    const g = fakeGroq({ ids: ['openai/gpt-oss-120b', 'qwen/qwen3-32b', 'llama-3.1-8b-instant'], gone: ['openai/gpt-oss-120b', 'qwen/qwen3-32b'] })
    await expect(createLlm('groq', 'K', { fetchImpl: g.impl, repo, clock }).complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(
      ModelUnavailableError
    )
    expect(g.calls.filter((c) => c.url === CHAT)).toHaveLength(2)
  })
})

describe('createTranscriber groq: escolha do modelo', () => {
  let tmp: string
  let file: string
  let repo: Repo
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'saga-gm-'))
    file = join(tmp, 'a.ogg')
    writeFileSync(file, Buffer.from([1]))
    repo = new Repo(openDb(':memory:'), new FakeClock(T0))
    return () => rmSync(tmp, { recursive: true, force: true })
  })

  it('prefere whisper-large-v3-turbo; 404 cai para whisper-large-v3', async () => {
    const g = fakeGroq({ ids: ['whisper-large-v3', 'whisper-large-v3-turbo'], gone: ['whisper-large-v3-turbo'] })
    expect(await createTranscriber('groq', 'K', g.impl, { repo }).transcribe(file, 3)).toBe('texto')
    expect(g.calls.filter((c) => c.url === AUDIO).map((c) => c.model)).toEqual(['whisper-large-v3-turbo', 'whisper-large-v3'])
  })

  it('sem nenhum whisper: ModelUnavailableError', async () => {
    const g = fakeGroq({ ids: ['qwen/qwen3-32b'] })
    await expect(createTranscriber('groq', 'K', g.impl, { repo }).transcribe(file, 3)).rejects.toBeInstanceOf(ModelUnavailableError)
  })

  it('o sinal da fila cancela o pedido', async () => {
    const ctrl = new AbortController()
    let seen: AbortSignal | undefined
    const f = (async (url: any, init: any) => {
      if (String(url) === MODELS) return json(200, { data: [{ id: 'whisper-large-v3' }] })
      seen = init.signal
      ctrl.abort()
      return new Response('x', { status: 200 })
    }) as unknown as typeof fetch
    await createTranscriber('groq', 'K', f, { repo }).transcribe(file, 3, ctrl.signal)
    expect(seen?.aborted).toBe(true)
  })
})

describe('GroqModels: limite (429) troca de modelo', () => {
  let clock: FakeClock
  let repo: Repo
  beforeEach(() => {
    clock = new FakeClock(T0)
    repo = new Repo(openDb(':memory:'), clock)
  })
  const IDS = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'qwen/qwen3-32b', 'openai/gpt-oss-20b']
  /** Groq falsa em que os modelos de `limited` respondem 429 (retry-after em segundos). */
  function limitedGroq(limited: string[], retryAfter = '3600') {
    const calls: string[] = []
    const impl = (async (url: any, init: any) => {
      const u = String(url)
      if (u === MODELS) return json(200, { object: 'list', data: IDS.map((id) => ({ id, active: true })) })
      const model = JSON.parse(init.body).model
      calls.push(model)
      if (limited.includes(model)) return new Response('{}', { status: 429, headers: { 'retry-after': retryAfter } })
      return json(200, { choices: [{ message: { content: GOOD } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  it('429 no modelo preferido: usa o próximo na mesma chamada e lembra o limite', async () => {
    const g = limitedGroq(['openai/gpt-oss-120b'])
    const llm = createLlm('groq', 'K', { fetchImpl: g.impl, repo, clock })
    const r = await llm.complete({ system: 's', user: 'u' })
    expect(r.model).toBe('llama-3.3-70b-versatile')
    expect(g.calls).toEqual(['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'])
    // próxima chamada (outra instância, mesmo banco): já vai direto ao modelo livre
    const g2 = limitedGroq(['openai/gpt-oss-120b'])
    await createLlm('groq', 'K', { fetchImpl: g2.impl, repo, clock }).complete({ system: 's', user: 'u' })
    expect(g2.calls).toEqual(['llama-3.3-70b-versatile'])
  })

  it('o modelo preferido volta depois do tempo pedido', async () => {
    const g = limitedGroq(['openai/gpt-oss-120b'], '600')
    await createLlm('groq', 'K', { fetchImpl: g.impl, repo, clock }).complete({ system: 's', user: 'u' })
    clock.advance(11 * 60_000)
    const g2 = limitedGroq([])
    const r = await createLlm('groq', 'K', { fetchImpl: g2.impl, repo, clock }).complete({ system: 's', user: 'u' })
    expect(r.model).toBe('openai/gpt-oss-120b')
  })

  it('no máximo 3 modelos por chamada; todos no limite: devolve o 429 (a fila espera)', async () => {
    const g = limitedGroq(IDS)
    const llm = createLlm('groq', 'K', { fetchImpl: g.impl, repo, clock })
    await expect(llm.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ name: 'LlmRateLimitError' })
    expect(g.calls.length).toBe(3)
  })
})
