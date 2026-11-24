import type { DatabaseSync } from 'node:sqlite'
import { systemClock, type Clock } from '../clock'
import type { NormalizedMessage } from '../types'

export type TranscriptStatus = 'done' | 'failed' | 'unavailable'

export interface ContactRow {
  jid: string
  pushName: string | null
  customName: string | null
  hidden: boolean
  notes: string | null
  displayName: string
  lastTs: number | null
  awaitingReply: boolean
}

export interface MessageRow {
  id: string
  jid: string
  fromMe: boolean
  ts: number
  kind: 'text' | 'audio' | 'other'
  text: string | null
  mediaKeyJson: string | null
  durationSec: number | null
  audioPath: string | null
  transcript: string | null
  transcriptStatus: TranscriptStatus | null
}

export interface AnalysisRow {
  jid: string
  lastMsgId: string
  provider: string
  summary: string
  suggestions: string[]
  createdAt: number
}

export interface ApprovedRow {
  id: number
  jid: string
  contextText: string
  originalSuggestion: string | null
  finalText: string
  sentText: string | null
  provider: string | null
  createdAt: number
}

export interface EventRow {
  id: number
  ts: number
  kind: string
  detail: string
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

export interface JobRow {
  id: number
  type: string
  key: string
  payload: unknown
  status: JobStatus
  attempts: number
  nextRunAt: number
  priority: number
  lastError: string | null
}

type Row = Record<string, any>

function toJob(r: Row): JobRow {
  return {
    id: r.id,
    type: r.type,
    key: r.key,
    payload: JSON.parse(r.payload_json),
    status: r.status,
    attempts: r.attempts,
    nextRunAt: r.next_run_at,
    priority: r.priority,
    lastError: r.last_error
  }
}

function toApproved(r: Row): ApprovedRow {
  return {
    id: r.id,
    jid: r.jid,
    contextText: r.context_text,
    originalSuggestion: r.original_suggestion,
    finalText: r.final_text,
    sentText: r.sent_text,
    provider: r.provider,
    createdAt: r.created_at
  }
}

function toMessage(r: Row): MessageRow {
  return {
    id: r.id,
    jid: r.jid,
    fromMe: r.from_me === 1,
    ts: r.ts,
    kind: r.kind,
    text: r.text,
    mediaKeyJson: r.media_key_json,
    durationSec: r.duration_sec,
    audioPath: r.audio_path,
    transcript: r.transcript,
    transcriptStatus: r.transcript_status
  }
}

/** `5547999998888@s.whatsapp.net` -> `+55 47 99999-8888` */
export function formatPhone(jid: string): string {
  const digits = jid.split('@')[0].split(':')[0].replace(/\D/g, '')
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits)
  if (m) return `+55 ${m[1]} ${m[2]}-${m[3]}`
  return digits ? `+${digits}` : jid
}

