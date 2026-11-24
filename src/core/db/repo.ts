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

export interface EventRow {
  id: number
  ts: number
  kind: string
  detail: string
}

type Row = Record<string, any>

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
    return rows.map((r) => ({
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
    }))
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
}
