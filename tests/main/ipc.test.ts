import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()
const showSaveDialog = vi.fn()

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: (...a: unknown[]) => showSaveDialog(...a), showErrorBox: vi.fn() },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
    removeHandler: (ch: string) => handlers.delete(ch)
  }
}))

const { registerIpc } = await import('../../src/main/ipc')

const APP = 'file:///app/index.html'
const call = (m: string, url: string | null, ...args: unknown[]) =>
  Promise.resolve().then(() => handlers.get(`saga:${m}`)!({ senderFrame: url ? { url } : null }, ...args))

describe('IPC das avaliações de alertas', () => {
  let dir: string
  let service: Record<string, ReturnType<typeof vi.fn>>
  let refused: string[]
  let off: () => void

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saga-ipc-'))
    refused = []
    service = {
      rateAlert: vi.fn(async () => {}),
      reportMissedAlert: vi.fn(async () => {}),
      alertQuality: vi.fn(async () => ({ since: 0, days: 30, kinds: [] })),
      alertFeedbackCsv: vi.fn(() => ({ csv: '﻿data;tipo\r\n"2026-11-25 10:00";"Urgente"\r\n', rows: 1 })),
      onState: vi.fn(() => () => {}),
      onContactsChanged: vi.fn(() => () => {}),
      on: vi.fn(),
      off: vi.fn()
    }
    off = registerIpc(service as never, {
      getWindow: () => null,
      isTrustedSender: (u) => u === APP,
      onRefused: (m) => refused.push(m)
    })
  })
  afterEach(() => {
    off()
    rmSync(dir, { recursive: true, force: true })
    showSaveDialog.mockReset()
  })

  it('recusa quem não é a interface do app, sem chamar o serviço', async () => {
    for (const m of ['rateAlert', 'reportMissedAlert', 'alertQuality', 'exportAlertFeedback']) {
      await expect(call(m, 'https://evil.example/', 1, 'up')).rejects.toThrow(/origem não confiável/)
      await expect(call(m, null)).rejects.toThrow(/origem não confiável/)
    }
    expect(refused).toHaveLength(8)
    expect(service.rateAlert).not.toHaveBeenCalled()
    expect(service.alertFeedbackCsv).not.toHaveBeenCalled()
  })

  it('valida os argumentos e repassa ao serviço', async () => {
    await expect(call('rateAlert', APP, 1, 'down')).rejects.toThrow(/argumentos inválidos/)
    await call('rateAlert', APP, 7, 'down', { code: 'brincadeira' })
    expect(service.rateAlert).toHaveBeenCalledWith(7, 'down', { code: 'brincadeira' })
    await call('reportMissedAlert', APP, 'j@s.whatsapp.net', 'reuniao')
    expect(service.reportMissedAlert).toHaveBeenCalledWith('j@s.whatsapp.net', 'reuniao', null, null)
  })

  it('exportar: o caminho vem do "Salvar como"; grava UTF-8 com BOM; cancelar não grava', async () => {
    const file = join(dir, 'avaliacoes.csv')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: file })
    expect(await call('exportAlertFeedback', APP, { anonymize: true })).toEqual({ status: 'saved', rows: 1 })
    expect(service.alertFeedbackCsv).toHaveBeenCalledWith({ anonymize: true })
    expect(showSaveDialog.mock.calls[0][0]).toMatchObject({ defaultPath: expect.stringMatching(/saga-avaliacoes-alertas-\d{4}-\d{2}-\d{2}\.csv$/) })
    const bytes = readFileSync(file)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.toString('utf8')).toContain('"Urgente"')

    showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' })
    expect(await call('exportAlertFeedback', APP, { anonymize: false })).toEqual({ status: 'canceled' })

    service.alertFeedbackCsv.mockReturnValueOnce({ csv: '', rows: 0 })
    expect(await call('exportAlertFeedback', APP, { anonymize: true })).toEqual({ status: 'empty' })
    expect(showSaveDialog).toHaveBeenCalledTimes(2)
  })
})
