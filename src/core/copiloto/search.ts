/**
 * Pesquisa pelo Copiloto (v0.9.0, contrato v1.3): o Copiloto pede (`search_pending`), o SagaZap procura no histórico
 * completo guardado aqui e responde (`search_result`). Só leitura do banco local; nunca toca no WhatsApp.
 *
 * - Escopo: as conversas do mentorado. Individuais cujo telefone (qualquer forma do 9º dígito) tem o hash num dos
 *   `phone_hashes`; grupos em que algum participante bate; e as conversas de `chat_keys`.
 * - Texto e transcrições, sem acento nem maiúscula (o índice da busca geral), dentro de `from..to`, mais recentes
 *   primeiro, no máximo 50, trecho de até 400 caracteres em volta do termo.
 * - Quem mandou: o mentor → `mentor`; mentorado (deste pedido ou da lista de mentorados) → `mentorado`; o resto →
 *   `outro`, com o nome exibido. Nunca telefone; nunca mídia.
 */
import { senderOf, type MessageRow, type Repo } from '../db/repo'
import { bodyOf } from '../search/search'
import { buildSnippet, isEmptyQuery, parseQuery, toFtsMatch } from '../search/query'
import { messageType } from './events'
import { chatKey, isRosterHash, phoneVariants, rosterHash } from './identity'

export const COPILOTO_SEARCH_LIMITS = {
  /** a cada 60 s enquanto a integração está ligada */
  pollEveryMs: 60_000,
  /** com eventos na fila (carga inicial), a consulta espera a vez deles, mas no máximo isto depois da anterior */
  maxPollDelayMs: 2 * 60_000,
  /** o servidor manda no máximo 10 por vez */
  perPoll: 10,
  queryChars: 200,
  maxResults: 50,
  excerptChars: 400,
  /** hashes e chaves por pedido (mais que isso é engano do servidor) */
  maxHashes: 40,
  maxChatKeys: 500,
  /** um pedido já respondido não é refeito se vier de novo neste tempo */
  keepAnsweredMs: 30 * 60_000
} as const

/** Um pedido já conferido. `invalid`: fora do contrato (responde `error` com o motivo curto). */
export interface PendingSearch {
  id: string
  phoneHashes: string[]
  chatKeys: string[]
  query: string
  /** epoch ms, inclusivo; null = sem limite */
  from: number | null
  to: number | null
  invalid: string | null
}

export interface SearchHitOut {
  chat: { key: string; kind: 'individual' | 'group'; name: string | null }
  sent_at: string
  from_mentor: boolean
  sender: 'mentor' | 'mentorado' | 'outro'
  sender_name: string | null
  message_type: 'text' | 'audio' | 'image' | 'document' | 'other'
  is_transcription: boolean
  excerpt: string
}

export interface SearchResultBody {
  version: 1
  action: 'search_result'
  id: string
  status: 'done' | 'error'
  results: SearchHitOut[]
  total_found: number
  truncated: boolean
  error: string | null
}

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/
const isHex64 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)

function isoOrNull(v: unknown): { ok: true; ms: number | null } | { ok: false } {
  if (v === null || v === undefined) return { ok: true, ms: null }
  if (typeof v !== 'string' || v.length > 40) return { ok: false }
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? { ok: true, ms } : { ok: false }
}

