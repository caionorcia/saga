import type { Clock } from '../clock'
import type { Repo } from '../db/repo'

/** USD por 1 milhão de tokens. Tokens de raciocínio já vêm contados em output_tokens. */
export const CLAUDE_PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 }
}

/** Transcrição pela OpenAI (whisper-1), em USD por minuto de áudio. Verificar preço atual. */
export const OPENAI_TRANSCRIBE_USD_PER_MIN = 0.006

/** Modelo desconhecido: preço do Opus (conservador). */
const FALLBACK_PRICING = CLAUDE_PRICING['claude-opus-5-5']

export function claudePricing(model: string | undefined): { input: number; output: number } {
  if (!model) return FALLBACK_PRICING
  const exact = CLAUDE_PRICING[model]
  if (exact) return exact
  for (const [k, v] of Object.entries(CLAUDE_PRICING)) if (model.startsWith(`${k}-`)) return v
  return FALLBACK_PRICING
}

export class BudgetExceededError extends Error {
  constructor(readonly spentUsd: number, readonly capUsd: number) {
    super(`teto diário de gasto com IA atingido (US$ ${spentUsd.toFixed(2)} de US$ ${capUsd.toFixed(2)})`)
    this.name = 'BudgetExceededError'
  }
}

export class CostTracker {
  constructor(
    private readonly repo: Repo,
    private readonly clock: Clock
  ) {}

  private key(): string {
    const d = new Date(this.clock.now())
    const p = (n: number) => String(n).padStart(2, '0')
    return `cost.${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  /** Só o Claude é pago; Groq, Gemini e Mistral (planos gratuitos) custam 0. */
  add(provider: string, inTok: number, outTok: number, model?: string): void {
    if (provider !== 'claude') return
    const pr = claudePricing(model)
    const usd = (inTok * pr.input + outTok * pr.output) / 1_000_000
    this.addUsd(usd)
  }

  /** Soma um gasto já em USD (ex.: transcrição paga) ao total de hoje. */
  addUsd(usd: number): void {
    if (!(usd > 0) || !Number.isFinite(usd)) return
    this.repo.setSetting(this.key(), String(this.todayUsd() + usd))
  }

  /** Milissegundos até a próxima meia-noite local (quando o gasto de hoje volta a zero). */
  msUntilTomorrow(): number {
    const now = this.clock.now()
    const d = new Date(now)
    d.setHours(24, 0, 0, 0)
    return Math.max(60_000, d.getTime() - now)
  }

  todayUsd(): number {
    const v = Number(this.repo.getSetting(this.key()))
    return Number.isFinite(v) ? v : 0
  }

  overCap(capUsd: number): boolean {
    return this.todayUsd() >= capUsd
  }
}
