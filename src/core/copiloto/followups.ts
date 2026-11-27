/**
 * Follow-up do Copiloto (v0.7.0, contrato v1.1): leitura da fila que o Copiloto manda (`followups_pending`), a conversa
 * local de cada follow-up e o corpo do `followup_update`. Puro, sem banco nem rede.
 *
 * - Individual: a conversa cujo telefone (qualquer das formas do 9º dígito) tem o hash num dos `phone_hashes`.
 * - Grupo: a conversa cujo `chat.key` (`sha256hex("sagazap-chat-v1:" + jid)`) é o `chat_key`.
 * - Nunca há telefone em claro do lado do Copiloto: só hashes vêm e vão.
 */
import { DRAFT_ID_RE } from '../../shared/send'
import { CONVO_LIMITS, FOLLOWUP_LIMITS, type ConvoGoal, type ConvoType, type FollowupStatus } from '../../shared/copiloto'
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

/**
 * v0.10.0 (contrato v2): um follow-up de conversa (onboarding ou sumido): sem texto pronto; a IA conduz a conversa no
 * grupo do mentorado rumo ao objetivo (`goal`), e o mentor confirma cada mensagem.
 */
export interface PendingConvo {
  id: string
  type: ConvoType
  target: { kind: 'group'; chat_key: string }
  author: string | null
  /** epoch ms */
  createdAt: number
  goal: ConvoGoal
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

function parseAuthor(v: unknown): { ok: boolean; author: string | null } {
  if (v !== null && v !== undefined && typeof v !== 'string') return { ok: false, author: null }
  return { ok: true, author: typeof v === 'string' && v.trim() ? [...v.trim()].slice(0, FOLLOWUP_LIMITS.authorChars).join('') : null }
}

/** Um item da fila; null se fora do contrato (fica de fora, sem quebrar os outros). Só o avulso (v1.1 e v2). */
export function parseFollowup(v: unknown): PendingFollowup | null {
  const f = v as { id?: unknown; target?: unknown; text?: unknown; author?: unknown; created_at?: unknown; auto_send?: unknown; type?: unknown } | null
  if (!f || typeof f !== 'object') return null
  if (f.type !== undefined && f.type !== 'avulso') return null
  // o id vira o id do rascunho da mensagem avulsa: precisa caber no formato dele (o uuid do Copiloto cabe)
  if (typeof f.id !== 'string' || !DRAFT_ID_RE.test(f.id)) return null
  const target = parseTarget(f.target)
  if (!target) return null
  if (typeof f.text !== 'string') return null
  const text = f.text.trim()
  if (!text || [...text].length > FOLLOWUP_LIMITS.textChars) return null
  const a = parseAuthor(f.author)
  if (!a.ok) return null
  if (typeof f.created_at !== 'string') return null
  const createdAt = Date.parse(f.created_at)
  if (!Number.isFinite(createdAt)) return null
  // v2: avulso pode vir sem `auto_send` → false (só `true` liga)
  return { id: f.id, target, text, author: a.author, createdAt, autoSend: f.auto_send === true }
}

/** Texto curto de uma linha (pendência, observação), cortado no limite; vazio → null. */
function oneText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? [...t].slice(0, max).join('') : null
}

/** O link da agenda: só https, sem usuário/senha, até 500 caracteres. */
export function parseLink(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string' || v.length > CONVO_LIMITS.linkChars) return undefined
  try {
    const u = new URL(v.trim())
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return undefined
    return v.trim()
  } catch {
    return undefined
  }
}

