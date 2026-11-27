import { useEffect, useRef, useState } from 'react'
import type { SagaApi, SendView } from '../../../shared/api'
import {
  CONVO_FINAL,
  CONVO_LIMITS,
  FOLLOWUP_LIMITS,
  convoStatusText,
  convoTitle,
  followupReasonText,
  type ConvoAction,
  type ConvoView,
  type FollowupView
} from '../../../shared/copiloto'
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

/** v0.10.0: as conversas de follow-up (onboarding/sumido), atualizadas quando mudam. `null` = carregando. */
export function useConvos(): ConvoView[] | null {
  const [list, setList] = useState<ConvoView[] | null>(null)
  useEffect(() => {
    const a = api()
    if (!a?.listConvos) {
      setList([])
      return
    }
    let alive = true
    const load = () =>
      void a.listConvos!()
        .then((l) => alive && setList(Array.isArray(l) ? l : []))
        .catch(() => alive && setList((old) => old ?? []))
    load()
    const off = a.onFollowupsChanged?.(load)
    // a próxima tentativa e o "sai às HH:MM" mudam com o tempo: confere de novo a cada 30 s
    const timer = setInterval(load, 30_000)
    return () => {
      alive = false
      off?.()
      clearInterval(timer)
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
  const convos = useConvos()
  const mine = (all ?? []).filter((f) => f.jid === jid)
  // v0.10.0: o follow-up de conversa fica no topo (as sugestões normais não geram sozinhas nesse grupo)
  const mineConvos = (convos ?? []).filter((c) => c.jid === jid)
  if (mine.length === 0 && mineConvos.length === 0) return null
  return (
    <div className="fu-section">
      {mineConvos.map((c) => (
        <ConvoCard key={c.id} convo={c} />
      ))}
      {mine.map((f) => (
        <FollowupCard key={f.id} followup={f} drafts={drafts} sends={sends} onQueued={onQueued} />
      ))}
    </div>
  )
}

/** "às 09:14", "amanhã às 09:14", "segunda às 09:14" */
export function autoWhen(at: number, now = Date.now()): string {
  const a = new Date(at)
  const n = new Date(now)
  const same = (x: Date, y: Date) => x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
  if (same(a, n)) return `às ${hhmm(at)}`
  if (same(a, new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1))) return `amanhã às ${hhmm(at)}`
  return `${['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][a.getDay()]} às ${hhmm(at)}`
}

/** v0.8.0: a linha de estado do envio automático ("Follow-up do Copiloto: envio automático às HH:MM"). */
export function autoStatusText(auto: NonNullable<FollowupView['auto']>, now = Date.now()): string {
  if (auto.state === 'sent') return `enviado ✓${auto.at ? ` às ${hhmm(auto.at)}` : ''}`
  if (auto.state === 'sending') return 'enviando…'
  if (auto.wait === 'no_hours') return 'envio automático quando houver um dia liberado no horário de envio'
  if (auto.wait === 'connection') return 'envio automático assim que o WhatsApp estiver conectado'
  if (auto.wait === 'copiloto') return 'envio automático quando o Copiloto responder de novo'
  if (auto.wait === 'daily_cap') return 'envio automático amanhã (limite de 30 por dia)'
  if (auto.at !== null && auto.at > now) return `envio automático ${autoWhen(auto.at, now)}`
  return 'envio automático em instantes'
}

/** v0.8.0: o follow-up sai sozinho: só uma linha de estado na conversa e "Não enviar" (vai ao Copiloto como recusado). */
function AutoFollowupLine({ followup: f }: { followup: FollowupView & { auto: NonNullable<FollowupView['auto']> } }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancel = async () => {
    setBusy(true)
    setError(null)
    try {
      if (!(await window.saga.followupDecline(f.id, null))) setError('Não dá mais para cancelar: o envio já começou.')
    } catch {
      setError('Não foi possível cancelar. Tente de novo.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="fu-auto small" role="status" aria-label="Follow-up do Copiloto" title={`${followupByline(f)}: ${f.text}`}>
      <span>
        📨 Follow-up do Copiloto: <strong>{autoStatusText(f.auto)}</strong>
      </span>
      {f.auto.canCancel && (
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => void cancel()}>
          Não enviar
        </button>
      )}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

function FollowupCard({ followup: f, drafts, sends, onQueued }: { followup: FollowupView; drafts: DraftStore; sends: SendView[]; onQueued: (send: SendView) => void }) {
  if (f.auto) return <AutoFollowupLine followup={f as FollowupView & { auto: NonNullable<FollowupView['auto']> }} />
  return <ManualFollowupCard followup={f} drafts={drafts} sends={sends} onQueued={onQueued} />
}

function ManualFollowupCard({ followup: f, drafts, sends, onQueued }: { followup: FollowupView; drafts: DraftStore; sends: SendView[]; onQueued: (send: SendView) => void }) {
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

// --- v0.10.0: follow-up de conversa (onboarding/sumido) ---

/** "hoje às 14:05", "amanhã às 09:14", "segunda às 09:14" (a data quando passa de uma semana) */
function whenText(at: number, now = Date.now()): string {
  if (at - now > 6 * 86_400_000) {
    const d = new Date(at)
    return `em ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} às ${hhmm(at)}`
  }
  const w = autoWhen(at, now)
  return w.startsWith('às') ? `hoje ${w}` : w
}

/** A linha de situação do cartão: tentativas, próxima, resposta. */
export function convoProgressText(c: ConvoView, now = Date.now()): string {
  const parts = [`${c.attemptsSent} de ${c.attemptTotal} tentativa(s) enviada(s)`]
  if (c.repliedAt !== null) parts.push(`respondeu ${whenText(c.repliedAt, now)}`)
  else if (c.nextAttempt !== null && c.nextAttemptAt !== null && !c.draft && !c.drafting) {
    parts.push(c.nextAttemptAt <= now ? `tentativa ${c.nextAttempt} em instantes` : `tentativa ${c.nextAttempt} ${whenText(c.nextAttemptAt, now)}`)
  }
  return parts.join(' · ')
}

function ConvoCard({ convo: c }: { convo: ConvoView }) {
  const [text, setText] = useState(c.draft?.text ?? '')
  const [draftId, setDraftId] = useState(c.draft?.id ?? null)
  const [forced, setForced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmEnd, setConfirmEnd] = useState(false)
  // rascunho novo (outra tentativa, ou a IA refez): o texto da caixa é o dele
  useEffect(() => {
    if ((c.draft?.id ?? null) !== draftId) {
      setDraftId(c.draft?.id ?? null)
      setText(c.draft?.text ?? '')
      setForced(false)
    }
  }, [c.draft?.id, c.draft?.text, draftId])

  const label = c.type === 'sumido' ? 'Follow-up Sumido' : 'Follow-up Onboarding'
  const run = async (a: ConvoAction) => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.saga.convoAction(c.id, a)
      if (!r.ok) setError(r.message)
    } catch {
      setError('Não foi possível salvar. Tente de novo.')
    } finally {
      setBusy(false)
    }
  }

  if (CONVO_FINAL.has(c.status)) {
    const good = c.status === 'scheduled' || c.status === 'completed'
    return (
      <div className="sug-card fu-card convo-card fu-done" role="group" aria-label={label}>
        <span className="sug-label">🔁 {label}</span>
        <p className={`small fu-result ${good ? 'fu-ok' : 'fu-bad'}`}>
          {convoStatusText(c.status)}
          {c.reason && !good && c.status !== 'declined' ? ` (${c.reason.replace(/_/g, ' ')})` : ''}. O Copiloto já sabe.
        </p>
      </div>
    )
  }

  const d = c.draft
  const total = c.goal.pendingItems.length
  const allDone = c.goal.pendingItems.every((x) => c.itemsDone.includes(x))
  return (
    <div className="sug-card fu-card convo-card" role="group" aria-label={label}>
      <div className="sug-head">
        <span className="sug-label">🔁 {convoTitle(c)}</span>
        {c.goal.sendMode === 'auto' && <span className="convo-tag" title="O envio automático ainda não está ligado: cada mensagem espera você">confirmação</span>}
      </div>
      <p className="muted small fu-byline">
        {followupByline(c)} · {convoProgressText(c)}
      </p>

      {c.type === 'sumido' ? (
        <ul className="convo-goal small" aria-label="Objetivo">
          <li>{c.repliedAt !== null ? '✅' : '⬜'} Conseguir uma resposta</li>
          <li>⬜ Marcar a reunião{c.goal.schedulingLink ? ' (pelo link da agenda)' : ''}</li>
        </ul>
      ) : (
        <ul className="convo-goal small" aria-label="Pendências">
          {c.goal.pendingItems.map((it) => {
            const done = c.itemsDone.includes(it)
            return (
              <li key={it}>
                <label>
                  <input type="checkbox" checked={done} disabled={busy} onChange={(e) => void run({ kind: 'item', item: it, done: e.target.checked })} />
                  <span className={done ? 'done' : undefined}>{it}</span>
                </label>
              </li>
            )
          })}
          {total === 0 && <li>Sem pendências informadas pelo Copiloto.</li>}
        </ul>
      )}
      {c.goal.schedulingLink && <p className="muted small convo-link">Link da agenda: {c.goal.schedulingLink}</p>}
      {c.goal.note && <p className="muted small fu-note">Observação da equipe: {c.goal.note}</p>}

      {(c.suggestScheduled || c.suggestItems.length > 0) && (
        <div className="convo-suggest small" role="status">
          {c.suggestScheduled && <p>A IA acha que a reunião foi marcada. Confirme só se for verdade.</p>}
          {c.suggestItems.map((it) => (
            <p key={it}>A IA acha que esta pendência foi cumprida: “{it}”.</p>
          ))}
          <div className="sug-actions">
            {c.suggestScheduled && (
              <button type="button" className="btn btn-primary btn-small" disabled={busy} onClick={() => void run({ kind: 'scheduled' })}>
                Sim, reunião marcada
              </button>
            )}
            {c.suggestItems.map((it) => (
              <button key={it} type="button" className="btn btn-primary btn-small" disabled={busy} onClick={() => void run({ kind: 'item', item: it, done: true })}>
                Confirmar “{it.length > 30 ? `${it.slice(0, 29)}…` : it}”
              </button>
            ))}
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run({ kind: 'dismiss_suggestion' })}>
              Ainda não
            </button>
          </div>
        </div>
      )}

      {c.needsYou && (
        <div className="convo-needs small" role="alert">
          <strong>⚠ Precisa de você</strong>
          {c.needsYou} A IA não escreveu nada; responda no WhatsApp ou peça um rascunho.
          <div className="sug-actions">
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run({ kind: 'retry' })}>
              Gerar rascunho mesmo assim
            </button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run({ kind: 'dismiss_needs_you' })}>
              Já resolvi
            </button>
          </div>
        </div>
      )}

      {c.drafting && (
        <p className="small convo-state" role="status">
          <span className="spinner" aria-hidden="true" /> A IA está escrevendo a próxima mensagem…
        </p>
      )}
      {c.aiError && !c.drafting && (
        <div className="small fu-result fu-bad" role="alert">
          Não foi possível escrever a mensagem: {c.aiError}{' '}
          <button type="button" className="link-btn" disabled={busy} onClick={() => void run({ kind: 'retry' })}>
            Tentar de novo
          </button>
        </div>
      )}

      {d && (
        <div className="convo-draft">
          <label className="small convo-draft-label" htmlFor={`convo-${c.id}`}>
            {d.kind === 'attempt' ? 'Mensagem sugerida (edite à vontade)' : 'Resposta sugerida (edite à vontade)'}
          </label>
          <textarea
            id={`convo-${c.id}`}
            rows={6}
            maxLength={CONVO_LIMITS.draftChars}
            value={d.state === 'ready' ? text : d.text}
            readOnly={d.state !== 'ready'}
            onChange={(e) => setText(e.target.value)}
          />
          {d.sendError && d.state === 'ready' && <p className="small fu-result fu-bad">O envio anterior não saiu ({d.sendError}). Pode enviar de novo.</p>}
          {d.state === 'ready' && c.outsideHours && (
            <label className="small convo-force">
              <input type="checkbox" checked={forced} onChange={(e) => setForced(e.target.checked)} />
              Forçar envio agora (fora do horário de envio)
            </label>
          )}
          {d.state === 'ready' && (
            <div className="convo-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => void run({ kind: 'skip' })}>
                {d.kind === 'attempt' ? 'Pular esta tentativa' : 'Descartar rascunho'}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !text.trim()}
                onClick={() => void run({ kind: 'send', draftId: d.id, text, ...(forced ? { forced: true } : {}) })}
              >
                Enviar
              </button>
            </div>
          )}
          {d.state === 'approved' && (
            <p className="small convo-state" role="status">
              Confirmado ✓ {d.forced ? 'Sai em instantes (forçar envio).' : d.at && d.at > Date.now() ? `Sai ${whenText(d.at)}, no horário de envio.` : 'Sai em instantes, com o ritmo de sempre.'}{' '}
              <button type="button" className="link-btn" disabled={busy} onClick={() => void run({ kind: 'cancel_send' })}>
                Cancelar envio
              </button>
            </p>
          )}
          {d.state === 'sending' && (
            <p className="small convo-state" role="status">
              Enviando…{' '}
              <button type="button" className="link-btn" disabled={busy} onClick={() => void run({ kind: 'cancel_send' })}>
                Cancelar envio
              </button>
            </p>
          )}
          {d.state === 'unknown' && (
            <p className="small convo-state fu-bad" role="status">
              O WhatsApp não confirmou o envio. O SagaZap confere na conversa e nunca reenvia sozinho.
            </p>
          )}
        </div>
      )}
      {!d && !c.drafting && !c.needsYou && !c.aiError && (
        <p className="muted small convo-state">{c.status === 'responded' ? 'Esperando a próxima mensagem do mentorado.' : 'Aguardando a resposta do mentorado.'}</p>
      )}

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="convo-footer">
        {c.type === 'sumido' && (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run({ kind: 'scheduled' })}>
            Reunião marcada
          </button>
        )}
        {c.type === 'onboarding' && allDone && (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run({ kind: 'complete' })}>
            Concluir onboarding
          </button>
        )}
        {confirmEnd ? (
          <>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => { setConfirmEnd(false); void run({ kind: 'decline' }) }}>
              Sim, encerrar
            </button>
            <button type="button" className="btn btn-small" onClick={() => setConfirmEnd(false)}>
              Voltar
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => setConfirmEnd(true)}>
            Encerrar
          </button>
        )}
      </div>
    </div>
  )
}
