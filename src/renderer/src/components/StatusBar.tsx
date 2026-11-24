import { useState } from 'react'
import type { AppState } from '../../../shared/api'
import { connectionLabel, formatUsd, needsManualReconnect } from '../format'

interface Props {
  state: AppState
  onOpenSettings: () => void
  settingsOpen: boolean
}

export function StatusBar({ state, onOpenSettings, settingsOpen }: Props) {
  const [busy, setBusy] = useState(false)
  const { conn, paused, diskLow, queue } = state
  const label = connectionLabel(conn, paused)
  const remaining = queue.pending + queue.running
  const total = queue.done + remaining
  const resumeMode = paused || diskLow

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

  return (
    <header className="statusbar" role="banner">
      <div className="status-conn" role="status">
        <span className={`dot dot-${label.tone}`} aria-hidden="true" />
        <strong>{label.text}</strong>
        {diskLow && <span className="chip chip-warn">Pouco espaço no disco</span>}
        {state.transcribePaused && <span className="chip chip-warn">Transcrição pausada — confira a chave</span>}
      </div>

      <div className="status-info">
        {remaining > 0 && (
          <span>
            Baixando áudios: {queue.done} de {total}
          </span>
        )}
        {queue.failed > 0 && (
          <span className="status-failed">
            {queue.failed} com falha
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => run(() => window.saga.retryFailedJobs())}>
              Tentar de novo
            </button>
          </span>
        )}
        <span>Gasto hoje: {formatUsd(state.costTodayUsd)}</span>
      </div>

      <div className="status-actions">
        {needsManualReconnect(conn) && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => window.saga.manualReconnect())}>
            Reconectar
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => run(() => (resumeMode ? window.saga.resumeAll() : window.saga.pauseAll()))}
        >
          {resumeMode ? 'Retomar' : 'Pausar tudo'}
        </button>
        <button type="button" className="btn" aria-pressed={settingsOpen} onClick={onOpenSettings}>
          {settingsOpen ? 'Voltar às conversas' : 'Configurações'}
        </button>
      </div>
    </header>
  )
}
