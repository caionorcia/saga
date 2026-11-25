import type { DatabaseSync } from 'node:sqlite'
import { systemClock, type Clock } from '../clock'
import type { NormalizedMessage } from '../types'
import { ALERT_KINDS, AI_ALERT_KINDS, alertSeverity, type AlertKind } from '../../shared/triage'
import type { ReasonCode, Verdict } from '../../shared/feedback'

/** Qualidade da fonte do nome guardado em `push_name` (maior vence; empate: o mais novo). */
export const NAME_RANK = { push: 1, profile: 2, addressBook: 3 } as const

export type TranscriptStatus = 'done' | 'failed' | 'unavailable'

/** Filtro da lista de conversas: todas, só pessoas ou só grupos. */
export type ContactKind = 'all' | 'individual' | 'group'

export { ALERT_KINDS, AI_ALERT_KINDS, alertSeverity, type AlertKind }

/** De onde veio o alerta: a IA, a regra "esperando" ou o próprio mentor ("Faltou um alerta?", tipo certo do 👎). */
export type AlertSource = 'ai' | 'rule' | 'user'

export interface AlertRow {
  id: number
  jid: string
  kind: AlertKind
  /** o quê e por quê, em pt-BR (até 120 caracteres) */
  detail: string
  /** mensagem que motivou o alerta (para rolar até ela), ou null */
  msgId: string | null
  createdAt: number
  source: AlertSource
  /** avaliação do mentor para este alerta (👍 = 'up'), ou null */
  rating: Verdict | null
}

/** Uma avaliação de alerta: um exemplo rotulado completo (com a janela de mensagens que a IA viu). */
export interface FeedbackRow {
  id: number
  alertId: number | null
  jid: string
  kind: AlertKind
  msgId: string | null
  verdict: Verdict
  reasonCode: ReasonCode | null
  reasonText: string | null
  /** 👎 "Não é esse tipo": o tipo certo; null = nenhum ou não informado */
  correctKind: AlertKind | null
  contextText: string
  detail: string
  model: string | null
  createdAt: number
}

/** Nome exibido de um grupo que ainda não tem assunto conhecido. */
export const UNNAMED_GROUP = 'Grupo sem nome'

export interface ContactRow {
  jid: string
  pushName: string | null
  customName: string | null
  hidden: boolean
  notes: string | null
  displayName: string
  lastTs: number | null
  /** a última mensagem não é do mentor (num grupo: de qualquer participante) */
  awaitingReply: boolean
  /** conversa de grupo (`@g.us`) */
  isGroup: boolean
  /**
   * aguardando resposta desde (epoch ms, horário do WhatsApp): a primeira mensagem do contato depois da última
   * do mentor; null quando o mentor falou por último (ou não há mensagens)
   */
  waitingSince: number | null
  /** tipos de alerta ativos, do mais grave para o menos grave */
  alerts: AlertKind[]
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
  /** grupo: quem mandou (null nas minhas e em conversas individuais) */
  senderJid: string | null
  /** grupo: o pushName de quem mandou, como chegou na mensagem */
  senderName: string | null
  /**
   * grupo: nome para exibir de quem mandou: nome personalizado ou da agenda/perfil desse contato,
   * senão o pushName da mensagem, senão o número. null nas minhas e em conversas individuais.
   */
  senderLabel: string | null
  /** grupo: a mensagem menciona o mentor ou cita uma mensagem dele */
  mentionsMe: boolean
}

