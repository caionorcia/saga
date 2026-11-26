/**
 * Regras puras de segurança do processo principal (sem importar o Electron, para testar).
 */
import { posix, win32 } from 'node:path'
import { ALERT_KINDS, CONTACT_KINDS, type InvokeMethod } from '../shared/api'
import { REASON_CODES, REASON_TEXT_MAX, REPLY_REASON_CODES } from '../shared/feedback'
import { AI_ALERT_KINDS } from '../shared/triage'
import { KB_LIMITS, KB_ROLES } from '../shared/kb'
import { SEARCH_KINDS, SEARCH_LIMITS, SEARCH_PERIODS } from '../shared/search'
import { BACKUP_PASSWORD_MAX, BACKUP_PASSWORD_MIN } from '../shared/backup'
import { DRAFT_ID_RE, SEND_LIMITS } from '../shared/send'
import { isValidSchedule } from '../shared/sendHours'
import { COPILOTO_URL_MAX } from '../shared/copiloto'

export interface AppOrigin {
  /** URL do servidor de desenvolvimento (ELECTRON_RENDERER_URL), se houver */
  devUrl?: string
  /** caminho absoluto do index.html empacotado */
  indexFile: string
}

/**
 * Caminho local de uma URL `file:` (host vazio ou `localhost`), no formato da plataforma; `null` se não for.
 * Feito à mão para poder testar o comportamento do Windows em qualquer sistema.
 */
