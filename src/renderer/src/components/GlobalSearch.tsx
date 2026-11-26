import { forwardRef, useEffect, useRef, useState } from 'react'
import type { Contact, SearchFilters, SearchResult, SearchSummaryResult } from '../../../shared/api'
import type { SearchHit, SearchKind, SearchPeriod, SearchSnippet } from '../../../shared/search'
import { formatDay, formatTime, sameDay } from '../format'
import { GroupIcon } from './GroupIcon'

/** Busca geral (v0.3.1): "Procurar em todas as conversas e transcrições". */

/** espera depois de parar de digitar, antes de procurar */
export const SEARCH_DEBOUNCE_MS = 450
/** com menos que isso (sem contar espaços), espera o Enter */
const MIN_CHARS = 3

export function MagnifierIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M10.6 10.6 14 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

interface BoxProps {
  value: string
  onChange: (v: string) => void
  /** procurar já (Enter) ou depois da pausa ao digitar */
  onSubmit: (q: string) => void
  onClear: () => void
  active: boolean
}

/** Caixa "Procurar nas mensagens" com a lupa; Enter procura já, Esc limpa. */
export const SearchBox = forwardRef<HTMLInputElement, BoxProps>(function SearchBox({ value, onChange, onSubmit, onClear, active }, ref) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const change = (v: string) => {
    onChange(v)
    clearTimeout(timer.current)
    if (!v.trim()) {
      onClear()
      return
    }
    if (v.replace(/\s/g, '').length >= MIN_CHARS) timer.current = setTimeout(() => onSubmit(v), SEARCH_DEBOUNCE_MS)
  }
  return (
    <form
      className={`gsearch${active ? ' is-active' : ''}`}
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        clearTimeout(timer.current)
        if (value.trim()) onSubmit(value)
      }}
    >
      <label htmlFor="gsearch" className="sr-only">
        Procurar em todas as conversas e transcrições
      </label>
      <span className="gsearch-icon" aria-hidden="true">
        <MagnifierIcon />
      </span>
      <input
        id="gsearch"
        ref={ref}
        type="text"
        autoComplete="off"
        spellCheck={false}
        maxLength={200}
        placeholder="Procurar nas mensagens (ex.: quem falou de preço?)"
        title="Procura em todas as conversas e transcrições dos áudios (Ctrl+F ou Ctrl+K)"
        value={value}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && (value || active)) {
            e.preventDefault()
            clearTimeout(timer.current)
            onClear()
          }
        }}
      />
      {(value || active) && (
        <button
          type="button"
          className="link-btn gsearch-clear"
          onClick={() => {
            clearTimeout(timer.current)
            onClear()
          }}
        >
          Limpar
        </button>
      )}
    </form>
  )
})

/** Trecho com as palavras encontradas em <mark>: monta pelos intervalos, nunca por HTML. */
export function Highlighted({ snippet }: { snippet: SearchSnippet }) {
  const parts: React.ReactNode[] = []
  let at = 0
  snippet.ranges.forEach(([s, e], i) => {
    if (s < at || e <= s || e > snippet.text.length) return
    if (s > at) parts.push(snippet.text.slice(at, s))
    parts.push(<mark key={i}>{snippet.text.slice(s, e)}</mark>)
    at = e
  })
  if (at < snippet.text.length) parts.push(snippet.text.slice(at))
  return (
    <span className="gs-snippet">
      {snippet.cutStart && '…'}
      {parts}
      {snippet.cutEnd && '…'}
    </span>
  )
}

const PERIODS: ReadonlyArray<{ value: SearchPeriod; label: string }> = [
  { value: 'all', label: 'Todo o período' },
  { value: '30d', label: 'Últimos 30 dias' },
  { value: '7d', label: 'Últimos 7 dias' }
]
const KINDS: ReadonlyArray<{ value: SearchKind; label: string }> = [
  { value: 'all', label: 'Todos' },
  { value: 'individual', label: 'Individuais' },
  { value: 'group', label: 'Grupos' }
]

const when = (ts: number) => (sameDay(ts, Date.now()) ? `hoje, ${formatTime(ts)}` : `${formatDay(ts)}, ${formatTime(ts)}`)
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

interface ResultsProps {
  query: string
  onOpenHit: (jid: string, msgId: string) => void
  onOpenChat: (jid: string) => void
}

