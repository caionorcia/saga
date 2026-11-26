/**
 * Copiloto da Saga: telefones e identificadores (contrato v1). Puro, sem banco.
 * - Normalização (igual nos dois lados): só os dígitos; com 10 ou 11 dígitos ganha o prefixo 55.
 * - Roster: `sha256hex("sagazap-v1:" + telefone)`; o servidor manda as duas formas do celular BR (com e sem o 9).
 * - `chat.key` = `sha256hex("sagazap-chat-v1:" + jid)`: o JID nunca sai do computador.
 */
import { createHash, randomBytes } from 'node:crypto'

export const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/** Só os dígitos; 10 ou 11 dígitos (DDD + número, sem país) ganham o 55. Vazio → null. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const d = raw.replace(/\D/g, '')
  if (!d) return null
  return d.length === 10 || d.length === 11 ? `55${d}` : d
}

/**
 * As formas do mesmo celular BR: `55 DD 9XXXXXXXX` (13 dígitos) ↔ `55 DD XXXXXXXX` (12 dígitos, contas antigas do
 * WhatsApp). Sem o 9, só vale para celular: começa com 6–9 (fixos começam com 2–5 e não mudam). Sempre inclui o próprio.
 */
export function phoneVariants(normalized: string): string[] {
  const out = [normalized]
  if (!normalized.startsWith('55')) return out
  const ddd = normalized.slice(2, 4)
  const local = normalized.slice(4)
  if (normalized.length === 13 && local.startsWith('9')) out.push(`55${ddd}${local.slice(1)}`)
  else if (normalized.length === 12 && /^[6-9]/.test(local)) out.push(`55${ddd}9${local}`)
  return out
}

export const rosterHash = (normalized: string): string => sha256hex(`sagazap-v1:${normalized}`)

/** O telefone (normalizado) de um JID `@s.whatsapp.net`; null para @lid, grupos e o resto. */
export function phoneOfJid(jid: string | null | undefined): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null
  return normalizePhone(jid.slice(0, jid.lastIndexOf('@')).split(':')[0])
}

/** O telefone está no roster (em qualquer das formas)? */
export function inRoster(normalized: string, roster: ReadonlySet<string>): boolean {
  return phoneVariants(normalized).some((p) => roster.has(rosterHash(p)))
}

export const chatKey = (jid: string): string => sha256hex(`sagazap-chat-v1:${jid}`)
/** id de mensagem: `"sz1:m:" + sha256hex(jid + "|" + waMessageId)` truncado em 40 hex */
export const messageEventId = (jid: string, waMessageId: string): string => `sz1:m:${sha256hex(`${jid}|${waMessageId}`).slice(0, 40)}`
export const alertEventId = (localId: number): string => `sz1:a:${localId}`
export const replyStateEventId = (jid: string): string => `sz1:r:${chatKey(jid)}`
export const summaryEventId = (jid: string): string => `sz1:s:${chatKey(jid)}`

/** "Gerar código": 32 bytes aleatórios em base64url (43 caracteres). */
export const generateCode = (): string => randomBytes(32).toString('base64url')

/** Formato de um hash do roster vindo do servidor. */
export const isRosterHash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
