import { useEffect, useState } from 'react'
import type { AppState, RecentEvent } from '../../../shared/api'
import { QR_SLOW_MS, connectionLabel, eventLabel, formatTime, needsManualReconnect, qrProblem } from '../format'
import { DiagnosticsActions } from './Diagnostics'

/**
 * QR Code para vincular o WhatsApp, com a instrução e o botão "Gerar novo QR Code" (assistente e tela principal).
 * Nunca fica num "Preparando…" sem fim: mostra o estado da conexão, o motivo quando algo deu errado
 * (com "Tentar de novo") e, depois de 45 s sem QR, um aviso com os detalhes para o suporte.
 */
export function QrCode({ state }: { state: AppState }) {
  const [busy, setBusy] = useState(false)
  const [slow, setSlow] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const retry = async () => {
    setBusy(true)
    try {
      await window.saga.manualReconnect()
    } catch {
      // o próximo estado do app mostra o resultado
    } finally {
      setBusy(false)
    }
  }

  const waiting = !state.qr && state.conn !== 'open'
  // conta 45 s a partir de quando ficou sem QR; recomeça quando um QR aparece
  useEffect(() => {
    if (!waiting) {
      setSlow(false)
      return
    }
    const t = setTimeout(() => setSlow(true), QR_SLOW_MS)
    return () => clearTimeout(t)
  }, [waiting])

  const problem = state.startError
    ? `O Saga não conseguiu iniciar a conexão (${state.startError}). Clique em Tentar de novo.`
    : qrProblem(state.conn)
  const failed = !!state.startError || needsManualReconnect(state.conn) || state.conn === 'waiting_retry'
  const label = connectionLabel(state.conn, false, state.retryAt)

  return (
    <>
      <p>
        No celular: <strong>WhatsApp › Aparelhos conectados › Conectar um aparelho</strong>. Depois aponte a câmera para o
        código abaixo.
      </p>
      <div className="qr-box">
        {state.qr ? (
          <img src={state.qr} alt="QR Code para vincular o WhatsApp" width={240} height={240} />
        ) : (
          <p className="muted" role="status">
            {state.conn === 'open' ? 'Conectado!' : failed ? 'QR Code indisponível no momento' : 'Preparando o QR Code…'}
          </p>
        )}
      </div>
      <p className="qr-conn small" aria-live="polite">
        <span className={`dot dot-${state.startError ? 'bad' : label.tone}`} aria-hidden="true" />
        Situação: {state.startError ? 'Erro ao iniciar' : label.text}
      </p>
      {problem && (
        <div className="conn-alert qr-problem" role="alert">
          <p>{problem}</p>
          {failed && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void retry()}>
              Tentar de novo
            </button>
          )}
        </div>
      )}
      {slow && waiting && (
        <p className="field-error" role="alert">
          O QR Code está demorando. Verifique a internet/antivírus e clique em Tentar de novo.
        </p>
      )}
      <p className="muted small">
        O código muda de tempos em tempos. Se ele não aparecer ou o celular não aceitar, clique em{' '}
        <strong>Gerar novo QR Code</strong>.
      </p>
      <div className="qr-actions">
        <button type="button" className="btn" disabled={busy || state.conn === 'open'} onClick={() => void retry()}>
          Gerar novo QR Code
        </button>
        {slow && waiting && !failed && (
          <button type="button" className="btn" disabled={busy} onClick={() => void retry()}>
            Tentar de novo
          </button>
        )}
        {(slow || failed) && state.conn !== 'open' && (
          <button type="button" className="link-btn" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>
            {showDetails ? 'Esconder detalhes' : 'Ver detalhes'}
          </button>
        )}
      </div>
      {showDetails && <QrDetails />}
    </>
  )
}

/** Últimos eventos do app (para entender o que está travando) e as ações de diagnóstico. */
function QrDetails() {
  const [events, setEvents] = useState<RecentEvent[] | null>(null)
  useEffect(() => {
    let alive = true
    const load = () =>
      window.saga
        .recentEvents(10)
        .then((e) => alive && setEvents(e))
        .catch(() => alive && setEvents([]))
    void load()
    const t = setInterval(() => void load(), 5_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])
  return (
    <section className="qr-details" aria-label="Detalhes da conexão">
      <h3>Eventos recentes</h3>
      {events === null ? (
        <p className="muted small">Carregando…</p>
      ) : events.length === 0 ? (
        <p className="muted small">Nenhum evento registrado ainda.</p>
      ) : (
        <ul className="events">
          {events.map((e) => (
            <li key={e.id}>
              <time>{formatTime(e.ts)}</time>
              <span>
                {eventLabel(e.kind)}
                {e.detail && <code className="small"> — {e.detail}</code>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">Se precisar de ajuda, clique em Copiar diagnóstico e cole numa mensagem para o suporte.</p>
      <DiagnosticsActions />
    </section>
  )
}
