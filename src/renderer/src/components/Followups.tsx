import { useEffect, useRef, useState } from 'react'
import type { SagaApi, SendView } from '../../../shared/api'
import { FOLLOWUP_LIMITS, followupReasonText, type FollowupView } from '../../../shared/copiloto'
import { AvulsaComposer, type DraftStore } from './Suggestions'

/** O `window.saga` pode não ter os follow-ups (testes com uma API parcial): sem eles, nada aparece. */
const api = () => window.saga as Partial<SagaApi> | undefined

/**
 * v0.7.0: os follow-ups do Copiloto (todos, ou de uma conversa), atualizados quando mudam. `null` = carregando.
 */
export function useFollowups(): FollowupView[] | null {
  const [list, setList] = useState<FollowupView[] | null>(null)
  useEffect(() => {
    const a = api()
    if (!a?.listFollowups) {
      setList([])
      return
    }
    let alive = true
    const load = () =>
      void a.listFollowups!()
        .then((l) => alive && setList(Array.isArray(l) ? l : []))
        .catch(() => alive && setList((old) => old ?? []))
    load()
    const off = a.onFollowupsChanged?.(load)
    return () => {
      alive = false
      off?.()
    }
  }, [])
  return list
}

/** "por Equipe Saga · Marina, 26/11 às 14:05" */
export function followupByline(f: Pick<FollowupView, 'author' | 'createdAt'>): string {
  const d = new Date(f.createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `por ${f.author ?? 'equipe do Copiloto'}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)} às ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const hhmm = (ts: number) => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

interface SectionProps {
  jid: string
  drafts: DraftStore
  sends: SendView[]
  onQueued: (send: SendView) => void
}

/** Os avisos "Mensagem do Copiloto" da conversa, no topo da coluna das sugestões. Nada sai sem a confirmação. */
export function FollowupSection({ jid, drafts, sends, onQueued }: SectionProps) {
  const all = useFollowups()
  const mine = (all ?? []).filter((f) => f.jid === jid)
  if (mine.length === 0) return null
  return (
    <div className="fu-section">
      {mine.map((f) => (
        <FollowupCard key={f.id} followup={f} drafts={drafts} sends={sends} onQueued={onQueued} />
      ))}
    </div>
  )
}

function FollowupCard({ followup: f, drafts, sends, onQueued }: { followup: FollowupView; drafts: DraftStore; sends: SendView[]; onQueued: (send: SendView) => void }) {
  const [open, setOpen] = useState(f.status === 'sending')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [declining, setDeclining] = useState(false)
  useEffect(() => {
    if (f.status === 'sending') setOpen(true)
  }, [f.status])

  if (f.status === 'sent') {
    return (
      <div className="sug-card fu-card fu-done" role="group" aria-label="Mensagem do Copiloto">
        <span className="sug-label">📨 Mensagem do Copiloto</span>
        <p className="small fu-result fu-ok">Enviada ✓{f.sentAt ? ` às ${hhmm(f.sentAt)}` : ''}. O Copiloto já sabe.</p>
      </div>
    )
  }
  if (f.status === 'failed') {
    return (
      <div className="sug-card fu-card fu-done" role="group" aria-label="Mensagem do Copiloto">
        <span className="sug-label">📨 Mensagem do Copiloto</span>
        <p className="small fu-result fu-bad">Não enviada: {followupReasonText(f.reason) ?? 'não foi possível enviar'}. A equipe foi avisada.</p>
      </div>
    )
  }

  const openToSend = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.saga.followupOpen(f.id)
      if (r.ok) setOpen(true)
      else setError(r.message)
    } catch {
      setError('Não foi possível abrir agora. Tente de novo.')
    } finally {
      setBusy(false)
    }
  }

  const decline = async (reason: string | null) => {
    setDeclining(false)
    setBusy(true)
    try {
      if (!(await window.saga.followupDecline(f.id, reason))) setError('Esta mensagem do Copiloto não pode mais ser recusada.')
    } catch {
      setError('Não foi possível salvar. Tente de novo.')
    } finally {
      setBusy(false)
    }
  }

  if (open) {
    return (
      <div className="fu-open">
        <AvulsaComposer jid={f.jid} drafts={drafts} sends={sends} onQueued={onQueued} followup={f} onClose={() => setOpen(false)} />
      </div>
    )
  }

  return (
    <div className="sug-card fu-card" role="group" aria-label="Mensagem do Copiloto">
      <div className="sug-head">
        <span className="sug-label">📨 Mensagem do Copiloto</span>
      </div>
      <p className="muted small fu-byline">{followupByline(f)}</p>
      <p className="fu-text">{f.text}</p>
      {f.sendError && <p className="small fu-result fu-bad">O envio anterior não saiu ({f.sendError}). Pode abrir e enviar de novo.</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="sug-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => setDeclining(true)}>
          Recusar
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void openToSend()}>
          Abrir para enviar
        </button>
      </div>
      {declining && <DeclineDialog onClose={() => setDeclining(false)} onSave={(r) => void decline(r)} />}
    </div>
  )
}

/** "Recusar": o motivo é opcional (vai à equipe, até 200 caracteres). */
function DeclineDialog({ onClose, onSave }: { onClose: () => void; onSave: (reason: string | null) => void }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <div className="overlay" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fu-decline-title"
        onSubmit={(e) => {
          e.preventDefault()
          onSave(text.trim() || null)
        }}
      >
        <h2 id="fu-decline-title">Recusar a mensagem do Copiloto</h2>
        <p className="muted small">Ela não será enviada. A equipe vê que você recusou.</p>
        <label htmlFor="fu-decline-reason">Motivo (opcional)</label>
        <textarea id="fu-decline-reason" ref={ref} rows={3} maxLength={FOLLOWUP_LIMITS.reasonChars} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary">
            Recusar
          </button>
        </div>
      </form>
    </div>
  )
}
