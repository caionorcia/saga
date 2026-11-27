import type { DatabaseSync } from 'node:sqlite'
import { systemClock, type Clock } from '../clock'
import type { NormalizedMessage } from '../types'
import { ALERT_KINDS, AI_ALERT_KINDS, GROUP_ANSWER_MAX_MEMBERS, alertSeverity, type AlertKind } from '../../shared/triage'
import type { KbSource } from '../../shared/kb'
import { KbRepo } from './kbRepo'
import { SendRepo } from './sendRepo'
import { BackupRepo } from './backupRepo'
import { CopilotoRepo } from './copilotoRepo'
import { FollowupRepo } from './followupRepo'
import type { GroupAnswer, ReasonCode, ReplyDecision, ReplyDecisionSource, ReplyReasonCode, ReplyVerdict, Verdict } from '../../shared/feedback'

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
  /**
   * entra em "Para responder": aguarda resposta e nem o SagaZap nem o mentor decidiram que a última mensagem do contato
   * dispensa resposta (agradecimento, "ok", emoji, conversa de grupo que não é com o mentor…)
   */
  needsReply: boolean
  /**
   * a decisão sobre a última mensagem do contato (null = ninguém decidiu, ou o mentor falou por último). `by: 'group'`
   * (com `group`): conversa individual em que, depois de `waitingSince`, o mentor escreveu num grupo de que o contato
   * participa; vale até o mentor dizer "Precisa sim".
   */
  replyDecision: ReplyDecision | null
}

/** A decisão guardada para a última mensagem do contato (`reply_checks`). */
export interface ReplyCheckRow {
  jid: string
  msgId: string
  appNeeds: boolean | null
  appReason: string | null
  appSource: 'rule' | 'ai' | null
  model: string | null
  userNeeds: boolean | null
}

