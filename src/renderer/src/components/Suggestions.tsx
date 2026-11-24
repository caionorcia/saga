import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiErrorCode, Analysis } from '../../../shared/api'

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

interface Props {
  jid: string
  /** avisa o resumo ("O que a pessoa quer") sempre que a análise mudar */
  onAnalysis?: (analysis: Analysis | null) => void
}

export function Suggestions({ jid, onAnalysis }: Props) {
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const current = useRef<Analysis | null>(null)
  const onAnalysisRef = useRef(onAnalysis)
  onAnalysisRef.current = onAnalysis
  const seq = useRef(0)

  const apply = useCallback(
    (run: () => Promise<Awaited<ReturnType<typeof window.saga.getAnalysis>>>, silent: boolean) => {
      const mine = ++seq.current
      if (!silent) {
        setView({ kind: 'loading' })
        current.current = null
        onAnalysisRef.current?.(null)
      }
      setBusy(true)
      run()
        .then((r) => {
          if (mine !== seq.current) return
          if (r.ok) {
            // atualização silenciosa (chegou mensagem): não apaga o que o mentor está editando
            // se a conversa não mudou para a IA
            if (silent && current.current?.lastMsgId === r.analysis.lastMsgId) return
            current.current = r.analysis
            setView({ kind: 'ready', analysis: r.analysis })
            onAnalysisRef.current?.(r.analysis)
          } else if (!silent) {
            setView({ kind: 'error', code: r.code, message: r.message })
          }
        })
        .catch(() => {
          if (mine !== seq.current || silent) return
          setView({ kind: 'error', code: 'exception', message: GENERIC_ERROR })
        })
        .finally(() => {
          if (mine === seq.current) setBusy(false)
        })
    },
    []
  )

  const load = useCallback(() => apply(() => window.saga.getAnalysis(jid), false), [apply, jid])

  useEffect(() => {
    load()
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.saga.onMessages(jid, () => {
      clearTimeout(timer)
      timer = setTimeout(() => apply(() => window.saga.getAnalysis(jid), true), REFRESH_DEBOUNCE_MS)
    })
    return () => {
      clearTimeout(timer)
      off()
      seq.current++
    }
  }, [jid, load, apply])

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
      {analysis.suggestions.map((text, i) => (
        <SuggestionCard
          // a chave inclui a geração: "Gerar novas" recomeça os cartões
          key={`${analysis.createdAt}-${analysis.lastMsgId}-${i}`}
          jid={jid}
          index={i}
          original={text}
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

function SuggestionCard({ jid, index, original }: { jid: string; index: number; original: string }) {
  const [text, setText] = useState(original)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const save = async () => {
    setFailed(null)
    try {
      await window.saga.saveReply({ jid, originalSuggestion: original, finalText: text })
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
        <button type="button" className={saved ? 'btn btn-done' : 'btn'} onClick={save} disabled={!text.trim()}>
          {saved ? 'Salvo ✓' : 'Salvar'}
        </button>
        <button type="button" className={copied ? 'btn btn-done' : 'btn btn-primary'} onClick={copy}>
          {copied ? 'Copiado ✓' : 'Copiar'}
        </button>
      </div>
    </div>
  )
}
