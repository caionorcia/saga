import type { DatabaseSync } from 'node:sqlite'
import { systemClock, type Clock } from '../clock'
import type { ConvoGoal, ConvoStatus, ConvoType } from '../../shared/copiloto'
import type { PendingConvo } from '../copiloto/followups'

type Row = Record<string, any>

/** Uma conversa de follow-up (onboarding/sumido) no banco (`copiloto_convos`, v0.10.0). */
export interface ConvoRow {
  id: string
  type: ConvoType
  targetJson: string
  author: string | null
  createdAt: number
  receivedAt: number
  jid: string | null
  goal: ConvoGoal
  itemsDone: string[]
  status: ConvoStatus
  reason: string | null
  day0At: number
  /** recebida com o modo de teste ligado (1 dia = 2 min) */
  testMode: boolean
  slot: number
  attempts: number
  lastAttemptAt: number | null
  lastSentAt: number | null
  awaitingReply: boolean
  repliedAt: number | null
  handledTs: number
  draftId: string | null
  draftKind: 'attempt' | 'reply' | null
  draftSlot: number | null
  draftText: string | null
  draftState: 'ready' | 'approved' | 'sending' | null
  draftAt: number | null
  draftForced: boolean
  draftSendId: number | null
  draftError: string | null
  draftSummary: string | null
  needsYou: string | null
  aiError: string | null
  suggestScheduled: boolean
  suggestItems: string[]
  summary: string | null
  updatedAt: number
}

const json = <T>(s: unknown, fallback: T): T => {
  try {
    return typeof s === 'string' ? (JSON.parse(s) as T) : fallback
  } catch {
    return fallback
  }
}

function toRow(r: Row): ConvoRow {
  return {
    id: r.id,
    type: r.type,
    targetJson: r.target_json,
    author: r.author ?? null,
    createdAt: r.created_at,
    receivedAt: r.received_at,
    jid: r.jid ?? null,
    goal: json<ConvoGoal>(r.goal_json, { pendingItems: [], schedulingLink: null, note: null, cadenceDays: [0], sendMode: 'confirm' }),
    itemsDone: json<string[]>(r.items_done_json, []),
    status: r.status,
    reason: r.reason ?? null,
    day0At: r.day0_at,
    testMode: r.test_mode === 1,
    slot: r.slot,
    attempts: r.attempts,
    lastAttemptAt: r.last_attempt_at ?? null,
    lastSentAt: r.last_sent_at ?? null,
    awaitingReply: r.awaiting_reply === 1,
    repliedAt: r.replied_at ?? null,
    handledTs: r.handled_ts ?? 0,
    draftId: r.draft_id ?? null,
    draftKind: r.draft_kind ?? null,
    draftSlot: r.draft_slot ?? null,
    draftText: r.draft_text ?? null,
    draftState: r.draft_state ?? null,
    draftAt: r.draft_at ?? null,
    draftForced: r.draft_forced === 1,
    draftSendId: r.draft_send_id ?? null,
    draftError: r.draft_error ?? null,
    draftSummary: r.draft_summary ?? null,
    needsYou: r.needs_you ?? null,
    aiError: r.ai_error ?? null,
    suggestScheduled: r.suggest_scheduled === 1,
    suggestItems: json<string[]>(r.suggest_items_json, []),
    summary: r.summary ?? null,
    updatedAt: r.updated_at
  }
}

/** Campos que mudam (os nomes do `ConvoRow`); `undefined` = fica como está. */
export type ConvoPatch = Partial<Omit<ConvoRow, 'id' | 'type' | 'targetJson' | 'author' | 'createdAt' | 'receivedAt' | 'updatedAt' | 'testMode'>>

const COLUMN: Record<keyof ConvoPatch, string> = {
  jid: 'jid',
  goal: 'goal_json',
  itemsDone: 'items_done_json',
  status: 'status',
  reason: 'reason',
  day0At: 'day0_at',
  slot: 'slot',
  attempts: 'attempts',
  lastAttemptAt: 'last_attempt_at',
  lastSentAt: 'last_sent_at',
  awaitingReply: 'awaiting_reply',
  repliedAt: 'replied_at',
  handledTs: 'handled_ts',
  draftId: 'draft_id',
  draftKind: 'draft_kind',
  draftSlot: 'draft_slot',
  draftText: 'draft_text',
  draftState: 'draft_state',
  draftAt: 'draft_at',
  draftForced: 'draft_forced',
  draftSendId: 'draft_send_id',
  draftError: 'draft_error',
  draftSummary: 'draft_summary',
  needsYou: 'needs_you',
  aiError: 'ai_error',
  suggestScheduled: 'suggest_scheduled',
  suggestItems: 'suggest_items_json',
  summary: 'summary'
}

