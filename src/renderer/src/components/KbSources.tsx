import { useEffect, useRef, useState } from 'react'
import type { KbChunkView, KbSource } from '../../../shared/api'

/** "Arquivo › Seção" (sem o nome do pacote, que fica na dica e no visualizador). */
export const shortCrumb = (b: string): string => {
  const parts = b.split(' › ')
  return parts.length > 2 ? parts.slice(1).join(' › ') : b
}

/** "Baseado em: …": os trechos de conhecimento da base usados na sugestão; clicar abre o trecho. */
export function KbSources({ sources }: { sources: KbSource[] | undefined }) {
  const [open, setOpen] = useState<KbSource | null>(null)
  if (!sources?.length) return null
  return (
    <div className="kb-sources">
      <span className="kb-sources-label">Baseado em:</span>
      {sources.map((s) => (
        <button key={s.chunkId} type="button" className="kb-chip" title={s.breadcrumb} onClick={() => setOpen(s)}>
          <BookIcon />
          <span className="kb-chip-text">{shortCrumb(s.breadcrumb)}</span>
        </button>
      ))}
      {open && <KbChunkViewer source={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function BookIcon() {
  return (
    <svg className="kb-chip-icon" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2.5 2.5h4A2.5 2.5 0 0 1 9 5v8.5a2 2 0 0 0-2-2H2.5zM13.5 2.5h-2A2.5 2.5 0 0 0 9 5v8.5a2 2 0 0 1 2-2h2.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** O texto de um trecho da base, num diálogo pequeno (Esc ou "Fechar" fecham). */
export function KbChunkViewer({ source, onClose }: { source: KbSource; onClose: () => void }) {
  const [chunk, setChunk] = useState<KbChunkView | null | 'loading' | 'error'>('loading')
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let alive = true
    window.saga
      .kbGetChunk(source.chunkId)
      .then((c) => alive && setChunk(c))
      .catch(() => alive && setChunk('error'))
    closeRef.current?.focus()
    return () => {
      alive = false
    }
  }, [source.chunkId])

  const crumbs = (chunk && typeof chunk === 'object' ? chunk.breadcrumb : source.breadcrumb).split(' › ')
  return (
    <div className="overlay" onKeyDown={(e) => e.key === 'Escape' && onClose()} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog kb-viewer" role="dialog" aria-modal="true" aria-labelledby="kb-viewer-title">
        <p className="kb-viewer-path muted small">{crumbs.slice(0, -1).join(' › ')}</p>
        <h2 id="kb-viewer-title">{crumbs[crumbs.length - 1]}</h2>
        <div className="kb-viewer-body" tabIndex={0}>
          {chunk === 'loading' && <p className="muted">Carregando…</p>}
          {chunk === 'error' && <p className="field-error">Não foi possível abrir este trecho.</p>}
          {chunk === null && <p className="muted">Este trecho não está mais na base (o pacote foi reimportado ou removido).</p>}
          {chunk && typeof chunk === 'object' && <p className="kb-viewer-text">{chunk.text}</p>}
        </div>
        <p className="muted small">Trecho da sua base de conhecimento usado para escrever as sugestões. Só você vê isto.</p>
        <div className="dialog-actions">
          <button ref={closeRef} type="button" className="btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}
