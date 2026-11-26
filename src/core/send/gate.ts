import { randomUUID } from 'node:crypto'
import type { Clock } from '../clock'
import { SEND_LIMITS } from '../../shared/send'

/**
 * O que o mentor viu na confirmação e fica preso ao token: para onde vai, qual mensagem é citada e se marcou "Forçar
 * envio" (v0.4.1: um token sem `forced` nunca vale fora do horário de envio).
 */
export interface SendBinding {
  address: string
  quotedId: string | null
  forced: boolean
}

/**
 * Confirmação explícita a cada envio: `issue` (o diálogo "Enviar" abriu com este jid + texto) devolve um token de uso
 * único que vale 5 min; `consume` só aceita o token para exatamente o mesmo jid e o mesmo texto, e o gasta, devolvendo o
 * destino e a citação mostrados na confirmação. Os tokens ficam só na memória: depois de reiniciar o app nenhum vale.
 */
export class SendGate {
  private tokens = new Map<string, { jid: string; text: string; expiresAt: number; bind: SendBinding }>()

  constructor(private readonly clock: Clock) {}

  issue(jid: string, text: string, bind: SendBinding = { address: jid, quotedId: null, forced: false }): { token: string; expiresAt: number } {
    this.sweep()
    const token = randomUUID()
    const expiresAt = this.clock.now() + SEND_LIMITS.tokenTtlMs
    this.tokens.set(token, { jid, text: text.trim(), expiresAt, bind: { address: bind.address, quotedId: bind.quotedId, forced: bind.forced === true } })
    return { token, expiresAt }
  }

  /** O destino e a citação confirmados, só uma vez, para o token certo, dentro do prazo, com o mesmo jid e texto. */
  consume(token: string, jid: string, text: string): SendBinding | null {
    const t = this.tokens.get(token)
    if (!t) return null
    // gasto mesmo quando não confere: uma tentativa errada não deixa o token vivo para outra
    this.tokens.delete(token)
    return t.expiresAt > this.clock.now() && t.jid === jid && t.text === text.trim() ? t.bind : null
  }

  private sweep(): void {
    const now = this.clock.now()
    for (const [k, t] of this.tokens) if (t.expiresAt <= now) this.tokens.delete(k)
  }
}
