import { describe, expect, it } from 'vitest'
import { connectionLabel, eventLabel } from '../../src/renderer/src/format'

describe('connectionLabel', () => {
  const now = 1_000_000
  it('mostra a espera para reconectar em minutos ou segundos', () => {
    expect(connectionLabel('waiting_retry', false, now + 120_000, now).text).toBe('Reconectando em 2 min')
    expect(connectionLabel('waiting_retry', false, now + 90_000, now).text).toBe('Reconectando em 2 min')
    expect(connectionLabel('waiting_retry', false, now + 45_000, now).text).toBe('Reconectando em 45 s')
    expect(connectionLabel('waiting_retry', false, now - 1, now).text).toBe('Reconectando…')
    expect(connectionLabel('waiting_retry', false, null, now).text).toBe('Reconectando…')
  })
  it('pausado tem prioridade', () => {
    expect(connectionLabel('open', true, null, now).text).toBe('Pausado')
  })
})

describe('eventLabel', () => {
  it('traduz tipos conhecidos e tem texto genérico para o resto', () => {
    expect(eventLabel('wa_open')).toBe('WhatsApp conectado')
    expect(eventLabel('qualquer_coisa')).toBe('Evento interno')
  })
})