/** Uma avaliação do "Para responder" (um exemplo rotulado: as últimas mensagens do contato e o veredito). */
export interface ReplyFeedbackRow {
  id: number
  jid: string
  msgId: string
  alertId: number | null
  verdict: ReplyVerdict
  /** o que o SagaZap achava na hora: true/false, ou null (não tinha decidido: deixava na lista) */
  appNeeds: boolean | null
  appReason: string | null
  appSource: string | null
  reasonCode: ReplyReasonCode | null
  reasonText: string | null
  contextText: string
  model: string | null
  createdAt: number
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
  /** v0.4.0, só nas do contato: a chave original no WhatsApp (JSON `{ remoteJid, id, participant? }`) */
  waKeyJson?: string | null
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
  /** trechos de conhecimento da base usados no pedido ("Baseado em"); vazio sem base */
  sources?: KbSource[]
  /** índice da sugestão que o mentor escolheu (Copiar ou Salvar); null = ainda não escolheu */
  chosenIndex?: number | null
  /** id em `approved_replies` da última resposta salva dessa escolha */
  chosenReplyId?: number | null
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
  /** as outras sugestões que o mentor NÃO escolheu naquela análise */
  rejected: string[]
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

/** 👍/👎 do alerta; no "esperando", a avaliação fica em `reply_feedback` (precisa / não precisa responder). */
const RATING_SQL = `COALESCE((SELECT f.verdict FROM alert_feedback f WHERE f.alert_id = a.id),
  (SELECT CASE r.verdict WHEN 'reply_not_needed' THEN 'down' ELSE 'up' END FROM reply_feedback r WHERE r.alert_id = a.id)) AS rating`

const bit = (v: unknown): boolean | null => (v === 1 ? true : v === 0 ? false : null)

function toReplyCheck(r: Row): ReplyCheckRow {
  return {
    jid: r.jid,
    msgId: r.msg_id,
    appNeeds: bit(r.app_needs),
    appReason: r.app_reason ?? null,
    appSource: r.app_source ?? null,
    model: r.model ?? null,
    userNeeds: bit(r.user_needs)
  }
}

function toReplyFeedback(r: Row): ReplyFeedbackRow {
  return {
    id: r.id,
    jid: r.jid,
    msgId: r.msg_id,
    alertId: r.alert_id ?? null,
    verdict: r.verdict,
    appNeeds: bit(r.app_needs),
    appReason: r.app_reason ?? null,
    appSource: r.app_source ?? null,
    reasonCode: r.reason_code ?? null,
    reasonText: r.reason_text ?? null,
    contextText: r.context_text,
    model: r.model ?? null,
    createdAt: r.created_at
  }
}

/** Texto do motivo quando o mentor respondeu no grupo do contato. */
export const groupAnswerReason = (g: GroupAnswer) => `Respondido no grupo ${g.name}`

/**
 * Decisão vigente: a do mentor vence; depois a regra do grupo (o mentor escreveu num grupo do contato depois da
 * mensagem dele); depois a do SagaZap (regra de agradecimento ou IA). Sem nenhuma, null.
 */
function decisionOf(r: Row, group: GroupAnswer | null): ReplyDecision | null {
  const user = bit(r.rc_user_needs)
  if (user !== null) return { needed: user, by: 'user', reason: null }
  if (group) return { needed: false, by: 'group', reason: groupAnswerReason(group), group }
  const app = bit(r.rc_app_needs)
  if (app === null) return null
  return { needed: app, by: (r.rc_app_source ?? 'ai') as ReplyDecisionSource, reason: r.rc_app_reason ?? null }
}

/** SQL: a primeira mensagem do contato depois da última do mentor na conversa `cjid` (só quando ele falou por último). */
const WAITING_SINCE_SQL = (cjid: string) => `(
  SELECT MIN(w.ts) FROM messages w
   WHERE w.jid = ${cjid} AND w.from_me = 0
     AND w.ts > COALESCE((SELECT MAX(me.ts) FROM messages me WHERE me.jid = ${cjid} AND me.from_me = 1), -1))`

export { GROUP_ANSWER_MAX_MEMBERS }

/**
 * SQL: a mensagem mais recente do mentor, depois de `since`, que responde ao contato `cjid` num grupo, como
 * "<ts> <jid do grupo>"; NULL se não houver. Conta:
 * (a) qualquer mensagem num grupo de que o contato participa (pelos participantes do grupo ou porque já mandou mensagem
 *     lá) com até GROUP_ANSWER_MAX_MEMBERS participantes conhecidos (tamanho desconhecido = grande);
 * (b) em qualquer grupo, a mensagem que menciona (@) o contato ou cita uma mensagem dele.
 */
const GROUP_ANSWER_SQL = (cjid: string, since: string) => `(
  SELECT gm.ts || ' ' || gm.jid FROM messages gm
   WHERE gm.from_me = 1 AND gm.ts > ${since} AND gm.jid LIKE '%@g.us'
     AND (
       (gm.jid IN (SELECT gs.group_jid FROM group_sizes gs WHERE gs.members <= ${GROUP_ANSWER_MAX_MEMBERS})
        AND gm.jid IN (SELECT g.group_jid FROM group_members g WHERE g.member_jid = ${cjid}
                       UNION SELECT s.jid FROM messages s WHERE s.sender_jid = ${cjid}))
       OR EXISTS (SELECT 1 FROM message_targets t WHERE t.msg_id = gm.id AND t.target_jid = ${cjid}))
   ORDER BY gm.ts DESC LIMIT 1)`

function parseSources(json: unknown): KbSource[] {
  if (typeof json !== 'string') return []
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v)
      ? v.filter((x): x is KbSource => !!x && typeof x.chunkId === 'number' && typeof x.breadcrumb === 'string')
      : []
  } catch {
    return []
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
    createdAt: r.created_at,
    rejected: parseStrings(r.rejected_json)
  }
}