export interface AnalysisRow {
  jid: string
  lastMsgId: string
  provider: string
  summary: string
  suggestions: string[]
  createdAt: number
  /** impressão das transcrições do contexto usado (muda quando um áudio termina de ser transcrito) */
  transcriptFp: string
  /** áudios do contexto que ainda estavam sendo transcritos quando a análise foi feita */
  pendingAudios: number
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

const ALERT_ORDER_SQL = `CASE kind ${ALERT_KINDS.map((k, i) => `WHEN '${k}' THEN ${i}`).join(' ')} END`

function sortKinds(csv: string | null): AlertKind[] {
  if (!csv) return []
  return [...new Set(csv.split(',').filter((k): k is AlertKind => (ALERT_KINDS as readonly string[]).includes(k)))].sort(
    (a, b) => alertSeverity(a) - alertSeverity(b)
  )
}

function toAlert(r: Row): AlertRow {
  return {
    id: r.id,
    jid: r.jid,
    kind: r.kind,
    detail: r.detail,
    msgId: r.msg_id ?? null,
    createdAt: r.created_at,
    source: r.source ?? 'ai',
    rating: r.rating ?? null
  }
}

function toFeedback(r: Row): FeedbackRow {
  return {
    id: r.id,
    alertId: r.alert_id ?? null,
    jid: r.jid,
    kind: r.kind,
    msgId: r.msg_id ?? null,
    verdict: r.verdict,
    reasonCode: r.reason_code ?? null,
    reasonText: r.reason_text ?? null,
    correctKind: r.correct_kind ?? null,
    contextText: r.context_text,
    detail: r.detail,
    model: r.model ?? null,
    createdAt: r.created_at
  }
}

const RATING_SQL = '(SELECT f.verdict FROM alert_feedback f WHERE f.alert_id = a.id) AS rating'

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
    transcriptStatus: r.transcript_status,
    senderJid: r.sender_jid ?? null,
    senderName: r.sender_name ?? null,
    senderLabel: r.sender_jid
      ? (r.s_custom ?? (r.s_rank >= NAME_RANK.profile ? r.s_push : null) ?? r.sender_name ?? r.s_push ?? formatPhone(r.sender_jid))
      : null,
    mentionsMe: r.mentions_me === 1
  }
}

