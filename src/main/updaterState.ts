/**
 * Regras puras do atualizador (sem Electron, para testar): o estado mostrado na interface a partir dos eventos do
 * `electron-updater`, as linhas do registro de diagnóstico e quando procurar de novo.
 */
import type { UpdateCheck, UpdateState } from '../shared/api'

export interface UpdaterModel {
  /** o aviso da barra de status ("Nova versão disponível — Atualizar") */
  update: UpdateState
  /** a última procura (Configurações › Atualizações) */
  check: UpdateCheck
}

export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string; at: number }
  | { type: 'not_available'; version: string | null; at: number }
  | { type: 'error'; message: string; at: number }
  | { type: 'download_started' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }

/** primeira procura: um pouco depois de abrir (a rede do Windows pode ainda estar subindo) */
export const FIRST_CHECK_MS = 30_000
/** de quanto em quanto tempo procura com o app aberto (inclusive só na bandeja) */
export const CHECK_EVERY_MS = 60 * 60_000
/** depois de uma falha (ex.: sem internet), tenta de novo mais cedo */
export const RETRY_AFTER_ERROR_MS = 10 * 60_000
/** ao abrir a janela ou voltar da suspensão: procura se a última foi há mais que isto */
export const ACTIVITY_GAP_MS = 20 * 60_000

export function initialUpdaterModel(currentVersion: string, enabled: boolean): UpdaterModel {
  return {
    update: { status: 'none' },
    check: { enabled, currentVersion, checking: false, lastCheckAt: null, lastResult: null, latestVersion: null, lastError: null }
  }
}

/** Uma linha curta do erro: só a primeira linha da mensagem, até 200 caracteres. */
export function shortError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const line = raw.split(/\r?\n/).find((l) => l.trim()) ?? ''
  return line.replace(/\s+/g, ' ').trim().slice(0, 200) || 'erro desconhecido'
}

const pct = (n: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)))

/** O próximo estado depois de um evento do atualizador. */
export function reduceUpdater(m: UpdaterModel, e: UpdaterEvent): UpdaterModel {
  switch (e.type) {
    case 'checking':
      return { ...m, check: { ...m.check, checking: true } }
    case 'available': {
      // já baixando ou baixada esta mesma versão: não volta para o botão "Atualizar"
      const keep = m.update.status !== 'none' && m.update.status !== 'available' && m.update.version === e.version
      return {
        update: keep ? m.update : { status: 'available', version: e.version },
        check: { ...m.check, checking: false, lastCheckAt: e.at, lastResult: 'available', latestVersion: e.version, lastError: null }
      }
    }
    case 'not_available':
      return {
        // uma versão já baixada continua pronta para instalar
        update: m.update.status === 'ready' ? m.update : { status: 'none' },
        check: { ...m.check, checking: false, lastCheckAt: e.at, lastResult: 'up_to_date', latestVersion: e.version, lastError: null }
      }
    case 'error': {
      // falhou no meio do download: volta a oferecer o botão "Atualizar"
      const update: UpdateState = m.update.status === 'downloading' ? { status: 'available', version: m.update.version } : m.update
      return { update, check: { ...m.check, checking: false, lastCheckAt: e.at, lastResult: 'error', lastError: e.message } }
    }
    case 'download_started':
      return m.update.status === 'available' ? { ...m, update: { status: 'downloading', version: m.update.version } } : m
    case 'progress':
      return m.update.status === 'downloading' || m.update.status === 'available'
        ? { ...m, update: { status: 'downloading', version: m.update.version, percent: pct(e.percent) } }
        : m
    case 'downloaded':
      return { ...m, update: { status: 'ready', version: e.version } }
  }
}

/**
 * A linha do registro de diagnóstico para o evento (`[tipo, detalhe]`), ou null para não registrar.
 * O progresso do download só entra a cada 25% (`lastBucket`: a última faixa registrada).
 */
export function updaterLogLine(e: UpdaterEvent, lastBucket = -1): [string, string] | null {
  switch (e.type) {
    case 'checking':
      return ['update_checking', '']
    case 'available':
      return ['update_available', `versão ${e.version}`]
    case 'not_available':
      return ['update_not_available', e.version ? `mais nova publicada: ${e.version}` : '']
    case 'error':
      return ['update_error', e.message]
    case 'download_started':
      return ['update_download_started', '']
    case 'progress': {
      const b = progressBucket(e.percent)
      return b > lastBucket ? ['update_download_progress', `${b}%`] : null
    }
    case 'downloaded':
      return ['update_downloaded', `versão ${e.version}`]
  }
}

/** 0, 25, 50, 75 ou 100. */
export function progressBucket(percent: number): number {
  const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  return Math.floor(p / 25) * 25
}

/** Abriu a janela ou voltou da suspensão: vale procurar agora? (nunca enquanto já procura) */
export function shouldCheckOnActivity(check: UpdateCheck, now: number, gapMs = ACTIVITY_GAP_MS): boolean {
  if (!check.enabled || check.checking) return false
  return check.lastCheckAt === null || now - check.lastCheckAt >= gapMs
}

/** Quanto esperar até a próxima procura automática, depois de uma que terminou assim. */
export function nextCheckDelay(result: UpdateCheck['lastResult']): number {
  return result === 'error' ? RETRY_AFTER_ERROR_MS : CHECK_EVERY_MS
}