function dbValue(v: unknown): string | number | null {
  if (v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number' || typeof v === 'string') return v
  return JSON.stringify(v)
}

/** O rascunho sai inteiro de cena (usado ao terminar, ao trocar e ao pular). */
export const NO_DRAFT: ConvoPatch = {
  draftId: null,
  draftKind: null,
  draftSlot: null,
  draftText: null,
  draftState: null,
  draftAt: null,
  draftForced: false,
  draftSendId: null,
  draftError: null,
  draftSummary: null
}

/** Um relatório da fila (`copiloto_convo_reports`). */
export interface ConvoReportRow {
  seq: number
  convoId: string
  status: string
  payload: Record<string, unknown>
  attempts: number
}

const ACTIVE = "('active', 'responded')"

/**
 * Conversas de follow-up. Mudanças condicionais ao estado atual (`from`): uma conversa encerrada nunca volta a andar,
 * e um rascunho que já foi para a fila nunca é trocado por outro.
 */
export class ConvoRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock
  ) {}

  /** Guarda uma conversa nova (dedupe pelo id). `true` se entrou. */
  insert(c: PendingConvo, jid: string | null, status: ConvoStatus, day0At: number, o: { reason?: string | null; testMode?: boolean } = {}): boolean {
    const now = this.clock.now()
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO copiloto_convos(id, type, target_json, author, created_at, received_at, jid, goal_json, status, reason, day0_at, test_mode, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(c.id, c.type, JSON.stringify(c.target), c.author, c.createdAt, now, jid, JSON.stringify(c.goal), status, o.reason ?? null, day0At, o.testMode ? 1 : 0, now)
    return Number(res.changes) > 0
  }

  get(id: string): ConvoRow | null {
    const r = this.db.prepare('SELECT * FROM copiloto_convos WHERE id = ?').get(id) as Row | undefined
    return r ? toRow(r) : null
  }

  has(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM copiloto_convos WHERE id = ?').get(id)
  }

  /** As que estão andando (com conversa local), mais antigas primeiro. */
  listActive(): Array<ConvoRow & { jid: string }> {
    return (this.db.prepare(`SELECT * FROM copiloto_convos WHERE jid IS NOT NULL AND status IN ${ACTIVE} ORDER BY created_at, id`).all() as Row[]).map(
      (r) => toRow(r) as ConvoRow & { jid: string }
    )
  }

  activeCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM copiloto_convos WHERE jid IS NOT NULL AND status IN ${ACTIVE}`).get() as Row).n
  }

  /** O que a interface mostra: as que andam e, por `recentMs`, as encerradas (menos as paradas pela equipe). */
  listVisible(recentMs: number): Array<ConvoRow & { jid: string }> {
    const since = this.clock.now() - recentMs
    return (
      this.db
        .prepare(
          `SELECT * FROM copiloto_convos WHERE jid IS NOT NULL AND (status IN ${ACTIVE} OR (status <> 'cancelled' AND updated_at >= ?)) ORDER BY created_at, id`
        )
        .all(since) as Row[]
    ).map((r) => toRow(r) as ConvoRow & { jid: string })
  }

  /** A conversa que andando leva este envio (pelo `draft_send_id`), ou null. */
  bySendId(sendId: number): ConvoRow | null {
    const r = this.db.prepare('SELECT * FROM copiloto_convos WHERE draft_send_id = ? LIMIT 1').get(sendId) as Row | undefined
    return r ? toRow(r) : null
  }

  /** Muda campos; com `from`, só se o estado atual for um deles. `true` se mudou. */
  patch(id: string, p: ConvoPatch, from?: ReadonlyArray<ConvoStatus>): boolean {
    const set: string[] = ['updated_at = ?']
    const args: Array<string | number | null> = [this.clock.now()]
    for (const [k, v] of Object.entries(p) as Array<[keyof ConvoPatch, unknown]>) {
      if (v === undefined) continue
      set.push(`${COLUMN[k]} = ?`)
      args.push(dbValue(v))
    }
    const where = from ? ' AND status IN (SELECT value FROM json_each(?))' : ''
    const res = this.db.prepare(`UPDATE copiloto_convos SET ${set.join(', ')} WHERE id = ?${where}`).run(...args, id, ...(from ? [JSON.stringify(from)] : []))
    return Number(res.changes) > 0
  }

  /** O rascunho só muda se ainda for o mesmo (`draftId`) e no estado `fromState`. `true` se mudou. */
  patchDraft(id: string, draftId: string, fromState: ReadonlyArray<'ready' | 'approved' | 'sending'>, p: ConvoPatch): boolean {
    const set: string[] = ['updated_at = ?']
    const args: Array<string | number | null> = [this.clock.now()]
    for (const [k, v] of Object.entries(p) as Array<[keyof ConvoPatch, unknown]>) {
      if (v === undefined) continue
      set.push(`${COLUMN[k]} = ?`)
      args.push(dbValue(v))
    }
    const res = this.db
      .prepare(
        `UPDATE copiloto_convos SET ${set.join(', ')} WHERE id = ? AND draft_id = ? AND status IN ${ACTIVE} AND draft_state IN (SELECT value FROM json_each(?))`
      )
      .run(...args, id, draftId, JSON.stringify(fromState))
    return Number(res.changes) > 0
  }

  // --- relatórios (`followup_update` v2) ---

  addReport(convoId: string, status: string, payload: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO copiloto_convo_reports(convo_id, status, payload_json, created_at) VALUES (?, ?, ?, ?)')
      .run(convoId, status, JSON.stringify(payload), this.clock.now())
  }

  /** Os relatórios que já podem ir, na ordem em que aconteceram. */
  dueReports(now: number, limit: number): ConvoReportRow[] {
    return (
      this.db.prepare('SELECT * FROM copiloto_convo_reports WHERE done = 0 AND next_at <= ? ORDER BY seq LIMIT ?').all(now, limit) as Row[]
    ).map((r) => ({ seq: r.seq, convoId: r.convo_id, status: r.status, payload: json<Record<string, unknown>>(r.payload_json, {}), attempts: r.attempts }))
  }

  nextReportAt(): number | null {
    const r = this.db.prepare('SELECT MIN(next_at) AS t FROM copiloto_convo_reports WHERE done = 0').get() as Row
    return typeof r.t === 'number' ? r.t : null
  }

  pendingReports(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM copiloto_convo_reports WHERE done = 0').get() as Row).n
  }

  markReportDone(seq: number, result: string): void {
    this.db.prepare('UPDATE copiloto_convo_reports SET done = 1, last_result = ? WHERE seq = ?').run(result, seq)
  }

  /** A conversa acabou do lado do Copiloto (cancelada/duplicada): o que ainda estava na fila não vai mais. */
  dropReports(convoId: string, result: string): void {
    this.db.prepare('UPDATE copiloto_convo_reports SET done = 1, last_result = ? WHERE convo_id = ? AND done = 0').run(result, convoId)
  }

  retryReports(seqs: ReadonlyArray<number>, at: number, result: string): void {
    const st = this.db.prepare('UPDATE copiloto_convo_reports SET attempts = attempts + 1, next_at = ?, last_result = ? WHERE seq = ? AND done = 0')
    for (const s of seqs) st.run(at, result, s)
  }

  /** Os relatórios de uma conversa (testes e diagnóstico). */
  reportsOf(convoId: string): Array<{ status: string; payload: Record<string, unknown>; done: boolean; lastResult: string | null }> {
    return (this.db.prepare('SELECT * FROM copiloto_convo_reports WHERE convo_id = ? ORDER BY seq').all(convoId) as Row[]).map((r) => ({
      status: r.status,
      payload: json<Record<string, unknown>>(r.payload_json, {}),
      done: r.done === 1,
      lastResult: r.last_result ?? null
    }))
  }

  clearAll(): void {
    this.db.exec('DELETE FROM copiloto_convos')
    this.db.exec('DELETE FROM copiloto_convo_reports')
  }

  /** Esquece as encerradas há mais de `before` (com os relatórios já confirmados). */
  prune(before: number): void {
    this.db.prepare(`DELETE FROM copiloto_convos WHERE status NOT IN ${ACTIVE} AND updated_at < ?`).run(before)
    this.db.prepare('DELETE FROM copiloto_convo_reports WHERE done = 1 AND created_at < ?').run(before)
  }
}
