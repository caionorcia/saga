import { useEffect, useRef, useState } from 'react'
import type { SendPreview, SendReplyInput, SendView } from '../../../shared/api'
import { sendStatusText } from '../format'

const GENERIC = 'Não foi possível enviar agora. Tente de novo.'

/** A linha "como vai sair" do diálogo, conforme as opções. */
function sendHowText(typing: boolean, markRead: boolean): string {
  const parts = [typing && 'mostra “digitando…” antes', markRead && 'marca a conversa como lida', 'sai no ritmo seguro (30 a 90 s entre envios)'].filter(
    (x): x is string => !!x
  )
  const t = parts.join(' · ')
  return t[0].toUpperCase() + t.slice(1) + '.'
}

interface DialogProps {
  jid: string
  text: string
  /** o que vai junto no `sendReply` (escolha da sugestão, resposta já salva) */
  extras: Omit<SendReplyInput, 'token' | 'jid' | 'text'>
  onClose: () => void
  /** foi para a fila: o texto final e o envio */
  onQueued: (text: string, send: SendView) => void
}

/**
 * Confirmação de cada envio: para quem vai (nome e número, ou o grupo), nos grupos a mensagem citada, o texto final
 * (editável) e "Enviar" / "Cancelar". Ctrl+Enter envia, Esc cancela. Nada sai sem este clique.
 */
export function SendDialog({ jid, text: initial, extras, onClose, onQueued }: DialogProps) {
  const [preview, setPreview] = useState<SendPreview | null>(null)
  const [text, setText] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)
  const [busy, setBusy] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  /** um envio em andamento (Ctrl+Enter repetido ou clique duplo antes de o estado atualizar não envia duas vezes) */
  const inFlight = useRef(false)

  useEffect(() => {
    let alive = true
    window.saga
      .prepareSend({ jid, text: initial })
      .then((r) => {
        if (!alive) return
        if (r.ok) setPreview(r.preview)
        else {
          setRefused(true)
          setError(r.message)
        }
      })
      .catch(() => alive && (setRefused(true), setError(GENERIC)))
    return () => {
      alive = false
    }
  }, [jid, initial])

  useEffect(() => {
    if (preview) textRef.current?.focus()
  }, [preview])

  const confirm = async () => {
    if (!preview || inFlight.current || !text.trim()) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      let p = preview
      // o texto mudou no diálogo: a confirmação vale para o texto novo
      if (text.trim() !== p.text) {
        const r = await window.saga.prepareSend({ jid, text })
        if (!r.ok) {
          setError(r.message)
          return
        }
        p = r.preview
        setPreview(p)
      }
      const r = await window.saga.sendReply({ ...extras, token: p.token, jid, text: p.text })
      if (r.ok) {
        onQueued(p.text, r.send)
        return
      }
      setError(r.message)
      // confirmação vencida: prepara outra para o próximo clique
      if (r.code === 'not_confirmed') {
        const again = await window.saga.prepareSend({ jid, text })
        if (again.ok) setPreview(again.preview)
      }
    } catch {
      setError(GENERIC)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const r = preview?.recipient
  const o = preview?.options
  return (
    <div
      className="overlay"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          void confirm()
        }
      }}
    >
      <form
        className="dialog send-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-title"
        onSubmit={(e) => {
          e.preventDefault()
          void confirm()
        }}
      >
        <h2 id="send-title">Enviar resposta</h2>
        {!preview && !refused && (
          <p className="muted" role="status">
            <span className="spinner" aria-hidden="true" />
            Conferindo…
          </p>
        )}
        {r && (
          <p className="send-to">
            {r.isGroup ? 'Para o grupo ' : 'Para '}
            <strong>{r.name}</strong>
            {r.phone && <span className="muted"> · {r.phone}</span>}
          </p>
        )}
        {preview?.quote && (
          <blockquote className="send-quote" aria-label="Mensagem citada">
            <span className="send-quote-who">Respondendo a {preview.quote.senderName}</span>
            <span className="send-quote-text">{preview.quote.text}</span>
          </blockquote>
        )}
        {preview && (
          <>
            <label htmlFor="send-text">Mensagem</label>
            <textarea id="send-text" ref={textRef} rows={6} value={text} onChange={(e) => setText(e.target.value)} />
            <p className="muted small send-how">
              {sendHowText(o?.typing === true, o?.markRead === true)}
            </p>
          </>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <span className="muted small send-kbd">{preview ? 'Ctrl+Enter envia' : ''}</span>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          {!refused && (
            <button type="submit" className="btn btn-primary" disabled={!preview || busy || !text.trim()}>
              {busy ? 'Enviando…' : 'Enviar'}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

interface StatusProps {
  send: SendView
  /** "Tentar de novo" / "Enviar de novo": abre a confirmação outra vez */
  onResend: () => void
}

/** O estado do envio no cartão: contagem regressiva na fila, "Digitando…", "Enviada ✓ às HH:MM" ou os erros. */
export function SendStatus({ send, onResend }: StatusProps) {
  const [now, setNow] = useState(() => Date.now())
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (send.status !== 'queued') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [send.status])

  const tone = send.status === 'sent' ? 'ok' : send.status === 'failed' || send.status === 'unknown' || send.status === 'expired' ? 'bad' : 'info'
  const check = async () => {
    setBusy(true)
    try {
      await window.saga.checkSend(send.id)
    } catch {
      // segue mostrando o estado atual
    } finally {
      setBusy(false)
      setChecked(true)
    }
  }
  return (
    <div className={`send-status send-${tone}`} role="status" aria-live="polite">
      <span className="send-status-text">
        {(send.status === 'typing' || send.status === 'sending') && <span className="spinner spinner-small" aria-hidden="true" />}
        {sendStatusText(send, now)}
      </span>
      {send.status === 'queued' && (
        <button type="button" className="link-btn" disabled={busy} onClick={() => void window.saga.cancelSend(send.id)}>
          Cancelar envio
        </button>
      )}
      {(send.status === 'failed' || send.status === 'expired') && (
        <button type="button" className="btn btn-small" onClick={onResend}>
          {send.status === 'expired' ? 'Enviar de novo' : 'Tentar de novo'}
        </button>
      )}
      {send.status === 'unknown' && !checked && (
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => void check()}>
          Conferir
        </button>
      )}
      {send.status === 'unknown' && checked && (
        <span className="send-unknown-help">
          <span className="small">A mensagem não apareceu nesta conversa. Olhe no celular: se não chegou, envie de novo.</span>
          <button type="button" className="btn btn-small" onClick={onResend}>
            Enviar de novo
          </button>
        </span>
      )}
    </div>
  )
}
