import Anthropic from '@anthropic-ai/sdk'
import type { Clock } from '../clock'
import type { AnalysisRow, MessageRow, Repo } from '../db/repo'
import { selectExamples } from '../memory/memory'
import type { RateLimiter } from '../queue/limiter'
import { BudgetExceededError, type CostTracker } from './budget'
import { InvalidOutputError, buildPrompt, parseSuggestions } from './prompt'
import { InvalidKeyError } from './transcriber'

export interface LlmResult {
  text: string
  inputTokens: number
  outputTokens: number
  /** modelo que de fato respondeu (para preço) */
  model?: string
}

export interface LlmProvider {
  name: 'groq' | 'claude'
  complete(p: { system: string; user: string }): Promise<LlmResult>
}

/** 429: o provedor pediu para esperar. */
export class LlmRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`limite de pedidos da IA atingido; nova tentativa em ${Math.ceil(retryAfterMs / 1000)} s`)
    this.name = 'LlmRateLimitError'
  }
}

/** O modelo recusou responder; a interface oferece "Tentar de novo". */
export class LlmRefusalError extends Error {
  constructor(readonly usage?: { inputTokens: number; outputTokens: number; model?: string }) {
    super('a IA recusou responder a este pedido')
    this.name = 'LlmRefusalError'
  }
}

/**
 * Verificar contra o catálogo gratuito vivo da Groq antes de lançar.
 * Sobrescrevível pela setting `llm.groq.model`.
 */
export const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile'
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'
export const SETTING_GROQ_MODEL = 'llm.groq.model'
export const SETTING_CLAUDE_MODEL = 'llm.claude.model'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const DEFAULT_RETRY_AFTER_MS = 60_000

function retryAfterMs(h: string | null | undefined): number {
  const s = h == null ? NaN : Number(h)
  return Number.isFinite(s) && s >= 0 ? Math.ceil(s * 1000) : DEFAULT_RETRY_AFTER_MS
}

const CLAUDE_SCHEMA = {
  type: 'object',
  properties: {
    resumo: { type: 'string' },
    sugestoes: { type: 'array', items: { type: 'string' } }
  },
  required: ['resumo', 'sugestoes'],
  additionalProperties: false
}

export interface CreateLlmOpts {
  repo?: Repo
  model?: string
  fetchImpl?: typeof fetch
  /** cliente do SDK já construído (testes) */
  client?: Anthropic
}

export function createLlm(kind: 'groq' | 'claude', apiKey: string, opts: CreateLlmOpts = {}): LlmProvider {
  if (kind === 'groq') {
    const fetchImpl = opts.fetchImpl ?? fetch
    return {
      name: 'groq',
      async complete({ system, user }) {
        const model = opts.model ?? opts.repo?.getSetting(SETTING_GROQ_MODEL) ?? DEFAULT_GROQ_MODEL
        const res = await fetchImpl(GROQ_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.7
          })
        })
        if (res.status === 401) throw new InvalidKeyError()
        if (res.status === 429) throw new LlmRateLimitError(retryAfterMs(res.headers.get('retry-after')))
        if (res.status === 400) {
          // modo json_object: saída inválida do modelo vem como 400 json_validate_failed
          const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
          if (body?.error?.code === 'json_validate_failed') throw new InvalidOutputError('Groq: json_validate_failed')
          throw new Error('pedido à IA falhou: HTTP 400 (groq)')
        }
        if (!res.ok) throw new Error(`pedido à IA falhou: HTTP ${res.status} (groq)`)
        const j = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        return {
          text: j.choices?.[0]?.message?.content ?? '',
          inputTokens: j.usage?.prompt_tokens ?? 0,
          outputTokens: j.usage?.completion_tokens ?? 0,
          model
        }
      }
    }
  }

  const client = opts.client ?? new Anthropic({ apiKey, maxRetries: 0, fetch: opts.fetchImpl })
  return {
    name: 'claude',
    async complete({ system, user }) {
      const model = opts.model ?? opts.repo?.getSetting(SETTING_CLAUDE_MODEL) ?? DEFAULT_CLAUDE_MODEL
      let msg
      try {
        msg = await client.beta.messages.create({
          model,
          max_tokens: 4000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'medium', format: { type: 'json_schema', schema: CLAUDE_SCHEMA } },
          system,
          messages: [{ role: 'user', content: user }]
        })
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new InvalidKeyError()
        if (e instanceof Anthropic.RateLimitError) throw new LlmRateLimitError(retryAfterMs(e.headers?.get('retry-after')))
        throw e
      }
      if (msg.stop_reason === 'refusal') {
        throw new LlmRefusalError({
          inputTokens: msg.usage?.input_tokens ?? 0,
          outputTokens: msg.usage?.output_tokens ?? 0,
          model: msg.model ?? model
        })
      }
      const text = msg.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('')
      return {
        text,
        inputTokens: msg.usage?.input_tokens ?? 0,
        outputTokens: msg.usage?.output_tokens ?? 0,
        model: msg.model ?? model
      }
    }
  }
}

