/**
 * Regras puras de segurança do processo principal (sem importar o Electron, para testar).
 */
import { posix, win32 } from 'node:path'
import { ALERT_KINDS, CONTACT_KINDS, type InvokeMethod } from '../shared/api'
import { REASON_CODES, REASON_TEXT_MAX, REPLY_REASON_CODES } from '../shared/feedback'
import { AI_ALERT_KINDS } from '../shared/triage'
import { KB_LIMITS, KB_ROLES } from '../shared/kb'

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
const KEY_KINDS = new Set(['groq', 'claude', 'openai'])
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
  provider: (v) => v === 'groq' || v === 'claude',
  transcriber: (v) => v === 'groq' || v === 'openai',
  dailyCapUsd: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  startWithWindows: isBool,
  claudeModel: isStr,
  groqModel: isStr,
  theme: (v) => v === 'system' || v === 'light' || v === 'dark'
}

/** Papel e/ou "Usar" de um arquivo da base (pelo menos um dos dois). */
function isKbPatch(p: unknown): boolean {
  if (!isObj(p) || Object.keys(p).length === 0 || !Object.keys(p).every((k) => k === 'role' || k === 'enabled')) return false
  return (p.role === undefined || (KB_ROLES as readonly unknown[]).includes(p.role)) && (p.enabled === undefined || isBool(p.enabled))
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
  getAnalysis: ([j]) => nonEmpty(j),
  regenerate: ([j]) => nonEmpty(j),
  saveReply: ([i]) =>
    isObj(i) &&
    nonEmpty(i.jid) &&
    nonEmpty(i.finalText) &&
    (i.originalSuggestion === null || i.originalSuggestion === undefined || isStr(i.originalSuggestion)) &&
    (i.analysisLastMsgId === null || i.analysisLastMsgId === undefined || isStr(i.analysisLastMsgId)) &&
    (i.chosenIndex === undefined || (typeof i.chosenIndex === 'number' && Number.isInteger(i.chosenIndex) && i.chosenIndex >= 0 && i.chosenIndex < 20)),
  copyToClipboard: ([t]) => isStr(t),
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
  kbGetChunk: (a) => a.length === 1 && isId(a[0])
}

/** Lança `InvalidIpcArgsError` se os argumentos vindos da interface não tiverem o formato esperado. */
export function validateIpcArgs(method: InvokeMethod, args: unknown[]): void {
  if (!RULES[method](args)) throw new InvalidIpcArgsError(method)
}
