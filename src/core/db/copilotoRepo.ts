import type { DatabaseSync } from 'node:sqlite'
import { systemClock, type Clock } from '../clock'
import { formatPhone } from './repo'

type Row = Record<string, any>

/** Um evento na fila de saída do Copiloto. */
export interface OutboxRow {
  eventId: string
  jid: string
  payloadJson: string
  payloadHash: string
  attempts: number
}

/** Uma referência local do que mudou (`copiloto_dirty`). */
export interface DirtyRef {
  ref: string
  jid: string
}

/** O básico da conversa para o `chat` do evento. */
export interface ChatBasic {
  jid: string
  isGroup: boolean
  /** nome personalizado, da agenda/perfil, ou (individual) o número formatado; grupo sem nome: null */
  name: string | null
}

/** Alerta com a avaliação do mentor (👍/👎 do alerta, ou, no "esperando", o "Para responder" ligado a ele). */
export interface AlertFull {
  id: number
  jid: string
  kind: string
  detail: string
  msgId: string | null
  source: 'ai' | 'rule' | 'user'
  createdAt: number
  dismissedAt: number | null
  feedback: { verdict: 'up' | 'down'; reasonCode: string | null; reasonText: string | null; correctKind: string | null } | null
}

/** Tabelas da integração com o Copiloto da Saga (v0.5.0) e as leituras que montam os eventos. */
export class CopilotoRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock
  ) {}

  // --- fila de saída ---

  /**
   * Põe (ou troca) o evento na fila. Mesmo id com o mesmo conteúdo já aceito ou na fila: nada muda (`false`).
   * Conteúdo novo: volta a pendente, com as tentativas zeradas. `force` (v0.8.1, reenvio dos grupos): volta a pendente
   * mesmo com o mesmo conteúdo já aceito (o servidor faz upsert pelo id; a fila continua com uma linha por id).
   */
  upsert(eventId: string, jid: string, payloadJson: string, payloadHash: string, force = false): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO copiloto_outbox(event_id, jid, payload_json, payload_hash, status, attempts, next_attempt_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', 0, 0, ?5)
         ON CONFLICT(event_id) DO UPDATE SET
           jid = excluded.jid, payload_json = excluded.payload_json, payload_hash = excluded.payload_hash,
           status = 'pending', attempts = 0, next_attempt_at = 0, last_status = NULL, updated_at = excluded.updated_at
         WHERE copiloto_outbox.payload_hash <> excluded.payload_hash OR (?6 = 1 AND copiloto_outbox.status <> 'pending')`
      )
      .run(eventId, jid, payloadJson, payloadHash, this.clock.now(), force ? 1 : 0)
    return Number(res.changes) > 0
  }

  /** Os pendentes que já podem sair, mais antigos primeiro. */
  due(now: number, limit: number): OutboxRow[] {
    return (
      this.db
        .prepare(
          `SELECT event_id, jid, payload_json, payload_hash, attempts FROM copiloto_outbox
            WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY updated_at, rowid LIMIT ?`
        )
        .all(now, limit) as Row[]
    ).map((r) => ({ eventId: r.event_id, jid: r.jid, payloadJson: r.payload_json, payloadHash: r.payload_hash, attempts: r.attempts }))
  }

  /** Quando sai o próximo pendente (epoch ms), ou null sem pendentes. */
  nextDueAt(): number | null {
    const r = this.db.prepare("SELECT MIN(next_attempt_at) AS t FROM copiloto_outbox WHERE status = 'pending'").get() as Row
    return typeof r.t === 'number' ? r.t : null
  }

  /**
   * Fecha os eventos de um lote respondido (`done`) ou recusado (`invalid`). Só fecha se o conteúdo ainda é o que foi
   * enviado: uma versão mais nova que chegou durante o pedido continua pendente. O texto sai da fila.
   */
  finish(rows: ReadonlyArray<Pick<OutboxRow, 'eventId' | 'payloadHash'>>, status: 'done' | 'invalid', lastStatus: (id: string) => string): void {
    const st = this.db.prepare(
      `UPDATE copiloto_outbox SET status = ?1, payload_json = '', last_status = ?2, updated_at = ?3
        WHERE event_id = ?4 AND payload_hash = ?5 AND status = 'pending'`
    )
    this.tx(() => {
      for (const r of rows) st.run(status, lastStatus(r.eventId), this.clock.now(), r.eventId, r.payloadHash)
    })
  }

  /** Lote que falhou (429, 5xx, rede): tenta de novo em `nextAt`. */
  retryLater(rows: ReadonlyArray<Pick<OutboxRow, 'eventId' | 'payloadHash'>>, nextAt: number, lastStatus: string): void {
    const st = this.db.prepare(
      `UPDATE copiloto_outbox SET attempts = attempts + 1, next_attempt_at = ?1, last_status = ?2
        WHERE event_id = ?3 AND payload_hash = ?4 AND status = 'pending'`
    )
    this.tx(() => {
      for (const r of rows) st.run(nextAt, lastStatus, r.eventId, r.payloadHash)
    })
  }

  pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM copiloto_outbox WHERE status = 'pending'").get() as Row).n
  }

  /** Tira da fila os pendentes de conversas que deixaram de ser de mentorados. Devolve quantos. */
  dropPendingExcept(jids: ReadonlySet<string>): number {
    const res = this.db
      .prepare("DELETE FROM copiloto_outbox WHERE status = 'pending' AND jid NOT IN (SELECT value FROM json_each(?))")
      .run(JSON.stringify([...jids]))
    return Number(res.changes)
  }

  /** Esquece os eventos já aceitos há mais de `before` (só a impressão deles fica aqui). */
  pruneDone(before: number): void {
    this.db.prepare("DELETE FROM copiloto_outbox WHERE status <> 'pending' AND updated_at < ?").run(before)
  }

  /** Desligar: apaga a fila, as mudanças anotadas e a carga inicial feita. */
  clearAll(): void {
    this.db.exec('DELETE FROM copiloto_outbox; DELETE FROM copiloto_dirty; DELETE FROM copiloto_chats;')
  }

  // --- o que mudou ---

  takeDirty(limit: number): DirtyRef[] {
    return (this.db.prepare('SELECT ref, jid FROM copiloto_dirty ORDER BY rowid LIMIT ?').all(limit) as Row[]).map((r) => ({ ref: r.ref, jid: r.jid }))
  }

  dirtyCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM copiloto_dirty').get() as Row).n
  }

  removeDirty(refs: ReadonlyArray<string>): void {
    const st = this.db.prepare('DELETE FROM copiloto_dirty WHERE ref = ?')
    this.tx(() => {
      for (const r of refs) st.run(r)
    })
  }

  addDirty(refs: ReadonlyArray<DirtyRef>): void {
    const st = this.db.prepare('INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES (?, ?)')
    this.tx(() => {
      for (const r of refs) st.run(r.ref, r.jid)
    })
  }

  // --- carga inicial ---

  isBackfilled(jid: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM copiloto_chats WHERE jid = ?').get(jid)
  }

  /**
   * Carga inicial de uma conversa de mentorado: anota tudo dos últimos dias (mensagens, alertas, envios, o "Para
   * responder" e o resumo) para virar evento, e marca a conversa como feita.
   * v0.8.1: grupo sem mensagem nos últimos dias leva a mais recente guardada aqui (seja de quando for), para o Copiloto
   * saber que o grupo existe. Devolve quantas mensagens anotou.
   */
  backfill(jid: string, since: number): number {
    let n = 0
    this.tx(() => {
      const ins = this.db.prepare('INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES (?, ?)')
      for (const id of this.backfillMessageIds(jid, since)) {
        ins.run(`m:${id}`, jid)
        n++
      }
      const extras = this.backfillExtras(jid, since)
      for (const id of extras.alerts) ins.run(`a:${id}`, jid)
      for (const id of extras.sends) ins.run(`x:${id}`, jid)
      ins.run(`r:${jid}`, jid)
      ins.run(`s:${jid}`, jid)
      this.markBackfilled(jid)
    })
    return n
  }

  /** As mensagens da carga: as dos últimos dias; grupo sem nenhuma nesse tempo, a mais recente guardada (ou nada). */
  backfillMessageIds(jid: string, since: number): string[] {
    const ids = (this.db.prepare('SELECT id FROM messages WHERE jid = ? AND ts >= ? ORDER BY ts, rowid').all(jid, since) as Row[]).map((r) => r.id as string)
    if (ids.length > 0 || !jid.endsWith('@g.us')) return ids
    const last = this.db.prepare('SELECT id FROM messages WHERE jid = ? ORDER BY ts DESC, rowid DESC LIMIT 1').get(jid) as Row | undefined
    return last ? [last.id as string] : []
  }

  /** Os alertas e os envios diretos da carga (os mesmos de `backfill`). */
  backfillExtras(jid: string, since: number): { alerts: number[]; sends: number[] } {
    return {
      alerts: (this.db.prepare('SELECT id FROM alerts WHERE jid = ?1 AND (created_at >= ?2 OR dismissed_at IS NULL)').all(jid, since) as Row[]).map((r) => r.id as number),
      sends: (this.db.prepare("SELECT id FROM sends WHERE jid = ? AND status = 'sent' AND sent_at >= ?").all(jid, since) as Row[]).map((r) => r.id as number)
    }
  }

  markBackfilled(jid: string): void {
    this.db.prepare('INSERT OR REPLACE INTO copiloto_chats(jid, backfilled_at) VALUES (?, ?)').run(jid, this.clock.now())
  }

  /** Esquece a carga desta conversa (v0.8.1: ela deixou de casar; quando casar de novo, a carga é refeita). */
  forgetChat(jid: string): void {
    this.db.prepare('DELETE FROM copiloto_chats WHERE jid = ?').run(jid)
  }

  /** Os grupos ainda sem carga feita (candidatos a casar com o roster). */
  groupsNotBackfilled(): string[] {
    return (
      this.db.prepare("SELECT jid FROM contacts WHERE is_group = 1 AND jid NOT IN (SELECT jid FROM copiloto_chats) ORDER BY jid").all() as Row[]
    ).map((r) => r.jid as string)
  }

  /** Todos os grupos deste computador: os com conversa e os conhecidos só pela consulta de participantes. */
  groupJids(): string[] {
    return (
      this.db
        .prepare("SELECT jid FROM contacts WHERE is_group = 1 UNION SELECT group_jid FROM group_sizes WHERE group_jid LIKE '%@g.us' ORDER BY 1")
        .all() as Row[]
    ).map((r) => r.jid as string)
  }

  chatCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM copiloto_chats').get() as Row).n
  }

  /** Esquece a carga das conversas que não são mais de mentorados (se voltarem, a carga é feita de novo). */
  forgetChatsExcept(jids: ReadonlySet<string>): void {
    this.db.prepare('DELETE FROM copiloto_chats WHERE jid NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify([...jids]))
  }

  // --- leituras para montar os eventos ---

  /** Todas as conversas (individuais e grupos). */
  listChats(): ChatBasic[] {
    return (this.db.prepare('SELECT jid, is_group, custom_name, push_name FROM contacts ORDER BY jid').all() as Row[]).map(toChat)
  }

  chat(jid: string): ChatBasic | null {
    const r = this.db.prepare('SELECT jid, is_group, custom_name, push_name FROM contacts WHERE jid = ?').get(jid) as Row | undefined
    return r ? toChat(r) : null
  }

  /** Quem participa do grupo: pela consulta de participantes e quem já mandou mensagem lá (telefone e/ou @lid). */
  groupParticipants(groupJid: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT member_jid AS j FROM group_members WHERE group_jid = ?1
           UNION SELECT DISTINCT sender_jid FROM messages WHERE jid = ?1 AND sender_jid IS NOT NULL`
        )
        .all(groupJid) as Row[]
    ).map((r) => r.j as string)
  }

  /** Os grupos de que esta pessoa participa (por qualquer forma do JID). */
  groupsOf(memberJids: ReadonlyArray<string>): string[] {
    return (
      this.db
        .prepare(
          `SELECT group_jid AS g FROM group_members WHERE member_jid IN (SELECT value FROM json_each(?1))
           UNION SELECT DISTINCT jid FROM messages WHERE sender_jid IN (SELECT value FROM json_each(?1)) AND jid LIKE '%@g.us'`
        )
        .all(JSON.stringify(memberJids)) as Row[]
    ).map((r) => r.g as string)
  }

  getAlert(id: number): AlertFull | null {
    const r = this.db
      .prepare(
        `SELECT a.*, f.verdict AS f_verdict, f.reason_code AS f_code, f.reason_text AS f_text, f.correct_kind AS f_kind,
                rf.verdict AS r_verdict, rf.reason_code AS r_code, rf.reason_text AS r_text
           FROM alerts a
           LEFT JOIN alert_feedback f ON f.alert_id = a.id AND f.verdict IN ('up', 'down')
           LEFT JOIN reply_feedback rf ON rf.alert_id = a.id
          WHERE a.id = ?`
      )
      .get(id) as Row | undefined
    if (!r) return null
    let feedback: AlertFull['feedback'] = null
    if (r.f_verdict) feedback = { verdict: r.f_verdict, reasonCode: r.f_code ?? null, reasonText: r.f_text ?? null, correctKind: r.f_kind ?? null }
    else if (r.r_verdict) {
      feedback = { verdict: r.r_verdict === 'reply_not_needed' ? 'down' : 'up', reasonCode: r.r_code ?? null, reasonText: r.r_text ?? null, correctKind: null }
    }
    return {
      id: r.id,
      jid: r.jid,
      kind: r.kind,
      detail: r.detail,
      msgId: r.msg_id ?? null,
      source: r.source ?? 'ai',
      createdAt: r.created_at,
      dismissedAt: r.dismissed_at ?? null,
      feedback
    }
  }

  /** A mensagem mais nova do contato (não do mentor) na conversa. */
  lastInbound(jid: string): { id: string; ts: number } | null {
    const r = this.db.prepare('SELECT id, ts FROM messages WHERE jid = ? AND from_me = 0 ORDER BY ts DESC, rowid DESC LIMIT 1').get(jid) as Row | undefined
    return r ? { id: r.id, ts: r.ts } : null
  }

  /** Quando a decisão do "Para responder" mudou por último (decisão guardada e avaliação do mentor). */
  replyUpdatedAt(jid: string): number | null {
    const r = this.db
      .prepare(
        `SELECT MAX(COALESCE((SELECT updated_at FROM reply_checks WHERE jid = ?1), 0),
                    COALESCE((SELECT MAX(created_at) FROM reply_feedback WHERE jid = ?1), 0)) AS t`
      )
      .get(jid) as Row
    return r.t > 0 ? r.t : null
  }

  /** O motivo que o mentor deu para "Não precisa responder" nesta mensagem, ou null. */
  replyReasonCode(jid: string, msgId: string): string | null {
    const r = this.db
      .prepare("SELECT reason_code FROM reply_feedback WHERE jid = ? AND msg_id = ? AND verdict = 'reply_not_needed'")
      .get(jid, msgId) as Row | undefined
    return r?.reason_code ?? null
  }

  /** Esta mensagem minha saiu pelo envio direto do SagaZap (confirmado pelo mentor)? */
  sentViaApp(jid: string, msgId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM sends WHERE jid = ?1 AND status = 'sent'
            AND (wa_msg_id = ?2 OR EXISTS (SELECT 1 FROM json_each(sends.msg_ids_json) WHERE value = ?2)) LIMIT 1`
      )
      .get(jid, msgId)
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

function toChat(r: Row): ChatBasic {
  const isGroup = r.is_group === 1
  return { jid: r.jid, isGroup, name: r.custom_name ?? r.push_name ?? (isGroup ? null : formatPhone(r.jid)) }
}
