import type { DatabaseSync } from 'node:sqlite'
import type { BackupCounts, BackupRestoreMode } from '../../shared/backup'
import { KB_ROLES } from '../../shared/kb'

type Row = Record<string, any>

/** O conteúdo de uma cópia de segurança (o `data.json`). Nunca chaves, sessão do WhatsApp nem mídia. */
export interface BackupData {
  approvedReplies: Array<{
    jid: string
    contextText: string
    originalSuggestion: string | null
    finalText: string
    sentText: string | null
    provider: string | null
    createdAt: number
    rejected: string[]
  }>
  /** nomes personalizados e notas (só os contatos que têm algum) */
  contacts: Array<{ jid: string; isGroup: boolean; customName: string | null; notes: string | null }>
  alertFeedback: Array<{
    jid: string
    kind: string
    msgId: string | null
    verdict: string
    reasonCode: string | null
    reasonText: string | null
    correctKind: string | null
    contextText: string
    detail: string
    model: string | null
    createdAt: number
  }>
  replyFeedback: Array<{
    jid: string
    msgId: string
    verdict: string
    appNeeds: number | null
    appReason: string | null
    appSource: string | null
    reasonCode: string | null
    reasonText: string | null
    contextText: string
    model: string | null
    createdAt: number
  }>
  kb: Array<{
    name: string
    kind: 'package' | 'manual'
    enabled: boolean
    importedAt: number
    skipped: number
    duplicates: number
    files: Array<{
      path: string
      title: string
      role: string
      autoRole: string
      roleReason: string
      enabled: boolean
      size: number
      hash: string
      sections: number
      chunks: Array<{ ord: number; heading: string; breadcrumb: string; text: string; sensitive: boolean }>
    }>
  }>
  /** configurações sem segredo (chave → valor de `settings_kv`) */
  settings: Record<string, string>
  /** "Incluir mensagens e transcrições": as mensagens (sem a mídia) e os contatos todos */
  messages?: {
    contacts: Array<{ jid: string; pushName: string | null; nameRank: number; isGroup: boolean }>
    rows: Array<{
      id: string
      jid: string
      fromMe: boolean
      ts: number
      kind: string
      text: string | null
      durationSec: number | null
      transcript: string | null
      transcriptStatus: string | null
      senderJid: string | null
      senderName: string | null
      mentionsMe: boolean
    }>
  }
}

