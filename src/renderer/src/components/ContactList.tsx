import { useEffect, useMemo, useRef, useState } from 'react'
import type { Contact, ContactKind } from '../../../shared/api'
import { alertSeverity } from '../../../shared/triage'
import { formatListTime, initials } from '../format'
import { AlertChips, WaitBadge } from './Alerts'
import { NoReplyDialog, NoReplyIcon, THANKS, Toast } from './AlertFeedback'
import { GroupIcon } from './GroupIcon'

/** Recorte da lista: todas, só as que esperam resposta ("Para responder") ou só as com alerta. */
export type ContactView = 'all' | 'awaiting' | 'alerts'

interface Props {
  selected: string | null
  onSelect: (jid: string | null) => void
  /** pedido de fora (contador da barra de status): muda o recorte e volta o tipo para "Todos"; `seq` novo = novo pedido */
  request?: { view: ContactView; seq: number }
}

type Editing = { jid: string; mode: 'rename' | 'notes' } | null

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** Filtro escolhido (lembrado só neste computador; sem armazenamento, volta para "Todos"). */
const KIND_KEY = 'saga.contactKind'
const KINDS: ReadonlyArray<{ kind: ContactKind; label: string }> = [
  { kind: 'all', label: 'Todos' },
  { kind: 'individual', label: 'Individuais' },
  { kind: 'group', label: 'Grupos' }
]

function readKind(): ContactKind {
  try {
    const v = localStorage.getItem(KIND_KEY)
    return v === 'individual' || v === 'group' ? v : 'all'
  } catch {
    return 'all'
  }
}

function writeKind(kind: ContactKind): void {
  try {
    localStorage.setItem(KIND_KEY, kind)
  } catch {
    // sem armazenamento: o filtro vale só até fechar
  }
}

/** Recorte escolhido (também lembrado só neste computador). */
const VIEW_KEY = 'saga.contactView'

function readView(): ContactView {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'awaiting' || v === 'alerts' ? v : 'all'
  } catch {
    return 'all'
  }
}

function writeView(view: ContactView): void {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    // sem armazenamento: vale só até fechar
  }
}

const byWait = (a: Contact, b: Contact) => (a.waitingSince ?? Infinity) - (b.waitingSince ?? Infinity)

/** Entra em "Para responder": espera resposta e nem o Saga nem o mentor disseram que não precisa. */
const inAwaiting = (c: Contact) => c.needsReply && c.waitingSince !== null
/** A última mensagem é do contato, mas o Saga ou o mentor decidiram que não precisa de resposta. */
const noReply = (c: Contact) => c.awaitingReply && !c.needsReply && !c.hidden

/** Aplica o recorte e a ordem: "Para responder" = quem espera há mais tempo primeiro; "Com alerta" = mais grave primeiro. */
export function applyView(list: Contact[], view: ContactView): Contact[] {
  if (view === 'awaiting') return list.filter(inAwaiting).sort(byWait)
  if (view === 'alerts') {
    return list
      .filter((c) => c.alerts.length > 0)
      .sort((a, b) => alertSeverity(a.alerts[0]) - alertSeverity(b.alerts[0]) || byWait(a, b) || (b.lastTs ?? 0) - (a.lastTs ?? 0))
  }
  return list
}

/** Relógio da lista (os selos "há 15 min" andam sozinhos). */
function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

const EMPTY: Record<ContactKind, string> = {
  all: 'Ainda não há conversas. Elas aparecem aqui assim que forem importadas.',
  individual: 'Nenhuma conversa individual ainda.',
  group: 'Nenhum grupo ainda. Os grupos aparecem aqui assim que forem importados.'
}

const VIEW_EMPTY: Record<Exclude<ContactView, 'all'>, string> = {
  awaiting: 'Ninguém está esperando resposta agora.',
  alerts: 'Nenhum alerta agora. Os alertas aparecem aqui quando alguém precisar de atenção.'
}

