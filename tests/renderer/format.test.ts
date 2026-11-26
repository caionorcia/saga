import { describe, expect, it } from 'vitest'
import { connAlert, connectionLabel, downloadProgress, eventLabel, transcribeChip } from '../../src/renderer/src/format'

describe('connectionLabel', () => {
  const now = 1_000_000
  it('mostra a espera para reconectar em minutos ou segundos', () => {
    expect(connectionLabel('waiting_retry', false, now + 120_000, now).text).toBe('Reconectando em 2 min')
    expect(connectionLabel('waiting_retry', false, now + 90_000, now).text).toBe('Reconectando em 2 min')
    expect(connectionLabel('waiting_retry', false, now + 45_000, now).text).toBe('Reconectando em 45 s')
    expect(connectionLabel('waiting_retry', false, now - 1, now).text).toBe('Reconectando…')
    expect(connectionLabel('waiting_retry', false, null, now).text).toBe('Reconectando…')
  })
  it('pausado só vale com conexão aberta, conectando ou esperando para reconectar', () => {
    expect(connectionLabel('open', true, null, now).text).toBe('Pausado')
    expect(connectionLabel('connecting', true, null, now).text).toBe('Pausado')
    expect(connectionLabel('waiting_retry', true, now + 45_000, now).text).toBe('Pausado')
  })
  it('paradas definitivas mostram o motivo mesmo com a fila pausada', () => {
    expect(connectionLabel('stopped_restricted', true, null, now)).toEqual({ text: 'Conta restrita pelo WhatsApp', tone: 'bad' })
    expect(connectionLabel('stopped_logged_out', true, null, now).text).toBe('Desconectado — vincule novamente')
    expect(connectionLabel('stopped_outdated', true, null, now).text).toBe('Versão do app desatualizada')
    expect(connectionLabel('stopped_replaced', true, null, now).text).toBe('Conectado em outro lugar')
    expect(connectionLabel('needs_qr', true, null, now).text).toBe('Aguardando o QR Code')
    expect(connectionLabel('manual_retry_needed', true, null, now).text).toBe('Desconectado — tente de novo')
  })
})

describe('connAlert', () => {
  it('restrição tem texto de alerta; conectado não tem', () => {
    expect(connAlert('stopped_restricted')).toMatch(/restrição/)
    expect(connAlert('stopped_restricted')).toMatch(/Reconectar/)
    expect(connAlert('stopped_outdated')).toMatch(/atualize o SagaZap/)
    expect(connAlert('stopped_replaced')).toMatch(/outro/)
    expect(connAlert('stopped_logged_out')).toMatch(/QR Code/)
    expect(connAlert('open')).toBeNull()
    expect(connAlert('waiting_retry')).toBeNull()
  })
})

describe('downloadProgress', () => {
  it('conta só os downloads do lote atual', () => {
    expect(downloadProgress({ remaining: 0, done: 5 }, false)).toBeNull()
    expect(downloadProgress({ remaining: 328, done: 12 }, false)).toBe('Baixando áudios: 12 de 340')
    expect(downloadProgress({ remaining: 3, done: 1 }, true)).toBe('Downloads pausados (1 de 4)')
  })
})

describe('transcribeChip', () => {
  it('texto pelo motivo da pausa', () => {
    expect(transcribeChip(null)).toBeNull()
    expect(transcribeChip('key')).toBe('Transcrição pausada — confira a chave')
    expect(transcribeChip('budget')).toBe('Transcrição pausada — teto de gasto de hoje atingido')
    expect(transcribeChip('network')).toBe('Sem internet — transcrição volta em instantes')
  })
})

describe('eventLabel', () => {
  it('traduz tipos conhecidos e tem texto genérico para o resto', () => {
    expect(eventLabel('wa_open')).toBe('WhatsApp conectado')
    expect(eventLabel('transcribe_budget')).toBe('Teto de gasto atingido: transcrições pausadas')
    expect(eventLabel('transcribe_offline')).toBe('Sem internet: transcrição adiada')
    expect(eventLabel('qualquer_coisa')).toBe('Evento interno')
  })
})
