import { useEffect, useState } from 'react'
import type { AppState } from '../../../shared/api'
import { UpdateNotice } from './UpdateNotice'
import { setThemePref, toggledTheme, useTheme } from '../theme'
import { connectionLabel, downloadProgress, formatUsd, needsManualReconnect, transcribeChip } from '../format'

interface Props {
  state: AppState
  onOpenSettings: () => void
  settingsOpen: boolean
  /** clique no contador "N para responder · M com alerta": mostrar a lista "Para responder" */
  onShowAwaiting?: () => void
  /** clique em "Fora do horário de envio": Configurações › Envio direto › Horário de envio */
  onOpenSendHours?: () => void
}

export function StatusBar({ state, onOpenSettings, settingsOpen, onShowAwaiting, onOpenSendHours }: Props) {
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
        {state.sendHours && (
          <button
            type="button"
            className="chip chip-hours"
            title={`Envio direto: ${state.sendHours.summary}.${state.sendHours.next ? ` Próximo horário: ${state.sendHours.next}.` : ''} Clique para ajustar.`}
            onClick={() => onOpenSendHours?.()}
          >
            Fora do horário de envio
          </button>
        )}
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
        <ThemeToggle />
        <button type="button" className="btn" aria-pressed={settingsOpen} onClick={onOpenSettings}>
          {settingsOpen ? 'Voltar às conversas' : 'Configurações'}
        </button>
      </div>
    </header>
  )
}

/** Botão rápido de tema (sol/lua): inverte o tema que está valendo; "Automático" volta em Configurações. */
function ThemeToggle() {
  const { pref, resolved } = useTheme()
  const label = resolved === 'dark' ? 'Usar o tema claro' : 'Usar o tema escuro'
  return (
    <button type="button" className="theme-toggle" aria-label={label} title={label} onClick={() => void setThemePref(toggledTheme(pref))}>
      {resolved === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
    </svg>
  )
}
