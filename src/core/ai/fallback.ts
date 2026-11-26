/**
 * Corrente de reserva (v0.6.2): quando a IA principal (Groq, ou Claude) chega ao limite (429, depois de a Groq já
 * ter trocado de modelo), o pedido vai para o Gemini e depois para o Mistral — cada um só se o mentor salvou a chave.
 * Um 429 de uma reserva tira ela da corrente até o tempo pedido (mínimo 2 min), guardado em `settings_kv`.
 * O resultado diz quem respondeu (`provider`) para a tela mostrar "Gerado por: Gemini".
 */
import { systemClock, type Clock } from '../clock'
import type { Repo } from '../db/repo'
import { InvalidKeyError } from './groqModels'
import { LlmRateLimitError, type LlmName, type LlmProvider } from './llm'
import { InvalidOutputError } from './prompt'

/** Ordem das reservas gratuitas. */
export const FREE_FALLBACKS = ['gemini', 'mistral'] as const
export type FreeFallback = (typeof FREE_FALLBACKS)[number]

const LIMITED_KEY = 'llm.fallback.limited'
export const MIN_LIMITED_MS = 2 * 60_000
/** Chave recusada: a reserva fica de fora por este tempo (o mentor pode trocar a chave antes). */
const BAD_KEY_PAUSE_MS = 30 * 60_000

/** "No limite até": por provedor, guardado em `settings_kv` (sem `repo`, só na memória). */
export class ProviderLimits {
  private mem: Record<string, number> = {}
  private readonly clock: Clock

  constructor(
    private readonly repo?: Repo,
    clock?: Clock
  ) {
    this.clock = clock ?? systemClock
  }

  private all(): Record<string, number> {
    let stored: Record<string, number> = {}
    try {
      const raw = this.repo?.getSetting(LIMITED_KEY)
      if (raw) stored = JSON.parse(raw) as Record<string, number>
    } catch {
      // ilegível: nenhum no limite
    }
    const now = this.clock.now()
    return Object.fromEntries(Object.entries({ ...stored, ...this.mem }).filter(([, until]) => typeof until === 'number' && until > now))
  }

  /** Até quando o provedor está no limite (null: livre). */
  until(name: LlmName): number | null {
    return this.all()[name] ?? null
  }

  mark(name: LlmName, waitMs: number): number {
    const until = this.clock.now() + Math.max(waitMs, MIN_LIMITED_MS)
    this.mem[name] = until
    const a = this.all()
    a[name] = until
    this.repo?.setSetting(LIMITED_KEY, JSON.stringify(a))
    return until
  }

  clear(name: LlmName): void {
    delete this.mem[name]
    const a = this.all()
    delete a[name]
    this.repo?.setSetting(LIMITED_KEY, JSON.stringify(a))
  }
}

export interface FallbackOpts {
  repo?: Repo
  clock?: Clock
  /** só nomes de provedor, tempos e tipos de erro; nunca chave nem texto */
  diag?: (kind: string, detail: string) => void
}

/**
 * Envolve a IA principal: um `LlmRateLimitError` dela passa o pedido para a primeira reserva livre. Sem reserva
 * que responda, lança de novo o 429, com a espera até o primeiro provedor que volta.
 * Saída fora do formato (`InvalidOutputError`) de uma reserva sobe como está (quem chamou tenta de novo).
 */
export function withFallback(primary: LlmProvider, fallbacks: LlmProvider[], opts: FallbackOpts = {}): LlmProvider {
  if (fallbacks.length === 0) return primary
  const clock = opts.clock ?? systemClock
  const limits = new ProviderLimits(opts.repo, clock)
  const diag = (k: string, d: string) => {
    try {
      opts.diag?.(k, d)
    } catch {
      // registrar nunca quebra a IA
    }
  }
  return {
    name: primary.name,
    async complete(p) {
      let primaryErr: LlmRateLimitError
      try {
        const r = await primary.complete(p)
        return { ...r, provider: r.provider ?? primary.name }
      } catch (e) {
        if (!(e instanceof LlmRateLimitError)) throw e
        primaryErr = e
      }
      const waits = [primaryErr.retryAfterMs]
      for (const fb of fallbacks) {
        const until = limits.until(fb.name)
        if (until !== null) {
          waits.push(until - clock.now())
          continue
        }
        try {
          const r = await fb.complete(p)
          diag('llm_fallback', `${primary.name} no limite; respondeu ${fb.name}`)
          return { ...r, provider: fb.name }
        } catch (e) {
          if (e instanceof InvalidOutputError) throw e
          if (e instanceof LlmRateLimitError) {
            const u = limits.mark(fb.name, e.retryAfterMs)
            waits.push(u - clock.now())
            diag('llm_fallback_limited', `${fb.name} no limite (429) por ${Math.ceil((u - clock.now()) / 60_000)} min`)
          } else if (e instanceof InvalidKeyError) {
            limits.mark(fb.name, BAD_KEY_PAUSE_MS)
            diag('llm_fallback_error', `${fb.name}: chave recusada`)
          } else {
            diag('llm_fallback_error', `${fb.name}: ${e instanceof Error ? e.name : 'erro'}`)
          }
        }
      }
      throw new LlmRateLimitError(Math.max(0, Math.min(...waits)))
    }
  }
}
