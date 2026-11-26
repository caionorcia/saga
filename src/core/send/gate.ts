import { randomUUID } from 'node:crypto'
import type { Clock } from '../clock'
import { SEND_LIMITS, type SendKind } from '../../shared/send'

/**
 * O que o mentor viu na confirmação e fica preso ao token: para onde vai, qual mensagem é citada, se marcou "Forçar
 * envio" (v0.4.1: um token sem `forced` nunca vale fora do horário de envio) e o tipo (v0.6.0: a confirmação de uma
 * resposta não vale para uma mensagem avulsa, nem o contrário; a avulsa nunca leva citação).
 */
export interface SendBinding {
  address: string
  quotedId: string | null
  forced: boolean
  kind: SendKind
}

/**
 * Confirmação explícita a cada envio: `issue` (o diálogo "Enviar" abriu com este jid + texto) devolve um token de uso
 * único que vale 5 min; `consume` só aceita o token para exatamente o mesmo jid e o mesmo texto, e o gasta, devolvendo o
 * destino e a citação mostrados na confirmação. Os tokens ficam só na memória: depois de reiniciar o app nenhum vale.
 */
export class SendGate {
  private tokens = new Map<string, { jid: string; text: string; expiresAt: number; bind: SendBinding }>()

  constructor(private readonly clock: Clock) {}

  issue(jid: string, text: string, bind: Partial<SendBinding> & Pick<SendBinding, 'address'> = { address: jid }): { token: string; expiresAt: number } {
    this.sweep()
    const token = randomUUID()
    const expiresAt = this.clock.now() + SEND_LIMITS.tokenTtlMs
    const kind: SendKind = bind.kind === 'avulsa' ? 'avulsa' : 'reply'
    this.tokens.set(token, {
      jid,
      text: text.trim(),
      expiresAt,
      bind: { address: bind.address, quotedId: kind === 'avulsa' ? null : (bind.quotedId ?? null), forced: bind.forced === true, kind }
    })
    return { token, expiresAt }
  }

  /**
   * O destino e a citação confirmados, só uma vez, para o token certo, dentro do prazo, com o mesmo jid, texto e tipo
   * (`reply` quando não informado).
   */
  consume(token: string, jid: string, text: string, kind: SendKind = 'reply'): SendBinding | null {
    const t = this.tokens.get(token)
    if (!t) return null
    // gasto mesmo quando não confere: uma tentativa errada não deixa o token vivo para outra
    this.tokens.delete(token)
    return t.expiresAt > this.clock.now() && t.jid === jid && t.text === text.trim() && t.bind.kind === kind ? t.bind : null
  }

  private sweep(): void {
    const now = this.clock.now()
    for (const [k, t] of this.tokens) if (t.expiresAt <= now) this.tokens.delete(k)
  }
}
