import { useSyncExternalStore } from 'react'

/**
 * "Forçar envio" do cabeçalho da conversa (v0.4.1): enquanto ligado, a confirmação de envio DESSA conversa já abre com
 * "Forçar envio" marcado (fora do horário de envio). Só na memória da janela: nunca é salvo, desliga sozinho depois de
 * 30 min ou quando a conversa é fechada. Uma conversa de cada vez (ligar em outra desliga a anterior).
 */
export const FORCE_SEND_TTL_MS = 30 * 60_000

let current: { jid: string; until: number } | null = null
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

export function setForceSend(jid: string, on: boolean, now = Date.now()): void {
  clearTimeout(timer)
  timer = undefined
  if (on) {
    current = { jid, until: now + FORCE_SEND_TTL_MS }
    timer = setTimeout(() => {
      if (current?.jid === jid) {
        current = null
        notify()
      }
    }, FORCE_SEND_TTL_MS)
  } else if (current?.jid === jid) current = null
  notify()
}

/** "Forçar envio" ligado para esta conversa agora? */
export function isForceSend(jid: string, now = Date.now()): boolean {
  return !!current && current.jid === jid && now < current.until
}

/** A conversa foi fechada: o "Forçar envio" dela desliga. */
export function clearForceSend(jid: string): void {
  if (current?.jid === jid) setForceSend(jid, false)
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useForceSend(jid: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isForceSend(jid),
    () => false
  )
}
