import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()
const showOpenDialog = vi.fn()

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  clipboard: { writeText: vi.fn() },
  dialog: { showOpenDialog: (...a: unknown[]) => showOpenDialog(...a), showSaveDialog: vi.fn(), showErrorBox: vi.fn() },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
    removeHandler: (ch: string) => handlers.delete(ch)
  }
}))

const { registerIpc } = await import('../../src/main/ipc')

const APP = 'file:///app/index.html'
const call = (m: string, url: string | null, ...args: unknown[]) =>
  Promise.resolve().then(() => handlers.get(`saga:${m}`)!({ senderFrame: url ? { url } : null }, ...args))

describe('IPC da base de conhecimento', () => {
  let service: Record<string, ReturnType<typeof vi.fn>>
  let refused: string[]
  let off: () => void
  const OK = { status: 'imported', packageName: 'P', files: 1, sections: 2, skipped: 0, duplicates: 0, replaced: false }

  beforeEach(() => {
    refused = []
    service = {
      kbImportPackage: vi.fn(async () => OK),
      kbAddFile: vi.fn(async () => OK),
      kbAddText: vi.fn(async () => OK),
      kbUpdateFile: vi.fn(async () => {}),
      kbGetChunk: vi.fn(async () => null),
      onState: vi.fn(() => () => {}),
      onContactsChanged: vi.fn(() => () => {}),
      on: vi.fn(),
      off: vi.fn()
    }
    off = registerIpc(service as never, { getWindow: () => null, isTrustedSender: (u) => u === APP, onRefused: (m) => refused.push(m) })
  })
  afterEach(() => {
    off()
    showOpenDialog.mockReset()
  })

  it('recusa quem não é a interface do app, sem abrir diálogo', async () => {
    await expect(call('kbImport', 'https://evil.example/', 'archive')).rejects.toThrow(/origem não confiável/)
    await expect(call('kbAddText', null, 'a', 'b')).rejects.toThrow(/origem não confiável/)
    expect(refused).toEqual(['kbImport', 'kbAddText'])
    expect(showOpenDialog).not.toHaveBeenCalled()
  })

  it('o caminho vem do diálogo do sistema: .zip/.skill ou pasta; cancelar não importa', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await call('kbImport', APP, 'archive')).toEqual({ status: 'canceled' })
    expect(showOpenDialog.mock.calls[0][0]).toMatchObject({ properties: ['openFile'], filters: [{ extensions: ['zip', 'skill'] }] })

    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/u/pacote.zip'] })
    expect(await call('kbImport', APP, 'archive')).toEqual(OK)
    expect(service.kbImportPackage).toHaveBeenCalledWith('/u/pacote.zip', 'archive')

    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/u/pasta'] })
    await call('kbImport', APP, 'folder')
    expect(showOpenDialog.mock.calls[2][0]).toMatchObject({ properties: ['openDirectory'] })
    expect(service.kbImportPackage).toHaveBeenLastCalledWith('/u/pasta', 'folder')

    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/u/notas.docx'] })
    await call('kbAddFile', APP)
    expect(showOpenDialog.mock.calls[3][0].filters[0].extensions).toEqual(['md', 'markdown', 'txt', 'docx'])
    expect(service.kbAddFile).toHaveBeenCalledWith('/u/notas.docx')
  })

  it('valida os argumentos antes de chamar o serviço', async () => {
    await expect(call('kbUpdateFile', APP, 1, { role: 'x' })).rejects.toThrow(/argumentos inválidos/)
    expect(service.kbUpdateFile).not.toHaveBeenCalled()
    await call('kbUpdateFile', APP, 1, { role: 'interno' })
    expect(service.kbUpdateFile).toHaveBeenCalledWith(1, { role: 'interno' })
    await call('kbAddText', APP, 'Título', 'Texto')
    expect(service.kbAddText).toHaveBeenCalledWith('Título', 'Texto')
    expect(await call('kbGetChunk', APP, 4)).toBeNull()
  })
})
