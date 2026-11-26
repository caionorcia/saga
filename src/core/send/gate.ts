import { randomUUID } from 'node:crypto'
import type { Clock } from '../clock'
import { SEND_LIMITS } from '../../shared/send'

/**
 * Confirmação explícita a cada envio: `issue` (o diálogo "Enviar" abriu com este jid + texto) devolve um token de uso
 * único que vale 5 min; `consume` só aceita o token para exatamente o mesmo jid e o mesmo texto, e o gasta. Os tokens
 * ficam só na memória: depois de reiniciar o app nenhum vale (nada é enviado sem uma confirmação nova).
 */
export class SendGate {
  private tokens = new Map<string, { jid: string; text: string; expiresAt: number }>()

  constructor(private readonly clock: Clock) {}

  issue(jid: string, text: string): { token: string; expiresAt: number } {
    this.sweep()
    const token = randomUUID()
    const expiresAt = this.clock.now() + SEND_LIMITS.tokenTtlMs
    this.tokens.set(token, { jid, text: text.trim(), expiresAt })
    return { token, expiresAt }
  }

  /** `true` só uma vez, para o token certo, dentro do prazo, com o mesmo jid e o mesmo texto. */
  consume(token: string, jid: string, text: string): boolean {
    const t = this.tokens.get(token)
    if (!t) return false
    // gasto mesmo quando não confere: uma tentativa errada não deixa o token vivo para outra
    this.tokens.delete(token)
    return t.expiresAt > this.clock.now() && t.jid === jid && t.text === text.trim()
  }

  private sweep(): void {
    const now = this.clock.now()
    for (const [k, t] of this.tokens) if (t.expiresAt <= now) this.tokens.delete(k)
  }
}