export interface AnalysisDeps {
  repo: Repo
  llm: LlmProvider
  limiter: RateLimiter
  cost: CostTracker
  capUsd: number
  clock: Clock
  /** injetável nos testes; padrão setTimeout */
  sleep?: (ms: number) => Promise<void>
}

const MAX_ATTEMPTS = 2
const PRIOR_LIMIT = 20
const NO_MENTOR_REPLY_LIMIT = 40

function textOf(m: MessageRow): string {
  return (m.kind === 'text' ? m.text : m.transcriptStatus === 'done' ? m.transcript : null) ?? ''
}

/**
 * Novas = mensagens depois do último fromMe (sem nenhum fromMe: as últimas 40).
 * Se o mentor falou por último, novas = [] e a geração continua permitida
 * (botão "Gerar novas"): o prompt pede como retomar a conversa.
 */
export async function generateAnalysis(
  deps: AnalysisDeps,
  jid: string,
  opts: { force?: boolean } = {}
): Promise<AnalysisRow> {
  const { repo, llm, limiter, cost, capUsd, clock } = deps
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const all = repo.listMessages(jid, PRIOR_LIMIT + NO_MENTOR_REPLY_LIMIT + 200)
  if (all.length === 0) throw new Error('sem mensagens para analisar')
  const lastId = all[all.length - 1].id

  if (!opts.force) {
    const cached = repo.getAnalysis(jid)
    if (cached && cached.lastMsgId === lastId) return cached
  }

  let lastMe = -1
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].fromMe) {
      lastMe = i
      break
    }
  }
  const newMessages = lastMe === -1 ? all.slice(-NO_MENTOR_REPLY_LIMIT) : all.slice(lastMe + 1)
  const newStart = all.length - newMessages.length
  const priorMessages = all.slice(Math.max(0, newStart - PRIOR_LIMIT), newStart)

  const contact = repo.listContacts({ includeHidden: true }).find((c) => c.jid === jid)
  const contextText = newMessages.map(textOf).join('\n')
  const prompt = buildPrompt({
    contactName: contact?.displayName ?? jid,
    notes: contact?.notes ?? null,
    newMessages,
    priorMessages,
    examples: selectExamples(repo, jid, contextText)
  })

  let lastErr: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (cost.overCap(capUsd)) throw new BudgetExceededError(cost.todayUsd(), capUsd)
    const wait = limiter.nextAllowedAt() - clock.now()
    if (wait > 0) await sleep(wait)
    limiter.record()
    try {
      let res: LlmResult
      try {
        res = await llm.complete(prompt)
      } catch (e) {
        if (e instanceof LlmRefusalError && e.usage) cost.add(llm.name, e.usage.inputTokens, e.usage.outputTokens, e.usage.model)
        throw e
      } finally {
        limiter.markFinished()
      }
      cost.add(llm.name, res.inputTokens, res.outputTokens, res.model)
      const parsed = parseSuggestions(res.text)
      repo.saveAnalysis(jid, lastId, llm.name, parsed.summary, parsed.suggestions)
      return repo.getAnalysis(jid)!
    } catch (e) {
      // saída inválida (do parser ou 400 json_validate_failed da Groq): tenta de novo
      if (!(e instanceof InvalidOutputError)) throw e
      lastErr = e
      repo.logEvent('ai_invalid_output', `${llm.name}: ${e.message} (tentativa ${attempt + 1})`)
    }
  }
  throw lastErr
}
