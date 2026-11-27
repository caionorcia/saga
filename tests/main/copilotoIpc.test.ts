import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateIpcArgs } from '../../src/main/guards'

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showErrorBox: vi.fn() },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
    removeHandler: (ch: string) => handlers.delete(ch)
  }
}))
const { registerIpc } = await import('../../src/main/ipc')

const APP = 'file:///app/index.html'
const call = (m: string, url: string | null, ...args: unknown[]) =>
  Promise.resolve().then(() => handlers.get(`saga:${m}`)!({ senderFrame: url ? { url } : null }, ...args))

describe('IPC do Copiloto: argumentos', () => {
  const ok = (m: any, ...a: unknown[]) => expect(() => validateIpcArgs(m, a)).not.toThrow()
  const bad = (m: any, ...a: unknown[]) => expect(() => validateIpcArgs(m, a)).toThrow(/argumentos inválidos/)

  it('status, gerar código e testar não levam argumentos', () => {
    for (const m of ['copilotoStatus', 'copilotoGenerateCode', 'copilotoTest', 'copilotoRepairGroups', 'copilotoFetchGroupHistory']) {
      ok(m)
      bad(m, 'x')
    }
  })

  it('salvar: só enabled (sim/não) e/ou url (texto curto)', () => {
    ok('copilotoSave', { enabled: true })
    ok('copilotoSave', { url: 'https://exemplo.supabase.co/functions/v1/sagazap-webhook' })
    ok('copilotoSave', { enabled: false, url: '' })
    bad('copilotoSave')
    bad('copilotoSave', {})
    bad('copilotoSave', { enabled: 'sim' })
    bad('copilotoSave', { url: 42 })
    bad('copilotoSave', { url: 'x'.repeat(301) })
    bad('copilotoSave', { code: 'segredo' })
    bad('copilotoSave', { enabled: true }, 'extra')
  })
})

describe('IPC do Copiloto: ligação com o serviço', () => {
  let service: Record<string, ReturnType<typeof vi.fn>>
  let off: () => void
  beforeEach(() => {
    service = {
      copilotoStatus: vi.fn(async () => ({ enabled: false })),
      copilotoSave: vi.fn(async () => ({ ok: true })),
      copilotoGenerateCode: vi.fn(async () => ({ ok: true, code: 'c' })),
      copilotoTest: vi.fn(async () => ({ ok: true, phones: 2, chats: 1 })),
      copilotoRepairGroups: vi.fn(async () => ({ ok: true, status: { enabled: true } })),
      copilotoFetchGroupHistory: vi.fn(async () => ({ ok: true, status: { enabled: true } })),
      onState: vi.fn(() => () => {}),
      onContactsChanged: vi.fn(() => () => {}),
      on: vi.fn(),
      off: vi.fn()
    }
    off = registerIpc(service as never, { getWindow: () => null, isTrustedSender: (u) => u === APP })
  })
  afterEach(() => off())

  it('recusa quem não é a interface do app', async () => {
    for (const m of ['copilotoStatus', 'copilotoSave', 'copilotoGenerateCode', 'copilotoTest']) {
      await expect(call(m, 'https://evil.example/', { enabled: true })).rejects.toThrow(/origem não confiável/)
    }
    expect(service.copilotoGenerateCode).not.toHaveBeenCalled()
    expect(service.copilotoSave).not.toHaveBeenCalled()
  })

  it('repassa só os campos conhecidos', async () => {
    await call('copilotoSave', APP, { enabled: true })
    expect(service.copilotoSave).toHaveBeenCalledWith({ enabled: true })
    await call('copilotoSave', APP, { url: 'https://exemplo.supabase.co/functions/v1/sagazap-webhook' })
    expect(service.copilotoSave).toHaveBeenLastCalledWith({ url: 'https://exemplo.supabase.co/functions/v1/sagazap-webhook' })
    await expect(call('copilotoSave', APP, { enabled: 1 })).rejects.toThrow(/argumentos inválidos/)
    expect(await call('copilotoTest', APP)).toEqual({ ok: true, phones: 2, chats: 1 })
    expect(await call('copilotoRepairGroups', APP)).toEqual({ ok: true, status: { enabled: true } })
    await expect(call('copilotoRepairGroups', 'https://evil.example/')).rejects.toThrow(/origem não confiável/)
    expect(await call('copilotoFetchGroupHistory', APP)).toEqual({ ok: true, status: { enabled: true } })
    await expect(call('copilotoFetchGroupHistory', 'https://evil.example/')).rejects.toThrow(/origem não confiável/)
  })
})