/** O `goal` do onboarding/sumido; null se fora do contrato (a cadência é obrigatória e vale como veio). */
export function parseGoal(v: unknown, type: ConvoType): ConvoGoal | null {
  const g = v as { pending_items?: unknown; scheduling_link?: unknown; note?: unknown; cadence_days?: unknown; send_mode?: unknown; guidelines?: unknown; end_day?: unknown; meeting?: unknown; meetings?: unknown } | null
  if (!g || typeof g !== 'object' || Array.isArray(g)) return null
  let pendingItems: string[] = []
  if (g.pending_items !== undefined && g.pending_items !== null) {
    if (!Array.isArray(g.pending_items) || g.pending_items.length > CONVO_LIMITS.itemsMax) return null
    const items = g.pending_items.map((x) => oneText(x, CONVO_LIMITS.itemChars))
    if (items.some((x) => x === null)) return null
    pendingItems = [...new Set(items as string[])]
  }
  // sumido: sem pendências (o objetivo é a reunião)
  if (type === 'sumido') pendingItems = []
  const link = parseLink(g.scheduling_link)
  if (link === undefined) return null
  if (g.note !== undefined && g.note !== null && typeof g.note !== 'string') return null
  const note = oneText(g.note, CONVO_LIMITS.noteChars)
  // v2.1: a cadência é exatamente a que vier (sem padrão): crescente, sem repetir, inteiros de 0 a 365, até 30
  const c = g.cadence_days
  if (!Array.isArray(c) || c.length === 0 || c.length > CONVO_LIMITS.cadenceMax) return null
  if (!c.every((d, i) => Number.isInteger(d) && d >= 0 && d <= CONVO_LIMITS.cadenceDayMax && (i === 0 || d > (c[i - 1] as number)))) return null
  const cadenceDays = c as number[]
  // "auto" é para depois: por enquanto cada mensagem espera a confirmação (o valor fica guardado só para contar)
  const sendMode = g.send_mode === 'auto' ? 'auto' : 'confirm'
  // v2.1: diretrizes do dono (texto livre, até 4000 caracteres), dia de encerrar, reunião a marcar e reuniões com link
  if (g.guidelines !== undefined && g.guidelines !== null && typeof g.guidelines !== 'string') return null
  const gl = typeof g.guidelines === 'string' ? g.guidelines.trim() : ''
  const guidelines = gl ? [...gl].slice(0, CONVO_LIMITS.guidelinesChars).join('') : null
  let endDay: number | null = null
  if (g.end_day !== undefined && g.end_day !== null) {
    if (!Number.isInteger(g.end_day) || (g.end_day as number) < 0 || (g.end_day as number) > CONVO_LIMITS.cadenceDayMax) return null
    endDay = g.end_day as number
  }
  const person = (v: unknown): { ok: boolean; v: string | null } =>
    v === undefined || v === null ? { ok: true, v: null } : typeof v === 'string' ? { ok: true, v: oneText(v, CONVO_LIMITS.nameChars) } : { ok: false, v: null }
  let meeting: ConvoGoal['meeting'] = null
  if (g.meeting !== undefined && g.meeting !== null) {
    const m = g.meeting as { name?: unknown; mentor?: unknown }
    const name = oneText(m?.name, CONVO_LIMITS.nameChars)
    const mentor = person(m?.mentor)
    if (typeof m !== 'object' || !name || !mentor.ok) return null
    meeting = { name, mentor: mentor.v }
  }
  const meetings: ConvoGoal['meetings'] = []
  if (g.meetings !== undefined && g.meetings !== null) {
    if (!Array.isArray(g.meetings) || g.meetings.length > CONVO_LIMITS.meetingsMax) return null
    for (const raw of g.meetings) {
      const m = raw as { name?: unknown; mentor?: unknown; link?: unknown } | null
      const name = oneText(m?.name, CONVO_LIMITS.nameChars)
      const mentor = person(m?.mentor)
      const mlink = parseLink(m?.link)
      if (!m || typeof m !== 'object' || !name || !mentor.ok || !mlink) return null
      meetings.push({ name, mentor: mentor.v, link: mlink })
    }
  }
  return { pendingItems, schedulingLink: link, note, cadenceDays, sendMode, guidelines, endDay, meeting, meetings }
}

