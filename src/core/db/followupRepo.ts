import type { DatabaseSync } from 'node:sqlite'
import { systemClock, type Clock } from '../clock'
import type { FollowupStatus, FollowupView } from '../../shared/copiloto'
import type { PendingFollowup } from '../copiloto/followups'

type Row = Record<string, any>

/** Um follow-up do Copiloto no banco (`copiloto_followups`, v0.7.0). */
export interface FollowupRow {
  id: string
  targetJson: string
  text: string
  author: string | null
  createdAt: number
  receivedAt: number
  /** a conversa local (null: não encontrada) */
  jid: string | null
  status: FollowupStatus
  sendId: number | null
  finalText: string | null
  sentAt: number | null
  reason: string | null
  sendError: string | null
  reported: boolean
  reportAttempts: number
  nextReportAt: number
  lastResult: string | null
  updatedAt: number
  /** v0.8.0 (contrato v1.2): o Copiloto marcou para envio automático */
  autoSend: boolean
  /** o horário escolhido para o envio automático (epoch ms; gravado: reiniciar não sorteia de novo); null = ainda não */
  autoAt: number | null
  /** o envio automático deste item acabou (desconhecido, falhou, tentativas demais): segue como na v1.1 */
  autoOff: boolean
  autoAttempts: number
}

function toRow(r: Row): FollowupRow {
  return {
    id: r.id,
    targetJson: r.target_json,
    text: r.text,
    author: r.author ?? null,
    createdAt: r.created_at,
    receivedAt: r.received_at,
    jid: r.jid ?? null,
    status: r.local_status,
    sendId: r.send_id ?? null,
    finalText: r.final_text ?? null,
    sentAt: r.sent_at ?? null,
    reason: r.reason ?? null,
    sendError: r.send_error ?? null,
    reported: r.reported === 1,
    reportAttempts: r.report_attempts,
    nextReportAt: r.next_report_at,
    lastResult: r.last_result ?? null,
    updatedAt: r.updated_at,
    autoSend: r.auto_send === 1,
    autoAt: r.auto_at ?? null,
    autoOff: r.auto_off === 1,
    autoAttempts: r.auto_attempts ?? 0
  }
}

export function followupView(f: FollowupRow & { jid: string }): FollowupView {
  return {
    id: f.id,
    jid: f.jid,
    text: f.text,
    author: f.author,
    createdAt: f.createdAt,
    status: f.status,
    sendId: f.sendId,
    finalText: f.finalText,
    sentAt: f.sentAt,
    reason: f.reason,
    sendError: f.sendError,
    auto: null
  }
}

export interface FollowupChange {
  sendId?: number | null
  finalText?: string | null
  sentAt?: number | null
  reason?: string | null
  sendError?: string | null
  /** volta a precisar de relatório ao Copiloto (estado final novo) */
  report?: boolean
}

/**
 * Follow-ups do Copiloto. Toda mudança de estado é condicional ao estado atual (`from`): um relatório atrasado nunca
 * desfaz um envio, e o mesmo follow-up nunca volta a "esperando" depois de enviado.
 */
