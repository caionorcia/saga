import type { AppState } from '../../shared/api'

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
const shortDayFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' })
const usdFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', currencyDisplay: 'code' })

export const formatTime = (ts: number): string => timeFmt.format(ts)
export const formatDay = (ts: number): string => dayFmt.format(ts)

const startOfDay = (ts: number): number => {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** "14:05" hoje, "Ontem", ou "23/11" */
export function formatListTime(ts: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000)
  if (days <= 0) return formatTime(ts)
  if (days === 1) return 'Ontem'
  return shortDayFmt.format(ts)
}

/** "Hoje", "Ontem" ou "domingo, 23 de novembro" */
export function formatDayHeading(ts: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000)
  if (days <= 0) return 'Hoje'
  if (days === 1) return 'Ontem'
  return formatDay(ts)
}

export const sameDay = (a: number, b: number): boolean => startOfDay(a) === startOfDay(b)

/** "US$ 0,00" */
export function formatUsd(v: number): string {
  return usdFmt.format(v).replace('USD', 'US$').replace(/\s/g, ' ').replace(/^US\$\s*/, 'US$ ')
}

export function formatDuration(sec: number | null): string {
  if (sec === null) return ''
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = parts[0][0]
  const last = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return (first + last).toUpperCase()
}

export type Tone = 'ok' | 'warn' | 'bad'

/** Texto e cor da bolinha de conexão. */
export function connectionLabel(
  conn: AppState['conn'],
  paused: boolean,
  retryAt: number | null = null,
  now = Date.now()
): { text: string; tone: Tone } {
  if (paused) return { text: 'Pausado', tone: 'warn' }
  switch (conn) {
    case 'open':
      return { text: 'Conectado', tone: 'ok' }
    case 'connecting':
      return { text: 'Conectando…', tone: 'warn' }
    case 'waiting_retry':
      if (retryAt !== null && retryAt > now) {
        const sec = Math.ceil((retryAt - now) / 1000)
        return { text: sec >= 60 ? `Reconectando em ${Math.round(sec / 60)} min` : `Reconectando em ${sec} s`, tone: 'warn' }
      }
      return { text: 'Reconectando…', tone: 'warn' }
    case 'needs_qr':
      return { text: 'Aguardando o QR Code', tone: 'warn' }
    case 'manual_retry_needed':
      return { text: 'Desconectado — tente de novo', tone: 'bad' }
    case 'stopped_logged_out':
      return { text: 'Desconectado — vincule novamente', tone: 'bad' }
    case 'stopped_restricted':
      return { text: 'Conta restrita pelo WhatsApp', tone: 'bad' }
    case 'stopped_outdated':
      return { text: 'Versão do app desatualizada', tone: 'bad' }
    case 'stopped_replaced':
      return { text: 'Conectado em outro lugar', tone: 'bad' }
  }
}

export const needsManualReconnect = (conn: AppState['conn']): boolean =>
  conn === 'manual_retry_needed' || conn.startsWith('stopped_')

const EVENT_LABELS: Record<string, string> = {
  ai_error: 'Erro ao gerar sugestões',
  ai_invalid_output: 'A IA respondeu fora do formato esperado',
  ai_key_invalid: 'Chave da IA recusada',
  ai_key_missing: 'Chave da IA não configurada',
  disk_low: 'Pouco espaço no disco: downloads pausados',
  disk_ok: 'Espaço no disco normalizado',
  fetch_profile_skipped: 'Nome do perfil não consultado',
  ipc_refused: 'Chamada bloqueada por segurança',
  reconcile_error: 'Erro ao conferir mensagens enviadas',
  emit_error: 'Erro ao atualizar a tela',
  start_error: 'Erro ao iniciar o Saga',
  wa_open: 'WhatsApp conectado',
  wa_error: 'Erro na conexão com o WhatsApp',
  wa_bad_session: 'Sessão do WhatsApp refeita',
  wa_bad_session_restored: 'Sessão do WhatsApp restaurada do backup',
  wa_manual_retry_needed: 'Reconexão automática esgotada',
  wa_stopped_logged_out: 'WhatsApp desvinculado do celular',
  wa_stopped_restricted: 'Conta restrita pelo WhatsApp',
  wa_stopped_outdated: 'Versão do app desatualizada',
  wa_stopped_replaced: 'WhatsApp conectado em outro lugar'
}

export const eventLabel = (kind: string): string => EVENT_LABELS[kind] ?? 'Evento interno'
