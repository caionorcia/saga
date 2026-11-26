import type { DatabaseSync } from 'node:sqlite'
import { systemClock, type Clock } from '../clock'
import type { SendStatus } from '../../shared/send'

type Row = Record<string, any>

/** Um envio no banco (`sends`). */
export interface SendRow {
  id: number
  idemKey: string
  replyId: number
  jid: string
  text: string
  status: SendStatus
  /** 1 na primeira confirmação; cada nova confirmação depois de falha/expiração/desconhecido soma 1 */
  attempt: number
  queuedAt: number
  /** quando começou a mostrar "digitando…" (epoch ms do PC) */
  startedAt: number | null
  sentAt: number | null
  waMsgId: string | null
  error: string | null
}

function toSend(r: Row): SendRow {
  return {
    id: r.id,
    idemKey: r.idem_key,
    replyId: r.reply_id,
    jid: r.jid,
    text: r.text,
    status: r.status,
    attempt: r.attempt,
    queuedAt: r.queued_at,
    startedAt: r.started_at ?? null,
    sentAt: r.sent_at ?? null,
    waMsgId: r.wa_msg_id ?? null,
    error: r.error ?? null
  }
}

/** A chave do job da fila de um envio (uma por confirmação: uma tentativa nova nunca reaproveita o job antigo). */
export const sendJobKey = (s: Pick<SendRow, 'id' | 'attempt'>) => `send:${s.id}:${s.attempt}`

/** Envio direto (v0.4.0): a tabela `sends`. As transições de estado ficam aqui, com as condições no próprio UPDATE. */
export class SendRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock
  ) {}

  get(id: number): SendRow | null {
    const r = this.db.prepare('SELECT * FROM sends WHERE id = ?').get(id) as Row | undefined
    return r ? toSend(r) : null
  }

  byIdemKey(key: string): SendRow | null {
    const r = this.db.prepare('SELECT * FROM sends WHERE idem_key = ?').get(key) as Row | undefined
    return r ? toSend(r) : null
  }

  /** Os envios mais recentes de uma conversa (mais novos primeiro). */
  listForJid(jid: string, limit = 20): SendRow[] {
    return (this.db.prepare('SELECT * FROM sends WHERE jid = ? ORDER BY id DESC LIMIT ?').all(jid, limit) as Row[]).map(toSend)
  }

  listByStatus(...statuses: SendStatus[]): SendRow[] {
    return (
      this.db.prepare('SELECT * FROM sends WHERE status IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(statuses)) as Row[]
    ).map(toSend)
  }

  /**
   * Novo envio na fila, ou o mesmo de antes (mesma chave de idempotência): um que ainda vai sair ou já saiu é devolvido
   * como está (`created: false`); um que falhou, expirou, ficou desconhecido ou foi cancelado volta para a fila com
   * `attempt + 1` (só depois de uma nova confirmação explícita, que é quem chama).
   */
  enqueue(a: { idemKey: string; replyId: number; jid: string; text: string }): { send: SendRow; created: boolean } {
    const now = this.clock.now()
    const cur = this.byIdemKey(a.idemKey)
    if (!cur) {
      const res = this.db
        .prepare(`INSERT INTO sends(idem_key, reply_id, jid, text, status, queued_at) VALUES (?, ?, ?, ?, 'queued', ?)`)
        .run(a.idemKey, a.replyId, a.jid, a.text, now)
      return { send: this.get(Number(res.lastInsertRowid))!, created: true }
    }
    if (cur.status === 'queued' || cur.status === 'typing' || cur.status === 'sending' || cur.status === 'sent') {
      return { send: cur, created: false }
    }
    this.db
      .prepare(
        `UPDATE sends SET status = 'queued', attempt = attempt + 1, queued_at = ?, started_at = NULL, sent_at = NULL, wa_msg_id = NULL, error = NULL
         WHERE id = ?`
      )
      .run(now, cur.id)
    return { send: this.get(cur.id)!, created: true }
  }

  /** Muda o estado só se o atual for um dos `from`. `true` se mudou. */
  transition(id: number, from: SendStatus[], to: SendStatus, extra: { error?: string | null; startedAt?: number; sentAt?: number; waMsgId?: string | null } = {}): boolean {
    const res = this.db
      .prepare(
        `UPDATE sends SET status = ?1,
           error = CASE WHEN ?2 THEN ?3 ELSE error END,
           started_at = COALESCE(?4, started_at),
           sent_at = COALESCE(?5, sent_at),
           wa_msg_id = COALESCE(?6, wa_msg_id)
         WHERE id = ?7 AND status IN (SELECT value FROM json_each(?8))`
      )
      .run(
        to,
        'error' in extra ? 1 : 0,
        extra.error ?? null,
        extra.startedAt ?? null,
        extra.sentAt ?? null,
        extra.waMsgId ?? null,
        id,
        JSON.stringify(from)
      )
    return Number(res.changes) > 0
  }

  /** Quantos envios há em cada estado (painel de status e testes). */
  counts(): Record<SendStatus, number> {
    const out = { queued: 0, typing: 0, sending: 0, sent: 0, failed: 0, unknown: 0, expired: 0, canceled: 0 } as Record<SendStatus, number>
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS c FROM sends GROUP BY status').all() as Row[]) out[r.status as SendStatus] = r.c
    return out
  }
}
