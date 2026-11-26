import { systemClock, type Clock } from '../clock'
import type { Repo } from '../db/repo'

/**
 * Escolha do modelo da Groq na hora do uso. A Groq aposenta modelos sem aviso (o
 * `llama-3.3-70b-versatile` passou a responder 404), então o app pergunta à própria Groq quais modelos
 * a chave pode usar (`GET /models`, guardado por 24 h) e pega o primeiro da lista de preferência.
 * Um 404 (modelo não encontrado/aposentado) marca o modelo como ruim, refaz a escolha e tenta mais uma vez.
 */

export const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models'

export const GROQ_CHAT_PREFERENCE = [
  'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'qwen/qwen3-32b',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant'
] as const

export const GROQ_TRANSCRIBE_PREFERENCE = ['whisper-large-v3-turbo', 'whisper-large-v3'] as const

export type GroqModelKind = 'chat' | 'transcribe'

const CACHE_KEY = 'groq.models.cache'
const BAD_KEY = 'groq.models.bad'
/** Modelos que responderam 429 (limite por modelo, ex.: cota diária do plano gratuito) → até quando ficam de fora. */
const LIMITED_KEY = 'groq.models.limited'
/** Um 429 tira o modelo da escolha por pelo menos isto (a Groq às vezes não manda retry-after). */
const MIN_LIMITED_MS = 2 * 60_000
/** Quantos modelos tentar num mesmo pedido quando o anterior está no limite. */
const MAX_RATE_LIMIT_HOPS = 3
const CHOSEN_KEY = (k: GroqModelKind) => `groq.models.chosen.${k}`
const CACHE_MS = 24 * 3_600_000
const LIST_TIMEOUT_MS = 15_000

/** 401: chave recusada pelo provedor. */
export class InvalidKeyError extends Error {
  constructor() {
    super('chave de API recusada pelo provedor de transcrição (401)')
    this.name = 'InvalidKeyError'
  }
}

/** O provedor respondeu que o modelo não existe (404) ou foi aposentado. */
export class ModelNotFoundError extends Error {
  constructor(readonly model: string) {
    super(`modelo não encontrado ou aposentado: ${model}`)
    this.name = 'ModelNotFoundError'
  }
}

/** Nenhum modelo da Groq serve para este uso agora. */
export class ModelUnavailableError extends Error {
  constructor(readonly kind: GroqModelKind) {
    super(kind === 'chat' ? 'nenhum modelo de IA da Groq disponível' : 'nenhum modelo de transcrição da Groq disponível')
    this.name = 'ModelUnavailableError'
  }
}

/** 404, ou 400 com código de modelo aposentado/inexistente: o modelo não serve mais. */
export async function isModelGone(res: Response): Promise<boolean> {
  if (res.status === 404) return true
  if (res.status !== 400) return false
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: { code?: string } } | null
  const code = body?.error?.code ?? ''
  return code === 'model_not_found' || code === 'model_decommissioned'
}

/** Ids que não são modelos de conversa. */
const NOT_CHAT = /whisper|tts|guard|orpheus|playai|distil/i

export interface GroqModelsOpts {
  apiKey: string
  fetchImpl?: typeof fetch
  /** cache (24 h) da lista e dos modelos ruins em `settings_kv`; sem `repo`, só na memória */
  repo?: Repo
  clock?: Clock
  diag?: (kind: string, detail: string) => void
}

export class GroqModels {
  private readonly fetchImpl: typeof fetch
  private readonly clock: Clock
  private memCache: { at: number; ids: string[] } | null = null
  private memBad: Record<string, number> = {}
  private memLimited: Record<string, number> = {}

  constructor(private readonly opts: GroqModelsOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.clock = opts.clock ?? systemClock
  }

  private diag(kind: string, detail: string): void {
    try {
      this.opts.diag?.(kind, detail)
    } catch {
      // registrar nunca quebra a IA
    }
  }

