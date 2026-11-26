import { useState } from 'react'
import type { UpdateState } from '../../../shared/api'

/**
 * Aviso de versão nova: "Nova versão disponível — Atualizar", o download e "Reiniciar e atualizar".
 * Na barra de status e também no assistente (quem ainda está configurando o Saga vê a atualização).
 */
export function UpdateNotice({ update, className = 'status-update' }: { update: UpdateState; className?: string }) {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch {
      // o próximo estado do app mostra o resultado
    } finally {
      setBusy(false)
    }
  }

  if (update.status === 'available') {
    return (
      <span className={className} role="status">
        Nova versão disponível ({update.version}) —{' '}
        <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => run(() => window.saga.downloadUpdate())}>
          Atualizar
        </button>
      </span>
    )
  }
  if (update.status === 'downloading') {
    return (
      <span className={className} role="status">
        {update.percent === undefined ? 'Baixando a nova versão…' : `Baixando a nova versão… ${update.percent}%`}
      </span>
    )
  }
  if (update.status === 'ready') {
    return (
      <span className={className} role="status">
        Atualização pronta — será instalada quando você fechar o Saga.{' '}
        <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => run(() => window.saga.installUpdate())}>
          Reiniciar e atualizar
        </button>
      </span>
    )
  }
  return null
}
