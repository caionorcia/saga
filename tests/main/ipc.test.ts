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
      setNeedsReply: vi.fn(async () => {}),
      confirmNoReply: vi.fn(async () => {}),
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
    for (const m of ['rateAlert', 'reportMissedAlert', 'alertQuality', 'exportAlertFeedback', 'setNeedsReply', 'confirmNoReply']) {
      await expect(call(m, 'https://evil.example/', 1, 'up')).rejects.toThrow(/origem não confiável/)
      await expect(call(m, null)).rejects.toThrow(/origem não confiável/)
    }
    expect(refused).toHaveLength(12)
    expect(service.rateAlert).not.toHaveBeenCalled()
    expect(service.setNeedsReply).not.toHaveBeenCalled()
    expect(service.confirmNoReply).not.toHaveBeenCalled()
    expect(service.alertFeedbackCsv).not.toHaveBeenCalled()
  })

  it('valida os argumentos e repassa ao serviço', async () => {
    await expect(call('rateAlert', APP, 1, 'down')).rejects.toThrow(/argumentos inválidos/)
    await call('rateAlert', APP, 7, 'down', { code: 'brincadeira' })
    expect(service.rateAlert).toHaveBeenCalledWith(7, 'down', { code: 'brincadeira' })
    await call('reportMissedAlert', APP, 'j@s.whatsapp.net', 'reuniao')
    expect(service.reportMissedAlert).toHaveBeenCalledWith('j@s.whatsapp.net', 'reuniao', null, null)
    await expect(call('setNeedsReply', APP, 'j@s.whatsapp.net', false)).rejects.toThrow(/argumentos inválidos/)
    await call('setNeedsReply', APP, 'j@s.whatsapp.net', false, { code: 'encerrada' })
    expect(service.setNeedsReply).toHaveBeenCalledWith('j@s.whatsapp.net', false, { code: 'encerrada' })
    await call('setNeedsReply', APP, 'j@s.whatsapp.net', true)
    expect(service.setNeedsReply).toHaveBeenLastCalledWith('j@s.whatsapp.net', true, undefined)
    await call('confirmNoReply', APP, 'j@s.whatsapp.net')
    expect(service.confirmNoReply).toHaveBeenCalledWith('j@s.whatsapp.net')
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

describe('IPC "Verificar agora" (checkForUpdates)', () => {
  const CHECK = { enabled: true, currentVersion: '0.2.3', checking: false, lastCheckAt: 5, lastResult: 'up_to_date', latestVersion: '0.2.3', lastError: null }
  let refused: string[]
  let off: () => void
  let onCheck: ReturnType<typeof vi.fn>
  let service: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    refused = []
    onCheck = vi.fn(async () => CHECK)
    service = {
      state: vi.fn(() => ({ updateCheck: { ...CHECK, enabled: false } })),
      onState: vi.fn(() => () => {}),
      onContactsChanged: vi.fn(() => () => {}),
      on: vi.fn(),
      off: vi.fn()
    }
  })
  afterEach(() => off())

  it('só a interface do app; sem argumentos; devolve o resultado da procura', async () => {
    off = registerIpc(service as never, { getWindow: () => null, isTrustedSender: (u) => u === APP, onRefused: (m) => refused.push(m), onCheckForUpdates: onCheck as never })
    await expect(call('checkForUpdates', 'https://evil.example/')).rejects.toThrow(/origem não confiável/)
    expect(refused).toEqual(['checkForUpdates'])
    expect(onCheck).not.toHaveBeenCalled()
    await expect(call('checkForUpdates', APP, true)).rejects.toThrow(/argumentos inválidos/)
    expect(onCheck).not.toHaveBeenCalled()
    expect(await call('checkForUpdates', APP)).toEqual(CHECK)
    expect(onCheck).toHaveBeenCalledTimes(1)
  })

  it('sem atualizador (app de desenvolvimento): devolve a situação atual, sem procurar', async () => {
    off = registerIpc(service as never, { getWindow: () => null, isTrustedSender: (u) => u === APP })
    expect(await call('checkForUpdates', APP)).toMatchObject({ enabled: false })
  })
})