type Load = { status: 'loading' } | { status: 'done'; result: SearchResult } | { status: 'error' }
type Summary = { status: 'idle' } | { status: 'loading' } | { status: 'done'; result: SearchSummaryResult }

/** Resultados no lugar da lista: por conversa, com filtros e o "Resumir com IA" opcional. */
export function SearchResults({ query, onOpenHit, onOpenChat }: ResultsProps) {
  /** para o filtro "conversa": todas, de qualquer tipo */
  const [contacts, setContacts] = useState<Contact[]>([])
  useEffect(() => {
    let alive = true
    window.saga
      .listContacts(false, 'all')
      .then((l) => alive && setContacts(l))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const [kind, setKind] = useState<SearchKind>('all')
  const [period, setPeriod] = useState<SearchPeriod>('all')
  const [audioOnly, setAudioOnly] = useState(false)
  const [jid, setJid] = useState<string>('')
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [summary, setSummary] = useState<Summary>({ status: 'idle' })
  const seq = useRef(0)
  const filters: SearchFilters = { kind, period, audioOnly, jid: jid || null }
  const fkey = JSON.stringify([query, filters])

  useEffect(() => {
    const mine = ++seq.current
    setLoad({ status: 'loading' })
    setSummary({ status: 'idle' })
    window.saga
      .searchMessages(query, filters)
      .then((result) => mine === seq.current && setLoad({ status: 'done', result }))
      .catch(() => mine === seq.current && setLoad({ status: 'error' }))
  }, [fkey])

  const summarize = () => {
    const mine = seq.current
    setSummary({ status: 'loading' })
    window.saga
      .summarizeSearch(query, filters)
      .then((result) => mine === seq.current && setSummary({ status: 'done', result }))
      .catch(
        () =>
          mine === seq.current &&
          setSummary({ status: 'done', result: { ok: false, code: 'unknown', message: 'Não foi possível resumir agora. Tente de novo.' } })
      )
  }

  const r = load.status === 'done' ? load.result : null
  const filtered = kind !== 'all' || period !== 'all' || audioOnly || !!jid
  return (
    <section className="gs-results" aria-label="Resultados da busca">
      <div className="gs-filters">
        <div className="kind-filter" role="radiogroup" aria-label="Procurar em">
          {KINDS.map((k) => (
            <button key={k.value} type="button" role="radio" aria-checked={kind === k.value} className={kind === k.value ? 'is-active' : undefined} onClick={() => setKind(k.value)}>
              {k.label}
            </button>
          ))}
        </div>
        <div className="gs-filter-row">
          <label className="sr-only" htmlFor="gs-period">
            Período
          </label>
          <select id="gs-period" value={period} onChange={(e) => setPeriod(e.target.value as SearchPeriod)}>
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <label className="check gs-audio">
            <input type="checkbox" checked={audioOnly} onChange={(e) => setAudioOnly(e.target.checked)} />
            Só áudios
          </label>
        </div>
        <label className="sr-only" htmlFor="gs-chat">
          Conversa
        </label>
        <select id="gs-chat" value={jid} onChange={(e) => setJid(e.target.value)}>
          <option value="">Todas as conversas</option>
          {[...contacts]
            .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'))
            .map((c) => (
              <option key={c.jid} value={c.jid}>
                {c.displayName}
              </option>
            ))}
        </select>
      </div>

      <div className="gs-body" aria-live="polite">
        {load.status === 'loading' && <p className="empty">Procurando…</p>}
        {load.status === 'error' && <p className="empty">Não foi possível procurar agora. Tente de novo.</p>}
        {r && r.mode === 'empty' && (
          <div className="gs-empty">
            <p>
              <strong>Escreva o assunto que você procura.</strong>
            </p>
            <p className="muted small">Por exemplo: preço, contrato, reunião, pró-labore. Palavras como “quem”, “falou” e “sobre” são ignoradas.</p>
          </div>
        )}
        {r && r.mode !== 'empty' && r.total === 0 && (
          <div className="gs-empty">
            <p>
              <strong>Nenhum resultado</strong>
            </p>
            <ul className="muted small">
              <li>Tente uma palavra parecida ou mais curta (ex.: “preço” em vez de “precificação”).</li>
              {filtered && <li>Tire os filtros (período, só áudios, conversa).</li>}
              <li>Use aspas para uma frase exata: “plano de ação”.</li>
              <li>Áudios ainda sendo transcritos aparecem depois.</li>
            </ul>
          </div>
        )}
        {r && r.total > 0 && (
          <>
            <div className="gs-summary-row">
              <p className="small muted gs-count">
                {plural(r.total, 'mensagem', 'mensagens')} em {plural(r.groups.length, 'conversa', 'conversas')}
              </p>
              <button type="button" className="btn btn-small gs-ai-btn" disabled={summary.status === 'loading'} onClick={summarize} title="Manda até 30 trechos encontrados para a IA das sugestões e mostra uma resposta curta (conta no teto diário de gasto)">
                {summary.status === 'loading' ? 'Resumindo…' : 'Resumir com IA'}
              </button>
            </div>
            {r.mode === 'or' && <p className="small gs-or-note">Nenhuma mensagem tinha todas as palavras; mostrando as que têm alguma delas.</p>}
            {summary.status !== 'idle' && <SummaryCard summary={summary} onOpenChat={onOpenChat} />}
            <ul className="gs-groups">
              {r.groups.map((g) => (
                <li key={g.jid} className="gs-group">
                  <button type="button" className="gs-group-head" title="Abrir a conversa" onClick={() => onOpenChat(g.jid)}>
                    {g.isGroup && (
                      <span className="gs-group-icon" aria-hidden="true">
                        <GroupIcon />
                      </span>
                    )}
                    {g.isGroup && <span className="sr-only">Grupo: </span>}
                    <span className="gs-group-name">{g.name}</span>
                    <span className="view-count" aria-label={plural(g.count, 'mensagem', 'mensagens')}>
                      {g.count}
                    </span>
                  </button>
                  <ul className="gs-hits">
                    {g.hits.map((h) => (
                      <li key={h.id}>
                        <HitButton hit={h} isGroup={g.isGroup} onOpen={() => onOpenHit(g.jid, h.id)} />
                      </li>
                    ))}
                    {g.count > g.hits.length && <li className="muted small gs-more">e mais {g.count - g.hits.length} nesta conversa</li>}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}

function HitButton({ hit, isGroup, onOpen }: { hit: SearchHit; isGroup: boolean; onOpen: () => void }) {
  const who = hit.fromMe ? 'Você' : isGroup ? (hit.senderName ?? 'Participante') : null
  return (
    <button type="button" className="gs-hit" onClick={onOpen} title="Abrir a conversa nesta mensagem">
      <span className="gs-hit-meta">
        {who && <span className="gs-hit-who">{who}</span>}
        {hit.kind === 'audio' && <span className="gs-hit-audio">áudio</span>}
        <time>{when(hit.ts)}</time>
      </span>
      <Highlighted snippet={hit.snippet} />
    </button>
  )
}

function SummaryCard({ summary, onOpenChat }: { summary: Exclude<Summary, { status: 'idle' }>; onOpenChat: (jid: string) => void }) {
  if (summary.status === 'loading') {
    return (
      <div className="gs-ai" role="status">
        <span className="spinner" aria-hidden="true" /> Pedindo um resumo à IA…
      </div>
    )
  }
  const r = summary.result
  if (!r.ok) {
    return (
      <div className="gs-ai gs-ai-error" role="alert">
        {r.code === 'budget_exceeded' ? 'Limite de gasto diário atingido. Aumente o teto em Configurações para usar a IA.' : r.message}
      </div>
    )
  }
  return (
    <div className="gs-ai">
      <p className="gs-ai-title">Resumo da IA</p>
      <p className="gs-ai-answer">{r.answer}</p>
      {r.refs.length > 0 && (
        <p className="small gs-ai-refs">
          Conversas:{' '}
          {r.refs.map((ref, i) => (
            <span key={ref.jid}>
              {i > 0 && ', '}
              <button type="button" className="link-btn" onClick={() => onOpenChat(ref.jid)}>
                {ref.name}
              </button>
            </span>
          ))}
        </p>
      )}
      <p className="muted small">Feito com {r.used === 1 ? '1 trecho' : `${r.used} trechos`} encontrados. Confira nas mensagens.</p>
    </div>
  )
}