function parseStrings(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
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
    mentionsMe: r.mentions_me === 1,
    waKeyJson: r.wa_key_json ?? null
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

/** Filtros da busca geral, já resolvidos (período virou horário mínimo). */
export interface MessageSearchFilter {
  kind: ContactKind
  /** epoch ms (horário do WhatsApp); null = tudo */
  sinceTs: number | null
  audioOnly: boolean
  /** uma conversa só; null = todas */
  jid: string | null
}

export interface MessageSearchRow {
  message: MessageRow
  contactName: string
  isGroup: boolean
  /** bm25 (menor = mais relevante) */
  rank: number
}

/** ?2 tipo, ?3 desde, ?4 só áudios, ?5 conversa */
const searchWhere = `AND (?2 = 'all' OR (?2 = 'group') = (c.is_group = 1))
              AND (?3 IS NULL OR m.ts >= ?3)
              AND (?4 = 0 OR m.kind = 'audio')
              AND (?5 IS NULL OR m.jid = ?5)`

export class Repo {
  /** base de conhecimento (v0.3.0) */
  readonly kb: KbRepo
  /** envio direto (v0.4.0) */
  readonly sends: SendRepo
  /** cópia de segurança (v0.3.1) */
  readonly backup: BackupRepo
  /** Copiloto da Saga (v0.5.0) */
  readonly copiloto: CopilotoRepo
  /** follow-ups do Copiloto (v0.7.0) */
  readonly followups: FollowupRepo

  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock
  ) {
    this.kb = new KbRepo(db, clock)
    this.sends = new SendRepo(db, clock)
    this.backup = new BackupRepo(db)
    this.copiloto = new CopilotoRepo(db, clock)
    this.followups = new FollowupRepo(db, clock)
  }

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
    // v0.8.1: grupo sem nome que já tem o assunto guardado (a consulta dos grupos veio antes da primeira mensagem)
    if (c.isGroup) {
      this.db
        .prepare(
          `UPDATE contacts SET push_name = (SELECT subject FROM group_subjects WHERE group_jid = ?1), name_rank = ?2
            WHERE jid = ?1 AND push_name IS NULL AND EXISTS (SELECT 1 FROM group_subjects WHERE group_jid = ?1)`
        )
        .run(c.jid, NAME_RANK.profile)
    }
  }

  /**
   * v0.8.1: o assunto de um grupo (consulta dos grupos, `groups.upsert`/`groups.update`). Fica guardado mesmo sem a
   * conversa existir ainda; com ela, vira o nome (se não for pior que o atual). `true` se o nome da conversa mudou.
   */
  setGroupSubject(groupJid: string, subject: string): boolean {
    this.db
      .prepare(
        `INSERT INTO group_subjects(group_jid, subject, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(group_jid) DO UPDATE SET subject = excluded.subject, updated_at = excluded.updated_at`
      )
      .run(groupJid, subject, this.clock.now())
    return this.setContactName(groupJid, subject, NAME_RANK.profile)
  }

  /** v0.8.1: o grupo tem nome (o personalizado ou o assunto)? Sem a conversa aqui, vale o assunto guardado. */
  groupHasName(groupJid: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM contacts WHERE jid = ?1 AND (custom_name IS NOT NULL OR push_name IS NOT NULL))
            OR EXISTS (SELECT 1 FROM group_subjects WHERE group_jid = ?1)`
      )
      .get(groupJid)
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
        `WITH base AS (
           SELECT c.jid, c.push_name, c.custom_name, c.hidden, c.notes, c.is_group,
                  l.id AS last_id, l.ts AS last_ts, l.from_me AS last_from_me,
                  CASE WHEN l.from_me = 0 THEN ${WAITING_SINCE_SQL('c.jid')} END AS waiting_since
             FROM contacts c
             LEFT JOIN messages l ON l.id = (
               SELECT id FROM messages WHERE jid = c.jid ORDER BY ts DESC, rowid DESC LIMIT 1)
            WHERE (?1 = 1 OR c.hidden = 0)
              AND (?2 = 'all' OR (?2 = 'group') = (c.is_group = 1)))
         SELECT b.*,
                (SELECT group_concat(a.kind) FROM alerts a WHERE a.jid = b.jid AND a.dismissed_at IS NULL) AS alert_kinds,
                rc.user_needs AS rc_user_needs, rc.app_needs AS rc_app_needs, rc.app_source AS rc_app_source,
                rc.app_reason AS rc_app_reason,
                CASE WHEN b.is_group = 0 AND b.waiting_since IS NOT NULL
                     THEN ${GROUP_ANSWER_SQL('b.jid', 'b.waiting_since')} END AS group_answer
           FROM base b
           LEFT JOIN reply_checks rc ON rc.jid = b.jid AND rc.msg_id = b.last_id AND b.last_from_me = 0
          ORDER BY b.last_ts IS NULL, b.last_ts DESC, b.jid`
      )
      .all(opts.includeHidden ? 1 : 0, kind) as Row[]
    return rows.map((r) => {
      const answeredInGroup = this.parseGroupAnswer(r.group_answer)
      const replyDecision = r.last_from_me === 0 ? decisionOf(r, answeredInGroup) : null
      return {
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
        alerts: sortKinds(r.alert_kinds),
        needsReply: r.last_from_me === 0 && (replyDecision?.needed ?? true),
        replyDecision
      }
    })
  }

  /** "<ts> <jid>" do SQL → o grupo, com o nome exibido. */
  private parseGroupAnswer(packed: unknown): GroupAnswer | null {
    if (typeof packed !== 'string') return null
    const sp = packed.indexOf(' ')
    const ts = Number(packed.slice(0, sp))
    const jid = packed.slice(sp + 1)
    if (sp <= 0 || !Number.isFinite(ts) || !jid) return null
    const g = this.db.prepare('SELECT custom_name, push_name FROM contacts WHERE jid = ?').get(jid) as Row | undefined
    return { jid, ts, name: g?.custom_name ?? g?.push_name ?? UNNAMED_GROUP }
  }

  /**
   * Conversa individual esperando resposta: o mentor escreveu, depois da primeira mensagem do contato sem resposta,
   * num grupo de que o contato participa? (o mais recente; null se não, ou se a conversa não espera resposta)
   */
  groupAnswer(jid: string): GroupAnswer | null {
    const r = this.db
      .prepare(
        `WITH base AS (
           SELECT c.jid, c.is_group, l.from_me AS last_from_me, ${WAITING_SINCE_SQL('c.jid')} AS waiting_since
             FROM contacts c
             JOIN messages l ON l.id = (SELECT id FROM messages WHERE jid = c.jid ORDER BY ts DESC, rowid DESC LIMIT 1)
            WHERE c.jid = ?1)
         SELECT CASE WHEN b.is_group = 0 AND b.last_from_me = 0 AND b.waiting_since IS NOT NULL
                     THEN ${GROUP_ANSWER_SQL('b.jid', 'b.waiting_since')} END AS group_answer
           FROM base b`
      )
      .get(jid) as Row | undefined
    return this.parseGroupAnswer(r?.group_answer)
  }

  /** Conversas (fora as escondidas) em "Para responder" e conversas com algum alerta ativo. */
  triageCounts(): { awaiting: number; withAlerts: number } {
    const r = this.db
      .prepare(
        `WITH base AS (
           SELECT c.jid, c.is_group, l.id AS last_id, ${WAITING_SINCE_SQL('c.jid')} AS waiting_since
             FROM contacts c
             JOIN messages l ON l.id = (SELECT id FROM messages WHERE jid = c.jid ORDER BY ts DESC, rowid DESC LIMIT 1)
            WHERE c.hidden = 0 AND l.from_me = 0)
         SELECT
           (SELECT COUNT(*) FROM base b
              LEFT JOIN reply_checks rc ON rc.jid = b.jid AND rc.msg_id = b.last_id
             WHERE COALESCE(
                     rc.user_needs,
                     CASE WHEN b.is_group = 0 AND ${GROUP_ANSWER_SQL('b.jid', 'b.waiting_since')} IS NOT NULL THEN 0 END,
                     rc.app_needs,
                     1) = 1) AS awaiting,
           (SELECT COUNT(DISTINCT a.jid) FROM alerts a JOIN contacts c ON c.jid = a.jid
             WHERE a.dismissed_at IS NULL AND c.hidden = 0) AS with_alerts`
      )
      .get() as Row
    return { awaiting: r.awaiting, withAlerts: r.with_alerts }
  }

  // --- participantes de grupos ---

  /**
   * Troca os participantes conhecidos de um grupo (da consulta `groupFetchAllParticipating`). Cada participante pode
   * vir em mais de uma forma (telefone e @lid): todas entram. `true` se algo mudou.
   */
  setGroupMembers(groupJid: string, memberJids: Iterable<string>, memberCount?: number): boolean {
    const next = new Set([...memberJids].filter((j) => j && j !== groupJid))
    // quantas pessoas (cada uma pode ter duas formas de JID); sem contagem, as formas distintas
    const count = memberCount ?? next.size
    const size = this.db.prepare('SELECT members FROM group_sizes WHERE group_jid = ?').get(groupJid) as Row | undefined
    let sizeChanged = false
    if (size?.members !== count) {
      this.db.prepare('INSERT INTO group_sizes(group_jid, members) VALUES (?, ?) ON CONFLICT(group_jid) DO UPDATE SET members = excluded.members').run(groupJid, count)
      sizeChanged = true
    }
    const cur = new Set(
      (this.db.prepare('SELECT member_jid FROM group_members WHERE group_jid = ?').all(groupJid) as Row[]).map((r) => r.member_jid as string)
    )
    if (cur.size === next.size && [...next].every((j) => cur.has(j))) return sizeChanged
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM group_members WHERE group_jid = ?').run(groupJid)
      const ins = this.db.prepare('INSERT OR IGNORE INTO group_members(group_jid, member_jid) VALUES (?, ?)')
      for (const j of next) ins.run(groupJid, j)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return true
  }

  /** v0.8.1: quantos grupos há aqui e quantos sem nome nenhum (nem personalizado, nem assunto). */
  groupCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE is_group = 1').get() as Row).n
  }

  unnamedGroupCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE is_group = 1 AND custom_name IS NULL AND push_name IS NULL').get() as Row).n
  }

  /** v0.8.1: já se sabe quem participa deste grupo (alguma consulta trouxe os participantes)? */
  hasGroupMembership(groupJid: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM group_sizes WHERE group_jid = ?').get(groupJid)
  }

  /**
   * v0.8.1 (`group-participants.update`): entra ou sai gente do grupo, sem uma consulta nova. `forms` são as formas do
   * JID de cada pessoa (telefone e @lid); `people` quantas pessoas são (ajusta a contagem já conhecida). `true` se mudou.
   */
  changeGroupMembers(groupJid: string, action: 'add' | 'remove', forms: ReadonlyArray<string>, people: number): boolean {
    let changed = false
    this.inTx(() => {
      const st =
        action === 'add'
          ? this.db.prepare('INSERT OR IGNORE INTO group_members(group_jid, member_jid) VALUES (?, ?)')
          : this.db.prepare('DELETE FROM group_members WHERE group_jid = ? AND member_jid = ?')
      for (const j of forms) if (j && j !== groupJid && Number(st.run(groupJid, j).changes) > 0) changed = true
      if (changed && people > 0) {
        this.db
          .prepare('UPDATE group_sizes SET members = MAX(0, members + ?) WHERE group_jid = ?')
          .run(action === 'add' ? people : -people, groupJid)
      }
    })
    return changed
  }

  /**
   * v0.8.1: um @lid ganhou telefone. Nos grupos em que ele participa (pela consulta ou por ter mandado mensagem), o
   * telefone entra como mais uma forma do participante, guardada (o mapa do WhatsApp é só da memória). Quantos grupos.
   */
  linkLidPhone(lid: string, pn: string): number {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO group_members(group_jid, member_jid)
         SELECT group_jid, ?2 FROM group_members WHERE member_jid = ?1
         UNION SELECT DISTINCT jid, ?2 FROM messages WHERE sender_jid = ?1 AND jid LIKE '%@g.us'`
      )
      .run(lid, pn)
    return Number(res.changes)
  }

  private inTx(fn: () => void): void {
    if (this.db.isTransaction) return fn()
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** Participantes conhecidos de um grupo (pela consulta), em ordem. */
  groupMembers(groupJid: string): string[] {
    return (this.db.prepare('SELECT member_jid FROM group_members WHERE group_jid = ? ORDER BY member_jid').all(groupJid) as Row[]).map(
      (r) => r.member_jid as string
    )
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

  /** Quantas avaliações de cada tipo e veredito desde `since` (fora as dos alertas marcados pelo próprio mentor). */
  feedbackCounts(since: number): Array<{ kind: AlertKind; verdict: Verdict; n: number }> {
    return (
      this.db
        .prepare(
          `SELECT f.kind, f.verdict, COUNT(*) AS n FROM alert_feedback f LEFT JOIN alerts a ON a.id = f.alert_id
            WHERE f.created_at >= ? AND COALESCE(a.source, 'ai') <> 'user' GROUP BY f.kind, f.verdict`
        )
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

  // --- "Para responder" ---

  getReplyCheck(jid: string): ReplyCheckRow | null {
    const r = this.db.prepare('SELECT * FROM reply_checks WHERE jid = ?').get(jid) as Row | undefined
    return r ? toReplyCheck(r) : null
  }

  /**
   * A decisão do SagaZap (regra ou IA) para a última mensagem do contato `msgId`. Mensagem diferente da guardada:
   * a linha recomeça (a decisão do mentor, que era sobre a mensagem antiga, sai). `true` se algo mudou.
   */
  setAppReply(a: { jid: string; msgId: string; needs: boolean; reason: string | null; source: 'rule' | 'ai'; model?: string | null }): boolean {
    const cur = this.getReplyCheck(a.jid)
    if (cur && cur.msgId === a.msgId && cur.appNeeds === a.needs && cur.appReason === a.reason && cur.appSource === a.source) return false
    this.db
      .prepare(
        `INSERT INTO reply_checks(jid, msg_id, app_needs, app_reason, app_source, model, user_needs, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)
         ON CONFLICT(jid) DO UPDATE SET
           user_needs = CASE WHEN msg_id = excluded.msg_id THEN user_needs END,
           msg_id = excluded.msg_id, app_needs = excluded.app_needs, app_reason = excluded.app_reason,
           app_source = excluded.app_source, model = excluded.model, updated_at = excluded.updated_at`
      )
      .run(a.jid, a.msgId, a.needs ? 1 : 0, a.reason, a.source, a.model ?? null, this.clock.now())
    return true
  }

  /** A decisão do mentor para a última mensagem do contato `msgId` (vence a do SagaZap). `true` se algo mudou. */
  setUserReply(jid: string, msgId: string, needs: boolean): boolean {
    const cur = this.getReplyCheck(jid)
    if (cur && cur.msgId === msgId && cur.userNeeds === needs) return false
    this.db
      .prepare(
        `INSERT INTO reply_checks(jid, msg_id, user_needs, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(jid) DO UPDATE SET
           app_needs = CASE WHEN msg_id = excluded.msg_id THEN app_needs END,
           app_reason = CASE WHEN msg_id = excluded.msg_id THEN app_reason END,
           app_source = CASE WHEN msg_id = excluded.msg_id THEN app_source END,
           model = CASE WHEN msg_id = excluded.msg_id THEN model END,
           msg_id = excluded.msg_id, user_needs = excluded.user_needs, updated_at = excluded.updated_at`
      )
      .run(jid, msgId, needs ? 1 : 0, this.clock.now())
    return true
  }

  /** A mensagem mais nova da conversa, ou null. */
  lastMessage(jid: string): MessageRow | null {
    const r = this.db
      .prepare(
        `SELECT m.*, ${SENDER_COLS} FROM messages m LEFT JOIN contacts sc ON sc.jid = m.sender_jid
          WHERE m.jid = ? ORDER BY m.ts DESC, m.rowid DESC LIMIT 1`
      )
      .get(jid) as Row | undefined
    return r ? toMessage(r) : null
  }

  /**
   * As mensagens do contato depois da última do mentor (as que esperam resposta), as `limit` mais novas em ordem
   * cronológica; `more` diz se havia outras antes delas.
   */
  latestContactRun(jid: string, limit: number): { messages: MessageRow[]; more: boolean } {
    const rows = this.db
      .prepare(
        `SELECT m.*, ${SENDER_COLS} FROM messages m LEFT JOIN contacts sc ON sc.jid = m.sender_jid
          WHERE m.jid = ?1 AND m.from_me = 0
            AND m.ts > COALESCE((SELECT MAX(me.ts) FROM messages me WHERE me.jid = ?1 AND me.from_me = 1), -1)
          ORDER BY m.ts DESC, m.rowid DESC LIMIT ?2`
      )
      .all(jid, limit + 1) as Row[]
    return { messages: rows.slice(0, limit).map(toMessage).reverse(), more: rows.length > limit }
  }

  /** Grava a avaliação; uma por conversa e mensagem (mudar de ideia atualiza a mesma linha). Devolve o id. */
  saveReplyFeedback(f: Omit<ReplyFeedbackRow, 'id' | 'createdAt'>): number {
    const r = this.db
      .prepare(
        `INSERT INTO reply_feedback(jid, msg_id, alert_id, verdict, app_needs, app_reason, app_source, reason_code, reason_text,
                                    context_text, model, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(jid, msg_id) DO UPDATE SET
           alert_id = COALESCE(excluded.alert_id, alert_id), verdict = excluded.verdict, reason_code = excluded.reason_code,
           reason_text = excluded.reason_text, context_text = excluded.context_text, created_at = excluded.created_at
         RETURNING id`
      )
      .get(
        f.jid,
        f.msgId,
        f.alertId,
        f.verdict,
        f.appNeeds === null ? null : f.appNeeds ? 1 : 0,
        f.appReason,
        f.appSource,
        f.reasonCode,
        f.reasonText,
        f.contextText,
        f.model,
        this.clock.now()
      ) as Row
    return r.id
  }

  /** Avaliações do "Para responder", mais novas primeiro (desde `since`, se dado). */
  listReplyFeedback(opts: { since?: number; limit?: number } = {}): ReplyFeedbackRow[] {
    const rows = this.db
      .prepare('SELECT * FROM reply_feedback WHERE created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(opts.since ?? 0, opts.limit ?? -1) as Row[]
    return rows.map(toReplyFeedback)
  }

  // --- mensagens ---

  insertMessage(m: NormalizedMessage): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages(id, jid, from_me, ts, kind, text, media_key_json, duration_sec, sender_jid, sender_name, mentions_me, wa_key_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        m.mentionsMe ? 1 : 0,
        m.waKeyJson ?? null
      )
    const inserted = Number(res.changes) > 0
    if (inserted && m.fromMe && m.targets?.length) {
      const ins = this.db.prepare('INSERT OR IGNORE INTO message_targets(msg_id, target_jid) VALUES (?, ?)')
      for (const t of new Set(m.targets)) ins.run(m.id, t)
    }
    return inserted
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

  /** v0.8.3: a mensagem mais antiga guardada da conversa (o ponto de partida do pedido de histórico ao celular), ou null. */
  oldestMessage(jid: string): { id: string; fromMe: boolean; ts: number; waKeyJson: string | null } | null {
    const r = this.db.prepare('SELECT id, from_me, ts, wa_key_json FROM messages WHERE jid = ? ORDER BY ts ASC, rowid ASC LIMIT 1').get(jid) as Row | undefined
    return r ? { id: r.id, fromMe: r.from_me === 1, ts: r.ts, waKeyJson: r.wa_key_json ?? null } : null
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

  // --- busca geral (v0.3.1) ---

  /**
   * Mensagens que combinam com a expressão do FTS5 (`messages_fts`), mais relevantes primeiro (bm25; o texto pesa
   * mais que o nome de quem mandou). Expressão inválida = nenhuma.
   */
  searchMessages(match: string, f: MessageSearchFilter, limit: number): MessageSearchRow[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT m.id, m.jid, m.ts, m.from_me, m.kind, m.text, m.transcript, m.transcript_status, m.sender_jid, m.sender_name,
                  ${SENDER_COLS}, c.custom_name AS c_custom, c.push_name AS c_push, c.is_group AS c_group,
                  bm25(messages_fts, 1.0, 0.4) AS rank
             FROM messages_fts
             JOIN messages m ON m.rowid = messages_fts.rowid
             JOIN contacts c ON c.jid = m.jid
             LEFT JOIN contacts sc ON sc.jid = m.sender_jid
            WHERE messages_fts MATCH ?1 AND c.hidden = 0
              ${searchWhere}
            ORDER BY rank, m.ts DESC LIMIT ?6`
        )
        .all(match, f.kind, f.sinceTs, f.audioOnly ? 1 : 0, f.jid, limit) as Row[]
      return rows.map((r) => ({
        message: toMessage(r),
        contactName: r.c_custom ?? r.c_push ?? (r.c_group === 1 ? UNNAMED_GROUP : formatPhone(r.jid)),
        isGroup: r.c_group === 1,
        rank: r.rank
      }))
    } catch {
      return []
    }
  }

  /** Quantas mensagens combinam, por conversa (mesmos filtros de `searchMessages`). */
  searchCounts(match: string, f: MessageSearchFilter): Map<string, number> {
    const out = new Map<string, number>()
    try {
      const rows = this.db
        .prepare(
          `SELECT m.jid, COUNT(*) AS n FROM messages_fts
             JOIN messages m ON m.rowid = messages_fts.rowid
             JOIN contacts c ON c.jid = m.jid
            WHERE messages_fts MATCH ?1 AND c.hidden = 0
              ${searchWhere}
            GROUP BY m.jid`
        )
        .all(match, f.kind, f.sinceTs, f.audioOnly ? 1 : 0, f.jid) as Row[]
      for (const r of rows) out.set(r.jid, r.n)
    } catch {
      // expressão inválida: nada
    }
    return out
  }

  /** Quantas mensagens estão no índice da busca (diagnóstico e testes). */
  searchIndexCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get() as Row).n as number
  }

  // --- análises ---

  saveAnalysis(
    jid: string,
    lastMsgId: string,
    provider: string,
    summary: string,
    suggestions: string[],
    extra: { transcriptFp?: string; pendingAudios?: number; sources?: KbSource[] } = {}
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO analyses(jid, last_msg_id, provider, summary, suggestions_json, created_at, transcript_fp, pending_audios, sources_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        jid,
        lastMsgId,
        provider,
        summary,
        JSON.stringify(suggestions),
        this.clock.now(),
        extra.transcriptFp ?? '',
        extra.pendingAudios ?? 0,
        JSON.stringify(extra.sources ?? [])
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
      pendingAudios: r.pending_audios ?? 0,
      sources: parseSources(r.sources_json),
      chosenIndex: r.chosen_index ?? null,
      chosenReplyId: r.chosen_reply_id ?? null
    }
  }

  /** Guarda qual sugestão o mentor escolheu (e a resposta salva dela) na análise atual do contato. */
  setChosen(jid: string, lastMsgId: string, index: number, replyId: number): void {
    this.db
      .prepare('UPDATE analyses SET chosen_index = ?, chosen_reply_id = ? WHERE jid = ? AND last_msg_id = ?')
      .run(index, replyId, jid, lastMsgId)
  }

  // --- respostas aprovadas (memória) ---

  insertApproved(a: {
    jid: string
    contextText: string
    originalSuggestion: string | null
    finalText: string
    provider: string | null
    rejected?: string[]
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO approved_replies(jid, context_text, original_suggestion, final_text, provider, created_at, rejected_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(a.jid, a.contextText, a.originalSuggestion, a.finalText, a.provider, this.clock.now(), a.rejected?.length ? JSON.stringify(a.rejected) : null)
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

  getApproved(id: number): ApprovedRow | null {
    const r = this.db.prepare('SELECT * FROM approved_replies WHERE id = ?').get(id) as Row | undefined
    return r ? toApproved(r) : null
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
  /** `revive` (v0.8.1): um job que falhou de vez também volta (só para consultas de leitura, nunca envios). */
  requeueJob(type: string, key: string, payload: unknown, priority: number, revive = false): void {
    this.db
      .prepare(
        `INSERT INTO jobs(type, key, payload_json, status, priority) VALUES (?1, ?2, ?3, 'pending', ?4)
         ON CONFLICT(key) DO UPDATE SET status = 'pending', attempts = 0, next_run_at = 0, last_error = NULL,
           payload_json = excluded.payload_json, priority = excluded.priority
         WHERE jobs.status = 'done' OR (?5 = 1 AND jobs.status = 'failed' AND jobs.type <> 'send_message')`
      )
      .run(type, key, JSON.stringify(payload), priority, revive ? 1 : 0)
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

  /** O id do job com essa chave (registro de diagnóstico), ou null. */
  jobIdByKey(key: string): number | null {
    const r = this.db.prepare('SELECT id FROM jobs WHERE key = ?').get(key) as Row | undefined
    return r ? Number(r.id) : null
  }

  /** Conclui sem rodar os jobs pendentes de um tipo (envios que ficaram na fila quando o app fechou). Quantos. */
  finishPendingJobs(type: string): number {
    const res = this.db.prepare(`UPDATE jobs SET status = 'done' WHERE type = ? AND status IN ('pending', 'failed')`).run(type)
    return Number(res.changes)
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