function filePathOf(u: URL, platform: NodeJS.Platform): string | null {
  if (u.protocol !== 'file:' || (u.host !== '' && u.host !== 'localhost')) return null
  let p: string
  try {
    p = decodeURIComponent(u.pathname)
  } catch {
    return null
  }
  if (p.includes('\0')) return null
  if (platform === 'win32') {
    // /C:/Users/... → C:\Users\...
    if (!/^\/[A-Za-z]:\//.test(p)) return null
    return win32.resolve(p.slice(1).replace(/\//g, '\\'))
  }
  return posix.resolve(p)
}

/**
 * A URL é a própria interface do app (servidor de dev ou o index.html empacotado)?
 * No Windows os caminhos não diferenciam maiúsculas (o Chromium manda `C:`, o atalho pode dar `c:`).
 */
export function isAppUrl(url: string, origin: AppOrigin, platform: NodeJS.Platform = process.platform): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (origin.devUrl) {
    try {
      const dev = new URL(origin.devUrl)
      if ((dev.protocol === 'http:' || dev.protocol === 'https:') && u.origin === dev.origin) return true
    } catch {
      // devUrl inválida: só vale o arquivo
    }
  }
  const file = filePathOf(u, platform)
  if (file === null) return false
  if (platform === 'win32') return file.toLowerCase() === win32.resolve(origin.indexFile).toLowerCase()
  return file === posix.resolve(origin.indexFile)
}

/** Links que podem abrir no navegador padrão. */
export function isExternalHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export class InvalidIpcArgsError extends Error {
  constructor(method: string) {
    super(`argumentos inválidos para ${method}`)
    this.name = 'InvalidIpcArgsError'
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const nonEmpty = (v: unknown): v is string => isStr(v) && v.trim().length > 0
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const KEY_KINDS = new Set(['groq', 'claude', 'openai', 'gemini', 'mistral'])
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const isAiKind = (v: unknown) => (AI_ALERT_KINDS as readonly unknown[]).includes(v)
const optText = (v: unknown) => v === undefined || v === null || (isStr(v) && v.length <= REASON_TEXT_MAX)
const REASON_FIELDS = new Set(['code', 'correctKind', 'text'])

/** 👎: motivo conhecido; tipo certo só com "tipo_errado" (null = nenhum); texto opcional e curto. */
function isReason(r: unknown): boolean {
  if (!isObj(r) || !Object.keys(r).every((k) => REASON_FIELDS.has(k))) return false
  if (!(REASON_CODES as readonly unknown[]).includes(r.code)) return false
  if (r.correctKind !== undefined && r.correctKind !== null && !(r.code === 'tipo_errado' && isAiKind(r.correctKind))) return false
  return optText(r.text)
}

/** "Não precisa responder": motivo conhecido e texto opcional e curto. */
function isReplyReason(r: unknown): boolean {
  if (!isObj(r) || !Object.keys(r).every((k) => k === 'code' || k === 'text')) return false
  return (REPLY_REASON_CODES as readonly unknown[]).includes(r.code) && optText(r.text)
}

const SETTINGS_FIELDS: Record<string, (v: unknown) => boolean> = {
  groqKey: isStr,
  claudeKey: isStr,
  openaiKey: isStr,
  geminiKey: isStr,
  mistralKey: isStr,
  provider: (v) => v === 'groq' || v === 'claude',
  transcriber: (v) => v === 'groq' || v === 'openai',
  dailyCapUsd: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  startWithWindows: isBool,
  claudeModel: isStr,
  groqModel: isStr,
  theme: (v) => v === 'system' || v === 'light' || v === 'dark',
  directSend: isBool,
  sendTyping: isBool,
  sendMarkRead: isBool,
  sendQuoteInGroups: isBool,
  sendSchedule: isValidSchedule
}

/** Papel e/ou "Usar" de um arquivo da base (pelo menos um dos dois). */
function isKbPatch(p: unknown): boolean {
  if (!isObj(p) || Object.keys(p).length === 0 || !Object.keys(p).every((k) => k === 'role' || k === 'enabled')) return false
  return (p.role === undefined || (KB_ROLES as readonly unknown[]).includes(p.role)) && (p.enabled === undefined || isBool(p.enabled))
}

const SEARCH_FIELDS: Record<string, (v: unknown) => boolean> = {
  kind: (v) => (SEARCH_KINDS as readonly unknown[]).includes(v),
  period: (v) => (SEARCH_PERIODS as readonly unknown[]).includes(v),
  audioOnly: isBool,
  jid: (v) => v === null || (nonEmpty(v) && v.length <= 200)
}

/** Busca geral: texto (até 200 caracteres) e filtros conhecidos (opcionais). */
function isSearch(a: unknown[]): boolean {
  if (a.length < 1 || a.length > 2) return false
  if (!isStr(a[0]) || a[0].length > SEARCH_LIMITS.queryChars) return false
  const f = a[1]
  if (f === undefined) return true
  return isObj(f) && Object.entries(f).every(([k, v]) => v === undefined || (SEARCH_FIELDS[k]?.(v) ?? false))
}

const isPassword = (v: unknown): v is string => isStr(v) && v.length >= BACKUP_PASSWORD_MIN && v.length <= BACKUP_PASSWORD_MAX
const isToken = (v: unknown) => isStr(v) && /^[0-9a-f-]{36}$/.test(v)

/** "Exportar cópia": senha opcional (6 a 200 caracteres), mensagens sim/não e as preferências da tela (curtas). */
function isBackupExport(o: unknown): boolean {
  if (!isObj(o) || !Object.keys(o).every((k) => k === 'password' || k === 'includeMessages' || k === 'uiPrefs')) return false
  if (!isBool(o.includeMessages)) return false
  if (o.password !== undefined && o.password !== '' && !isPassword(o.password)) return false
  if (o.uiPrefs === undefined) return true
  if (!isObj(o.uiPrefs)) return false
  const e = Object.entries(o.uiPrefs)
  return e.length <= 20 && e.every(([k, v]) => k.startsWith('saga.') && k.length <= 64 && isStr(v) && v.length <= 64)
}

function isAutoBackupPatch(p: unknown): boolean {
  if (!isObj(p) || Object.keys(p).length === 0 || !Object.keys(p).every((k) => k === 'enabled' || k === 'password')) return false
  return (p.enabled === undefined || isBool(p.enabled)) && (p.password === undefined || p.password === '' || isPassword(p.password))
}

const isSendText = (v: unknown): v is string => nonEmpty(v) && [...v].length <= SEND_LIMITS.textChars
const isUuid = (v: unknown) => isStr(v) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
const SEND_REPLY_FIELDS = new Set(['token', 'jid', 'text', 'replyId', 'originalSuggestion', 'analysisLastMsgId', 'chosenIndex'])

/** "Enviar": o token do `prepareSend`, a conversa e o texto, mais (opcionais) os dados da sugestão escolhida. */
function isSendReply(i: unknown): boolean {
  if (!isObj(i) || !Object.keys(i).every((k) => SEND_REPLY_FIELDS.has(k))) return false
  return (
    isUuid(i.token) &&
    nonEmpty(i.jid) &&
    i.jid.length <= 200 &&
    isSendText(i.text) &&
    (i.replyId === undefined || i.replyId === null || isId(i.replyId)) &&
    (i.originalSuggestion === undefined || i.originalSuggestion === null || isStr(i.originalSuggestion)) &&
    (i.analysisLastMsgId === undefined || i.analysisLastMsgId === null || isStr(i.analysisLastMsgId)) &&
    (i.chosenIndex === undefined || (typeof i.chosenIndex === 'number' && Number.isInteger(i.chosenIndex) && i.chosenIndex >= 0 && i.chosenIndex < 20))
  )
}

const SEND_AVULSA_FIELDS = new Set(['token', 'jid', 'text', 'draftId'])

/** v0.6.0 "Enviar mensagem avulsa": só o token, a conversa, o texto e o id do rascunho (nada de "forçar" nem citação). */
function isSendAvulsa(i: unknown): boolean {
  if (!isObj(i) || !Object.keys(i).every((k) => SEND_AVULSA_FIELDS.has(k))) return false
  return isUuid(i.token) && nonEmpty(i.jid) && i.jid.length <= 200 && isSendText(i.text) && isStr(i.draftId) && DRAFT_ID_RE.test(i.draftId)
}

/** Copiloto: só `enabled` (sim/não) e/ou `url` (texto curto; o formato é conferido no serviço, com mensagem). */
function isCopilotoPatch(p: unknown): boolean {
  if (!isObj(p) || Object.keys(p).length === 0 || !Object.keys(p).every((k) => k === 'enabled' || k === 'url')) return false
  return (p.enabled === undefined || isBool(p.enabled)) && (p.url === undefined || (isStr(p.url) && p.url.length <= COPILOTO_URL_MAX))
}

const RULES: Record<InvokeMethod, (a: unknown[]) => boolean> = {
  getState: () => true,
  listContacts: ([h, k]) => isBool(h) && (k === undefined || (CONTACT_KINDS as readonly unknown[]).includes(k)),
  listMessages: ([j]) => nonEmpty(j),
  listAlerts: (a) => a.length <= 1 && (a[0] === undefined || nonEmpty(a[0])),
  dismissAlert: (a) => a.length === 2 && nonEmpty(a[0]) && (ALERT_KINDS as readonly unknown[]).includes(a[1]),
  rateAlert: (a) =>
    isId(a[0]) &&
    ((a[1] === 'up' && a.length <= 3 && a[2] === undefined) || (a[1] === 'down' && a.length === 3 && isReason(a[2]))),
  reportMissedAlert: (a) =>
    a.length >= 2 && a.length <= 4 && nonEmpty(a[0]) && isAiKind(a[1]) && (a[2] === undefined || a[2] === null || nonEmpty(a[2])) && optText(a[3]),
  setNeedsReply: (a) =>
    nonEmpty(a[0]) &&
    ((a[1] === true && a.length <= 3 && a[2] === undefined) || (a[1] === false && a.length === 3 && isReplyReason(a[2]))),
  confirmNoReply: (a) => a.length === 1 && nonEmpty(a[0]),
  alertQuality: (a) => a.length === 0,
  exportAlertFeedback: (a) => a.length === 1 && isObj(a[0]) && Object.keys(a[0]).every((k) => k === 'anonymize') && isBool(a[0].anonymize),
  getAnalysis: (a) =>
    a.length >= 1 &&
    a.length <= 2 &&
    nonEmpty(a[0]) &&
    (a[1] === undefined || (isObj(a[1]) && Object.keys(a[1]).every((k) => k === 'onlyIfNeeded') && (a[1].onlyIfNeeded === undefined || isBool(a[1].onlyIfNeeded)))),
  regenerate: ([j]) => nonEmpty(j),
  saveReply: ([i]) =>
    isObj(i) &&
    nonEmpty(i.jid) &&
    nonEmpty(i.finalText) &&
    (i.originalSuggestion === null || i.originalSuggestion === undefined || isStr(i.originalSuggestion)) &&
    (i.analysisLastMsgId === null || i.analysisLastMsgId === undefined || isStr(i.analysisLastMsgId)) &&
    (i.chosenIndex === undefined || (typeof i.chosenIndex === 'number' && Number.isInteger(i.chosenIndex) && i.chosenIndex >= 0 && i.chosenIndex < 20)),
  copyToClipboard: ([t]) => isStr(t),
  prepareSend: (a) =>
    a.length === 1 &&
    isObj(a[0]) &&
    Object.keys(a[0]).every((k) => k === 'jid' || k === 'text' || k === 'forced' || k === 'kind') &&
    nonEmpty(a[0].jid) &&
    a[0].jid.length <= 200 &&
    isSendText(a[0].text) &&
    (a[0].forced === undefined || isBool(a[0].forced)) &&
    (a[0].kind === undefined || a[0].kind === 'reply' || a[0].kind === 'avulsa'),
  sendReply: (a) => a.length === 1 && isSendReply(a[0]),
  sendAvulsa: (a) => a.length === 1 && isSendAvulsa(a[0]),
  cancelSend: (a) => a.length === 1 && isId(a[0]),
  listSends: (a) => a.length === 1 && nonEmpty(a[0]) && a[0].length <= 200,
  checkSend: (a) => a.length === 1 && isId(a[0]),
  renameContact: ([j, n]) => nonEmpty(j) && isStr(n),
  setNotes: ([j, t]) => nonEmpty(j) && isStr(t),
  pauseAll: () => true,
  resumeAll: () => true,
  manualReconnect: () => true,
  retryFailedJobs: () => true,
  downloadUpdate: () => true,
  checkForUpdates: (a) => a.length === 0,
  installUpdate: (a) => a.length === 0,
  getSettings: () => true,
  saveSettings: ([p]) => isObj(p) && Object.entries(p).every(([k, v]) => v === undefined || (SETTINGS_FIELDS[k]?.(v) ?? false)),
  testKey: ([k, key]) => isStr(k) && KEY_KINDS.has(k) && isStr(key),
  recentEvents: ([n]) => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 200,
  copyDiagnostics: (a) => a.length === 0,
  openLogsFolder: (a) => a.length === 0,
  audioUrl: ([id]) => nonEmpty(id),
  kbList: (a) => a.length === 0,
  kbImport: (a) => a.length === 1 && (a[0] === 'archive' || a[0] === 'folder'),
  kbAddFile: (a) => a.length === 0,
  kbAddText: (a) =>
    a.length === 2 && nonEmpty(a[0]) && a[0].length <= KB_LIMITS.titleChars && nonEmpty(a[1]) && a[1].length <= KB_LIMITS.pasteChars,
  kbUpdateFile: (a) => a.length === 2 && isId(a[0]) && isKbPatch(a[1]),
  kbSetPackageEnabled: (a) => a.length === 2 && isId(a[0]) && isBool(a[1]),
  kbRemovePackage: (a) => a.length === 1 && isId(a[0]),
  kbGetChunk: (a) => a.length === 1 && isId(a[0]),
  searchMessages: isSearch,
  summarizeSearch: isSearch,
  backupStatus: (a) => a.length === 0,
  exportBackup: (a) => a.length === 1 && isBackupExport(a[0]),
  restoreOpen: (a) => a.length === 0,
  restoreUnlock: (a) => a.length === 2 && isToken(a[0]) && isStr(a[1]) && a[1].length > 0 && a[1].length <= BACKUP_PASSWORD_MAX,
  restoreApply: (a) => a.length === 2 && isToken(a[0]) && (a[1] === 'merge' || a[1] === 'replace'),
  chooseBackupFolder: (a) => a.length === 0,
  setAutoBackup: (a) => a.length === 1 && isAutoBackupPatch(a[0]),
  copilotoStatus: (a) => a.length === 0,
  copilotoSave: (a) => a.length === 1 && isCopilotoPatch(a[0]),
  copilotoGenerateCode: (a) => a.length === 0,
  copilotoTest: (a) => a.length === 0
}

/** Lança `InvalidIpcArgsError` se os argumentos vindos da interface não tiverem o formato esperado. */
export function validateIpcArgs(method: InvokeMethod, args: unknown[]): void {
  if (!RULES[method](args)) throw new InvalidIpcArgsError(method)
}
