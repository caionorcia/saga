import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SEND_SCHEDULE,
  cloneSchedule,
  formatNextWindow,
  isValidSchedule,
  isWithinSendHours,
  nextSendWindow,
  outsideHoursText,
  parseHHMM,
  scheduleSummary,
  sendHoursInfo,
  type SendSchedule
} from '../../../src/shared/sendHours'

/** hora local (o vitest.config fixa o fuso em America/Sao_Paulo) */
const at = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime()
// 24/11/2025 é segunda
const MON = 24

const sched = (patch: (s: SendSchedule) => void = () => {}) => {
  const s = cloneSchedule(DEFAULT_SEND_SCHEDULE)
  patch(s)
  return s
}

describe('horário de envio', () => {
  it('padrão: segunda a sexta, 09:00–18:00, ligado', () => {
    expect(DEFAULT_SEND_SCHEDULE.enabled).toBe(true)
    expect(scheduleSummary(DEFAULT_SEND_SCHEDULE)).toBe('Seg–Sex, 09:00–18:00')
    expect(isValidSchedule(DEFAULT_SEND_SCHEDULE)).toBe(true)
  })

  it('dentro e fora em cada dia da semana', () => {
    const s = DEFAULT_SEND_SCHEDULE
    for (let i = 0; i < 7; i++) {
      const day = MON + i // seg..dom
      const weekday = i < 5
      expect(isWithinSendHours(s, at(2025, 11, day, 10)), `dia ${day} 10h`).toBe(weekday)
      expect(isWithinSendHours(s, at(2025, 11, day, 8)), `dia ${day} 8h`).toBe(false)
      expect(isWithinSendHours(s, at(2025, 11, day, 20)), `dia ${day} 20h`).toBe(false)
    }
  })

  it('limites: o início vale, o fim não', () => {
    const s = DEFAULT_SEND_SCHEDULE
    expect(isWithinSendHours(s, at(2025, 11, MON, 8, 59, 59))).toBe(false)
    expect(isWithinSendHours(s, at(2025, 11, MON, 9, 0, 0))).toBe(true)
    expect(isWithinSendHours(s, at(2025, 11, MON, 17, 59, 59))).toBe(true)
    expect(isWithinSendHours(s, at(2025, 11, MON, 18, 0, 0))).toBe(false)
  })

  it('desligado (ou ausente) = pode sempre', () => {
    const off = sched((s) => (s.enabled = false))
    expect(isWithinSendHours(off, at(2025, 11, 29, 3))).toBe(true)
    expect(isWithinSendHours(undefined, at(2025, 11, 29, 3))).toBe(true)
  })

  it('fim 24:00 vai até a meia-noite; cada dia com o seu horário', () => {
    const s = sched((x) => {
      x.days[6] = { on: true, start: '10:00', end: '24:00' }
    })
    expect(isWithinSendHours(s, at(2025, 11, 29, 23, 59, 59))).toBe(true)
    expect(isWithinSendHours(s, at(2025, 11, 30, 0, 0))).toBe(false)
    expect(scheduleSummary(s)).toBe('Seg–Sex, 09:00–18:00; Sáb, 10:00–24:00')
  })

  it('próximo horário: mais tarde hoje, amanhã, ou segunda depois da sexta à noite', () => {
    const s = DEFAULT_SEND_SCHEDULE
    expect(nextSendWindow(s, at(2025, 11, MON, 7))).toBe(at(2025, 11, MON, 9))
    expect(formatNextWindow(at(2025, 11, MON, 9), at(2025, 11, MON, 7))).toBe('hoje 09:00')
    expect(nextSendWindow(s, at(2025, 11, MON, 19))).toBe(at(2025, 11, MON + 1, 9))
    expect(formatNextWindow(at(2025, 11, MON + 1, 9), at(2025, 11, MON, 19))).toBe('amanhã 09:00')
    const fri = at(2025, 11, 28, 18, 30)
    expect(nextSendWindow(s, fri)).toBe(at(2025, 12, 1, 9))
    const info = sendHoursInfo(s, fri)
    expect(info).toEqual({ summary: 'Seg–Sex, 09:00–18:00', nextAllowedAt: at(2025, 12, 1, 9), next: 'segunda 09:00' })
    expect(outsideHoursText(info)).toBe('Fora do horário de envio (Seg–Sex, 09:00–18:00). Próximo horário: segunda 09:00.')
  })

  it('nenhum dia liberado: nunca pode e não há próximo horário', () => {
    const s = sched((x) => x.days.forEach((d) => (d.on = false)))
    expect(isWithinSendHours(s, at(2025, 11, MON, 10))).toBe(false)
    expect(nextSendWindow(s, at(2025, 11, MON, 10))).toBeNull()
    expect(scheduleSummary(s)).toBe('nenhum dia liberado')
    expect(outsideHoursText(sendHoursInfo(s, at(2025, 11, MON, 10)))).toContain('Nenhum dia está liberado')
  })

  it('todos os dias iguais', () => {
    const s = sched((x) => x.days.forEach((d) => (d.on = true)))
    expect(scheduleSummary(s)).toBe('todos os dias, 09:00–18:00')
  })

  it('validação: HH:MM de 15 em 15 min, fim depois do início, 7 dias, sem campos a mais', () => {
    expect(parseHHMM('09:15')).toBe(555)
    expect(parseHHMM('24:00')).toBe(1440)
    for (const bad of ['9:00', '09:10', '24:15', '25:00', '09:60', '', 900, null]) expect(parseHHMM(bad)).toBeNull()
    expect(isValidSchedule(sched((x) => (x.days[1] = { on: true, start: '18:00', end: '09:00' })))).toBe(false)
    expect(isValidSchedule(sched((x) => (x.days[1] = { on: false, start: '10:00', end: '10:00' })))).toBe(false)
    expect(isValidSchedule({ enabled: true, days: DEFAULT_SEND_SCHEDULE.days.slice(0, 6) })).toBe(false)
    expect(isValidSchedule({ ...DEFAULT_SEND_SCHEDULE, extra: 1 })).toBe(false)
    expect(isValidSchedule(sched((x) => ((x.days[1] as any).x = 1)))).toBe(false)
    expect(isValidSchedule('x')).toBe(false)
  })

  describe('horário de verão (pelas partes da data local, nunca por deslocamento fixo)', () => {
    const prev = process.env.TZ
    afterEach(() => {
      process.env.TZ = prev
    })

    it('Nova York: o próximo horário depois da troca para o horário de verão é 09:00 locais', () => {
      process.env.TZ = 'America/New_York'
      // sábado 07/03/2026 20:00 EST (UTC-5); a troca é domingo 08/03 às 02:00
      const sat = Date.UTC(2026, 2, 8, 1, 0)
      expect(new Date(sat).getHours()).toBe(20)
      // segunda 09/03 09:00 EDT = 13:00 UTC (um deslocamento fixo daria 14:00 UTC)
      expect(nextSendWindow(DEFAULT_SEND_SCHEDULE, sat)).toBe(Date.UTC(2026, 2, 9, 13, 0))
      expect(isWithinSendHours(DEFAULT_SEND_SCHEDULE, Date.UTC(2026, 2, 9, 12, 59))).toBe(false)
      expect(isWithinSendHours(DEFAULT_SEND_SCHEDULE, Date.UTC(2026, 2, 9, 13, 0))).toBe(true)
      expect(isWithinSendHours(DEFAULT_SEND_SCHEDULE, Date.UTC(2026, 2, 9, 21, 59))).toBe(true)
      expect(isWithinSendHours(DEFAULT_SEND_SCHEDULE, Date.UTC(2026, 2, 9, 22, 0))).toBe(false)
    })

    it('Nova York: na volta do horário de verão, 09:00 locais = 14:00 UTC', () => {
      process.env.TZ = 'America/New_York'
      // sexta 30/10/2026 19:00 EDT; a volta é domingo 01/11
      const fri = Date.UTC(2026, 9, 30, 23, 0)
      expect(nextSendWindow(DEFAULT_SEND_SCHEDULE, fri)).toBe(Date.UTC(2026, 10, 2, 14, 0))
      expect(formatNextWindow(Date.UTC(2026, 10, 2, 14, 0), fri)).toBe('segunda 09:00')
    })
  })
})
