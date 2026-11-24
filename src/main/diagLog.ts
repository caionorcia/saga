/**
 * Registro de diagnóstico em arquivo (`<userData>/logs/saga.log`), para o suporte entender problemas
 * na máquina do mentor (ex.: o QR Code que não aparece). Sem Electron, para testar.
 *
 * Uma linha por evento: `2026-11-24T12:00:00.000Z tipo detalhe`. Gira em ~1 MB (guarda 1 arquivo antigo).
 * Nunca deve receber chaves de API, texto de mensagens nem o conteúdo do QR; por garantia, padrões de
 * chave conhecidos são mascarados.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const LOG_FILE = 'saga.log'
export const OLD_LOG_FILE = 'saga.log.1'
export const DEFAULT_MAX_BYTES = 1024 * 1024
const MAX_DETAIL = 2000

/** Mascara padrões de chaves de API (Groq, Anthropic, OpenAI, Bearer). */
export function redactSecrets(s: string): string {
  return s
    .replace(/\b(gsk|sk-ant|sk-proj|sk)[-_][A-Za-z0-9_-]{6,}/g, '[chave omitida]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[omitido]')
    .replace(/(x-api-key["':\s]+)[A-Za-z0-9._-]{8,}/gi, '$1[omitido]')
}

const oneLine = (s: string) => s.replace(/\r?\n/g, ' | ').replace(/\s+/g, ' ').trim()

export interface DiagLog {
  readonly dir: string
  readonly file: string
  write(kind: string, detail?: string): void
  /** últimas `n` linhas (do arquivo antigo também, se preciso) */
  tail(n: number): string[]
}

export function createDiagLog(dir: string, opts: { maxBytes?: number; now?: () => number } = {}): DiagLog {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const now = opts.now ?? Date.now
  const file = join(dir, LOG_FILE)
  const old = join(dir, OLD_LOG_FILE)

  const rotateIfNeeded = () => {
    try {
      if (existsSync(file) && statSync(file).size >= maxBytes) {
        rmSync(old, { force: true })
        renameSync(file, old)
      }
    } catch {
      // sem girar: continua escrevendo
    }
  }

  const readLines = (f: string): string[] => {
    try {
      return readFileSync(f, 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  return {
    dir,
    file,
    write(kind, detail = '') {
      try {
        mkdirSync(dir, { recursive: true })
        rotateIfNeeded()
        const k = oneLine(kind).replace(/\s/g, '_') || 'evento'
        const d = redactSecrets(oneLine(detail)).slice(0, MAX_DETAIL)
        appendFileSync(file, `${new Date(now()).toISOString()} ${k}${d ? ` ${d}` : ''}\n`, 'utf8')
      } catch {
        // disco cheio / sem permissão: o registro nunca derruba o app
      }
    },
    tail(n) {
      const cur = readLines(file)
      if (cur.length >= n) return cur.slice(-n)
      return [...readLines(old), ...cur].slice(-n)
    }
  }
}

/** Texto do "Copiar diagnóstico": cabeçalho com versões e as últimas linhas do registro. */
export function diagnosticsText(log: DiagLog, header: Record<string, string>, lines = 200): string {
  const head = Object.entries(header).map(([k, v]) => `${k}: ${v}`)
  const body = log.tail(lines)
  return [
    '=== Diagnóstico do Saga ===',
    ...head,
    `Registro: ${body.length} linhas mais recentes`,
    '',
    ...(body.length ? body : ['(registro vazio)'])
  ].join('\n')
}
