import type { DatabaseSync } from 'node:sqlite'
import { systemClock, type Clock } from '../clock'
import type { SendKind, SendStatus } from '../../shared/send'

type Row = Record<string, any>

/** Um envio no banco (`sends`). */
export interface SendRow {
  id: number
  idemKey: string
  /** v0.6.0: `reply` (resposta a uma sugestão) ou `avulsa` (mensagem escrita fora das sugestões) */
  kind: SendKind
  /** a resposta aprovada que este envio leva; null na avulsa (nunca entra na memória) */
  replyId: number | null
  jid: string
  text: string
  /** para onde vai: o grupo, ou na individual o JID como o contato escreveu por último (@lid ou telefone) */
  address: string
  /** grupo: a mensagem citada vista na confirmação (null = sem citação) */
  quotedId: string | null
  /** ids de mensagem gerados pelo app, um por tentativa que chegou a pedir o envio */
  msgIds: string[]
  status: SendStatus
  /** v0.4.1: confirmado com "Forçar envio" (pode sair fora do horário de envio) */
  forced: boolean
  /** 1 na primeira confirmação; cada nova confirmação depois de falha/expiração/desconhecido soma 1 */
  attempt: number
  queuedAt: number
  /** quando começou a mostrar "digitando…" (epoch ms do PC) */
  startedAt: number | null
  sentAt: number | null
  waMsgId: string | null
  error: string | null
}

function ids(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function toSend(r: Row): SendRow {
  return {
    id: r.id,
    idemKey: r.idem_key,
    kind: r.kind === 'avulsa' ? 'avulsa' : 'reply',
    replyId: r.reply_id ?? null,
    jid: r.jid,
    text: r.text,
    address: r.address,
    quotedId: r.quoted_id ?? null,
    msgIds: ids(r.msg_ids_json),
    status: r.status,
    forced: r.forced === 1,
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

export class SendConflictError extends Error {
  constructor() {
    super('a chave do envio já pertence a outra conversa')
    this.name = 'SendConflictError'
  }
}

export interface SendTransitionExtra {
  error?: string | null
  startedAt?: number
  sentAt?: number
  /** id da mensagem que confirmou o envio (resposta do WhatsApp ou mensagem achada na conversa) */
  waMsgId?: string | null
  /** id gerado para esta tentativa: vira o `wa_msg_id` e entra na lista de ids (conferência) */
  newMsgId?: string
}

/**
 * Envio direto (v0.4.0): a tabela `sends`. Toda transição de estado é condicional ao estado atual E à tentativa: o
 * handler de uma tentativa antiga (por exemplo, que estourou o prazo) nunca mexe na linha de uma tentativa nova.
 */
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

  /** O envio que gerou este id de mensagem (o eco da mensagem enviada), ou null. */
  byMsgId(msgId: string): SendRow | null {
    const r = this.db
      .prepare('SELECT s.* FROM sends s WHERE EXISTS (SELECT 1 FROM json_each(s.msg_ids_json) WHERE value = ?) ORDER BY s.id DESC LIMIT 1')
      .get(msgId) as Row | undefined
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
   * `attempt + 1` e o destino/citação desta nova confirmação (só depois de uma nova confirmação explícita, que é quem
   * chama). A chave de outra conversa (ou de outro tipo/resposta) lança `SendConflictError`. A avulsa (`replyId`
   * null) nunca leva citação.
   */
  enqueue(a: { idemKey: string; kind?: SendKind; replyId: number | null; jid: string; text: string; address: string; quotedId: string | null; forced?: boolean }): {
    send: SendRow
    created: boolean
  } {
    const kind: SendKind = a.kind ?? 'reply'
    if ((kind === 'reply') !== (a.replyId !== null)) throw new Error('envio: resposta sem resposta aprovada ou avulsa com resposta aprovada')
    const quotedId = kind === 'avulsa' ? null : a.quotedId
    const forced = a.forced ? 1 : 0
    const now = this.clock.now()
    const cur = this.byIdemKey(a.idemKey)
    if (!cur) {
      const res = this.db
        .prepare(`INSERT INTO sends(idem_key, kind, reply_id, jid, text, address, quoted_id, forced, status, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`)
        .run(a.idemKey, kind, a.replyId, a.jid, a.text, a.address, quotedId, forced, now)
      return { send: this.get(Number(res.lastInsertRowid))!, created: true }
    }
    if (cur.jid !== a.jid || cur.kind !== kind || cur.replyId !== a.replyId) throw new SendConflictError()
    if (cur.status === 'queued' || cur.status === 'typing' || cur.status === 'sending' || cur.status === 'sent') {
      return { send: cur, created: false }
    }
    this.db
      .prepare(
        `UPDATE sends SET status = 'queued', attempt = attempt + 1, queued_at = ?, started_at = NULL, sent_at = NULL, wa_msg_id = NULL,
           error = NULL, address = ?, quoted_id = ?, forced = ?
         WHERE id = ? AND attempt = ?`
      )
      .run(now, a.address, quotedId, forced, cur.id, cur.attempt)
    return { send: this.get(cur.id)!, created: true }
  }

  /** Muda o estado só se a tentativa for a mesma e o estado atual for um dos `from`. `true` se mudou. */
  transition(id: number, attempt: number, from: SendStatus[], to: SendStatus, extra: SendTransitionExtra = {}): boolean {
    const msgId = extra.newMsgId ?? extra.waMsgId ?? null
    const res = this.db
      .prepare(
        `UPDATE sends SET status = ?1,
           error = CASE WHEN ?2 THEN ?3 ELSE error END,
           started_at = COALESCE(?4, started_at),
           sent_at = COALESCE(?5, sent_at),
           wa_msg_id = COALESCE(?6, wa_msg_id),
           msg_ids_json = CASE WHEN ?7 IS NULL THEN msg_ids_json ELSE json_insert(msg_ids_json, '$[#]', ?7) END
         WHERE id = ?8 AND attempt = ?9 AND status IN (SELECT value FROM json_each(?10))`
      )
      .run(
        to,
        'error' in extra ? 1 : 0,
        extra.error ?? null,
        extra.startedAt ?? null,
        extra.sentAt ?? null,
        msgId,
        extra.newMsgId ?? null,
        id,
        attempt,
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