/** Um item de `searches`; null quando nem o id vale (não há como responder). */
export function parseSearch(v: unknown): PendingSearch | null {
  const s = v as { id?: unknown; target?: unknown; query?: unknown; from?: unknown; to?: unknown } | null
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !ID_RE.test(s.id)) return null
  const L = COPILOTO_SEARCH_LIMITS
  const out: PendingSearch = { id: s.id, phoneHashes: [], chatKeys: [], query: '', from: null, to: null, invalid: null }
  const t = s.target as { phone_hashes?: unknown; chat_keys?: unknown } | null
  const hashes = t && typeof t === 'object' && Array.isArray(t.phone_hashes) ? t.phone_hashes : null
  const keys = t && typeof t === 'object' ? (t.chat_keys === undefined || t.chat_keys === null ? [] : t.chat_keys) : null
  if (!hashes || !Array.isArray(keys) || hashes.length > L.maxHashes || keys.length > L.maxChatKeys) {
    out.invalid = 'alvo_invalido'
    return out
  }
  out.phoneHashes = [...new Set(hashes.filter(isRosterHash))]
  out.chatKeys = [...new Set(keys.filter(isHex64))]
  if (out.phoneHashes.length === 0 && out.chatKeys.length === 0) {
    out.invalid = 'alvo_invalido'
    return out
  }
  const q = typeof s.query === 'string' ? s.query.trim() : ''
  if (!q || [...q].length > L.queryChars) {
    out.invalid = 'consulta_invalida'
    return out
  }
  out.query = q
  const from = isoOrNull(s.from)
  const to = isoOrNull(s.to)
  if (!from.ok || !to.ok || (from.ms !== null && to.ms !== null && from.ms > to.ms)) {
    out.invalid = 'periodo_invalido'
    return out
  }
  out.from = from.ms
  out.to = to.ms
  return out
}

/** A resposta do `search_pending`. Envelope fora do contrato → null; `cancelled_ids` ausente ou fora do formato → []. */
export function parseSearchPending(body: unknown): { items: PendingSearch[]; cancelledIds: string[] } | null {
  const b = body as { version?: unknown; searches?: unknown; cancelled_ids?: unknown } | null
  if (!b || typeof b !== 'object' || b.version !== 1 || !Array.isArray(b.searches)) return null
  const items: PendingSearch[] = []
  const seen = new Set<string>()
  for (const raw of b.searches.slice(0, COPILOTO_SEARCH_LIMITS.perPoll * 2)) {
    const s = parseSearch(raw)
    if (!s || seen.has(s.id)) continue
    seen.add(s.id)
    items.push(s)
  }
  const cancelledIds = Array.isArray(b.cancelled_ids) ? b.cancelled_ids.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)).slice(0, 200) : []
  return { items, cancelledIds }
}

/** O telefone (normalizado) bate com algum dos hashes (qualquer forma do 9º dígito)? */
function hashed(phone: string | null, hashes: ReadonlySet<string>): boolean {
  return !!phone && phoneVariants(phone).some((p) => hashes.has(rosterHash(p)))
}

/**
 * As conversas do mentorado neste computador: individuais pelo telefone, grupos por algum participante, e as de
 * `chat_keys`. `phoneOf`: o telefone normalizado de um JID (telefone ou @lid já mapeado), ou null.
 */
export function resolveSearchChats(repo: Repo, s: Pick<PendingSearch, 'phoneHashes' | 'chatKeys'>, phoneOf: (jid: string) => string | null): string[] {
  const hashes = new Set(s.phoneHashes)
  const keys = new Set(s.chatKeys)
  const out = new Set<string>()
  for (const c of repo.copiloto.listChats()) {
    if (keys.has(chatKey(c.jid))) out.add(c.jid)
    else if (!c.isGroup && hashed(phoneOf(c.jid), hashes)) out.add(c.jid)
  }
  if (hashes.size > 0) {
    for (const g of repo.copiloto.groupJids()) {
      if (out.has(g)) continue
      if (repo.copiloto.groupParticipants(g).some((p) => hashed(phoneOf(p), hashes))) out.add(g)
    }
  }
  return [...out]
}

/** Nome que parece telefone (só dígitos e pontuação) nunca sai. */
const looksLikePhone = (s: string): boolean => /^[\d\s()+\-.]+$/.test(s)
const safeName = (s: string | null | undefined): string | null => {
  const t = s?.trim()
  return t && !looksLikePhone(t) ? [...t].slice(0, 100).join('') : null
}

