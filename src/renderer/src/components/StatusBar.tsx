import { useEffect, useState } from 'react'
import type { AppState } from '../../../shared/api'
import { connectionLabel, downloadProgress, formatUsd, needsManualReconnect, transcribeChip } from '../format'

interface Props {
  state: AppState
  onOpenSettings: () => void
  settingsOpen: boolean
}

export function StatusBar({ state, onOpenSettings, settingsOpen }: Props) {
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
        {downloads && <span>{downloads}</span>}
        {queue.failed > 0 && (
          <span className="status-failed">
            {queue.failed} {queue.failed === 1 ? 'áudio' : 'áudios'} com falha
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => run(() => window.saga.retryFailedJobs())}>
              Tentar de novo
            </button>
          </span>
        )}
        {state.update.status === 'available' && (
          <span className="status-update">
            Nova versão disponível — <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => run(() => window.saga.downloadUpdate())}>Atualizar</button>
          </span>
        )}
        {state.update.status === 'downloading' && <span className="status-update">Baixando a nova versão…</span>}
        {state.update.status === 'ready' && (
          <span className="status-update">
            Atualização pronta — será instalada quando você fechar o Saga.{' '}
            <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => run(() => window.saga.installUpdate())}>
              Reiniciar e atualizar
            </button>
          </span>
        )}
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
