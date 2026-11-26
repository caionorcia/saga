/**
 * Horário de envio (v0.4.1): em que dias e horários o envio direto pode sair. Fora dele, um envio só sai com "Forçar
 * envio" (o mentor marca na confirmação). Tudo no fuso do computador e pelas partes da data local (dia da semana, hora e
 * minuto), nunca por um deslocamento fixo: a troca de horário de verão não quebra a regra.
 *
 * Regras: o início vale (09:00 já pode), o fim não (18:00 já não pode). Um intervalo por dia. Horário de envio desligado
 * = pode sempre. Nada espera para sair depois: um envio que cai fora do horário expira (ver o spec, "Envio de mensagens").
 */

/** Um dia da semana: liberado ou não, e o intervalo (HH:MM, de 15 em 15 minutos; o fim pode ser 24:00). */
export interface SendDay {
  on: boolean
  start: string
  end: string
}

export interface SendSchedule {
  /** a regra vale (padrão: sim). Desligada, o envio pode sair a qualquer hora */
  enabled: boolean
  /** 7 dias, na ordem do `Date.getDay()`: 0 = domingo, 1 = segunda … 6 = sábado */
  days: SendDay[]
}

const WEEKDAY: SendDay = { on: true, start: '09:00', end: '18:00' }
const WEEKEND: SendDay = { on: false, start: '09:00', end: '18:00' }

/** Padrão: segunda a sexta, das 09:00 às 18:00; sábado e domingo sem envio. */
export const DEFAULT_SEND_SCHEDULE: SendSchedule = {
  enabled: true,
  days: [WEEKEND, WEEKDAY, WEEKDAY, WEEKDAY, WEEKDAY, WEEKDAY, WEEKEND].map((d) => ({ ...d }))
}

/** A ordem em que os dias aparecem (segunda primeiro), como índices do `getDay()`. */
export const WEEK_ORDER: ReadonlyArray<number> = [1, 2, 3, 4, 5, 6, 0]
export const DAY_SHORT: ReadonlyArray<string> = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
export const DAY_LONG: ReadonlyArray<string> = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']

/** Motivo gravado quando um envio confirmado sem "Forçar envio" cai fora do horário antes de sair. */
export const OUTSIDE_HOURS_REASON = 'fora do horário de envio'

/** Os horários que dá para escolher: de 00:00 a 24:00, de 15 em 15 minutos. */
export const SCHEDULE_TIMES: ReadonlyArray<string> = Array.from({ length: 97 }, (_, i) => minutesToHHMM(i * 15))

export function minutesToHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

/** "09:30" → 570. Só HH:MM de 15 em 15 minutos, de 00:00 a 24:00; qualquer outra coisa → null. */
export function parseHHMM(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{2}):(\d{2})$/.exec(v)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (min % 15 !== 0 || min > 45 || h > 24 || (h === 24 && min !== 0)) return null
  return h * 60 + min
}

/** O dia está certo: o fim depois do início (só importa nos dias liberados, mas os dois horários precisam ser válidos). */
export function isValidDay(d: unknown): d is SendDay {
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return false
  const x = d as Record<string, unknown>
  if (!Object.keys(x).every((k) => k === 'on' || k === 'start' || k === 'end')) return false
  const s = parseHHMM(x.start)
  const e = parseHHMM(x.end)
  return typeof x.on === 'boolean' && s !== null && e !== null && e > s
}

export function isValidSchedule(v: unknown): v is SendSchedule {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const x = v as Record<string, unknown>
  if (!Object.keys(x).every((k) => k === 'enabled' || k === 'days')) return false
  return typeof x.enabled === 'boolean' && Array.isArray(x.days) && x.days.length === 7 && x.days.every(isValidDay)
}

/** Cópia limpa (só os campos conhecidos). */
export function cloneSchedule(s: SendSchedule): SendSchedule {
  return { enabled: s.enabled, days: s.days.map((d) => ({ on: d.on, start: d.start, end: d.end })) }
}

const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes()

