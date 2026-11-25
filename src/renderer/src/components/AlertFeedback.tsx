import { useEffect, useRef, useState } from 'react'
import type { Alert, AlertKind, MessageView, RateReason } from '../../../shared/api'
import {
  REASON_CODES,
  REASON_LABELS,
  REASON_TEXT_MAX,
  REPLY_REASON_CODES,
  REPLY_REASON_LABELS,
  type ReasonCode,
  type ReplyReason,
  type ReplyReasonCode
} from '../../../shared/feedback'
import { AI_ALERT_KINDS } from '../../../shared/triage'
import { ALERT_LABELS, formatTime } from '../format'

/** Diálogo com foco no primeiro campo e Esc para fechar. */
function Modal({ title, onClose, onSubmit, children, canSave }: {
  title: string
  onClose: () => void
  onSubmit: () => void
  children: React.ReactNode
  canSave: boolean
}) {
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, select, textarea')?.focus()
  }, [])
  return (
    <div className="overlay" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form
        ref={ref}
        className="dialog feedback-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fb-title"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave) onSubmit()
        }}
      >
        <h2 id="fb-title">{title}</h2>
        {children}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canSave}>
            Salvar
          </button>
        </div>
      </form>
    </div>
  )
}

/** 👎: o que está errado neste alerta (motivo rápido, tipo certo e texto livre). */
export function RateDownDialog({ alert, onClose, onSave }: { alert: Alert; onClose: () => void; onSave: (r: RateReason) => void }) {
  const [code, setCode] = useState<ReasonCode | null>(null)
  const [correct, setCorrect] = useState<AlertKind | ''>('')
  const [text, setText] = useState('')
  const others = AI_ALERT_KINDS.filter((k) => k !== alert.kind)
  return (
    <Modal
      title="O que está errado neste alerta?"
      onClose={onClose}
      canSave={code !== null}
      onSubmit={() =>
        onSave({
          code: code!,
          ...(code === 'tipo_errado' ? { correctKind: correct || null } : {}),
          ...(text.trim() ? { text: text.trim() } : {})
        })
      }
    >
      <p className="muted small">
        Alerta <strong>{ALERT_LABELS[alert.kind]}</strong>: {alert.detail}
      </p>
      <fieldset className="fb-reasons">
        <legend className="sr-only">Motivo</legend>
        {REASON_CODES.map((c) => (
          <div key={c}>
            <label className="check">
              <input type="radio" name="fb-reason" checked={code === c} onChange={() => setCode(c)} />
              {REASON_LABELS[c]}
            </label>
            {c === 'tipo_errado' && code === 'tipo_errado' && (
              <div className="fb-sub">
                <label htmlFor="fb-correct">Qual seria o certo?</label>
                <select id="fb-correct" value={correct} onChange={(e) => setCorrect(e.target.value as AlertKind | '')}>
                  <option value="">Nenhum</option>
                  {others.map((k) => (
                    <option key={k} value={k}>
                      {ALERT_LABELS[k]}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        ))}
      </fieldset>
      <label htmlFor="fb-text">Explique com suas palavras (opcional)</label>
      <textarea id="fb-text" rows={3} maxLength={REASON_TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  )
}

const excerpt = (m: MessageView): string => {
  const t = (m.kind === 'audio' ? (m.transcript ? `🎤 ${m.transcript}` : '🎤 Áudio') : (m.text ?? 'Mensagem sem texto')).replace(/\s+/g, ' ').trim()
  return t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t
}

/** "Faltou um alerta?": o tipo, a mensagem (uma das 10 últimas do contato, opcional) e um texto. */
export function MissedAlertDialog({
  messages,
  onClose,
  onSave
}: {
  messages: MessageView[]
  onClose: () => void
  onSave: (kind: AlertKind, msgId: string | null, text: string | null) => void
}) {
  const [kind, setKind] = useState<AlertKind | null>(null)
  const [msgId, setMsgId] = useState('')
  const [text, setText] = useState('')
  const recent = messages.filter((m) => !m.fromMe).slice(-10).reverse()
  return (
    <Modal
      title="Faltou um alerta?"
      onClose={onClose}
      canSave={kind !== null}
      onSubmit={() => onSave(kind!, msgId || null, text.trim() || null)}
    >
      <p className="muted small">Conte qual sinal o Saga deixou passar. Ele cria o alerta e aprende com o exemplo.</p>
      <fieldset className="fb-kinds">
        <legend>Tipo de alerta</legend>
        {AI_ALERT_KINDS.map((k) => (
          <label key={k} className="check">
            <input type="radio" name="fb-kind" checked={kind === k} onChange={() => setKind(k)} />
            {ALERT_LABELS[k]}
          </label>
        ))}
      </fieldset>
      <label htmlFor="fb-msg">Qual mensagem? (opcional)</label>
      <select id="fb-msg" value={msgId} onChange={(e) => setMsgId(e.target.value)}>
        <option value="">Nenhuma em especial</option>
        {recent.map((m) => (
          <option key={m.id} value={m.id}>
            {formatTime(m.ts)} — {m.senderName ? `${m.senderName}: ` : ''}
            {excerpt(m)}
          </option>
        ))}
      </select>
      <label htmlFor="fb-missed-text">Explique com suas palavras (opcional)</label>
      <textarea id="fb-missed-text" rows={3} maxLength={REASON_TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  )
}

/** "Não precisa responder": por quê (motivo rápido obrigatório) e um texto opcional. */
export function NoReplyDialog({ name, onClose, onSave }: { name?: string; onClose: () => void; onSave: (r: ReplyReason) => void }) {
  const [code, setCode] = useState<ReplyReasonCode | null>(null)
  const [text, setText] = useState('')
  return (
    <Modal
      title="Por que esta conversa não precisa de resposta?"
      onClose={onClose}
      canSave={code !== null}
      onSubmit={() => onSave({ code: code!, ...(text.trim() ? { text: text.trim() } : {}) })}
    >
      <p className="muted small">
        {name ? (
          <>
            <strong>{name}</strong> sai de "Para responder" até mandar outra mensagem.
          </>
        ) : (
          'A conversa sai de "Para responder" até chegar outra mensagem.'
        )}{' '}
        O Saga aprende com o exemplo.
      </p>
      <fieldset className="fb-reasons">
        <legend className="sr-only">Motivo</legend>
        {REPLY_REASON_CODES.map((c) => (
          <label key={c} className="check">
            <input type="radio" name="nr-reason" checked={code === c} onChange={() => setCode(c)} />
            {REPLY_REASON_LABELS[c]}
          </label>
        ))}
      </fieldset>
      <label htmlFor="nr-text">Explique com suas palavras (opcional)</label>
      <textarea id="nr-text" rows={3} maxLength={REASON_TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  )
}

/** Ícone "não precisa responder": balão com um tique. */
export function NoReplyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />
      <path d="m5.5 7.6 1.7 1.6 3.3-3.3" />
    </svg>
  )
}

/** Aviso discreto que some sozinho. */
export function Toast({ text, seq, onDone }: { text: string; seq: number; onDone: () => void }) {
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    const t = setTimeout(() => done.current(), 3500)
    return () => clearTimeout(t)
  }, [text, seq])
  return (
    <div className="toast" role="status">
      {text}
    </div>
  )
}

export const THANKS = 'Obrigado — o Saga vai aprender com isso'