/** Um onboarding/sumido da fila v2; null se fora do contrato. Sempre no grupo do mentorado. */
export function parseConvo(v: unknown): PendingConvo | null {
  const f = v as { id?: unknown; type?: unknown; target?: unknown; text?: unknown; author?: unknown; created_at?: unknown; goal?: unknown } | null
  if (!f || typeof f !== 'object') return null
  if (f.type !== 'onboarding' && f.type !== 'sumido') return null
  if (typeof f.id !== 'string' || !DRAFT_ID_RE.test(f.id)) return null
  const target = parseTarget(f.target)
  if (!target || target.kind !== 'group') return null
  if (f.text !== null && f.text !== undefined && typeof f.text !== 'string') return null
  const a = parseAuthor(f.author)
  if (!a.ok) return null
  if (typeof f.created_at !== 'string') return null
  const createdAt = Date.parse(f.created_at)
  if (!Number.isFinite(createdAt)) return null
  const goal = parseGoal(f.goal, f.type)
  if (!goal) return null
  return { id: f.id, type: f.type, target, author: a.author, createdAt, goal }
}

/** O pedido do `followups_pending`: com `accepts`, o Copiloto responde no formato v2 (onboarding e sumido). */
export const PENDING_REQUEST = JSON.stringify({ version: 1, action: 'followups_pending', accepts: ['onboarding', 'sumido'] })

/** O que uma resposta do `followups_pending` traz, já conferido. */
export interface ParsedPending {
  items: PendingFollowup[]
  convos: PendingConvo[]
  invalid: number
  /** v1.2.1 `cancelled_ids` e v2 `stopped`, juntos e sem repetição */
  cancelledIds: string[]
  version: 1 | 2
}

/**
 * A resposta do `followups_pending`: `{ version: 1, followups: [...] }` (v1.1: só avulso) ou `{ version: 2, followups,
 * stopped }`. Envelope fora do contrato → null; itens fora do contrato ficam de fora (contados em `invalid`). Ids
 * repetidos na mesma resposta: vale o primeiro.
 */
export function parsePending(body: unknown): ParsedPending | null {
  const b = body as { version?: unknown; followups?: unknown; cancelled_ids?: unknown; stopped?: unknown } | null
  if (!b || typeof b !== 'object' || (b.version !== 1 && b.version !== 2) || !Array.isArray(b.followups)) return null
  const v2 = b.version === 2
  const items: PendingFollowup[] = []
  const convos: PendingConvo[] = []
  const seen = new Set<string>()
  let invalid = 0
  // o servidor manda no máximo 50; mais que isso, o resto vem na próxima busca
  for (const raw of b.followups.slice(0, FOLLOWUP_LIMITS.pendingMax * 2)) {
    const type = (raw as { type?: unknown } | null)?.type
    // v1.1 não tem `type`; na v2, um tipo que não conhecemos fica de fora
    const isConvo = v2 && (type === 'onboarding' || type === 'sumido')
    const f = isConvo ? parseConvo(raw) : !v2 || type === 'avulso' || type === undefined ? parseFollowup(raw) : null
    if (!f) {
      invalid++
      continue
    }
    if (seen.has(f.id)) continue
    seen.add(f.id)
    if (isConvo) convos.push(f as PendingConvo)
    else items.push(f as PendingFollowup)
  }
  const cancelledIds = [...new Set([...parseCancelled(b.cancelled_ids), ...(v2 ? parseCancelled(b.stopped) : [])])]
  return { items, convos, invalid, cancelledIds, version: v2 ? 2 : 1 }
}

/** v1.2.1: no máximo 200 ids cancelados por resposta. */
const MAX_CANCELLED = 200

/**
 * v1.2.1 `cancelled_ids`: ids cancelados no Copiloto (já entregues). Ausente ou fora do contrato → `[]`; ids em outro
 * formato ficam de fora.
 */
export function parseCancelled(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.slice(0, MAX_CANCELLED).filter((x): x is string => typeof x === 'string' && DRAFT_ID_RE.test(x)))]
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
