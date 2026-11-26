import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENTS, INVOKE_METHODS, invokeChannel, themeFromArgv, type AppState, type InvokeMethod, type SagaApi } from '../shared/api'

function subscribe<A extends unknown[]>(channel: string, fn: (...args: A) => void): () => void {
  const l = (_e: IpcRendererEvent, ...args: unknown[]) => fn(...(args as A))
  ipcRenderer.on(channel, l)
  return () => {
    ipcRenderer.removeListener(channel, l)
  }
}

const invokers = Object.fromEntries(
  INVOKE_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(invokeChannel(m), ...args)])
) as Pick<SagaApi, InvokeMethod>

const initialTheme = themeFromArgv(process.argv)
// já na primeira pintura (o CSS escolhe as cores por `data-theme`); a interface confirma ao iniciar
try {
  if (document.documentElement) document.documentElement.dataset.theme = initialTheme
} catch {
  // sem documento ainda: o main.tsx aplica
}

const api: SagaApi = {
  ...invokers,
  initialTheme,
  onState: (cb) => subscribe<[AppState]>(EVENTS.state, (s) => cb(s)),
  onContactsChanged: (cb) => subscribe(EVENTS.contacts, () => cb()),
  onMessages: (jid, cb) =>
    subscribe<[string]>(EVENTS.messages, (j) => {
      if (j === jid) cb()
    }),
  onSends: (jid, cb) =>
    subscribe<[string]>(EVENTS.sends, (j) => {
      if (j === jid) cb()
    })
}

contextBridge.exposeInMainWorld('saga', api)
