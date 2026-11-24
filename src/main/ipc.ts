import { clipboard, dialog, ipcMain, type BrowserWindow } from 'electron'
import type { SagaService } from '../core/service'
import { EVENTS, INVOKE_METHODS, invokeChannel, type InvokeMethod, type SagaApi } from '../shared/api'
import { validateIpcArgs } from './guards'

type Handlers = { [M in InvokeMethod]: (...args: Parameters<SagaApi[M]>) => ReturnType<SagaApi[M]> }

export interface IpcOptions {
  getWindow: () => BrowserWindow | null
  /** só a interface do próprio app pode chamar (URL do frame que enviou) */
  isTrustedSender: (frameUrl: string) => boolean
  /** depois de salvar as configurações (ex.: abrir com o Windows) */
  onSettingsSaved?: () => void
}

/** Liga cada método de `window.saga` ao serviço e repassa os eventos do serviço para a janela. */
export function registerIpc(service: SagaService, opts: IpcOptions): () => void {
  const h: Handlers = {
    getState: () => service.getState(),
    listContacts: (includeHidden) => service.listContacts(!!includeHidden),
    listMessages: (jid) => service.listMessages(String(jid)),
    getAnalysis: (jid) => service.getAnalysis(String(jid)),
    regenerate: (jid) => service.regenerate(String(jid)),
    saveReply: (input) => service.saveReply(input),
    copyToClipboard: async (text) => clipboard.writeText(String(text)),
    renameContact: (jid, name) => service.renameContact(String(jid), String(name)),
    setHidden: (jid, hidden) => service.setHidden(String(jid), !!hidden),
    setNotes: (jid, text) => service.setNotes(String(jid), String(text)),
    pauseAll: () => service.pauseAll(),
    resumeAll: () => service.resumeAll(),
    manualReconnect: () => service.manualReconnect(),
    retryFailedJobs: () => service.retryFailedJobs(),
    getSettings: () => service.getSettings(),
    saveSettings: async (patch) => {
      const r = await service.saveSettings(patch ?? {})
      if (!r.ok && r.code === 'encryption_unavailable') {
        dialog.showErrorBox('Saga', 'A criptografia do Windows não está disponível. A chave não foi salva.')
      }
      if (r.ok) opts.onSettingsSaved?.()
      return r
    },
    testKey: (kind, key) => service.testKey(kind, String(key)),
    audioUrl: (id) => service.audioUrl(String(id))
  }

  for (const m of INVOKE_METHODS) {
    const fn = h[m] as (...args: unknown[]) => unknown
    ipcMain.handle(invokeChannel(m), (e, ...args: unknown[]) => {
      const url = e.senderFrame?.url
      if (!url || !opts.isTrustedSender(url)) throw new Error(`chamada recusada: origem não confiável (${m})`)
      validateIpcArgs(m, args)
      return fn(...args)
    })
  }

  const send = (channel: string, ...args: unknown[]) => {
    const w = opts.getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args)
  }
  const offs = [
    service.onState((s) => send(EVENTS.state, s)),
    service.onContactsChanged(() => send(EVENTS.contacts))
  ]
  const onMsg = (jid: string) => send(EVENTS.messages, jid)
  service.on('messages', onMsg)

  return () => {
    for (const m of INVOKE_METHODS) ipcMain.removeHandler(invokeChannel(m))
    for (const off of offs) off()
    service.off('messages', onMsg)
  }
}