export class Repo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock
  ) {}

  // --- contatos ---

  upsertContact(c: { jid: string; pushName?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO contacts(jid, push_name) VALUES (?, ?)
         ON CONFLICT(jid) DO UPDATE SET push_name = COALESCE(excluded.push_name, push_name)`
      )
      .run(c.jid, c.pushName ?? null)
  }

  renameContact(jid: string, name: string): void {
    this.db.prepare('UPDATE contacts SET custom_name = ? WHERE jid = ?').run(name.trim() || null, jid)
  }

  setHidden(jid: string, hidden: boolean): void {
    this.db.prepare('UPDATE contacts SET hidden = ? WHERE jid = ?').run(hidden ? 1 : 0, jid)
  }

  setNotes(jid: string, text: string): void {
    this.db.prepare('UPDATE contacts SET notes = ? WHERE jid = ?').run(text, jid)
  }

  listContacts(opts: { includeHidden: boolean }): ContactRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.jid, c.push_name, c.custom_name, c.hidden, c.notes,
                l.ts AS last_ts, l.from_me AS last_from_me
           FROM contacts c
           LEFT JOIN messages l ON l.id = (
             SELECT id FROM messages WHERE jid = c.jid ORDER BY ts DESC, rowid DESC LIMIT 1)
          WHERE (? = 1 OR c.hidden = 0)
          ORDER BY l.ts IS NULL, l.ts DESC, c.jid`
      )
      .all(opts.includeHidden ? 1 : 0) as Row[]
    return rows.map((r) => ({
      jid: r.jid,
      pushName: r.push_name,
      customName: r.custom_name,
      hidden: r.hidden === 1,
      notes: r.notes,
      displayName: r.custom_name ?? r.push_name ?? formatPhone(r.jid),
      lastTs: r.last_ts,
      awaitingReply: r.last_from_me === 0
    }))
  }

  // --- mensagens ---

  insertMessage(m: NormalizedMessage): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages(id, jid, from_me, ts, kind, text, media_key_json, duration_sec)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(m.id, m.jid, m.fromMe ? 1 : 0, m.ts, m.kind, m.text, m.mediaKeyJson, m.durationSec)
    return Number(res.changes) > 0
  }

  /** Últimas `limit` mensagens (todas, sem limite), em ordem cronológica. */
  listMessages(jid: string, limit?: number): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT rowid AS rid, * FROM messages WHERE jid = ? ORDER BY ts DESC, rowid DESC LIMIT ?)
         ORDER BY ts ASC, rid ASC`
      )
      .all(jid, limit ?? -1) as Row[]
    return rows.map(toMessage)
  }

  getMessage(id: string): MessageRow | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined
    return r ? toMessage(r) : null
  }

  setAudioPath(id: string, path: string): void {
    this.db.prepare('UPDATE messages SET audio_path = ? WHERE id = ?').run(path, id)
  }

  setTranscript(id: string, text: string | null, status: TranscriptStatus): void {
    this.db.prepare('UPDATE messages SET transcript = ?, transcript_status = ? WHERE id = ?').run(text, status, id)
  }

  // --- análises ---

  saveAnalysis(jid: string, lastMsgId: string, provider: string, summary: string, suggestions: string[]): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO analyses(jid, last_msg_id, provider, summary, suggestions_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(jid, lastMsgId, provider, summary, JSON.stringify(suggestions), this.clock.now())
  }

  getAnalysis(jid: string): AnalysisRow | null {
    const r = this.db.prepare('SELECT * FROM analyses WHERE jid = ?').get(jid) as Row | undefined
    if (!r) return null
    return {
      jid: r.jid,
      lastMsgId: r.last_msg_id,
      provider: r.provider,
      summary: r.summary,
      suggestions: JSON.parse(r.suggestions_json) as string[],
      createdAt: r.created_at
    }
  }

  // --- respostas aprovadas (memória) ---

  insertApproved(a: {
    jid: string
    contextText: string
    originalSuggestion: string | null
    finalText: string
    provider: string | null
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO approved_replies(jid, context_text, original_suggestion, final_text, provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(a.jid, a.contextText, a.originalSuggestion, a.finalText, a.provider, this.clock.now())
    return Number(res.lastInsertRowid)
  }

  /** Mais recentes primeiro. `jid` null = qualquer contato. */
  listApproved(opts: { jid?: string | null; limit: number; excludeIds?: number[] }): ApprovedRow[] {
    const ex = opts.excludeIds ?? []
    const rows = this.db
      .prepare(
        `SELECT * FROM approved_replies
         WHERE (?1 IS NULL OR jid = ?1) AND id NOT IN (SELECT value FROM json_each(?2))
         ORDER BY created_at DESC, id DESC LIMIT ?3`
      )
      .all(opts.jid ?? null, JSON.stringify(ex), opts.limit) as Row[]
    return rows.map(toApproved)
  }

  /** Busca FTS5 (`match` já no formato FTS5), melhores primeiro por bm25. */
  searchApproved(match: string, limit: number, excludeIds: number[] = []): ApprovedRow[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM approved_fts f JOIN approved_replies a ON a.id = f.rowid
         WHERE approved_fts MATCH ? AND a.id NOT IN (SELECT value FROM json_each(?))
         ORDER BY bm25(approved_fts), a.id DESC LIMIT ?`
      )
      .all(match, JSON.stringify(excludeIds), limit) as Row[]
    return rows.map(toApproved)
  }

  /** Aprovadas do contato, ainda sem `sent_text`, criadas em [fromTs, toTs]. */
  listUnsentApproved(jid: string, fromTs: number, toTs: number): ApprovedRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM approved_replies
         WHERE jid = ? AND sent_text IS NULL AND created_at >= ? AND created_at <= ?
         ORDER BY created_at DESC, id DESC`
      )
      .all(jid, fromTs, toTs) as Row[]
    return rows.map(toApproved)
  }

  setApprovedSentText(id: number, text: string): void {
    this.db.prepare('UPDATE approved_replies SET sent_text = ? WHERE id = ?').run(text, id)
  }

  // --- eventos ---

  logEvent(kind: string, detail: string): void {
    this.db.prepare('INSERT INTO events(ts, kind, detail) VALUES (?, ?, ?)').run(this.clock.now(), kind, detail)
  }

  recentEvents(limit: number): EventRow[] {
    return this.db
      .prepare('SELECT id, ts, kind, detail FROM events ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as EventRow[]
  }

  // --- configurações genéricas ---

  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings_kv WHERE key = ?').get(key) as Row | undefined
    return r ? r.value : null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings_kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings_kv WHERE key = ?').run(key)
  }

  // --- fila de jobs ---

  insertJobIgnore(type: string, key: string, payload: unknown, priority: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs(type, key, payload_json, status, priority) VALUES (?, ?, ?, 'pending', ?)`
      )
      .run(type, key, JSON.stringify(payload), priority)
  }

  /** Melhor job pendente elegível (prioridade maior, depois id menor) de um tipo. */
  nextPendingJob(type: string, now: number): JobRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status = 'pending' AND type = ? AND next_run_at <= ?
         ORDER BY priority DESC, id ASC LIMIT 1`
      )
      .get(type, now) as Row | undefined
    return r ? toJob(r) : null
  }

  listJobs(status: JobStatus): JobRow[] {
    return (this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY id').all(status) as Row[]).map(toJob)
  }

  /** Para cada tipo, o menor next_run_at entre os pendentes. */
  pendingNextRunByType(): Array<{ type: string; nextRunAt: number }> {
    return (
      this.db
        .prepare(`SELECT type, MIN(next_run_at) AS n FROM jobs WHERE status = 'pending' GROUP BY type`)
        .all() as Row[]
    ).map((r) => ({ type: r.type, nextRunAt: r.n }))
  }

  markJobRunning(id: number): void {
    this.db.prepare(`UPDATE jobs SET status = 'running' WHERE id = ?`).run(id)
  }

  markJobDone(id: number): void {
    this.db.prepare(`UPDATE jobs SET status = 'done', last_error = NULL WHERE id = ?`).run(id)
  }

  /** Registra a falha: volta a pending com `nextRunAt`, ou failed se `nextRunAt` for null. */
  markJobFailed(id: number, attempts: number, error: string, nextRunAt: number | null): void {
    this.db
      .prepare(`UPDATE jobs SET status = ?, attempts = ?, last_error = ?, next_run_at = COALESCE(?, next_run_at) WHERE id = ?`)
      .run(nextRunAt === null ? 'failed' : 'pending', attempts, error, nextRunAt, id)
  }

  retryJob(id: number): void {
    this.db
      .prepare(`UPDATE jobs SET status = 'pending', attempts = 0, next_run_at = 0 WHERE id = ? AND status = 'failed'`)
      .run(id)
  }

  jobCounts(): Record<JobStatus, number> {
    const out: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 }
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS c FROM jobs GROUP BY status').all() as Row[]) {
      out[r.status as JobStatus] = r.c
    }
    return out
  }
}
