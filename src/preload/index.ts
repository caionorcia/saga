import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENTS, INVOKE_METHODS, invokeChannel, type AppState, type InvokeMethod, type SagaApi } from '../shared/api'

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

const api: SagaApi = {
  ...invokers,
  onState: (cb) => subscribe<[AppState]>(EVENTS.state, (s) => cb(s)),
  onContactsChanged: (cb) => subscribe(EVENTS.contacts, () => cb()),
  onMessages: (jid, cb) =>
    subscribe<[string]>(EVENTS.messages, (j) => {
      if (j === jid) cb()
    })
}

contextBridge.exposeInMainWorld('saga', api)
