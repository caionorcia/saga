import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiErrorCode, Analysis, MessageView } from '../../../shared/api'

type View =
  | { kind: 'loading' }
  | { kind: 'ready'; analysis: Analysis }
  | { kind: 'error'; code: AiErrorCode | 'exception'; message: string }

const REFRESH_DEBOUNCE_MS = 2_000
const COPIED_MS = 2_000

const GENERIC_ERROR = 'Não foi possível gerar as sugestões agora.'

export const providerLabel = (provider: string): string =>
  provider === 'groq' ? 'Groq (grátis)' : provider === 'claude' ? 'Claude' : provider

/** Erros em que tentar de novo não adianta sem o mentor mexer em algo. */
const NO_RETRY: ReadonlySet<string> = new Set(['budget_exceeded', 'missing_key', 'invalid_key', 'no_messages'])

function errorText(code: string, message: string): string {
  if (code === 'budget_exceeded') {
    return 'Limite de gasto diário atingido. Aumente o teto em Configurações para gerar mais sugestões.'
  }
  return message || GENERIC_ERROR
}

/**
 * As mensagens que chegaram depois da análise são todas do próprio mentor (ele respondeu)?
 * Nesse caso não vale gastar uma geração nova nem trocar os cartões em silêncio.
 */
export function onlyOwnNewMessages(messages: MessageView[], lastMsgId: string): boolean {
  const idx = messages.findIndex((m) => m.id === lastMsgId)
  if (idx < 0) return false
  const after = messages.slice(idx + 1)
  return after.length > 0 && after.every((m) => m.fromMe)
}

const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible'

/** Rascunhos editados pelo mentor, por `jid:índice`; vivem acima do componente para sobreviver a trocas de tela. */
export type DraftStore = Map<string, { original: string; text: string }>

const draftKey = (jid: string, i: number) => `${jid}:${i}`

function hasDirtyDraft(drafts: DraftStore, jid: string): boolean {
  for (const [k, d] of drafts) if (k.startsWith(`${jid}:`) && d.text !== d.original) return true
  return false
}

function clearDrafts(drafts: DraftStore, jid: string): void {
  for (const k of [...drafts.keys()]) if (k.startsWith(`${jid}:`)) drafts.delete(k)
}

interface Props {
  jid: string
  /** avisa o resumo ("O que a pessoa quer") sempre que a análise mudar */
  onAnalysis?: (analysis: Analysis | null) => void
  /** rascunhos guardados fora do componente (padrão: só enquanto ele existir) */
  drafts?: DraftStore
  /** botão "Abrir Configurações" nos erros de chave */
  onOpenSettings?: () => void
}

