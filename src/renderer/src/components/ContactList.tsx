import { useEffect, useMemo, useRef, useState } from 'react'
import type { Contact } from '../../../shared/api'
import { formatListTime, initials } from '../format'

interface Props {
  selected: string | null
  onSelect: (jid: string | null) => void
}

type Editing = { jid: string; mode: 'rename' | 'notes' } | null

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export function ContactList({ selected, onSelect }: Props) {
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [query, setQuery] = useState('')
  const [menuJid, setMenuJid] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      window.saga
        .listContacts(showHidden)
        .then((c) => alive && setContacts(c))
        .catch(() => alive && setContacts((old) => old ?? []))
    void load()
    const off = window.saga.onContactsChanged(() => void load())
    return () => {
      alive = false
      off()
    }
  }, [showHidden])

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
        <label htmlFor="busca" className="sr-only">
          Buscar pessoa
        </label>
        <input
          id="busca"
          type="search"
          placeholder="Buscar pessoa"
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
          <li className="empty">{query ? 'Ninguém encontrado.' : 'Ainda não há conversas. Elas aparecem aqui assim que forem importadas.'}</li>
        )}
        {visible.map((c) => (
          <li key={c.jid} className={`contact${c.jid === selected ? ' is-selected' : ''}${c.hidden ? ' is-hidden' : ''}`}>
            <button
              type="button"
              className="contact-main"
              aria-current={c.jid === selected ? 'true' : undefined}
              onClick={() => onSelect(c.jid)}
            >
              <span className="avatar" aria-hidden="true">
                {initials(c.displayName)}
              </span>
              <span className="contact-text">
                <span className="contact-name">{c.displayName}</span>
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