  private readJson<T>(key: string): T | null {
    try {
      const raw = this.opts.repo?.getSetting(key)
      return raw ? (JSON.parse(raw) as T) : null
    } catch {
      return null
    }
  }

  private writeJson(key: string, v: unknown): void {
    this.opts.repo?.setSetting(key, JSON.stringify(v))
  }

  private badSet(): Set<string> {
    const now = this.clock.now()
    const all = { ...(this.readJson<Record<string, number>>(BAD_KEY) ?? {}), ...this.memBad }
    return new Set(Object.entries(all).filter(([, at]) => now - at < CACHE_MS).map(([id]) => id))
  }

  /** Modelos ainda no limite (429), com o instante em que voltam. */
  private limitedMap(): Record<string, number> {
    const now = this.clock.now()
    const all = { ...(this.readJson<Record<string, number>>(LIMITED_KEY) ?? {}), ...this.memLimited }
    return Object.fromEntries(Object.entries(all).filter(([, until]) => typeof until === 'number' && until > now))
  }

  /** O modelo respondeu 429: fica de fora até `retryAfterMs` (mínimo 2 min). Os outros modelos têm cota própria. */
  markLimited(model: string, retryAfterMs: number): void {
    const until = this.clock.now() + Math.max(retryAfterMs, MIN_LIMITED_MS)
    this.memLimited[model] = until
    const stored = this.limitedMap()
    stored[model] = until
    this.writeJson(LIMITED_KEY, stored)
  }

  /** O modelo respondeu 404: fica de fora por 24 h e a lista é buscada de novo. */
  markBad(model: string): void {
    const now = this.clock.now()
    this.memBad[model] = now
    const stored = this.readJson<Record<string, number>>(BAD_KEY) ?? {}
    stored[model] = now
    this.writeJson(BAD_KEY, stored)
    this.invalidate()
  }

  invalidate(): void {
    this.memCache = null
    this.opts.repo?.deleteSetting(CACHE_KEY)
  }

