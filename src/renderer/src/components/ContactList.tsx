import { useEffect, useMemo, useRef, useState } from 'react'
import type { Contact, ContactKind } from '../../../shared/api'
import { formatListTime, initials } from '../format'
import { GroupIcon } from './GroupIcon'

interface Props {
  selected: string | null
  onSelect: (jid: string | null) => void
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

const EMPTY: Record<ContactKind, string> = {
  all: 'Ainda não há conversas. Elas aparecem aqui assim que forem importadas.',
  individual: 'Nenhuma conversa individual ainda.',
  group: 'Nenhum grupo ainda. Os grupos aparecem aqui assim que forem importados.'
}

export function ContactList({ selected, onSelect }: Props) {
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [kind, setKindState] = useState<ContactKind>(readKind)
  const [query, setQuery] = useState('')
  const [menuJid, setMenuJid] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      window.saga
        .listContacts(showHidden, kind)
        .then((c) => alive && setContacts(c))
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

  const visible = useMemo(() => {
    const q = norm(query.trim())
    return (contacts ?? []).filter((c) => !q || norm(c.displayName).includes(q) || c.jid.includes(q))
  }, [contacts, query])

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
          <li className="empty">{query ? 'Nada encontrado.' : EMPTY[kind]}</li>
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
                  {c.hidden ? 'Escondido' : c.awaitingReply ? 'Aguardando resposta' : 'Você respondeu'}
                </span>
              </span>
              <span className="contact-meta">
                {c.lastTs !== null && <time>{formatListTime(c.lastTs)}</time>}
                {c.awaitingReply && <span className="await-dot" role="img" aria-label="Aguardando resposta" />}
              </span>
            </button>
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
