/**
 * Follow-up do Copiloto (v0.7.0, contrato v1.1): leitura da fila que o Copiloto manda (`followups_pending`), a conversa
 * local de cada follow-up e o corpo do `followup_update`. Puro, sem banco nem rede.
 *
 * - Individual: a conversa cujo telefone (qualquer das formas do 9º dígito) tem o hash num dos `phone_hashes`.
 * - Grupo: a conversa cujo `chat.key` (`sha256hex("sagazap-chat-v1:" + jid)`) é o `chat_key`.
 * - Nunca há telefone em claro do lado do Copiloto: só hashes vêm e vão.
 */
import { DRAFT_ID_RE } from '../../shared/send'
import { FOLLOWUP_LIMITS, type FollowupStatus } from '../../shared/copiloto'
import { chatKey, isRosterHash, phoneVariants, rosterHash } from './identity'

export type FollowupTarget = { kind: 'individual'; phone_hashes: string[] } | { kind: 'group'; chat_key: string }

/** Um follow-up já conferido. */
export interface PendingFollowup {
  id: string
  target: FollowupTarget
  text: string
  author: string | null
  /** epoch ms */
  createdAt: number
  /**
   * v1.2: o Copiloto marcou para envio automático (só quando o autor é administrador). Só vale com a opção "Enviar
   * follow-ups do Copiloto automaticamente" ligada; ausente ou outro valor que não `true` = `false`.
   */
  autoSend: boolean
}

/** Hashes de telefone por follow-up: as duas formas de cada número (mais que isso é engano do servidor). */
const MAX_HASHES = 20

function parseTarget(v: unknown): FollowupTarget | null {
  const t = v as { kind?: unknown; phone_hashes?: unknown; chat_key?: unknown } | null
  if (!t || typeof t !== 'object') return null
  if (t.kind === 'individual') {
    if (!Array.isArray(t.phone_hashes) || t.phone_hashes.length === 0 || t.phone_hashes.length > MAX_HASHES) return null
    if (!t.phone_hashes.every(isRosterHash)) return null
    return { kind: 'individual', phone_hashes: [...new Set(t.phone_hashes as string[])] }
  }
  if (t.kind === 'group') return isRosterHash(t.chat_key) ? { kind: 'group', chat_key: t.chat_key } : null
  return null
}

/** Um item da fila; null se fora do contrato (fica de fora, sem quebrar os outros). */
export function parseFollowup(v: unknown): PendingFollowup | null {
  const f = v as { id?: unknown; target?: unknown; text?: unknown; author?: unknown; created_at?: unknown; auto_send?: unknown } | null
  if (!f || typeof f !== 'object') return null
  // o id vira o id do rascunho da mensagem avulsa: precisa caber no formato dele (o uuid do Copiloto cabe)
  if (typeof f.id !== 'string' || !DRAFT_ID_RE.test(f.id)) return null
  const target = parseTarget(f.target)
  if (!target) return null
  if (typeof f.text !== 'string') return null
  const text = f.text.trim()
  if (!text || [...text].length > FOLLOWUP_LIMITS.textChars) return null
  if (f.author !== null && f.author !== undefined && typeof f.author !== 'string') return null
  const author = typeof f.author === 'string' && f.author.trim() ? [...f.author.trim()].slice(0, FOLLOWUP_LIMITS.authorChars).join('') : null
  if (typeof f.created_at !== 'string') return null
  const createdAt = Date.parse(f.created_at)
  if (!Number.isFinite(createdAt)) return null
  return { id: f.id, target, text, author, createdAt, autoSend: f.auto_send === true }
}

/**
 * A resposta do `followups_pending`: `{ version: 1, followups: [...] }`. Envelope fora do contrato → null; itens fora
 * do contrato ficam de fora (contados em `invalid`). Ids repetidos na mesma resposta: vale o primeiro.
 */
export function parsePending(body: unknown): { items: PendingFollowup[]; invalid: number } | null {
  const b = body as { version?: unknown; followups?: unknown } | null
  if (!b || typeof b !== 'object' || b.version !== 1 || !Array.isArray(b.followups)) return null
  const items: PendingFollowup[] = []
  const seen = new Set<string>()
  let invalid = 0
  // o servidor manda no máximo 50; mais que isso, o resto vem na próxima busca
  for (const raw of b.followups.slice(0, FOLLOWUP_LIMITS.pendingMax * 2)) {
    const f = parseFollowup(raw)
    if (!f) {
      invalid++
      continue
    }
    if (seen.has(f.id)) continue
    seen.add(f.id)
    items.push(f)
  }
  return { items, invalid }
}

/** Uma conversa local candidata (o mínimo para casar o alvo). */
export interface LocalChat {
  jid: string
  isGroup: boolean
  /** a mensagem mais nova (para escolher entre duas conversas da mesma pessoa, ex.: telefone e @lid) */
  lastTs: number | null
}

/**
 * A conversa local do alvo, ou null. `phoneOf` dá o telefone normalizado de uma conversa individual (o próprio JID ou
 * o telefone conhecido de um @lid). Mais de uma conversa casando (a mesma pessoa por telefone e por @lid): a de
 * mensagem mais recente.
 */
export function resolveTarget(target: FollowupTarget, chats: ReadonlyArray<LocalChat>, phoneOf: (jid: string) => string | null): string | null {
  if (target.kind === 'group') {
    for (const c of chats) if (c.isGroup && chatKey(c.jid) === target.chat_key) return c.jid
    return null
  }
  const wanted = new Set(target.phone_hashes)
  let best: LocalChat | null = null
  for (const c of chats) {
    if (c.isGroup) continue
    const phone = phoneOf(c.jid)
    if (!phone || !phoneVariants(phone).some((p) => wanted.has(rosterHash(p)))) continue
    if (!best || (c.lastTs ?? -Infinity) > (best.lastTs ?? -Infinity)) best = c
  }
  return best?.jid ?? null
}

/** Um item do `followup_update`. */
export interface FollowupUpdate {
  id: string
  status: 'sent' | 'declined' | 'failed'
  final_text: string | null
  sent_at: string | null
  reason: string | null
}

/** Os estados locais que viram atualização para o Copiloto. */
export const REPORTABLE: ReadonlySet<FollowupStatus> = new Set(['sent', 'declined', 'failed'])

/** Resultados do `followup_update` que o SagaZap conhece; outro texto conta como concluído (200 = recebido). */
export type UpdateResult = 'updated' | 'duplicate' | 'cancelled' | 'invalid'

/** Motivo curto, só o que cabe no contrato (≤ 200 caracteres, uma linha). */
export function shortReason(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  const t = text.replace(/\s+/g, ' ').trim()
  return t ? [...t].slice(0, FOLLOWUP_LIMITS.reasonChars).join('') : null
}