describe('IPC da busca geral', () => {
  let off: () => void
  afterEach(() => off())

  it('só a interface do app; valida e repassa ao serviço', async () => {
    const refused: string[] = []
    const service = {
      searchMessages: vi.fn(async () => ({ mode: 'and', terms: ['preco'], total: 0, groups: [], tookMs: 1 })),
      summarizeSearch: vi.fn(async () => ({ ok: true, answer: 'x', refs: [], used: 1 })),
      onState: vi.fn(() => () => {}),
      onContactsChanged: vi.fn(() => () => {}),
      on: vi.fn(),
      off: vi.fn()
    }
    off = registerIpc(service as never, { getWindow: () => null, isTrustedSender: (u) => u === APP, onRefused: (m) => refused.push(m) })
    await expect(call('searchMessages', 'https://evil.example/', 'preço')).rejects.toThrow(/origem não confiável/)
    await expect(call('summarizeSearch', null, 'preço')).rejects.toThrow(/origem não confiável/)
    expect(refused).toEqual(['searchMessages', 'summarizeSearch'])
    await expect(call('searchMessages', APP, 'preço', { kind: 'nada' })).rejects.toThrow(/argumentos inválidos/)
    expect(service.searchMessages).not.toHaveBeenCalled()
    await call('searchMessages', APP, 'preço', { period: '7d' })
    expect(service.searchMessages).toHaveBeenCalledWith('preço', { period: '7d' })
    await call('summarizeSearch', APP, 'preço')
    expect(service.summarizeSearch).toHaveBeenCalledWith('preço', {})
  })
})

describe('IPC da cópia de segurança', () => {
  let off: () => void
  afterEach(() => {
    off()
    showSaveDialog.mockReset()
  })

  it('exportar: o caminho vem do "Salvar como" com o nome SagaZap-copia-AAAA-MM-DD.sagabackup; cancelar não grava', async () => {
    const exportTo = vi.fn(() => ({ counts: { approvedReplies: 1 }, bytes: 10 }))
    const saved = vi.fn()
    const service = {
      backup: { exportTo, status: vi.fn(() => ({})), restore: vi.fn(() => ({ status: 'restored' })) },
      onState: vi.fn(() => () => {}),
      onContactsChanged: vi.fn(() => () => {}),
      on: vi.fn(),
      off: vi.fn()
    }
    off = registerIpc(service as never, { getWindow: () => null, isTrustedSender: (u) => u === APP, onSettingsSaved: saved })
    await expect(call('exportBackup', 'https://evil.example/', { includeMessages: false })).rejects.toThrow(/origem não confiável/)
    showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' })
    expect(await call('exportBackup', APP, { includeMessages: false })).toEqual({ status: 'canceled' })
    expect(exportTo).not.toHaveBeenCalled()
    expect(showSaveDialog.mock.calls[0][0]).toMatchObject({ defaultPath: expect.stringMatching(/SagaZap-copia-\d{4}-\d{2}-\d{2}\.sagabackup$/) })
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/tmp/escolhido.sagabackup' })
    expect(await call('exportBackup', APP, { includeMessages: true, password: 'segredo' })).toMatchObject({ status: 'saved', encrypted: true })
    expect(exportTo).toHaveBeenCalledWith('/tmp/escolhido.sagabackup', { includeMessages: true, password: 'segredo', uiPrefs: undefined })
    // restaurar aplica as configurações restauradas na hora
    await call('restoreApply', APP, '0b6f2d4e-8a1c-4c3e-9f00-1234567890ab', 'merge')
    expect(saved).toHaveBeenCalledTimes(1)
  })
})

