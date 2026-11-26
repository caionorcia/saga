import type { AppState } from '../../shared/api'
import { WAIT_AMBER_MS, WAIT_RED_MS, type AlertKind } from '../../shared/triage'
import { KIND_LABELS } from '../../shared/feedback'

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

/**
 * Texto e cor da bolinha de conexão. O estado da conexão vem primeiro: "Pausado" só aparece quando o
 * WhatsApp está conectado, conectando ou esperando para reconectar (uma parada definitiva também pausa
 * a fila, mas o mentor precisa ver o motivo).
 */
export function connectionLabel(
  conn: AppState['conn'],
  paused: boolean,
  retryAt: number | null = null,
  now = Date.now()
): { text: string; tone: Tone } {
  switch (conn) {
    case 'open':
      return paused ? { text: 'Pausado', tone: 'warn' } : { text: 'Conectado', tone: 'ok' }
    case 'connecting':
      return paused ? { text: 'Pausado', tone: 'warn' } : { text: 'Conectando…', tone: 'warn' }
    case 'waiting_retry':
      if (paused) return { text: 'Pausado', tone: 'warn' }
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

/** Explicação (alerta) das paradas definitivas; null para os outros estados. */
export function connAlert(conn: AppState['conn']): string | null {
  switch (conn) {
    case 'stopped_restricted':
      return 'O WhatsApp sinalizou uma restrição na sua conta. O Saga parou tudo e não vai tentar de novo sozinho. Use o WhatsApp só pelo celular por alguns dias; quando quiser voltar a usar o Saga, clique em Reconectar.'
    case 'stopped_outdated':
      return 'O WhatsApp recusou a conexão mesmo depois de o Saga buscar a versão mais nova do WhatsApp Web. Clique em Reconectar para tentar de novo; se continuar, atualize o Saga para a versão mais nova.'
    case 'stopped_replaced':
      return 'O WhatsApp deste computador foi conectado em outro lugar. O Saga parou para não disputar a conexão. Feche o outro aparelho ou programa e clique em Reconectar.'
    case 'stopped_logged_out':
      return 'Este computador foi desvinculado do WhatsApp pelo celular. Clique em Reconectar para mostrar um QR Code novo e vincular de novo. As conversas já importadas continuam guardadas.'
    default:
      return null
  }
}

/**
 * Por que o QR Code não está na tela (passo do QR e painel de vincular de novo); null quando não há problema
 * a explicar. Paradas definitivas usam o mesmo texto do alerta da tela principal.
 */
export function qrProblem(conn: AppState['conn']): string | null {
  const alert = connAlert(conn)
  // aqui o botão se chama "Tentar de novo"
  if (alert) return alert.replace(/Reconectar/g, 'Tentar de novo')
  switch (conn) {
    case 'manual_retry_needed':
      return 'O Saga tentou falar com o WhatsApp várias vezes, sem sucesso, e parou para não insistir. Confira a internet e clique em Tentar de novo.'
    case 'waiting_retry':
      return 'A conexão com o WhatsApp falhou. O Saga vai tentar de novo sozinho; se preferir, clique em Tentar de novo.'
    default:
      return null
  }
}

/** Depois deste tempo sem QR (e sem conexão), o passo do QR avisa que está demorando. */
export const QR_SLOW_MS = 45_000

/** "Baixando áudios: 12 de 340" (só os downloads do lote atual); null sem downloads pendentes. */
export function downloadProgress(d: AppState['downloads'], paused: boolean): string | null {
  if (d.remaining <= 0) return null
  const total = d.done + d.remaining
  return paused ? `Downloads pausados (${d.done} de ${total})` : `Baixando áudios: ${d.done} de ${total}`
}

/** Aviso de transcrição pausada, pelo motivo. */
export function transcribeChip(reason: AppState['transcribePausedReason']): string | null {
  switch (reason) {
    case 'key':
      return 'Transcrição pausada — confira a chave'
    case 'budget':
      return 'Transcrição pausada — teto de gasto de hoje atingido'
    case 'network':
      return 'Sem internet — transcrição volta em instantes'
    default:
      return null
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
  transcribe_budget: 'Teto de gasto atingido: transcrições pausadas',
  transcribe_offline: 'Sem internet: transcrição adiada',
  update_error: 'Erro ao procurar ou baixar atualização',
  update_available: 'Nova versão do Saga disponível',
  update_downloaded: 'Nova versão do Saga baixada',
  wa_open: 'WhatsApp conectado',
  wa_qr: 'QR Code gerado',
  wa_closed: 'Conexão com o WhatsApp caiu',
  wa_connect_error: 'Falha ao conectar ao WhatsApp',
  wa_outdated_retry: 'WhatsApp pediu versão nova: tentando de novo',
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

/** O motivo de uma procura de atualização que falhou, em palavras simples. */
export function updateErrorText(message: string | null): string {
  const m = message ?? ''
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRE|ENETUNREACH|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|ERR_NETWORK|net::ERR_CONNECTION|ERR_TIMED_OUT/i.test(m)) {
    return 'sem conexão com a internet (ou o GitHub não respondeu)'
  }
  if (/\b(403|429)\b|rate limit/i.test(m)) return 'o GitHub recusou a consulta por enquanto (tente mais tarde)'
  if (/\b404\b|Cannot find latest|No published versions/i.test(m)) return 'não foi encontrada uma versão publicada'
  return m || 'erro desconhecido'
}

/** O resultado da última procura por atualização, para Configurações › Atualizações. */
export function updateCheckText(c: AppState['updateCheck'], update: AppState['update']): string {
  if (!c.enabled) return 'Este Saga não procura atualizações sozinho (versão de desenvolvimento).'
  if (c.checking) return 'Procurando uma versão nova…'
  if (c.lastCheckAt === null) return 'Ainda não procurou nesta sessão.'
  const when = `${formatDay(c.lastCheckAt)}, ${formatTime(c.lastCheckAt)}`
  if (c.lastResult === 'error') return `Última procura: ${when} — não foi possível verificar: ${updateErrorText(c.lastError)}.`
  if (c.lastResult === 'available' || update.status !== 'none') {
    const v = update.status !== 'none' ? update.version : c.latestVersion
    return `Última procura: ${when} — nova versão disponível${v ? ` (${v})` : ''}.`
  }
  return `Última procura: ${when} — você já está na versão mais nova.`
}

// --- fila do dia e alertas ---

export type WaitTone = 'neutral' | 'amber' | 'red'

/** "agora", "há 15 min", "há 3 h", "há 1 dia", "há 2 dias" */
export function formatWait(since: number, now = Date.now()): string {
  const ms = Math.max(0, now - since)
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.floor(h / 24)
  return d === 1 ? 'há 1 dia' : `há ${d} dias`
}

/** Cor do selo da espera: neutra até 24 h, âmbar até 48 h, vermelha depois. */
export function waitTone(since: number, now = Date.now()): WaitTone {
  const ms = now - since
  if (ms > WAIT_RED_MS) return 'red'
  if (ms >= WAIT_AMBER_MS) return 'amber'
  return 'neutral'
}

export const ALERT_LABELS: Record<AlertKind, string> = KIND_LABELS

/** Rótulo curto do selo; "esperando" diz há quantos dias ("Esperando 2 dias"). */
export function alertChipLabel(kind: AlertKind, waitingSince: number | null, now = Date.now()): string {
  if (kind !== 'esperando' || waitingSince === null) return ALERT_LABELS[kind]
  const d = Math.max(2, Math.floor((now - waitingSince) / 86_400_000))
  return `Esperando ${d} dias`
}
