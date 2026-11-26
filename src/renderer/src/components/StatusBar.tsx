import { useEffect, useState } from 'react'
import type { AppState } from '../../../shared/api'
import { UpdateNotice } from './UpdateNotice'
import { connectionLabel, downloadProgress, formatUsd, needsManualReconnect, transcribeChip } from '../format'

interface Props {
  state: AppState
  onOpenSettings: () => void
  settingsOpen: boolean
  /** clique no contador "N para responder · M com alerta": mostrar a lista "Para responder" */
  onShowAwaiting?: () => void
}

export function StatusBar({ state, onOpenSettings, settingsOpen, onShowAwaiting }: Props) {
  const [busy, setBusy] = useState(false)
  const { conn, paused, diskLow, queue } = state
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (conn !== 'waiting_retry') return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 3_000)
    return () => clearInterval(t)
  }, [conn])
  const label = connectionLabel(conn, paused, state.retryAt, now)
  const resumeMode = paused || diskLow
  const downloads = downloadProgress(state.downloads, resumeMode)
  const chip = state.transcribePaused ? (transcribeChip(state.transcribePausedReason) ?? transcribeChip('key')) : null

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
        {chip && <span className="chip chip-warn">{chip}</span>}
      </div>

      <div className="status-info">
        {(state.triage.awaiting > 0 || state.triage.withAlerts > 0) && (
          <button
            type="button"
            className="triage-counter"
            title="Ver as conversas esperando a sua resposta"
            onClick={() => onShowAwaiting?.()}
          >
            <strong>{state.triage.awaiting}</strong> para responder · <strong>{state.triage.withAlerts}</strong> com alerta
          </button>
        )}
        {downloads && <span>{downloads}</span>}
        {queue.failed > 0 && (
          <span className="status-failed">
            {queue.failed} {queue.failed === 1 ? 'áudio' : 'áudios'} com falha
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => run(() => window.saga.retryFailedJobs())}>
              Tentar de novo
            </button>
          </span>
        )}
        <UpdateNotice update={state.update} />
        <span>Gasto hoje: {formatUsd(state.costTodayUsd)}</span>
      </div>

      <div className="status-actions">
        {(needsManualReconnect(conn) || !!state.startError) && (
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