export function ContactList({ selected, onSelect, request }: Props) {
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [kind, setKindState] = useState<ContactKind>(readKind)
  const [view, setViewState] = useState<ContactView>(readView)
  const now = useNow()
  const [query, setQuery] = useState('')
  const [menuJid, setMenuJid] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  /** "Não precisa responder" aberto para esta conversa */
  const [noReplyFor, setNoReplyFor] = useState<Contact | null>(null)
  /** tiradas da lista agora (antes de a lista voltar do processo principal) */
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      window.saga
        .listContacts(showHidden, kind)
        .then((c) => {
          if (!alive) return
          setContacts(c)
          setRemoved(new Set())
        })
        .catch(() => alive && setContacts((old) => old ?? []))
    void load()
    const off = window.saga.onContactsChanged(() => void load())
    return () => {
      alive = false
      off()
    }
  }, [showHidden, kind])

  const setKind = (k: ContactKind) => {
    if (k === kind) return
    writeKind(k)
    setContacts(null)
    setKindState(k)
  }

  const setView = (v: ContactView) => {
    writeView(v)
    setViewState(v)
  }

  // contador da barra de status: "Para responder" com todos os tipos
  const lastSeq = useRef(request?.seq)
  useEffect(() => {
    if (!request || request.seq === lastSeq.current) return
    lastSeq.current = request.seq
    setView(request.view)
    setKind('all')
    setQuery('')
  }, [request?.seq])

  const counts = useMemo(() => {
    const list = (contacts ?? []).filter((c) => !c.hidden)
    return {
      awaiting: list.filter((c) => inAwaiting(c) && !removed.has(c.jid)).length,
      alerts: list.filter((c) => c.alerts.length > 0).length
    }
  }, [contacts, removed])

  const visible = useMemo(() => {
    const q = norm(query.trim())
    const found = (contacts ?? []).filter((c) => !q || norm(c.displayName).includes(q) || c.jid.includes(q))
    return applyView(found, view).filter((c) => view !== 'awaiting' || !removed.has(c.jid))
  }, [contacts, query, view, removed])

  const saveNoReply = (c: Contact, reason: Parameters<typeof window.saga.setNeedsReply>[2]) => {
    setNoReplyFor(null)
    setRemoved((r) => new Set(r).add(c.jid))
    setToast((t) => ({ text: THANKS, seq: (t?.seq ?? 0) + 1 }))
    window.saga.setNeedsReply(c.jid, false, reason).catch(() => {
      setRemoved((r) => {
        const n = new Set(r)
        n.delete(c.jid)
        return n
      })
      setToast((t) => ({ text: 'Não foi possível salvar. Tente de novo.', seq: (t?.seq ?? 0) + 1 }))
    })
  }

  useEffect(() => {
    if (!menuJid) return
    const close = () => setMenuJid(null)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('click', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', key)
    }
  }, [menuJid])

  const editingContact = editing ? contacts?.find((c) => c.jid === editing.jid) : undefined

  return (
    <nav className="contacts" aria-label="Conversas">
      <div className="contacts-head">
        <h1 className="brand">Saga</h1>
        <div className="view-filter" role="group" aria-label="Fila do dia">
          <button
            type="button"
            aria-pressed={view === 'awaiting'}
            className={view === 'awaiting' ? 'is-active' : undefined}
            title="Só as conversas esperando a sua resposta, de quem espera há mais tempo"
            onClick={() => setView(view === 'awaiting' ? 'all' : 'awaiting')}
          >
            Para responder <span className="view-count">{counts.awaiting}</span>
          </button>
          <button
            type="button"
            aria-pressed={view === 'alerts'}
            className={view === 'alerts' ? 'is-active' : undefined}
            title="Só as conversas com alerta (urgência, desânimo, travado, reunião, esperando), as mais graves primeiro"
            onClick={() => setView(view === 'alerts' ? 'all' : 'alerts')}
          >
            Com alerta <span className="view-count">{counts.alerts}</span>
          </button>
        </div>
        <div className="kind-filter" role="radiogroup" aria-label="Mostrar conversas">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={kind === k.kind}
              className={kind === k.kind ? 'is-active' : undefined}
              onClick={() => setKind(k.kind)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <label htmlFor="busca" className="sr-only">
          Buscar pessoa ou grupo
        </label>
        <input
          id="busca"
          type="search"
          placeholder={kind === 'group' ? 'Buscar grupo' : kind === 'individual' ? 'Buscar pessoa' : 'Buscar pessoa ou grupo'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          Mostrar escondidos
        </label>
      </div>

      <ul className="contacts-list">
        {contacts === null && <li className="empty">Carregando…</li>}
        {contacts !== null && visible.length === 0 && (
          <li className="empty">{query ? 'Nada encontrado.' : view === 'all' ? EMPTY[kind] : VIEW_EMPTY[view]}</li>
        )}
        {visible.map((c) => (
          <li key={c.jid} className={`contact${c.jid === selected ? ' is-selected' : ''}${c.hidden ? ' is-hidden' : ''}`}>
            <button
              type="button"
              className="contact-main"
              aria-current={c.jid === selected ? 'true' : undefined}
              onClick={() => onSelect(c.jid)}
            >
              {c.isGroup ? (
                <span className="avatar avatar-group" aria-hidden="true">
                  <GroupIcon />
                </span>
              ) : (
                <span className="avatar" aria-hidden="true">
                  {initials(c.displayName)}
                </span>
              )}
              <span className="contact-text">
                {c.isGroup && <span className="sr-only">Grupo: </span>}
                <span className="contact-name" title={c.displayName}>
                  {c.displayName}
                </span>
                <span className="contact-sub">
                  {c.hidden
                    ? 'Escondido'
                    : c.awaitingReply && !c.needsReply
                      ? 'Sem pendência'
                      : c.awaitingReply
                        ? c.waitingSince !== null
                          ? 'Aguardando'
                          : 'Aguardando resposta'
                        : 'Você respondeu'}
                </span>
              </span>
              <span className="contact-meta">
                {c.lastTs !== null && <time>{formatListTime(c.lastTs)}</time>}
                {c.needsReply && c.waitingSince === null && (
                  <span className="await-dot" role="img" aria-label="Aguardando resposta" />
                )}
              </span>
              {(inAwaiting(c) || noReply(c) || c.alerts.length > 0) && (
                <span className="contact-badges">
                  {inAwaiting(c) && <WaitBadge since={c.waitingSince!} now={now} />}
                  {noReply(c) &&
                    (c.replyDecision?.by === 'group' && c.replyDecision.group ? (
                      <span className="reply-chip reply-chip-group" title={c.replyDecision.reason ?? undefined}>
                        respondido em {c.replyDecision.group.name}
                      </span>
                    ) : (
                      <span className="reply-chip" title={c.replyDecision?.reason ?? 'Você marcou que não precisa responder'}>
                        Não precisa responder
                      </span>
                    ))}
                  <AlertChips kinds={c.alerts} waitingSince={c.waitingSince} now={now} />
                </span>
              )}
            </button>
            {view === 'awaiting' && !c.hidden && (
              <button
                type="button"
                className="icon-btn no-reply-btn"
                aria-label={`Não precisa responder: ${c.displayName}`}
                title="Não precisa responder (tira da lista)"
                onClick={() => setNoReplyFor(c)}
              >
                <NoReplyIcon />
              </button>
            )}
            <div className="contact-menu-wrap">
              <button
                type="button"
                className="icon-btn"
                aria-label={`Opções de ${c.displayName}`}
                aria-haspopup="menu"
                aria-expanded={menuJid === c.jid}
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuJid(menuJid === c.jid ? null : c.jid)
                }}
              >
                ⋯
              </button>
              {menuJid === c.jid && (
                <div className="menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => setEditing({ jid: c.jid, mode: 'rename' })}>
                    Renomear
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      void window.saga.setHidden(c.jid, !c.hidden)
                      if (!c.hidden && selected === c.jid && !showHidden) onSelect(null)
                    }}
                  >
                    {c.hidden ? 'Mostrar' : 'Esconder'}
                  </button>
                  <button type="button" role="menuitem" onClick={() => setEditing({ jid: c.jid, mode: 'notes' })}>
                    Notas
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      {noReplyFor && (
        <NoReplyDialog name={noReplyFor.displayName} onClose={() => setNoReplyFor(null)} onSave={(r) => saveNoReply(noReplyFor, r)} />
      )}
      {toast && <Toast text={toast.text} seq={toast.seq} onDone={() => setToast(null)} />}

      {editing && editingContact && (
        <EditDialog
          key={`${editing.jid}-${editing.mode}`}
          contact={editingContact}
          mode={editing.mode}
          onClose={() => setEditing(null)}
        />
      )}
    </nav>
  )
}

function EditDialog({ contact, mode, onClose }: { contact: Contact; mode: 'rename' | 'notes'; onClose: () => void }) {
  const [value, setValue] = useState(mode === 'rename' ? contact.displayName : (contact.notes ?? ''))
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])

  const save = async () => {
    try {
      if (mode === 'rename') await window.saga.renameContact(contact.jid, value.trim())
      else await window.saga.setNotes(contact.jid, value)
    } finally {
      onClose()
    }
  }

  const title = mode === 'rename' ? `Renomear ${contact.displayName}` : `Notas sobre ${contact.displayName}`
  return (
    <div className="overlay" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlg-title"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <h2 id="dlg-title">{title}</h2>
        {mode === 'rename' ? (
          <>
            <label htmlFor="dlg-field">Nome</label>
            <input id="dlg-field" ref={ref} value={value} onChange={(e) => setValue(e.target.value)} />
            <p className="muted small">Deixe vazio para voltar ao nome original do WhatsApp.</p>
          </>
        ) : (
          <>
            <label htmlFor="dlg-field">Suas anotações (só ficam neste computador)</label>
            <textarea id="dlg-field" ref={ref} rows={6} value={value} onChange={(e) => setValue(e.target.value)} />
          </>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary">
            Salvar
          </button>
        </div>
      </form>
    </div>
  )
}
