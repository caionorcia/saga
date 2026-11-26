import { useEffect, useRef, useState } from 'react'
import type { SendPreview, SendReplyInput, SendView } from '../../../shared/api'
import type { PrepareSendResult, SendDraft } from '../../../shared/send'
import { outsideHoursText, type SendHoursInfo } from '../../../shared/sendHours'
import { isForceSend } from '../forceSend'
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
  extras?: Omit<SendReplyInput, 'token' | 'jid' | 'text'>
  /**
   * v0.6.0: mensagem avulsa (fora das sugestões): confirmação própria (`kind: 'avulsa'`), sem citação, vai pelo
   * `sendAvulsa` com o id do rascunho (o mesmo rascunho com o mesmo texto não envia duas vezes)
   */
  avulsa?: { draftId: string }
  onClose: () => void
  /** foi para a fila: o texto final e o envio */
  onQueued: (text: string, send: SendView) => void
}

/**
 * Confirmação de cada envio: para quem vai (nome e número, ou o grupo), nos grupos a mensagem citada, o texto final
 * (editável) e "Enviar" / "Cancelar". Ctrl+Enter envia, Esc cancela. Nada sai sem este clique.
 */
export function SendDialog({ jid, text: initial, extras, avulsa, onClose, onQueued }: DialogProps) {
  const kind = avulsa ? 'avulsa' : 'reply'
  const [preview, setPreview] = useState<SendPreview | null>(null)
  /** fora do horário e sem "Forçar envio": o que iria sair (sem confirmação válida) */
  const [draft, setDraft] = useState<SendDraft | null>(null)
  /** agora está fora do horário de envio: o aviso e o "Forçar envio" */
  const [hours, setHours] = useState<SendHoursInfo | null>(null)
  /** "Forçar envio" marcado (já vem marcado se o cabeçalho da conversa estiver com "Forçar envio" ligado) */
  const [forced, setForced] = useState(() => isForceSend(jid))
  const [text, setText] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)
  const [busy, setBusy] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  /** um envio em andamento (Ctrl+Enter repetido ou clique duplo antes de o estado atualizar não envia duas vezes) */
  const inFlight = useRef(false)

  /** aplica a resposta do `prepareSend`; devolve a confirmação (ou null) */
  const apply = (r: PrepareSendResult): SendPreview | null => {
    if (r.ok) {
      setPreview(r.preview)
      setDraft(null)
      setHours(r.preview.outsideHours)
      return r.preview
    }
    setPreview(null)
    if (r.code === 'outside_hours') {
      setDraft(r.draft)
      setHours(r.hours)
    } else {
      setRefused(true)
      setError(r.message)
    }
    return null
  }

  useEffect(() => {
    let alive = true
    window.saga
      .prepareSend({ jid, text: initial, forced, kind })
      .then((r) => alive && apply(r))
      .catch(() => alive && (setRefused(true), setError(GENERIC)))
    return () => {
      alive = false
    }
    // o "Forçar envio" muda pelo seu próprio caminho (toggleForce)
  }, [jid, initial])

  const shown = preview ?? draft
  useEffect(() => {
    if (shown) textRef.current?.focus()
  }, [!!shown])

  /** marcou/desmarcou "Forçar envio": a confirmação é refeita (o "forçar" fica preso a ela) */
  const toggleForce = async (on: boolean) => {
    setForced(on)
    setError(null)
    setBusy(true)
    try {
      apply(await window.saga.prepareSend({ jid, text, forced: on, kind }))
    } catch {
      setError(GENERIC)
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (!preview || inFlight.current || !text.trim()) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      let p: SendPreview | null = preview
      // o texto mudou no diálogo: a confirmação vale para o texto novo
      if (text.trim() !== p.text) {
        p = apply(await window.saga.prepareSend({ jid, text, forced, kind }))
        if (!p) return
      }
      const r = avulsa
        ? await window.saga.sendAvulsa({ token: p.token, jid, text: p.text, draftId: avulsa.draftId })
        : await window.saga.sendReply({ ...extras, token: p.token, jid, text: p.text })
      if (r.ok) {
        onQueued(p.text, r.send)
        return
      }
      setError(r.code === 'outside_hours' ? null : r.message)
      // confirmação vencida (ou o horário acabou): prepara outra para o próximo clique
      if (r.code === 'not_confirmed' || r.code === 'outside_hours') {
        const again = await window.saga.prepareSend({ jid, text, forced, kind })
        if (again.ok || again.code === 'outside_hours') apply(again)
      }
    } catch {
      setError(GENERIC)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const r = shown?.recipient
  const o = shown?.options
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
        <h2 id="send-title">{avulsa ? 'Enviar mensagem avulsa' : 'Enviar resposta'}</h2>
        {!shown && !refused && (
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
        {avulsa && shown && <p className="muted small send-avulsa-note">Mensagem avulsa: não responde a nenhuma mensagem e não entra no aprendizado das sugestões.</p>}
        {!avulsa && shown?.quote && (
          <blockquote className="send-quote" aria-label="Mensagem citada">
            <span className="send-quote-who">Respondendo a {shown.quote.senderName}</span>
            <span className="send-quote-text">{shown.quote.text}</span>
          </blockquote>
        )}
        {shown && (
          <>
            <label htmlFor="send-text">Mensagem</label>
            <textarea id="send-text" ref={textRef} rows={6} value={text} onChange={(e) => setText(e.target.value)} />
            <p className="muted small send-how">{sendHowText(o?.typing === true, o?.markRead === true)}</p>
          </>
        )}
        {hours && shown && (
          <div className={`send-hours-notice${forced ? ' send-hours-forced' : ''}`} role="note" aria-label="Horário de envio">
            <p className="send-hours-text">
              <ClockIcon />
              <span>{outsideHoursText(hours)}</span>
            </p>
            <label className="check send-force">
              <input type="checkbox" checked={forced} disabled={busy} onChange={(e) => void toggleForce(e.target.checked)} />
              <span>
                <strong>Forçar envio</strong>
                <span className="muted small"> envia agora mesmo assim, fora do horário. As outras regras continuam valendo.</span>
              </span>
            </label>
          </div>
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
              {busy ? 'Enviando…' : hours && forced ? 'Enviar mesmo assim' : 'Enviar'}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

/** Relógio pequeno do aviso de horário (e do botão "Forçar envio" do cabeçalho). */
export function ClockIcon() {
  return (
    <svg className="clock-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
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
