import type { Clock } from '../clock'

/** Classe de uma desconexão, decidida pelo código de status do Baileys (sem importar o Baileys). */
export type DisconnectClass = 'retry' | 'bad_session' | 'logged_out' | 'restricted' | 'outdated' | 'replaced'

/**
 * Códigos numéricos do `DisconnectReason` do Baileys 7.0.0-rc14:
 * connectionClosed 428, connectionLost 408, timedOut 408, connectionReplaced 440,
 * loggedOut 401, badSession 500, restartRequired 515, multideviceMismatch 411,
 * forbidden 403, unavailableService 503.
 * Códigos definitivos vencem a mensagem; a mensagem com "version" só decide quando o código não é definitivo.
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
const MAX_DELAY_MS = 1_800_000
const WINDOW_MS = 60 * 60 * 1000
const MAX_ATTEMPTS_PER_WINDOW = 6
const JITTER = 0.2

/**
 * Política de reconexão anti-rajada: esperas crescentes com ±20% de variação
 * (teto de 30 min), no máximo 6 tentativas em 60 min deslizantes.
 *
 * - A escalada conta as tentativas desde o último `reset()`/`manualRetry()` e nunca desce sozinha.
 * - A janela de 60 min serve só ao limite de 6 por hora.
 * - Ao atingir o limite, `nextDelayMs()` devolve `null` e fica travado até `manualRetry()` ou `reset()`.
 */
export class ReconnectPolicy {
  /** instantes (relógio monotônico) das tentativas dentro da janela de 60 min */
  private attempts: number[] = []
  /** tentativas desde o último reset/manualRetry: indexa a escada de esperas */
  private sinceReset = 0
  private latched = false

  constructor(
    private clock: Clock,
    private rng: () => number = Math.random
  ) {}

  /** Devolve o atraso em ms até a próxima tentativa e conta a tentativa; `null` = desistir até a ação manual. */
  nextDelayMs(): number | null {
    if (this.latched) return null

    const now = this.clock.monotonic()
    this.attempts = this.attempts.filter((t) => t > now - WINDOW_MS)
    if (this.attempts.length >= MAX_ATTEMPTS_PER_WINDOW) {
      this.latched = true
      return null
    }

    const base = SEQUENCE_MS[Math.min(this.sinceReset, SEQUENCE_MS.length - 1)]
    const jittered = Math.round(base * (1 - JITTER + 2 * JITTER * this.rng()))

    this.attempts.push(now)
    this.sinceReset++
    return Math.min(MAX_DELAY_MS, jittered)
  }

  /** Conexão bem-sucedida: zera escada, janela e trava. */
  reset(): void {
    this.clear()
  }

  /**
   * Conexão ficou aberta e estável: a escada volta ao começo (e a trava sai), mas a janela
   * de 60 min continua contando — um link oscilando não ganha tentativas extras.
   */
  markStable(): void {
    this.sinceReset = 0
    this.latched = false
  }

  /** Clique manual do usuário: zera escada, janela e trava (mesmo efeito de `reset`, intenção diferente). */
  manualRetry(): void {
    this.clear()
  }

  private clear(): void {
    this.attempts = []
    this.sinceReset = 0
    this.latched = false
  }
}
