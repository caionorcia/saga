import type { Clock } from '../clock'

/** Classe de uma desconexão, decidida pelo código de status do Baileys (sem importar o Baileys). */
export type DisconnectClass = 'retry' | 'bad_session' | 'logged_out' | 'restricted' | 'outdated' | 'replaced'

/**
 * Códigos numéricos do `DisconnectReason` do Baileys 7.0.0-rc14:
 * connectionClosed 428, connectionLost 408, timedOut 408, connectionReplaced 440,
 * loggedOut 401, badSession 500, restartRequired 515, multideviceMismatch 411,
 * forbidden 403, unavailableService 503.
 */
export function classifyDisconnect(statusCode: number | undefined, message?: string): DisconnectClass {
  switch (statusCode) {
    case 401:
    case 411:
      return 'logged_out'
    case 403:
      return 'restricted'
    case 440:
      return 'replaced'
    case 500:
      return 'bad_session'
    case 405:
      return 'outdated'
  }
  if (message && /version/i.test(message)) return 'outdated'
  return 'retry'
}

const SEQUENCE_MS = [10_000, 30_000, 120_000, 300_000, 900_000, 1_800_000] as const
const WINDOW_MS = 60 * 60 * 1000
const MAX_ATTEMPTS_PER_WINDOW = 6
const JITTER = 0.2

/**
 * Política de reconexão anti-rajada: esperas crescentes com ±20% de variação,
 * no máximo 6 tentativas em 60 min deslizantes. Depois disso devolve `null`
 * até a ação manual (`manualRetry`) ou uma conexão bem-sucedida (`reset`).
 */
export class ReconnectPolicy {
  /** instantes (relógio monotônico) das tentativas dentro da janela */
  private attempts: number[] = []

  constructor(
    private clock: Clock,
    private rng: () => number = Math.random
  ) {}

  /** Devolve o atraso em ms até a próxima tentativa e conta a tentativa; `null` = desistir. */
  nextDelayMs(): number | null {
    const now = this.clock.monotonic()
    this.attempts = this.attempts.filter((t) => t > now - WINDOW_MS)
    if (this.attempts.length >= MAX_ATTEMPTS_PER_WINDOW) return null

    const index = Math.min(this.attempts.length, SEQUENCE_MS.length - 1)
    const base = SEQUENCE_MS[index]
    const delay = Math.round(base * (1 - JITTER + 2 * JITTER * this.rng()))

    this.attempts.push(now)
    return delay
  }

  /** Chamar ao conectar com sucesso: reinicia a sequência e a janela. */
  reset(): void {
    this.attempts = []
  }

  /** Ação manual do usuário: limpa a janela para a próxima chamada voltar a 10 s. */
  manualRetry(): void {
    this.attempts = []
  }
}