export class FollowupRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock
  ) {}

  /** Guarda um follow-up novo (dedupe pelo id: um que já existe, em qualquer estado, fica como está). `true` se entrou. */
  insert(f: PendingFollowup, jid: string | null, status: FollowupStatus, extra: { reason?: string | null } = {}): boolean {
    const now = this.clock.now()
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO copiloto_followups(id, target_json, text, author, created_at, received_at, jid, local_status, reason, updated_at, auto_send)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(f.id, JSON.stringify(f.target), f.text, f.author, f.createdAt, now, jid, status, extra.reason ?? null, now, f.autoSend ? 1 : 0)
    return Number(res.changes) > 0
  }

  get(id: string): FollowupRow | null {
    const r = this.db.prepare('SELECT * FROM copiloto_followups WHERE id = ?').get(id) as Row | undefined
    return r ? toRow(r) : null
  }

  has(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM copiloto_followups WHERE id = ?').get(id)
  }

  /**
   * O que a interface mostra: os que esperam o mentor ou estão saindo, e (por `recentMs`) os enviados e os que não dão
   * para enviar, para o aviso dizer o que aconteceu. Mais antigos primeiro.
   */
  listVisible(recentMs: number): Array<FollowupRow & { jid: string }> {
    const since = this.clock.now() - recentMs
    return (
      this.db
        .prepare(
          `SELECT * FROM copiloto_followups
            WHERE jid IS NOT NULL
              AND (local_status IN ('waiting', 'sending') OR (local_status IN ('sent', 'failed') AND updated_at >= ?))
            ORDER BY created_at, id`
        )
        .all(since) as Row[]
    ).map((r) => toRow(r) as FollowupRow & { jid: string })
  }

  listByStatus(status: FollowupStatus): FollowupRow[] {
    return (this.db.prepare('SELECT * FROM copiloto_followups WHERE local_status = ? ORDER BY created_at, id').all(status) as Row[]).map(toRow)
  }

  waitingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM copiloto_followups WHERE local_status = 'waiting' AND jid IS NOT NULL").get() as Row).n
  }

  /** Muda o estado só se o atual for um dos `from`. `true` se mudou. */
  transition(id: string, from: FollowupStatus[], to: FollowupStatus, c: FollowupChange = {}): boolean {
    const set: string[] = ['local_status = ?', 'updated_at = ?']
    const args: Array<string | number | null> = [to, this.clock.now()]
    const put = (col: string, v: string | number | null | undefined) => {
      if (v === undefined) return
      set.push(`${col} = ?`)
      args.push(v)
    }
    put('send_id', c.sendId)
    put('final_text', c.finalText)
    put('sent_at', c.sentAt)
    put('reason', c.reason)
    put('send_error', c.sendError)
    if (c.report) set.push('reported = 0', 'report_attempts = 0', 'next_report_at = 0', 'last_result = NULL')
    const res = this.db
      .prepare(`UPDATE copiloto_followups SET ${set.join(', ')} WHERE id = ? AND local_status IN (SELECT value FROM json_each(?))`)
      .run(...args, id, JSON.stringify(from))
    return Number(res.changes) > 0
  }

  /** Os estados finais que o Copiloto ainda não confirmou e já podem ir, mais antigos primeiro. */
  dueReports(now: number, limit: number): FollowupRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM copiloto_followups
            WHERE reported = 0 AND local_status IN ('sent', 'declined', 'failed') AND next_report_at <= ?
            ORDER BY updated_at, id LIMIT ?`
        )
        .all(now, limit) as Row[]
    ).map(toRow)
  }

  /** Quando sai o próximo relatório (epoch ms), ou null. */
  nextReportAt(): number | null {
    const r = this.db
      .prepare("SELECT MIN(next_report_at) AS t FROM copiloto_followups WHERE reported = 0 AND local_status IN ('sent', 'declined', 'failed')")
      .get() as Row
    return typeof r.t === 'number' ? r.t : null
  }

  pendingReports(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM copiloto_followups WHERE reported = 0 AND local_status IN ('sent', 'declined', 'failed')").get() as Row).n
  }

  /** O Copiloto respondeu: este relatório está feito (só se o estado ainda é o que foi enviado). */
  markReported(id: string, status: FollowupStatus, result: string): boolean {
    const res = this.db
      .prepare('UPDATE copiloto_followups SET reported = 1, last_result = ?, updated_at = ? WHERE id = ? AND local_status = ? AND reported = 0')
      .run(result, this.clock.now(), id, status)
    return Number(res.changes) > 0
  }

  /** 429, 5xx, rede: tenta de novo em `at`. */
  retryReports(ids: ReadonlyArray<string>, at: number, result: string): void {
    const st = this.db.prepare('UPDATE copiloto_followups SET report_attempts = report_attempts + 1, next_report_at = ?, last_result = ? WHERE id = ? AND reported = 0')
    this.tx(() => {
      for (const id of ids) st.run(at, result, id)
    })
  }

  // --- v0.8.0: envio automático (contrato v1.2) ---

  /** Os que esperam e estão marcados para envio automático (ainda valendo), mais antigos primeiro. */
  listAutoWaiting(): Array<FollowupRow & { jid: string }> {
    return (
      this.db
        .prepare(
          `SELECT * FROM copiloto_followups
            WHERE local_status = 'waiting' AND jid IS NOT NULL AND auto_send = 1 AND auto_off = 0
            ORDER BY created_at, id`
        )
        .all() as Row[]
    ).map((r) => toRow(r) as FollowupRow & { jid: string })
  }

  /** Grava o horário escolhido para o envio automático (null = escolher de novo na próxima volta). */
  setAutoAt(id: string, at: number | null): boolean {
    const res = this.db.prepare('UPDATE copiloto_followups SET auto_at = ? WHERE id = ?').run(at, id)
    return Number(res.changes) > 0
  }

  /** Mais uma tentativa automática posta na fila. */
  addAutoAttempt(id: string): void {
    this.db.prepare('UPDATE copiloto_followups SET auto_attempts = auto_attempts + 1 WHERE id = ?').run(id)
  }

  /**
   * v1.2.1: o Copiloto não respondeu à conferência antes do envio automático: adia para `at`, sem gastar a tentativa
   * (nunca envia no escuro, e uma rede ruim não tira o item do automático).
   */
  postponeAuto(id: string, at: number): void {
    this.db.prepare('UPDATE copiloto_followups SET auto_at = ?, auto_attempts = MAX(0, auto_attempts - 1) WHERE id = ?').run(at, id)
  }

  /** O envio automático deste item acabou: daqui em diante é o cartão da v1.1 (o mentor confirma). `true` se mudou. */
  setAutoOff(id: string): boolean {
    const res = this.db.prepare('UPDATE copiloto_followups SET auto_off = 1, auto_at = NULL, updated_at = ? WHERE id = ? AND auto_off = 0').run(this.clock.now(), id)
    return Number(res.changes) > 0
  }

  /** A opção foi desligada: os horários escolhidos deixam de valer (ligada de novo, escolhe outros). */
  clearAutoSchedule(): void {
    this.db.exec("UPDATE copiloto_followups SET auto_at = NULL WHERE local_status = 'waiting' AND auto_at IS NOT NULL")
  }

  /** O follow-up que um envio leva (pelo `send_id` gravado), ou null. */
  bySendId(sendId: number): FollowupRow | null {
    const r = this.db.prepare('SELECT * FROM copiloto_followups WHERE send_id = ? ORDER BY updated_at DESC LIMIT 1').get(sendId) as Row | undefined
    return r ? toRow(r) : null
  }

  /** Os envios (mensagem avulsa) deste follow-up: o id dele é o id do rascunho, dentro da chave de idempotência. */
  sendIdsOf(id: string, jid: string): number[] {
    return (
      this.db.prepare('SELECT id FROM sends WHERE kind = ? AND jid = ? AND idem_key LIKE ? ORDER BY id DESC').all('avulsa', jid, `avulsa:${jid}:${id}:%`) as Row[]
    ).map((r) => r.id as number)
  }

  /** Desligar a integração: esquece os follow-ups (os sem status voltam na próxima busca, se ligar de novo). */
  clearAll(): void {
    this.db.exec('DELETE FROM copiloto_followups')
  }

  /** Esquece os já confirmados pelo Copiloto há mais de `before`. */
  prune(before: number): void {
    this.db.prepare("DELETE FROM copiloto_followups WHERE (reported = 1 OR local_status = 'cancelled') AND updated_at < ?").run(before)
  }

  private tx(fn: () => void): void {
    if (this.db.isTransaction) {
      fn()
      return
    }
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
}