export function Suggestions({ jid, onAnalysis, drafts: draftsProp, onOpenSettings }: Props) {
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [newMessage, setNewMessage] = useState(false)
  const ownDrafts = useRef<DraftStore>(new Map())
  const drafts = draftsProp ?? ownDrafts.current
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const viewRef = useRef(view)
  viewRef.current = view
  /** um pedido "normal" (abrir, tentar de novo, gerar novas) em andamento */
  const normalInFlight = useRef(false)
  const current = useRef<Analysis | null>(null)
  const onAnalysisRef = useRef(onAnalysis)
  onAnalysisRef.current = onAnalysis
  const seq = useRef(0)

  const apply = useCallback(
    (run: () => Promise<Awaited<ReturnType<typeof window.saga.getAnalysis>>>, silent: boolean) => {
      // atualização silenciosa nunca atropela um pedido em andamento
      if (silent && normalInFlight.current) return
      const mine = ++seq.current
      if (!silent) {
        normalInFlight.current = true
        setView({ kind: 'loading' })
        setNewMessage(false)
        current.current = null
        onAnalysisRef.current?.(null)
      }
      setBusy(true)
      run()
        .then((r) => {
          if (mine !== seq.current) return
          if (r.ok) {
            if (silent) {
              if (current.current?.lastMsgId === r.analysis.lastMsgId) return
              // chegou mensagem e o mentor está editando: não troca os cartões, só avisa
              if (hasDirtyDraft(draftsRef.current, jid)) {
                setNewMessage(true)
                return
              }
            }
            clearDrafts(draftsRef.current, jid)
            current.current = r.analysis
            setView({ kind: 'ready', analysis: r.analysis })
            onAnalysisRef.current?.(r.analysis)
          } else if (!silent || viewRef.current.kind === 'loading') {
            setView({ kind: 'error', code: r.code, message: r.message })
          }
        })
        .catch(() => {
          if (mine !== seq.current) return
          if (!silent || viewRef.current.kind === 'loading') setView({ kind: 'error', code: 'exception', message: GENERIC_ERROR })
        })
        .finally(() => {
          if (mine === seq.current) {
            setBusy(false)
            if (!silent) normalInFlight.current = false
          }
        })
    },
    [jid]
  )

  const load = useCallback(() => apply(() => window.saga.getAnalysis(jid), false), [apply, jid])

  /** chegou algo com a janela escondida (bandeja): atualizar uma vez quando ela voltar a aparecer */
  const staleWhileHidden = useRef(false)

  /**
   * Atualização silenciosa (mensagem ou transcrição nova). Nunca gera em segundo plano com a janela
   * escondida, e não gera quando a única novidade é a resposta do próprio mentor.
   */
  const silentRefresh = useCallback(async () => {
    if (!isVisible()) {
      staleWhileHidden.current = true
      return
    }
    staleWhileHidden.current = false
    const cur = current.current
    // análise feita com áudio pendente: a novidade pode ser a transcrição terminando, então deixa o serviço decidir
    if (cur && cur.pendingAudios === 0) {
      try {
        if (onlyOwnNewMessages(await window.saga.listMessages(jid), cur.lastMsgId)) return
      } catch {
        // sem a lista, segue: o serviço decide pelo cache
      }
    }
    apply(() => window.saga.getAnalysis(jid), true)
  }, [apply, jid])

  useEffect(() => {
    load()
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.saga.onMessages(jid, () => {
      clearTimeout(timer)
      timer = setTimeout(() => void silentRefresh(), REFRESH_DEBOUNCE_MS)
    })
    const onVisibility = () => {
      if (isVisible() && staleWhileHidden.current) void silentRefresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearTimeout(timer)
      off()
      document.removeEventListener('visibilitychange', onVisibility)
      staleWhileHidden.current = false
      seq.current++
      normalInFlight.current = false
    }
  }, [jid, load, silentRefresh])

  if (view.kind === 'loading') {
    return (
      <div className="sug-state" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        Gerando sugestões…
      </div>
    )
  }

  if (view.kind === 'error') {
    return (
      <div className="sug-state sug-error" role="alert">
        <p>{errorText(view.code, view.message)}</p>
        {(view.code === 'missing_key' || view.code === 'invalid_key' || view.code === 'model_unavailable') && onOpenSettings && (
          <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
            Abrir Configurações
          </button>
        )}
        {!NO_RETRY.has(view.code) && (
          <button type="button" className="btn btn-primary" onClick={load}>
            Tentar de novo
          </button>
        )}
      </div>
    )
  }

  const { analysis } = view
  return (
    <div className="sug-list">
      {newMessage && (
        <div className="sug-notice" role="status">
          Chegou mensagem nova — suas edições foram mantidas.{' '}
          <button type="button" className="link-btn" disabled={busy} onClick={() => apply(() => window.saga.regenerate(jid), false)}>
            Gerar novas
          </button>
        </div>
      )}
      {analysis.suggestions.map((text, i) => (
        <SuggestionCard
          // a chave inclui a geração: "Gerar novas" recomeça os cartões
          key={`${analysis.createdAt}-${analysis.lastMsgId}-${i}`}
          jid={jid}
          index={i}
          original={text}
          analysisLastMsgId={analysis.lastMsgId}
          drafts={drafts}
        />
      ))}
      <div className="sug-footer">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => apply(() => window.saga.regenerate(jid), false)}
        >
          Gerar novas
        </button>
        <span className="muted">Gerado por: {providerLabel(analysis.provider)}</span>
      </div>
    </div>
  )
}

function SuggestionCard({
  jid,
  index,
  original,
  analysisLastMsgId,
  drafts
}: {
  jid: string
  index: number
  original: string
  /** a análise que gerou esta sugestão: o contexto salvo na memória é o dela */
  analysisLastMsgId: string
  drafts: DraftStore
}) {
  const key = draftKey(jid, index)
  const [text, setText] = useState(() => {
    const d = drafts.get(key)
    return d && d.original === original ? d.text : original
  })
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const save = async () => {
    setFailed(null)
    try {
      await window.saga.saveReply({ jid, originalSuggestion: original, finalText: text, analysisLastMsgId })
      setSaved(true)
    } catch {
      setFailed('Não foi possível salvar. Tente de novo.')
    }
  }

  const copy = async () => {
    setFailed(null)
    try {
      await window.saga.copyToClipboard(text)
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), COPIED_MS)
    } catch {
      setFailed('Não foi possível copiar. Tente de novo.')
    }
  }

  const id = `sug-${index}`
  return (
    <div className="sug-card">
      <label htmlFor={id} className="sug-label">
        Sugestão {index + 1}
      </label>
      <textarea
        id={id}
        value={text}
        rows={5}
        onChange={(e) => {
          setText(e.target.value)
          drafts.set(key, { original, text: e.target.value })
          setSaved(false)
          setCopied(false)
        }}
      />
      {failed && (
        <p className="field-error" role="alert">
          {failed}
        </p>
      )}
      <div className="sug-actions">
        <button type="button" className={saved ? 'btn btn-done' : 'btn'} onClick={save} disabled={saved || !text.trim()}>
          {saved ? 'Salvo ✓' : 'Salvar'}
        </button>
        <button type="button" className={copied ? 'btn btn-done' : 'btn btn-primary'} onClick={copy}>
          {copied ? 'Copiado ✓' : 'Copiar'}
        </button>
      </div>
    </div>
  )
}