const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const optStr = (v: unknown): string | null => (str(v) ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const ALERT_KINDS = new Set(['urgente', 'desanimo', 'reuniao', 'travado', 'esperando'])
const ALERT_VERDICTS = new Set(['up', 'down', 'missed'])
const REPLY_VERDICTS = new Set(['reply_not_needed', 'reply_needed', 'reply_ok'])
const ROLES = new Set<string>(KB_ROLES)
const MSG_KINDS = new Set(['text', 'audio', 'other'])
const TRANSCRIPT = new Set(['done', 'failed', 'unavailable'])

/**
 * Lê os dados de uma cópia sem confiar neles: ignora o que não tem o formato certo (cada linha é conferida).
 * Lança se nem a estrutura básica existir.
 */
export function sanitizeBackupData(raw: unknown): BackupData {
  const o = obj(raw)
  if (!o) throw new Error('dados inválidos')
  const out: BackupData = { approvedReplies: [], contacts: [], alertFeedback: [], replyFeedback: [], kb: [], settings: {} }
  for (const v of arr(o.approvedReplies)) {
    const r = obj(v)
    if (!r || !str(r.jid) || !str(r.finalText) || !num(r.createdAt)) continue
    out.approvedReplies.push({
      jid: r.jid,
      contextText: str(r.contextText) ? r.contextText : '',
      originalSuggestion: optStr(r.originalSuggestion),
      finalText: r.finalText,
      sentText: optStr(r.sentText),
      provider: optStr(r.provider),
      createdAt: r.createdAt,
      rejected: arr(r.rejected).filter(str)
    })
  }
  for (const v of arr(o.contacts)) {
    const r = obj(v)
    if (!r || !str(r.jid) || !r.jid) continue
    out.contacts.push({ jid: r.jid, isGroup: r.isGroup === true, customName: optStr(r.customName), notes: optStr(r.notes) })
  }
  for (const v of arr(o.alertFeedback)) {
    const r = obj(v)
    if (!r || !str(r.jid) || !ALERT_KINDS.has(r.kind as string) || !ALERT_VERDICTS.has(r.verdict as string) || !num(r.createdAt)) continue
    out.alertFeedback.push({
      jid: r.jid,
      kind: r.kind as string,
      msgId: optStr(r.msgId),
      verdict: r.verdict as string,
      reasonCode: optStr(r.reasonCode),
      reasonText: optStr(r.reasonText),
      correctKind: str(r.correctKind) && ALERT_KINDS.has(r.correctKind) ? r.correctKind : null,
      contextText: str(r.contextText) ? r.contextText : '',
      detail: str(r.detail) ? r.detail : '',
      model: optStr(r.model),
      createdAt: r.createdAt
    })
  }
  for (const v of arr(o.replyFeedback)) {
    const r = obj(v)
    if (!r || !str(r.jid) || !str(r.msgId) || !REPLY_VERDICTS.has(r.verdict as string) || !num(r.createdAt)) continue
    out.replyFeedback.push({
      jid: r.jid,
      msgId: r.msgId,
      verdict: r.verdict as string,
      appNeeds: r.appNeeds === 1 || r.appNeeds === 0 ? r.appNeeds : null,
      appReason: optStr(r.appReason),
      appSource: optStr(r.appSource),
      reasonCode: optStr(r.reasonCode),
      reasonText: optStr(r.reasonText),
      contextText: str(r.contextText) ? r.contextText : '',
      model: optStr(r.model),
      createdAt: r.createdAt
    })
  }
  for (const v of arr(o.kb)) {
    const p = obj(v)
    if (!p || !str(p.name) || !p.name || (p.kind !== 'package' && p.kind !== 'manual')) continue
    const files: BackupData['kb'][number]['files'] = []
    for (const fv of arr(p.files)) {
      const f = obj(fv)
      if (!f || !str(f.path) || !str(f.title) || !ROLES.has(f.role as string) || !ROLES.has(f.autoRole as string)) continue
      const chunks: BackupData['kb'][number]['files'][number]['chunks'] = []
      for (const cv of arr(f.chunks)) {
        const c = obj(cv)
        if (!c || !num(c.ord) || !str(c.heading) || !str(c.breadcrumb) || !str(c.text)) continue
        chunks.push({ ord: c.ord, heading: c.heading, breadcrumb: c.breadcrumb, text: c.text, sensitive: c.sensitive === true })
      }
      files.push({
        path: f.path,
        title: f.title,
        role: f.role as string,
        autoRole: f.autoRole as string,
        roleReason: str(f.roleReason) ? f.roleReason : '',
        enabled: f.enabled !== false,
        size: num(f.size) ? f.size : 0,
        hash: str(f.hash) ? f.hash : '',
        sections: num(f.sections) ? f.sections : chunks.length,
        chunks
      })
    }
    out.kb.push({
      name: p.name,
      kind: p.kind,
      enabled: p.enabled !== false,
      importedAt: num(p.importedAt) ? p.importedAt : 0,
      skipped: num(p.skipped) ? p.skipped : 0,
      duplicates: num(p.duplicates) ? p.duplicates : 0,
      files
    })
  }
  const s = obj(o.settings)
  if (s) for (const [k, v] of Object.entries(s)) if (str(v)) out.settings[k] = v
  const m = obj(o.messages)
  if (m) {
    const contacts: NonNullable<BackupData['messages']>['contacts'] = []
    for (const v of arr(m.contacts)) {
      const c = obj(v)
      if (!c || !str(c.jid) || !c.jid) continue
      contacts.push({ jid: c.jid, pushName: optStr(c.pushName), nameRank: num(c.nameRank) ? c.nameRank : 0, isGroup: c.isGroup === true })
    }
    const rows: NonNullable<BackupData['messages']>['rows'] = []
    for (const v of arr(m.rows)) {
      const r = obj(v)
      if (!r || !str(r.id) || !str(r.jid) || !num(r.ts) || !MSG_KINDS.has(r.kind as string)) continue
      rows.push({
        id: r.id,
        jid: r.jid,
        fromMe: r.fromMe === true,
        ts: r.ts,
        kind: r.kind as string,
        text: optStr(r.text),
        durationSec: num(r.durationSec) ? r.durationSec : null,
        transcript: optStr(r.transcript),
        transcriptStatus: str(r.transcriptStatus) && TRANSCRIPT.has(r.transcriptStatus) ? r.transcriptStatus : null,
        senderJid: optStr(r.senderJid),
        senderName: optStr(r.senderName),
        mentionsMe: r.mentionsMe === true
      })
    }
    out.messages = { contacts, rows }
  }
  return out
}

export function countBackup(d: BackupData): BackupCounts {
  return {
    approvedReplies: d.approvedReplies.length,
    contacts: d.contacts.length,
    alertFeedback: d.alertFeedback.length,
    replyFeedback: d.replyFeedback.length,
    kbPackages: d.kb.length,
    kbFiles: d.kb.reduce((n, p) => n + p.files.length, 0),
    settings: Object.keys(d.settings).length,
    messages: d.messages?.rows.length ?? 0
  }
}

const zero = (): BackupCounts => ({ approvedReplies: 0, contacts: 0, alertFeedback: 0, replyFeedback: 0, kbPackages: 0, kbFiles: 0, settings: 0, messages: 0 })

/** Leitura e gravação das tabelas da cópia de segurança. */
export class BackupRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** Junta os dados (sem `settings`, que vêm do `SettingsStore`). */
  collect(opts: { includeMessages: boolean }): Omit<BackupData, 'settings'> {
    const all = (sql: string) => this.db.prepare(sql).all() as Row[]
    const data: Omit<BackupData, 'settings'> = {
      approvedReplies: all('SELECT * FROM approved_replies ORDER BY id').map((r) => ({
        jid: r.jid,
        contextText: r.context_text,
        originalSuggestion: r.original_suggestion ?? null,
        finalText: r.final_text,
        sentText: r.sent_text ?? null,
        provider: r.provider ?? null,
        createdAt: r.created_at,
        rejected: (() => {
          try {
            const v = JSON.parse(r.rejected_json ?? '[]') as unknown
            return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
          } catch {
            return []
          }
        })()
      })),
      contacts: all('SELECT jid, is_group, custom_name, notes FROM contacts WHERE custom_name IS NOT NULL OR (notes IS NOT NULL AND notes <> \'\') ORDER BY jid').map((r) => ({
        jid: r.jid,
        isGroup: r.is_group === 1,
        customName: r.custom_name ?? null,
        notes: r.notes ?? null
      })),
      alertFeedback: all('SELECT * FROM alert_feedback ORDER BY id').map((r) => ({
        jid: r.jid,
        kind: r.kind,
        msgId: r.msg_id ?? null,
        verdict: r.verdict,
        reasonCode: r.reason_code ?? null,
        reasonText: r.reason_text ?? null,
        correctKind: r.correct_kind ?? null,
        contextText: r.context_text,
        detail: r.detail ?? '',
        model: r.model ?? null,
        createdAt: r.created_at
      })),
      replyFeedback: all('SELECT * FROM reply_feedback ORDER BY id').map((r) => ({
        jid: r.jid,
        msgId: r.msg_id,
        verdict: r.verdict,
        appNeeds: r.app_needs ?? null,
        appReason: r.app_reason ?? null,
        appSource: r.app_source ?? null,
        reasonCode: r.reason_code ?? null,
        reasonText: r.reason_text ?? null,
        contextText: r.context_text,
        model: r.model ?? null,
        createdAt: r.created_at
      })),
      kb: this.collectKb()
    }
    if (opts.includeMessages) {
      data.messages = {
        contacts: all('SELECT jid, push_name, name_rank, is_group FROM contacts ORDER BY jid').map((r) => ({
          jid: r.jid,
          pushName: r.push_name ?? null,
          nameRank: r.name_rank ?? 0,
          isGroup: r.is_group === 1
        })),
        // sem a mídia: nem o caminho do arquivo nem a chave de download
        rows: all('SELECT id, jid, from_me, ts, kind, text, duration_sec, transcript, transcript_status, sender_jid, sender_name, mentions_me FROM messages ORDER BY ts, rowid').map((r) => ({
          id: r.id,
          jid: r.jid,
          fromMe: r.from_me === 1,
          ts: r.ts,
          kind: r.kind,
          text: r.text ?? null,
          durationSec: r.duration_sec ?? null,
          transcript: r.transcript ?? null,
          transcriptStatus: r.transcript_status ?? null,
          senderJid: r.sender_jid ?? null,
          senderName: r.sender_name ?? null,
          mentionsMe: r.mentions_me === 1
        }))
      }
    }
    return data
  }

  private collectKb(): BackupData['kb'] {
    const pkgs = this.db.prepare('SELECT * FROM kb_packages ORDER BY id').all() as Row[]
    const files = this.db.prepare('SELECT * FROM kb_files ORDER BY id').all() as Row[]
    const chunks = this.db.prepare('SELECT * FROM kb_chunks ORDER BY file_id, ord').all() as Row[]
    const byFile = new Map<number, Row[]>()
    for (const c of chunks) {
      const l = byFile.get(c.file_id) ?? []
      l.push(c)
      byFile.set(c.file_id, l)
    }
    return pkgs.map((p) => ({
      name: p.name,
      kind: p.kind,
      enabled: p.enabled === 1,
      importedAt: p.imported_at,
      skipped: p.skipped,
      duplicates: p.duplicates,
      files: files
        .filter((f) => f.package_id === p.id)
        .map((f) => ({
          path: f.path,
          title: f.title,
          role: f.role,
          autoRole: f.auto_role,
          roleReason: f.role_reason,
          enabled: f.enabled === 1,
          size: f.size,
          hash: f.hash,
          sections: f.sections,
          chunks: (byFile.get(f.id) ?? []).map((c) => ({ ord: c.ord, heading: c.heading, breadcrumb: c.breadcrumb, text: c.text, sensitive: c.sensitive === 1 }))
        }))
    }))
  }

  /**
   * Aplica a cópia numa transação só (ou tudo, ou nada). `merge` junta sem repetir (chaves estáveis); `replace` apaga
   * antes as respostas aprovadas, avaliações, nomes/notas e a base de conhecimento. Mensagens nunca são apagadas
   * (voltam pelo WhatsApp); as da cópia só entram se ainda não existem. Os índices de busca são refeitos no fim.
   * Devolve quanto de cada coisa entrou.
   */
  apply(d: BackupData, mode: BackupRestoreMode): BackupCounts {
    const n = zero()
    const db = this.db
    db.exec('BEGIN IMMEDIATE')
    try {
      if (mode === 'replace') {
        db.exec(`DELETE FROM approved_replies; DELETE FROM alert_feedback; DELETE FROM reply_feedback;
                 UPDATE contacts SET custom_name = NULL, notes = NULL; DELETE FROM kb_packages; DELETE FROM kb_fts;
                 UPDATE analyses SET chosen_reply_id = NULL`)
      }
      const ensureContact = db.prepare('INSERT OR IGNORE INTO contacts(jid, is_group) VALUES (?, ?)')
      if (d.messages) {
        const up = db.prepare(
          `INSERT INTO contacts(jid, push_name, name_rank, is_group) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(jid) DO UPDATE SET is_group = MAX(is_group, excluded.is_group),
             push_name = CASE WHEN excluded.push_name IS NOT NULL AND excluded.name_rank > name_rank THEN excluded.push_name ELSE push_name END,
             name_rank = MAX(name_rank, CASE WHEN excluded.push_name IS NOT NULL THEN excluded.name_rank ELSE 0 END)`
        )
        for (const c of d.messages.contacts) up.run(c.jid, c.pushName, c.nameRank, c.isGroup ? 1 : 0)
        const ins = db.prepare(
          `INSERT OR IGNORE INTO messages(id, jid, from_me, ts, kind, text, duration_sec, transcript, transcript_status, sender_jid, sender_name, mentions_me)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        for (const m of d.messages.rows) {
          ensureContact.run(m.jid, m.jid.endsWith('@g.us') ? 1 : 0)
          const r = ins.run(m.id, m.jid, m.fromMe ? 1 : 0, m.ts, m.kind, m.text, m.durationSec, m.transcript, m.transcriptStatus, m.senderJid, m.senderName, m.mentionsMe ? 1 : 0)
          n.messages += Number(r.changes)
        }
      }
      const setName = db.prepare(mode === 'replace' ? 'UPDATE contacts SET custom_name = ? WHERE jid = ?' : 'UPDATE contacts SET custom_name = ? WHERE jid = ? AND custom_name IS NULL')
      const setNotes = db.prepare(
        mode === 'replace' ? 'UPDATE contacts SET notes = ? WHERE jid = ?' : "UPDATE contacts SET notes = ? WHERE jid = ? AND (notes IS NULL OR notes = '')"
      )
      for (const c of d.contacts) {
        ensureContact.run(c.jid, c.isGroup ? 1 : 0)
        let changed = 0
        if (c.customName) changed += Number(setName.run(c.customName, c.jid).changes)
        if (c.notes) changed += Number(setNotes.run(c.notes, c.jid).changes)
        if (changed) n.contacts++
      }
      const hasApproved = db.prepare('SELECT 1 FROM approved_replies WHERE jid = ? AND final_text = ? AND created_at = ?')
      const insApproved = db.prepare(
        `INSERT INTO approved_replies(jid, context_text, original_suggestion, final_text, sent_text, provider, created_at, rejected_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const a of d.approvedReplies) {
        if (hasApproved.get(a.jid, a.finalText, a.createdAt)) continue
        insApproved.run(a.jid, a.contextText, a.originalSuggestion, a.finalText, a.sentText, a.provider, a.createdAt, a.rejected.length ? JSON.stringify(a.rejected) : null)
        n.approvedReplies++
      }
      // o alert_id aponta para alertas deste computador: na cópia fica sem (os alertas não vão junto)
      const hasAlertFb = db.prepare('SELECT 1 FROM alert_feedback WHERE jid = ? AND kind = ? AND msg_id IS ? AND verdict = ? AND created_at = ?')
      const insAlertFb = db.prepare(
        `INSERT INTO alert_feedback(alert_id, jid, kind, msg_id, verdict, reason_code, reason_text, correct_kind, context_text, detail, model, created_at)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const f of d.alertFeedback) {
        if (hasAlertFb.get(f.jid, f.kind, f.msgId, f.verdict, f.createdAt)) continue
        insAlertFb.run(f.jid, f.kind, f.msgId, f.verdict, f.reasonCode, f.reasonText, f.correctKind, f.contextText, f.detail, f.model, f.createdAt)
        n.alertFeedback++
      }
      const insReplyFb = db.prepare(
        `INSERT OR IGNORE INTO reply_feedback(jid, msg_id, alert_id, verdict, app_needs, app_reason, app_source, reason_code, reason_text, context_text, model, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const f of d.replyFeedback) {
        n.replyFeedback += Number(
          insReplyFb.run(f.jid, f.msgId, f.verdict, f.appNeeds, f.appReason, f.appSource, f.reasonCode, f.reasonText, f.contextText, f.model, f.createdAt).changes
        )
      }
      this.applyKb(d.kb, n)
      this.rebuildIndexes()
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return n
  }

  /** Pacotes que ainda não existem entram inteiros; nos que existem, só os arquivos de caminho novo. */
  private applyKb(kb: BackupData['kb'], n: BackupCounts): void {
    const db = this.db
    const findPkg = db.prepare('SELECT id FROM kb_packages WHERE name = ?')
    const insPkg = db.prepare('INSERT INTO kb_packages(name, kind, enabled, imported_at, skipped, duplicates) VALUES (?, ?, ?, ?, ?, ?)')
    const hasFile = db.prepare('SELECT 1 FROM kb_files WHERE package_id = ? AND path = ?')
    const insFile = db.prepare(
      `INSERT INTO kb_files(package_id, path, title, role, auto_role, role_reason, enabled, size, hash, sections)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insChunk = db.prepare('INSERT INTO kb_chunks(file_id, ord, heading, breadcrumb, text, sensitive) VALUES (?, ?, ?, ?, ?, ?)')
    for (const p of kb) {
      let pkgId = (findPkg.get(p.name) as Row | undefined)?.id as number | undefined
      if (pkgId === undefined) {
        pkgId = Number(insPkg.run(p.name, p.kind, p.enabled ? 1 : 0, p.importedAt, p.skipped, p.duplicates).lastInsertRowid)
        n.kbPackages++
      }
      for (const f of p.files) {
        if (hasFile.get(pkgId, f.path)) continue
        const fileId = Number(insFile.run(pkgId, f.path, f.title, f.role, f.autoRole, f.roleReason, f.enabled ? 1 : 0, f.size, f.hash, f.sections).lastInsertRowid)
        for (const c of f.chunks) insChunk.run(fileId, c.ord, c.heading, c.breadcrumb, c.text, c.sensitive ? 1 : 0)
        n.kbFiles++
      }
    }
  }

  /** Refaz os índices de busca (respostas aprovadas, base de conhecimento e mensagens) a partir das tabelas. */
  rebuildIndexes(): void {
    this.db.exec(`DELETE FROM approved_fts;
      INSERT INTO approved_fts(rowid, context_text, final_text) SELECT id, context_text, final_text FROM approved_replies;
      DELETE FROM kb_fts;
      INSERT INTO kb_fts(rowid, heading, text) SELECT c.id, f.title || ' ' || c.heading, c.text FROM kb_chunks c JOIN kb_files f ON f.id = c.file_id;
      DELETE FROM messages_fts;
      INSERT INTO messages_fts(rowid, body, sender)
        SELECT rowid, TRIM(COALESCE(text, '') || ' ' || COALESCE(transcript, '')), COALESCE(sender_name, '')
          FROM messages WHERE COALESCE(text, transcript, sender_name) IS NOT NULL;`)
  }
}
