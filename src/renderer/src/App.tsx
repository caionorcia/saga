import { useEffect, useRef, useState } from 'react'
import type { Alert, Analysis, AppState, Contact } from '../../shared/api'
import { ContactList, type ContactView } from './components/ContactList'
import { Conversation } from './components/Conversation'
import { QrCode } from './components/QrCode'
import { Settings } from './components/Settings'
import { SetupWizard } from './components/SetupWizard'
import { StatusBar } from './components/StatusBar'
import { Suggestions, type DraftStore } from './components/Suggestions'
import { ColumnDivider, useColumnWidths } from './columns'
import { connAlert } from './format'

export function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [wizard, setWizard] = useState<boolean | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  /** pedido da barra de status para a lista mostrar "Para responder" */
  const [viewRequest, setViewRequest] = useState<{ view: ContactView; seq: number } | undefined>(undefined)

  useEffect(() => {
    let alive = true
    const off = window.saga.onState((s) => alive && setState(s))
    window.saga
      .getState()
      .then((s) => {
        if (!alive) return
        setState((old) => old ?? s)
        // o assistente fica na tela até o fim, mesmo que o app já conste como configurado no meio dele
        setWizard((w) => w ?? !s.setupDone)
      })
      .catch(() => {})
    return () => {
      alive = false
      off()
    }
  }, [])

  if (!state || wizard === null) return <div className="boot" role="status">Carregando…</div>
  if (wizard) return <SetupWizard state={state} onFinish={() => setWizard(false)} />

  const alert = state.startError
    ? `O Saga não conseguiu iniciar a conexão com o WhatsApp (${state.startError}). Clique em Reconectar para tentar de novo; se continuar, copie o diagnóstico em Configurações e mande para o suporte.`
    : connAlert(state.conn)
  return (
    <div className="app">
      <StatusBar
        state={state}
        settingsOpen={settingsOpen}
        onOpenSettings={() => setSettingsOpen((o) => !o)}
        onShowAwaiting={() => {
          setSettingsOpen(false)
          setViewRequest((r) => ({ view: 'awaiting', seq: (r?.seq ?? 0) + 1 }))
        }}
      />
      {alert && (
        <div className="conn-alert" role="alert">
          {alert}
        </div>
      )}
      <RelinkPanel state={state} />
      {/* a tela de conversas continua montada (escondida) para não perder rascunhos nem a posição */}
      <Main
        hidden={settingsOpen}
        selected={selected}
        onSelect={setSelected}
        onOpenSettings={() => setSettingsOpen(true)}
        viewRequest={viewRequest}
      />
      {settingsOpen && <Settings />}
    </div>
  )
}

/**
 * Vincular de novo depois do assistente (desvinculado no celular, sessão refeita): mostra o QR por cima
 * das conversas sempre que o WhatsApp pedir um. "Agora não" esconde até o próximo pedido.
 */
function RelinkPanel({ state }: { state: AppState }) {
  const wanted = !!state.qr || state.conn === 'needs_qr'
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    if (!wanted) setDismissed(false)
  }, [wanted])
  if (!wanted || dismissed) return null
  return (
    <div className="overlay">
      <section className="relink-card" role="dialog" aria-modal="true" aria-labelledby="relink-title">
        <h2 id="relink-title">Vincule o WhatsApp de novo</h2>
        <QrCode state={state} />
        <div className="relink-actions">
          <button type="button" className="link-btn" onClick={() => setDismissed(true)}>
            Agora não
          </button>
        </div>
      </section>
    </div>
  )
}

function Main({
  hidden,
  selected,
  onSelect,
  onOpenSettings,
  viewRequest
}: {
  hidden: boolean
  selected: string | null
  onSelect: (jid: string | null) => void
  onOpenSettings: () => void
  viewRequest?: { view: ContactView; seq: number }
}) {
  const drafts = useRef<DraftStore>(new Map())
  const [contact, setContact] = useState<Contact | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [alerts, setAlerts] = useState<Alert[]>([])
  /** a conversa não precisa de resposta e a IA não foi chamada (sem resumo) */
  const [skipped, setSkipped] = useState(false)
  /** busca geral: a mensagem para rolar e destacar na conversa aberta */
  const [focusMsg, setFocusMsg] = useState<{ jid: string; id: string; seq: number } | null>(null)

  // mantém o cabeçalho da conversa em dia (renomear, notas)
  useEffect(() => {
    if (!selected) {
      setContact(null)
      return
    }
    let alive = true
    const load = () => {
      window.saga
        .listContacts(true)
        .then((l) => alive && setContact(l.find((c) => c.jid === selected) ?? null))
        .catch(() => {})
      window.saga
        .listAlerts(selected)
        .then((a) => alive && setAlerts(a))
        .catch(() => {})
    }
    setAlerts([])
    void load()
    const off = window.saga.onContactsChanged(() => void load())
    return () => {
      alive = false
      off()
    }
  }, [selected])

  useEffect(() => {
    setAnalysis(null)
    setSkipped(false)
  }, [selected])
  const cols = useColumnWidths()

  return (
    <div className="columns" hidden={hidden} style={cols.style}>
      <ContactList
        selected={selected}
        onSelect={onSelect}
        request={viewRequest}
        onOpenHit={(jid, id) => {
          setFocusMsg((f) => ({ jid, id, seq: (f?.seq ?? 0) + 1 }))
          onSelect(jid)
        }}
      />
      <ColumnDivider {...cols.divider('left')} />
      {contact ? (
        <Conversation
          key={contact.jid}
          contact={contact}
          analysis={analysis}
          alerts={alerts.filter((a) => a.jid === contact.jid)}
          onOpenChat={onSelect}
          summarySkipped={skipped}
          focusMessage={focusMsg && focusMsg.jid === contact.jid ? focusMsg : null}
          onDismissAlert={(kind) => {
            setAlerts((l) => l.filter((a) => a.kind !== kind))
            void window.saga.dismissAlert(contact.jid, kind).catch(() => {})
          }}
        />
      ) : (
        <section className="conversation conversation-empty">
          <p>Escolha uma conversa na lista para ver as mensagens.</p>
        </section>
      )}
      <ColumnDivider {...cols.divider('right')} />
      <aside className="suggestions" aria-label="Sugestões de resposta">
        <h2>Sugestões de resposta</h2>
        <p className="muted small">
          {contact?.isGroup
            ? 'Mensagens para você postar no grupo. Edite como quiser, depois copie e cole no grupo do WhatsApp. O Saga não envia nada.'
            : 'Edite como quiser, depois copie e cole no WhatsApp. O Saga não envia nada.'}
        </p>
        {contact ? <Suggestions key={contact.jid} jid={contact.jid} drafts={drafts.current} onAnalysis={setAnalysis} onSkipped={setSkipped} onOpenSettings={onOpenSettings} /> : <p className="empty">As sugestões aparecem aqui.</p>}
      </aside>
    </div>
  )
}
