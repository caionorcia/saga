/**
 * Regras puras de segurança do processo principal (sem importar o Electron, para testar).
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { InvokeMethod } from '../shared/api'

export interface AppOrigin {
  /** URL do servidor de desenvolvimento (ELECTRON_RENDERER_URL), se houver */
  devUrl?: string
  /** caminho absoluto do index.html empacotado */
  indexFile: string
}

/** A URL é a própria interface do app (servidor de dev ou o index.html empacotado)? */
export function isAppUrl(url: string, origin: AppOrigin): boolean {
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
  if (u.protocol !== 'file:' || (u.host !== '' && u.host !== 'localhost')) return false
  try {
    const p = fileURLToPath(`file://${u.pathname}`)
    return resolve(p) === resolve(origin.indexFile)
  } catch {
    return false
  }
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

const SETTINGS_FIELDS: Record<string, (v: unknown) => boolean> = {
  groqKey: isStr,
  claudeKey: isStr,
  openaiKey: isStr,
  provider: (v) => v === 'groq' || v === 'claude',
  transcriber: (v) => v === 'groq' || v === 'openai',
  dailyCapUsd: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  startWithWindows: isBool,
  claudeModel: isStr,
  groqModel: isStr
}

const RULES: Record<InvokeMethod, (a: unknown[]) => boolean> = {
  getState: () => true,
  listContacts: ([h]) => isBool(h),
  listMessages: ([j]) => nonEmpty(j),
  getAnalysis: ([j]) => nonEmpty(j),
  regenerate: ([j]) => nonEmpty(j),
  saveReply: ([i]) =>
    isObj(i) &&
    nonEmpty(i.jid) &&
    nonEmpty(i.finalText) &&
    (i.originalSuggestion === null || i.originalSuggestion === undefined || isStr(i.originalSuggestion)),
  copyToClipboard: ([t]) => isStr(t),
  renameContact: ([j, n]) => nonEmpty(j) && isStr(n),
  setHidden: ([j, h]) => nonEmpty(j) && isBool(h),
  setNotes: ([j, t]) => nonEmpty(j) && isStr(t),
  pauseAll: () => true,
  resumeAll: () => true,
  manualReconnect: () => true,
  retryFailedJobs: () => true,
  getSettings: () => true,
  saveSettings: ([p]) => isObj(p) && Object.entries(p).every(([k, v]) => v === undefined || (SETTINGS_FIELDS[k]?.(v) ?? false)),
  testKey: ([k, key]) => isStr(k) && KEY_KINDS.has(k) && isStr(key),
  audioUrl: ([id]) => nonEmpty(id)
}

/** Lança `InvalidIpcArgsError` se os argumentos vindos da interface não tiverem o formato esperado. */
export function validateIpcArgs(method: InvokeMethod, args: unknown[]): void {
  if (!RULES[method](args)) throw new InvalidIpcArgsError(method)
}
