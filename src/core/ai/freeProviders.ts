/**
 * IAs gratuitas de reserva (v0.6.2): Google Gemini (plano gratuito do Google AI Studio) e Mistral (plano gratuito
 * "Experiment"). As duas falam o formato de chat da OpenAI (`/chat/completions`, chave em `Authorization: Bearer`).
 * Só entram quando a IA principal está no limite (ver `fallback.ts`). Nunca registram a chave nem o texto.
 */
import { systemClock, type Clock } from '../clock'
import type { Repo } from '../db/repo'
import { InvalidKeyError, ModelNotFoundError, ModelUnavailableError } from './groqModels'
import { LlmRateLimitError, retryAfterMs, type CreateLlmOpts, type LlmProvider, type LlmResult } from './llm'
import { InvalidOutputError } from './prompt'

export const GEMINI_CHAT_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
export const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/models'
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'

export const MISTRAL_CHAT_URL = 'https://api.mistral.ai/v1/chat/completions'
export const MISTRAL_MODELS_URL = 'https://api.mistral.ai/v1/models'
export const DEFAULT_MISTRAL_MODEL = 'mistral-small-latest'
/** Se o modelo principal da Mistral sumir (404 / "invalid model"), tenta este. */
export const MISTRAL_BACKUP_MODEL = 'open-mistral-nemo'
/** Opcional (sem tela): troca o modelo da Mistral. */
export const SETTING_MISTRAL_MODEL = 'llm.mistral.model'

const CALL_TIMEOUT_MS = 60_000
const LIST_TIMEOUT_MS = 15_000
const CACHE_MS = 24 * 3_600_000
const GEMINI_CACHE_KEY = 'gemini.models.cache'
const GEMINI_BAD_KEY = 'gemini.models.bad'

type Label = 'gemini' | 'mistral'

/** Tempo de espera de um 429: cabeçalho `retry-after` ou, no Gemini, `"retryDelay": "36s"` no corpo. */
function retryOf(res: Response, bodyText: string): number {
  if (res.headers.get('retry-after') != null) return retryAfterMs(res.headers.get('retry-after'))
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(bodyText)
  return m ? Math.ceil(Number(m[1]) * 1000) : retryAfterMs(null)
}

/** O corpo do erro diz que o modelo não existe (cada provedor escreve de um jeito). */
const MODEL_GONE = /model[_ ]not[_ ]found|invalid[_ ]model|model .*(not found|does not exist|is not supported)|unknown model|decommissioned/i
/** O corpo do erro diz que a chave é inválida (o Gemini responde 400 "API key not valid"). */
const BAD_KEY = /api[_ ]key[_ ]invalid|api key not valid|invalid api key/i

/** Um pedido de chat no formato da OpenAI. */
async function compatCall(
  label: Label,
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  model: string,
  p: { system: string; user: string; temperature?: number }
): Promise<LlmResult> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: p.system },
        { role: 'user', content: p.user }
      ],
      response_format: { type: 'json_object' },
      temperature: p.temperature ?? 0.7
    }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403 || (res.status === 400 && BAD_KEY.test(text))) throw new InvalidKeyError()
    if (res.status === 429) throw new LlmRateLimitError(retryOf(res, text))
    if (res.status === 404 || ((res.status === 400 || res.status === 422) && MODEL_GONE.test(text))) throw new ModelNotFoundError(model)
    throw new Error(`pedido à IA falhou: HTTP ${res.status} (${label})`)
  }
  const j = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: unknown } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  } | null
  const content = j?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new InvalidOutputError(`${label}: resposta vazia`)
  return {
    text: content,
    inputTokens: j?.usage?.prompt_tokens ?? 0,
    outputTokens: j?.usage?.completion_tokens ?? 0,
    model,
    provider: label
  }
}

/** Versão numérica de um id "gemini-2.5-flash" → [2, 5]. */
function versionOf(id: string): number[] {
  const m = /^gemini-([0-9.]+)-/.exec(id)
  return m ? m[1].split('.').map((x) => Number(x) || 0) : []
}

function cmpVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d
  }
  return 0
}

const NOT_FLASH_CHAT = /lite|image|tts|live|audio|embed|vision|thinking-exp/i

/**
 * Escolhe o Flash mais novo da lista: primeiro o "gemini-X.Y-flash" exato de maior versão, depois qualquer
 * "flash" de conversa (sem lite/imagem/voz/live). Nada disso: `null`.
 */
export function pickGeminiFlash(ids: string[]): string | null {
  const byVersion = (a: string, b: string) => cmpVersion(versionOf(b), versionOf(a))
  const exact = ids.filter((id) => /^gemini-[0-9.]+-flash$/.test(id)).sort(byVersion)
  if (exact[0]) return exact[0]
  const any = ids.filter((id) => /flash/i.test(id) && !NOT_FLASH_CHAT.test(id)).sort(byVersion)
  return any[0] ?? null
}

/** Modelos do Gemini que a chave pode usar (lista guardada por 24 h); um 404 tira o modelo da escolha por 24 h. */
export class GeminiModels {
  private readonly fetchImpl: typeof fetch
  private readonly clock: Clock
  private memCache: { at: number; ids: string[] } | null = null
  private memBad: Record<string, number> = {}