/** Pode enviar agora? Horário desligado (ou ausente): sempre. Início incluído, fim excluído, pela hora local. */
export function isWithinSendHours(s: SendSchedule | null | undefined, now: number): boolean {
  if (!s || !s.enabled) return true
  const d = new Date(now)
  const day = s.days[d.getDay()]
  if (!day?.on) return false
  const m = minuteOfDay(d)
  const start = parseHHMM(day.start)
  const end = parseHHMM(day.end)
  return start !== null && end !== null && m >= start && m < end
}

/** O começo do próximo horário de envio depois de `now` (epoch ms), ou null se nenhum dia estiver liberado. */
export function nextSendWindow(s: SendSchedule, now: number): number | null {
  const d = new Date(now)
  for (let k = 0; k <= 7; k++) {
    // a data local de `now` + k dias (o construtor local acerta o horário de verão)
    const base = new Date(d.getFullYear(), d.getMonth(), d.getDate() + k)
    const day = s.days[base.getDay()]
    const start = parseHHMM(day?.start)
    const end = parseHHMM(day?.end)
    if (!day?.on || start === null || end === null || end <= start) continue
    const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(start / 60), start % 60).getTime()
    if (at > now) return at
  }
  return null
}

/** "Seg–Sex, 09:00–18:00" (dias seguidos com o mesmo horário juntos; grupos separados por "; "). */
export function scheduleSummary(s: SendSchedule): string {
  const groups: Array<{ from: number; to: number; range: string }> = []
  let prev: { idx: number; range: string } | null = null
  for (let i = 0; i < WEEK_ORDER.length; i++) {
    const day = s.days[WEEK_ORDER[i]]
    if (!day?.on) {
      prev = null
      continue
    }
    const range = `${day.start}–${day.end}`
    const g = groups[groups.length - 1]
    if (prev && prev.idx === i - 1 && prev.range === range && g) g.to = WEEK_ORDER[i]
    else groups.push({ from: WEEK_ORDER[i], to: WEEK_ORDER[i], range })
    prev = { idx: i, range }
  }
  if (groups.length === 0) return 'nenhum dia liberado'
  if (groups.length === 1 && groups[0].from === 1 && groups[0].to === 0) return `todos os dias, ${groups[0].range}`
  return groups.map((g) => `${g.from === g.to ? DAY_SHORT[g.from] : `${DAY_SHORT[g.from]}–${DAY_SHORT[g.to]}`}, ${g.range}`).join('; ')
}

const sameLocalDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** "hoje 14:00", "amanhã 09:00" ou "segunda 09:00". */
export function formatNextWindow(at: number, now: number): string {
  const a = new Date(at)
  const n = new Date(now)
  const hhmm = minutesToHHMM(minuteOfDay(a))
  if (sameLocalDay(a, n)) return `hoje ${hhmm}`
  if (sameLocalDay(a, new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1))) return `amanhã ${hhmm}`
  return `${DAY_LONG[a.getDay()]} ${hhmm}`
}

/** A situação do horário de envio agora (para a confirmação e a barra de status). */
export interface SendHoursInfo {
  /** "Seg–Sex, 09:00–18:00" */
  summary: string
  /** epoch ms do próximo horário (null = nenhum dia liberado) */
  nextAllowedAt: number | null
  /** "segunda 09:00" (null = nenhum dia liberado) */
  next: string | null
}

export function sendHoursInfo(s: SendSchedule, now: number): SendHoursInfo {
  const nextAllowedAt = nextSendWindow(s, now)
  return { summary: scheduleSummary(s), nextAllowedAt, next: nextAllowedAt === null ? null : formatNextWindow(nextAllowedAt, now) }
}

/** "Fora do horário de envio (Seg–Sex, 09:00–18:00). Próximo horário: segunda 09:00." */
export function outsideHoursText(h: SendHoursInfo): string {
  return `Fora do horário de envio (${h.summary}).${h.next ? ` Próximo horário: ${h.next}.` : ' Nenhum dia está liberado nas Configurações.'}`
}

/** O fuso do computador ("America/Sao_Paulo"), para mostrar nas Configurações. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'horário do computador'
  } catch {
    return 'horário do computador'
  }
}