/** Colunas extras do contato de quem mandou (grupos), para `senderLabel`. */
const SENDER_COLS = 'sc.custom_name AS s_custom, sc.push_name AS s_push, sc.name_rank AS s_rank'

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

  /**
   * Cria o contato se preciso e guarda o nome se ele não for pior que o atual (`nameRank`:
   * 1 = pushName de mensagem, 2 = perfil/chat, 3 = agenda; veja `NAME_RANK`). O nome personalizado
   * (`custom_name`) fica separado e sempre vence na exibição.
   */
  upsertContact(c: { jid: string; pushName?: string | null; nameRank?: number; isGroup?: boolean }): void {
    const name = c.pushName ?? null
    const rank = name === null ? 0 : (c.nameRank ?? NAME_RANK.push)
    this.db
      .prepare(
        `INSERT INTO contacts(jid, push_name, name_rank, is_group) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(jid) DO UPDATE SET
           is_group = MAX(is_group, excluded.is_group),
           push_name = CASE WHEN excluded.push_name IS NOT NULL AND excluded.name_rank >= name_rank
                            THEN excluded.push_name ELSE push_name END,
           name_rank = CASE WHEN excluded.push_name IS NOT NULL AND excluded.name_rank >= name_rank
                            THEN excluded.name_rank ELSE name_rank END`
      )
      .run(c.jid, name, rank, c.isGroup ? 1 : 0)
  }

  /** Guarda o nome de um contato que já existe, se não for pior que o atual. `true` se mudou. */
  setContactName(jid: string, name: string, rank: number): boolean {
    const res = this.db
      .prepare('UPDATE contacts SET push_name = ?1, name_rank = ?2 WHERE jid = ?3 AND name_rank <= ?2 AND (push_name IS NOT ?1 OR name_rank < ?2)')
      .run(name, rank, jid)
    return Number(res.changes) > 0
  }

  renameContact(jid: string, name: string): void {
    this.db.prepare('UPDATE contacts SET custom_name = ? WHERE jid = ?').run(name.trim() || null, jid)
  }

  setHidden(jid: string, hidden: boolean): void {
    this.db.prepare('UPDATE contacts SET hidden = ? WHERE jid = ?').run(hidden ? 1 : 0, jid)
  }

  isGroup(jid: string): boolean {
    const r = this.db.prepare('SELECT is_group FROM contacts WHERE jid = ?').get(jid) as Row | undefined
    return r?.is_group === 1
  }

  isHidden(jid: string): boolean {
    const r = this.db.prepare('SELECT hidden FROM contacts WHERE jid = ?').get(jid) as Row | undefined
    return r?.hidden === 1
  }

  setNotes(jid: string, text: string): void {
    this.db.prepare('UPDATE contacts SET notes = ? WHERE jid = ?').run(text, jid)
  }

  listContacts(opts: { includeHidden: boolean; kind?: ContactKind }): ContactRow[] {
    const kind = opts.kind ?? 'all'
    const rows = this.db
      .prepare(
        `SELECT c.jid, c.push_name, c.custom_name, c.hidden, c.notes, c.is_group,
                l.ts AS last_ts, l.from_me AS last_from_me,
                CASE WHEN l.from_me = 0 THEN (
                  SELECT MIN(w.ts) FROM messages w
                   WHERE w.jid = c.jid AND w.from_me = 0
                     AND w.ts > COALESCE((SELECT MAX(me.ts) FROM messages me WHERE me.jid = c.jid AND me.from_me = 1), -1)
                ) END AS waiting_since,
                (SELECT group_concat(a.kind) FROM alerts a WHERE a.jid = c.jid AND a.dismissed_at IS NULL) AS alert_kinds
           FROM contacts c
           LEFT JOIN messages l ON l.id = (
             SELECT id FROM messages WHERE jid = c.jid ORDER BY ts DESC, rowid DESC LIMIT 1)
          WHERE (?1 = 1 OR c.hidden = 0)
            AND (?2 = 'all' OR (?2 = 'group') = (c.is_group = 1))
          ORDER BY l.ts IS NULL, l.ts DESC, c.jid`
      )
      .all(opts.includeHidden ? 1 : 0, kind) as Row[]
    return rows.map((r) => ({
      jid: r.jid,
      pushName: r.push_name,
      customName: r.custom_name,
      hidden: r.hidden === 1,
      notes: r.notes,
      displayName: r.custom_name ?? r.push_name ?? (r.is_group === 1 ? UNNAMED_GROUP : formatPhone(r.jid)),
      lastTs: r.last_ts,
      awaitingReply: r.last_from_me === 0,
      isGroup: r.is_group === 1,
      waitingSince: typeof r.waiting_since === 'number' ? r.waiting_since : null,
      alerts: sortKinds(r.alert_kinds)
    }))
  }

  /** Conversas (fora as escondidas) aguardando resposta e conversas com algum alerta ativo. */
  triageCounts(): { awaiting: number; withAlerts: number } {
    const r = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM contacts c
             WHERE c.hidden = 0
               AND (SELECT from_me FROM messages WHERE jid = c.jid ORDER BY ts DESC, rowid DESC LIMIT 1) = 0) AS awaiting,
           (SELECT COUNT(DISTINCT a.jid) FROM alerts a JOIN contacts c ON c.jid = a.jid
             WHERE a.dismissed_at IS NULL AND c.hidden = 0) AS with_alerts`
      )
      .get() as Row
    return { awaiting: r.awaiting, withAlerts: r.with_alerts }
  }

  // --- alertas ---

  /**
   * Cria o alerta ativo do tipo, ou atualiza detalhe e mensagem do que já está ativo (um por conversa e tipo).
   * Um alerta marcado pelo mentor (`source = 'user'`) não é reescrito pela IA. `true` se algo mudou.
   * `contextText`: a janela de mensagens que a IA viu (vira o exemplo quando o mentor avalia o alerta).
   */
  upsertAlert(a: {
    jid: string
    kind: AlertKind
    detail: string
    msgId: string | null
    source?: AlertSource
    contextText?: string | null
    model?: string | null
  }): boolean {
    const source = a.source ?? (a.kind === 'esperando' ? 'rule' : 'ai')
    const cur = this.db
      .prepare('SELECT id, detail, msg_id, source FROM alerts WHERE jid = ? AND kind = ? AND dismissed_at IS NULL')
      .get(a.jid, a.kind) as Row | undefined
    if (cur) {
      if (cur.source === 'user' && source !== 'user') return false
      if (cur.detail === a.detail && (cur.msg_id ?? null) === a.msgId) return false
      this.db
        .prepare('UPDATE alerts SET detail = ?, msg_id = ?, context_text = COALESCE(?, context_text), model = COALESCE(?, model) WHERE id = ?')
        .run(a.detail, a.msgId, a.contextText ?? null, a.model ?? null, cur.id)
      return true
    }
    this.db
      .prepare('INSERT INTO alerts(jid, kind, detail, msg_id, created_at, source, context_text, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.jid, a.kind, a.detail, a.msgId, this.clock.now(), source, a.contextText ?? null, a.model ?? null)
    return true
  }

  /** Alertas ativos (de uma conversa, ou de todas as não escondidas), mais graves primeiro. */
  listAlerts(jid?: string): AlertRow[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, ${RATING_SQL} FROM alerts a JOIN contacts c ON c.jid = a.jid
          WHERE a.dismissed_at IS NULL AND (?1 IS NULL AND c.hidden = 0 OR a.jid = ?1)
          ORDER BY ${ALERT_ORDER_SQL.replace(/kind/, 'a.kind')}, a.created_at, a.id`
      )
      .all(jid ?? null) as Row[]
    return rows.map(toAlert)
  }

  /** O alerta mais recente do tipo (ativo ou resolvido), ou null. */
  lastAlert(jid: string, kind: AlertKind): (AlertRow & { dismissedAt: number | null }) | null {
    const r = this.db.prepare(`SELECT a.*, ${RATING_SQL} FROM alerts a WHERE jid = ? AND kind = ? ORDER BY id DESC LIMIT 1`).get(jid, kind) as
      | Row
      | undefined
    return r ? { ...toAlert(r), dismissedAt: r.dismissed_at ?? null } : null
  }

  /** Um alerta pelo id (ativo ou resolvido), com a janela que a IA viu e o modelo; ou null. */
  getAlert(id: number): (AlertRow & { dismissedAt: number | null; contextText: string | null; model: string | null }) | null {
    const r = this.db.prepare(`SELECT a.*, ${RATING_SQL} FROM alerts a WHERE a.id = ?`).get(id) as Row | undefined
    return r ? { ...toAlert(r), dismissedAt: r.dismissed_at ?? null, contextText: r.context_text ?? null, model: r.model ?? null } : null
  }

  /** Resolve um alerta pelo id. `true` se estava ativo. */
  dismissAlertById(id: number): boolean {
    const res = this.db.prepare('UPDATE alerts SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL').run(this.clock.now(), id)
    return Number(res.changes) > 0
  }

  // --- avaliação dos alertas ---

  /** Grava a avaliação; com `alertId`, uma por alerta (mudar de ideia atualiza a mesma linha). Devolve o id. */
  saveFeedback(f: Omit<FeedbackRow, 'id' | 'createdAt'>): number {
    const now = this.clock.now()
    if (f.alertId !== null) {
      const cur = this.db.prepare('SELECT id FROM alert_feedback WHERE alert_id = ?').get(f.alertId) as Row | undefined
      if (cur) {
        this.db
          .prepare(
            `UPDATE alert_feedback SET verdict = ?, reason_code = ?, reason_text = ?, correct_kind = ?, created_at = ?
              WHERE id = ?`
          )
          .run(f.verdict, f.reasonCode, f.reasonText, f.correctKind, now, cur.id)
        return cur.id
      }
    }
    const res = this.db
      .prepare(
        `INSERT INTO alert_feedback(alert_id, jid, kind, msg_id, verdict, reason_code, reason_text, correct_kind, context_text, detail, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(f.alertId, f.jid, f.kind, f.msgId, f.verdict, f.reasonCode, f.reasonText, f.correctKind, f.contextText, f.detail, f.model, now)
    return Number(res.lastInsertRowid)
  }

  /** O mentor já disse 👎 para um alerta deste tipo nesta mensagem? */
  hasDownFeedback(jid: string, kind: AlertKind, msgId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM alert_feedback WHERE jid = ? AND kind = ? AND msg_id = ? AND verdict = 'down' LIMIT 1")
      .get(jid, kind, msgId)
  }

  /** Avaliações, mais novas primeiro (desde `since`, se dado). */
  listFeedback(opts: { since?: number; limit?: number } = {}): FeedbackRow[] {
    const rows = this.db
      .prepare('SELECT * FROM alert_feedback WHERE created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(opts.since ?? 0, opts.limit ?? -1) as Row[]
    return rows.map(toFeedback)
  }

  /** Quantas avaliações de cada tipo e veredito desde `since`. */
  feedbackCounts(since: number): Array<{ kind: AlertKind; verdict: Verdict; n: number }> {
    return (
      this.db
        .prepare('SELECT kind, verdict, COUNT(*) AS n FROM alert_feedback WHERE created_at >= ? GROUP BY kind, verdict')
        .all(since) as Row[]
    ).map((r) => ({ kind: r.kind, verdict: r.verdict, n: r.n }))
  }

  /** Resolve (dismiss) o alerta ativo do tipo. `true` se havia um. */
  dismissAlert(jid: string, kind: AlertKind): boolean {
    const res = this.db
      .prepare('UPDATE alerts SET dismissed_at = ? WHERE jid = ? AND kind = ? AND dismissed_at IS NULL')
      .run(this.clock.now(), jid, kind)
    return Number(res.changes) > 0
  }

  /**
   * Resolve os alertas ativos destes tipos cuja mensagem (ou, sem mensagem, a criação) é até `ts`
   * (o mentor respondeu depois deles). Devolve quantos.
   */
  dismissAlertsUpTo(jid: string, kinds: ReadonlyArray<AlertKind>, ts: number): number {
    const res = this.db
      .prepare(
        `UPDATE alerts SET dismissed_at = ?1
          WHERE jid = ?2 AND dismissed_at IS NULL AND kind IN (SELECT value FROM json_each(?3))
            AND COALESCE((SELECT m.ts FROM messages m WHERE m.id = alerts.msg_id), alerts.created_at) <= ?4`
      )
      .run(this.clock.now(), jid, JSON.stringify(kinds), ts)
    return Number(res.changes)
  }

  /** Id da mensagem do contato no horário `ts` (a que abriu a espera), ou null. */
  waitingMessageId(jid: string, ts: number): string | null {
    const r = this.db
      .prepare('SELECT id FROM messages WHERE jid = ? AND from_me = 0 AND ts = ? ORDER BY rowid LIMIT 1')
      .get(jid, ts) as Row | undefined
    return r ? r.id : null
  }

  /** Alguma mensagem do grupo desde `ts` menciona o mentor (ou cita uma mensagem dele)? */
  hasMentionSince(jid: string, ts: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM messages WHERE jid = ? AND ts >= ? AND mentions_me = 1 LIMIT 1').get(jid, ts)
  }

  getAlertCheck(jid: string): { lastMsgId: string; lastTs: number; checkedAt: number } | null {
    const r = this.db.prepare('SELECT * FROM alert_checks WHERE jid = ?').get(jid) as Row | undefined
    return r ? { lastMsgId: r.last_msg_id, lastTs: r.last_ts, checkedAt: r.checked_at } : null
  }

  setAlertCheck(jid: string, lastMsgId: string, lastTs: number): void {
    this.db
      .prepare(
        `INSERT INTO alert_checks(jid, last_msg_id, last_ts, checked_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(jid) DO UPDATE SET last_msg_id = ?2, last_ts = ?3, checked_at = ?4`
      )
      .run(jid, lastMsgId, lastTs, this.clock.now())
  }

  // --- mensagens ---

  insertMessage(m: NormalizedMessage): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages(id, jid, from_me, ts, kind, text, media_key_json, duration_sec, sender_jid, sender_name, mentions_me)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.id,
        m.jid,
        m.fromMe ? 1 : 0,
        m.ts,
        m.kind,
        m.text,
        m.mediaKeyJson,
        m.durationSec,
        m.senderJid ?? null,
        m.senderName ?? null,
        m.mentionsMe ? 1 : 0
      )
    return Number(res.changes) > 0
  }

  /** Últimas `limit` mensagens (todas, sem limite), em ordem cronológica. */
  listMessages(jid: string, limit?: number): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, ${SENDER_COLS} FROM (SELECT rowid AS rid, * FROM messages WHERE jid = ? ORDER BY ts DESC, rowid DESC LIMIT ?) m
         LEFT JOIN contacts sc ON sc.jid = m.sender_jid
         ORDER BY m.ts ASC, m.rid ASC`
      )
      .all(jid, limit ?? -1) as Row[]
    return rows.map(toMessage)
  }

  /** Horário (WhatsApp) da mensagem mais nova do banco (até `maxTs`, se dado), ou null sem mensagens. */
  newestMessageTs(maxTs?: number): number | null {
    const r = this.db
      .prepare('SELECT MAX(ts) AS t FROM messages WHERE (?1 IS NULL OR ts <= ?1)')
      .get(maxTs ?? null) as Row | undefined
    return typeof r?.t === 'number' ? r.t : null
  }

  getMessage(id: string): MessageRow | null {
    const r = this.db
      .prepare(`SELECT m.*, ${SENDER_COLS} FROM messages m LEFT JOIN contacts sc ON sc.jid = m.sender_jid WHERE m.id = ?`)
      .get(id) as Row | undefined
    return r ? toMessage(r) : null
  }

  setAudioPath(id: string, path: string): void {
    this.db.prepare('UPDATE messages SET audio_path = ? WHERE id = ?').run(path, id)
  }

  setTranscript(id: string, text: string | null, status: TranscriptStatus): void {
    this.db.prepare('UPDATE messages SET transcript = ?, transcript_status = ? WHERE id = ?').run(text, status, id)
  }

  // --- análises ---

  saveAnalysis(
    jid: string,
    lastMsgId: string,
    provider: string,
    summary: string,
    suggestions: string[],
    extra: { transcriptFp?: string; pendingAudios?: number } = {}
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO analyses(jid, last_msg_id, provider, summary, suggestions_json, created_at, transcript_fp, pending_audios)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        jid,
        lastMsgId,
        provider,
        summary,
        JSON.stringify(suggestions),
        this.clock.now(),
        extra.transcriptFp ?? '',
        extra.pendingAudios ?? 0
      )
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
      createdAt: r.created_at,
      transcriptFp: r.transcript_fp ?? '',
      pendingAudios: r.pending_audios ?? 0
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

  /**
   * Insere o job, ou devolve um já concluído (`done`) para a fila com tentativas zeradas
   * (ex.: áudio pulado enquanto o contato estava escondido). Pendente, rodando ou falho fica como está.
   */
  requeueJob(type: string, key: string, payload: unknown, priority: number): void {
    this.db
      .prepare(
        `INSERT INTO jobs(type, key, payload_json, status, priority) VALUES (?, ?, ?, 'pending', ?)
         ON CONFLICT(key) DO UPDATE SET status = 'pending', attempts = 0, next_run_at = 0, last_error = NULL,
           payload_json = excluded.payload_json, priority = excluded.priority
         WHERE jobs.status = 'done'`
      )
      .run(type, key, JSON.stringify(payload), priority)
  }

  /**
   * Melhor job pendente elegível de um tipo: prioridade maior, depois a mensagem mais nova
   * (`payload.ts`; sem ts por último), depois id menor.
   */
  nextPendingJob(type: string, now: number): JobRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status = 'pending' AND type = ? AND next_run_at <= ?
         ORDER BY priority DESC, json_extract(payload_json, '$.ts') DESC, id ASC LIMIT 1`
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

  /** Quantidade de jobs por status (de um tipo, ou de todos). */
  jobCounts(type?: string): Record<JobStatus, number> {
    const out: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 }
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS c FROM jobs WHERE (?1 IS NULL OR type = ?1) GROUP BY status')
      .all(type ?? null) as Row[]
    for (const r of rows) {
      out[r.status as JobStatus] = r.c
    }
    return out
  }
}