describe('IPC do envio direto', () => {
  it('recusa origem estranha e argumentos inválidos sem chamar o serviço; repassa o pedido confirmado', async () => {
    const refused: string[] = []
    const service = {
      sendReply: vi.fn(async () => ({ ok: false, code: 'not_confirmed', message: 'x' })),
      prepareSend: vi.fn(async () => ({ ok: false, code: 'disabled', message: 'x' })),
      onState: vi.fn(() => () => {}),
      onContactsChanged: vi.fn(() => () => {}),
      on: vi.fn(),
      off: vi.fn()
    }
    const off = registerIpc(service as never, { getWindow: () => null, isTrustedSender: (u) => u === APP, onRefused: (m) => refused.push(m) })
    try {
      const input = { token: '0f8e4f9a-3c1b-4d2e-9a7b-1c2d3e4f5a6b', jid: '5547999998888@s.whatsapp.net', text: 'Oi!' }
      await expect(call('sendReply', 'https://evil.example/', input)).rejects.toThrow(/origem não confiável/)
      await expect(call('sendReply', APP, { ...input, token: 'x' })).rejects.toThrow(/argumentos inválidos/)
      expect(service.sendReply).not.toHaveBeenCalled()
      expect(refused).toEqual(['sendReply'])
      await call('sendReply', APP, input)
      expect(service.sendReply).toHaveBeenCalledWith(input)
      await call('prepareSend', APP, { jid: input.jid, text: 'Oi!' })
      expect(service.prepareSend).toHaveBeenCalledWith({ jid: input.jid, text: 'Oi!', forced: false, kind: 'reply' })
    } finally {
      off()
    }
  })

  it('v0.6.0 mensagem avulsa: prepareSend com kind; sendAvulsa só com token, conversa, texto e rascunho válidos', async () => {
    const service = {
      sendAvulsa: vi.fn(async () => ({ ok: false, code: 'not_confirmed', message: 'x' })),
      prepareSend: vi.fn(async () => ({ ok: false, code: 'disabled', message: 'x' })),
      onState: vi.fn(() => () => {}),
      onContactsChanged: vi.fn(() => () => {}),
      on: vi.fn(),
      off: vi.fn()
    }
    const off = registerIpc(service as never, { getWindow: () => null, isTrustedSender: (u) => u === APP })
    try {
      const input = { token: '0f8e4f9a-3c1b-4d2e-9a7b-1c2d3e4f5a6b', jid: '5547999998888@s.whatsapp.net', text: 'Oi!', draftId: '6a0c1e2f-3b4d-4e5f-8a9b-0c1d2e3f4a5b' }
      await expect(call('sendAvulsa', 'https://evil.example/', input)).rejects.toThrow(/origem não confiável/)
      for (const bad of [
        { ...input, token: 'x' },
        { ...input, draftId: 'curto' },
        { ...input, draftId: 'com espaço e acento ç' },
        { ...input, draftId: undefined },
        { ...input, text: '   ' },
        { ...input, text: 'x'.repeat(4097) },
        // a avulsa não leva "forçar" (só o token decide), nem citação, nem resposta aprovada
        { ...input, forced: true },
        { ...input, quotedId: 'Q1' },
        { ...input, replyId: 3 }
      ]) {
        await expect(call('sendAvulsa', APP, bad)).rejects.toThrow(/argumentos inválidos/)
      }
      expect(service.sendAvulsa).not.toHaveBeenCalled()
      await call('sendAvulsa', APP, input)
      expect(service.sendAvulsa).toHaveBeenCalledWith(input)
      await expect(call('prepareSend', APP, { jid: input.jid, text: 'Oi!', kind: 'outro' })).rejects.toThrow(/argumentos inválidos/)
      await call('prepareSend', APP, { jid: input.jid, text: 'Oi!', kind: 'avulsa', forced: true })
      expect(service.prepareSend).toHaveBeenCalledWith({ jid: input.jid, text: 'Oi!', forced: true, kind: 'avulsa' })
    } finally {
      off()
    }
  })
})