  constructor(private readonly opts: { apiKey: string; fetchImpl?: typeof fetch; repo?: Repo; clock?: Clock; diag?: (k: string, d: string) => void }) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.clock = opts.clock ?? systemClock
  }

  private readJson<T>(key: string): T | null {
    try {
      const raw = this.opts.repo?.getSetting(key)
      return raw ? (JSON.parse(raw) as T) : null
    } catch {
      return null
    }
  }

  private bad(): Set<string> {
    const now = this.clock.now()
    const all = { ...(this.readJson<Record<string, number>>(GEMINI_BAD_KEY) ?? {}), ...this.memBad }
    return new Set(Object.entries(all).filter(([, at]) => now - at < CACHE_MS).map(([id]) => id))
  }

  markBad(model: string): void {
    const now = this.clock.now()
    this.memBad[model] = now
    const stored = this.readJson<Record<string, number>>(GEMINI_BAD_KEY) ?? {}
    stored[model] = now
    this.opts.repo?.setSetting(GEMINI_BAD_KEY, JSON.stringify(stored))
    this.memCache = null
    this.opts.repo?.deleteSetting(GEMINI_CACHE_KEY)
  }

  /** Ids (sem o prefixo "models/"); `null` se a lista não pôde ser lida. 401/403 lança `InvalidKeyError`. */
  async listModels(): Promise<string[] | null> {
    const now = this.clock.now()
    const cached = this.memCache ?? this.readJson<{ at: number; ids: string[] }>(GEMINI_CACHE_KEY)
    if (cached && Array.isArray(cached.ids) && now - cached.at >= 0 && now - cached.at < CACHE_MS) return cached.ids
    let res: Response
    try {
      res = await this.fetchImpl(GEMINI_MODELS_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS)
      })
    } catch (e) {
      this.opts.diag?.('gemini_models_error', `lista de modelos indisponível: ${e instanceof Error ? e.name : 'erro'}`)
      return null
    }
    if (res.status === 401 || res.status === 403) throw new InvalidKeyError()
    if (!res.ok) {
      this.opts.diag?.('gemini_models_error', `lista de modelos indisponível: HTTP ${res.status}`)
      return null
    }
    const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null
    if (!body || !Array.isArray(body.data)) return null
    const ids = body.data
      .map((m) => (m && typeof m.id === 'string' ? m.id.replace(/^models\//, '') : null))
      .filter((id): id is string => !!id)
    const entry = { at: now, ids }
    this.memCache = entry
    this.opts.repo?.setSetting(GEMINI_CACHE_KEY, JSON.stringify(entry))
    return ids
  }

  /** O Flash mais novo que a chave lista (fora os que deram 404); sem lista, o padrão. */
  async pick(): Promise<string> {
    const bad = this.bad()
    const ids = await this.listModels()
    const model = ids ? pickGeminiFlash(ids.filter((id) => !bad.has(id))) : bad.has(DEFAULT_GEMINI_MODEL) ? null : DEFAULT_GEMINI_MODEL
    if (!model) throw new ModelUnavailableError('chat')
    return model
  }
}

/** Esquece a lista e os modelos ruins do Gemini (chave mudou). */
export function resetGeminiModelCache(repo: Repo): void {
  repo.deleteSetting(GEMINI_CACHE_KEY)
  repo.deleteSetting(GEMINI_BAD_KEY)
}

export function createGeminiLlm(apiKey: string, opts: CreateLlmOpts = {}): LlmProvider {
  const fetchImpl = opts.fetchImpl ?? fetch
  const models = new GeminiModels({ apiKey, fetchImpl, repo: opts.repo, clock: opts.clock, diag: opts.diag })
  return {
    name: 'gemini',
    async complete(p) {
      // 404: o modelo saiu; marca, escolhe outro e tenta mais uma vez
      for (let attempt = 0; ; attempt++) {
        const model = opts.model ?? (await models.pick())
        try {
          return await compatCall('gemini', fetchImpl, GEMINI_CHAT_URL, apiKey, model, p)
        } catch (e) {
          if (!(e instanceof ModelNotFoundError) || opts.model || attempt >= 1) throw e
          opts.diag?.('gemini_model_gone', `${model} respondeu 404; escolhendo outro`)
          models.markBad(model)
        }
      }
    }
  }
}

export function createMistralLlm(apiKey: string, opts: CreateLlmOpts = {}): LlmProvider {
  const fetchImpl = opts.fetchImpl ?? fetch
  return {
    name: 'mistral',
    async complete(p) {
      const main = opts.model ?? opts.repo?.getSetting(SETTING_MISTRAL_MODEL) ?? DEFAULT_MISTRAL_MODEL
      try {
        return await compatCall('mistral', fetchImpl, MISTRAL_CHAT_URL, apiKey, main, p)
      } catch (e) {
        if (!(e instanceof ModelNotFoundError) || main === MISTRAL_BACKUP_MODEL) throw e
        opts.diag?.('mistral_model_gone', `${main} não encontrado; usando ${MISTRAL_BACKUP_MODEL}`)
        return compatCall('mistral', fetchImpl, MISTRAL_CHAT_URL, apiKey, MISTRAL_BACKUP_MODEL, p)
      }
    }
  }
}