  /** Ids ativos que a chave pode usar (cache de 24 h); `null` se a lista não pôde ser lida. 401 lança. */
  async listModels(signal?: AbortSignal): Promise<string[] | null> {
    const now = this.clock.now()
    const cached = this.memCache ?? this.readJson<{ at: number; ids: string[] }>(CACHE_KEY)
    if (cached && Array.isArray(cached.ids) && now - cached.at >= 0 && now - cached.at < CACHE_MS) return cached.ids
    let res: Response
    try {
      const t = AbortSignal.timeout(LIST_TIMEOUT_MS)
      res = await this.fetchImpl(GROQ_MODELS_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        signal: signal ? AbortSignal.any([t, signal]) : t
      })
    } catch (e) {
      this.diag('groq_models_error', `lista de modelos indisponível: ${e instanceof Error ? e.name : 'erro'}`)
      return null
    }
    if (res.status === 401) throw new InvalidKeyError()
    if (!res.ok) {
      this.diag('groq_models_error', `lista de modelos indisponível: HTTP ${res.status}`)
      return null
    }
    const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown; active?: unknown }> } | null
    if (!body || !Array.isArray(body.data)) {
      this.diag('groq_models_error', 'lista de modelos indisponível: resposta inesperada')
      return null
    }
    const ids = body.data
      .filter((m) => m && typeof m.id === 'string' && m.active !== false)
      .map((m) => m.id as string)
    const entry = { at: now, ids }
    this.memCache = entry
    this.writeJson(CACHE_KEY, entry)
    this.diag('groq_models', `${ids.length} modelos ativos`)
    return ids
  }

  /**
   * Modelo a usar: o configurado (se não deu 404), senão o primeiro da preferência que a Groq lista,
   * senão o primeiro da lista que serve para o uso. Sem lista (rede), o primeiro da preferência.
   */
  async pick(kind: GroqModelKind, explicit?: string | null, signal?: AbortSignal): Promise<string> {
    const bad = this.badSet()
    for (const id of Object.keys(this.limitedMap())) bad.add(id)
    let model: string | undefined
    let source = 'configurado'
    if (explicit && !bad.has(explicit)) model = explicit
    if (!model) {
      const prefs: readonly string[] = kind === 'chat' ? GROQ_CHAT_PREFERENCE : GROQ_TRANSCRIBE_PREFERENCE
      const ids = await this.listModels(signal)
      if (ids) {
        const avail = ids.filter((id) => !bad.has(id))
        const set = new Set(avail)
        model = prefs.find((p) => set.has(p))
        source = 'preferência'
        if (!model) {
          model = avail.find((id) => (kind === 'chat' ? !NOT_CHAT.test(id) : /whisper/i.test(id)))
          source = 'lista da Groq'
        }
      } else {
        model = prefs.find((p) => !bad.has(p))
        source = 'padrão (sem lista)'
      }
    }
    if (!model) {
      this.diag('groq_model', `${kind}: nenhum modelo disponível`)
      throw new ModelUnavailableError(kind)
    }
    const prev = this.readJson<string>(CHOSEN_KEY(kind))
    if (prev !== model || !this.opts.repo) {
      this.diag('groq_model', `${kind}: ${model} (${source})`)
      this.writeJson(CHOSEN_KEY(kind), model)
    }
    return model
  }

  /**
   * Roda `run` com o modelo escolhido; se ele lançar `ModelNotFoundError`, marca o modelo como ruim,
   * escolhe de novo e tenta mais uma vez. Sem outro modelo (ou 404 de novo): `ModelUnavailableError`.
   */
  async withModel<T>(
    kind: GroqModelKind,
    explicit: string | null | undefined,
    run: (model: string) => Promise<T>,
    signal?: AbortSignal,
    /** devolve o tempo de espera pedido se o erro for 429 (limite do modelo); senão null */
    rateLimitOf?: (e: unknown) => number | null
  ): Promise<T> {
    let goneOnce = false
    let lastLimit: unknown = null
    const tried = new Set<string>()
    for (let attempt = 0; attempt < MAX_RATE_LIMIT_HOPS + 2; attempt++) {
      let model: string
      try {
        model = await this.pick(kind, explicit, signal)
      } catch (e) {
        // todos no limite: devolve o 429 original (a fila espera e tenta de novo)
        if (lastLimit && e instanceof ModelUnavailableError) throw lastLimit
        throw e
      }
      if (tried.has(model)) {
        if (lastLimit) throw lastLimit
        throw new ModelUnavailableError(kind)
      }
      tried.add(model)
      try {
        return await run(model)
      } catch (e) {
        const wait = rateLimitOf ? rateLimitOf(e) : null
        if (wait !== null) {
          lastLimit = e
          this.markLimited(model, wait)
          if (tried.size >= MAX_RATE_LIMIT_HOPS) throw e
          this.diag('groq_model_limited', `${kind}: ${model} no limite (429) por ${Math.ceil(Math.max(wait, MIN_LIMITED_MS) / 60_000)} min; tentando outro`)
          continue
        }
        if (!(e instanceof ModelNotFoundError)) throw e
        this.diag('groq_model_gone', `${kind}: ${model} respondeu 404; escolhendo outro`)
        this.markBad(model)
        if (goneOnce) throw new ModelUnavailableError(kind)
        goneOnce = true
      }
    }
    if (lastLimit) throw lastLimit
    throw new ModelUnavailableError(kind)
  }
}

/** Esquece a lista e os modelos ruins (chave ou modelo configurado mudou). */
export function resetGroqModelCache(repo: Repo): void {
  repo.deleteSetting(CACHE_KEY)
  repo.deleteSetting(BAD_KEY)
  repo.deleteSetting(LIMITED_KEY)
}