/** O trecho em volta do termo, com "…" onde foi cortado, até 400 caracteres. */
function excerptOf(m: MessageRow, parsed: ReturnType<typeof parseQuery>): string {
  const max = COPILOTO_SEARCH_LIMITS.excerptChars
  const sn = buildSnippet(bodyOf(m), parsed, max - 2)
  const text = `${sn.cutStart ? '…' : ''}${sn.text}${sn.cutEnd ? '…' : ''}`
  return [...text].slice(0, max).join('')
}

export interface SearchContext {
  /** o telefone normalizado de um JID, ou null */
  phoneOf: (jid: string) => string | null
  /** hashes da lista de mentorados (vazio se ainda não chegou) */
  roster: ReadonlySet<string>
}

/**
 * Roda um pedido: as conversas, a busca (todas as palavras; sem nada, qualquer uma) e o corpo do `search_result`.
 * Pedido fora do contrato ou erro local → `status: 'error'` com um motivo curto (nunca o texto procurado).
 */
export function runCopilotoSearch(repo: Repo, s: PendingSearch, ctx: SearchContext): SearchResultBody {
  const base = { version: 1 as const, action: 'search_result' as const, id: s.id }
  if (s.invalid) return { ...base, status: 'error', results: [], total_found: 0, truncated: false, error: s.invalid }
  try {
    const jids = resolveSearchChats(repo, s, ctx.phoneOf)
    const parsed = parseQuery(s.query.slice(0, COPILOTO_SEARCH_LIMITS.queryChars))
    if (jids.length === 0 || isEmptyQuery(parsed)) return { ...base, status: 'done', results: [], total_found: 0, truncated: false, error: null }
    const L = COPILOTO_SEARCH_LIMITS
    let found = repo.searchInChats(toFtsMatch(parsed, 'and'), jids, s.from, s.to, L.maxResults)
    if (found.total === 0 && parsed.prefixes.length + parsed.phrases.length > 1) found = repo.searchInChats(toFtsMatch(parsed, 'or'), jids, s.from, s.to, L.maxResults)
    const target = new Set(s.phoneHashes)
    const isMentee = (phone: string | null) => hashed(phone, target) || hashed(phone, ctx.roster)
    const chats = new Map<string, SearchHitOut['chat']>()
    const chatOf = (jid: string): SearchHitOut['chat'] => {
      let c = chats.get(jid)
      if (!c) {
        const isGroup = jid.endsWith('@g.us')
        c = { key: chatKey(jid), kind: isGroup ? 'group' : 'individual', name: safeName(repo.copiloto.rawName(jid)) }
        chats.set(jid, c)
      }
      return c
    }
    const results = found.rows.map((m): SearchHitOut => {
      const chat = chatOf(m.jid)
      let sender: SearchHitOut['sender'] = 'outro'
      let senderName: string | null = null
      if (m.fromMe) sender = 'mentor'
      else if (chat.kind === 'individual') {
        sender = isMentee(ctx.phoneOf(m.jid)) ? 'mentorado' : 'outro'
        senderName = chat.name
      } else {
        // v0.10.1: o telefone de quem mandou quando conhecido (o @lid sozinho nunca casa com o roster)
        const who = senderOf(m)
        sender = who && isMentee(ctx.phoneOf(who)) ? 'mentorado' : 'outro'
        senderName = safeName(who ? repo.copiloto.rawName(who) : null) ?? safeName(m.senderName)
      }
      return {
        chat,
        sent_at: new Date(m.ts).toISOString(),
        from_mentor: m.fromMe,
        sender,
        sender_name: senderName,
        message_type: messageType(m),
        is_transcription: m.kind === 'audio' && m.transcriptStatus === 'done' && !!m.transcript,
        excerpt: excerptOf(m, parsed)
      }
    })
    return { ...base, status: 'done', results, total_found: found.total, truncated: found.total > results.length, error: null }
  } catch {
    return { ...base, status: 'error', results: [], total_found: 0, truncated: false, error: 'falha_local' }
  }
}
