/**
 * Busca geral (v0.3.1): procura a pergunta do mentor em todas as mensagens e transcrições e agrupa por conversa.
 * Tudo local (SQLite FTS5); nada sai do computador.
 */
import type { MessageRow, MessageSearchFilter, MessageSearchRow, Repo } from '../db/repo'
import {
  SEARCH_LIMITS,
  SEARCH_PERIOD_DAYS,
  type SearchFilters,
  type SearchGroup,
  type SearchHit,
  type SearchResult
} from '../../shared/search'
import { buildSnippet, isEmptyQuery, parseQuery, toFtsMatch, type ParsedQuery } from './query'

const DAY_MS = 86_400_000

/** O texto procurado da mensagem: o texto, ou a transcrição do áudio. */
export function bodyOf(m: MessageRow): string {
  return [m.text, m.transcript].filter((x): x is string => !!x && !!x.trim()).join(' ')
}

export function resolveFilters(f: SearchFilters, now: number): MessageSearchFilter {
  const days = SEARCH_PERIOD_DAYS[f.period ?? 'all']
  return {
    kind: f.kind ?? 'all',
    sinceTs: days === null ? null : now - days * DAY_MS,
    audioOnly: f.audioOnly === true,
    jid: f.jid ?? null
  }
}

export interface SearchRun {
  result: SearchResult
  /** todas as mensagens encontradas, a mais relevante primeiro (para o "Resumir com IA") */
  ranked: Array<SearchHit & { contactName: string }>
  parsed: ParsedQuery
}

function toHit(r: MessageSearchRow, p: ParsedQuery): SearchHit & { contactName: string } {
  const m = r.message
  const body = bodyOf(m)
  return {
    id: m.id,
    jid: m.jid,
    ts: m.ts,
    fromMe: m.fromMe,
    kind: m.kind,
    senderName: r.isGroup && !m.fromMe ? m.senderLabel : null,
    // sem texto (só o nome de quem mandou combinou): mostra o nome
    snippet: buildSnippet(body || (m.senderLabel ?? ''), p),
    contactName: r.contactName
  }
}

/**
 * Procura com todas as palavras; se nada aparecer, com qualquer uma delas. Conversas na ordem da mensagem mais
 * relevante; dentro de cada uma, as mais novas primeiro.
 */
export function runSearch(repo: Repo, query: string, filters: SearchFilters, now: number, perfNow: () => number = () => performance.now()): SearchRun {
  const t0 = perfNow()
  const parsed = parseQuery(query.slice(0, SEARCH_LIMITS.queryChars))
  const f = resolveFilters(filters, now)
  if (isEmptyQuery(parsed)) {
    return { result: { mode: 'empty', terms: [], total: 0, groups: [], tookMs: 0 }, ranked: [], parsed }
  }
  let mode: 'and' | 'or' = 'and'
  let match = toFtsMatch(parsed, 'and')
  let rows = repo.searchMessages(match, f, SEARCH_LIMITS.maxHits)
  const pieces = parsed.prefixes.length + parsed.phrases.length
  if (rows.length === 0 && pieces > 1) {
    mode = 'or'
    match = toFtsMatch(parsed, 'or')
    rows = repo.searchMessages(match, f, SEARCH_LIMITS.maxHits)
  }
  const counts = rows.length ? repo.searchCounts(match, f) : new Map<string, number>()
  const ranked = rows.map((r) => toHit(r, parsed))
  const groups = new Map<string, SearchGroup>()
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    let g = groups.get(r.message.jid)
    if (!g) {
      g = { jid: r.message.jid, name: r.contactName, isGroup: r.isGroup, count: counts.get(r.message.jid) ?? 0, hits: [] }
      groups.set(g.jid, g)
    }
    const { contactName: _, ...hit } = ranked[i]
    g.hits.push(hit)
  }
  const list = [...groups.values()]
  for (const g of list) {
    g.hits.sort((a, b) => b.ts - a.ts)
    g.hits = g.hits.slice(0, SEARCH_LIMITS.hitsPerGroup)
    g.count = Math.max(g.count, g.hits.length)
  }
  const total = list.reduce((n, g) => n + g.count, 0)
  return {
    result: { mode, terms: [...parsed.terms, ...parsed.phrases.map((p) => p.join(' '))], total, groups: list, tookMs: Math.round(perfNow() - t0) },
    ranked,
    parsed
  }
}
