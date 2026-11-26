/**
 * Regras puras do envio direto (v0.4.0): qual mensagem citar num grupo, quais marcar como lidas, se o contato falou
 * nos últimos 30 dias e como conferir na conversa um envio de estado desconhecido.
 */
import { createHash, randomBytes } from 'node:crypto'
import { BufferJSON } from '@whiskeysockets/baileys'
import type { MessageRow } from '../db/repo'
import { isGroupJid, isIndividualJid, stripDevice } from '../wa/normalize'
import { SEND_LIMITS } from '../../shared/send'

/** A chave de uma mensagem para o Baileys (`WAMessageKey`). */
export interface WaKey {
  remoteJid: string
  id: string
  fromMe: boolean
  participant?: string
}

/** Impressão curta da conversa para o registro de diagnóstico (nunca o jid). */
export function chatHash(jid: string): string {
  return createHash('sha256').update(jid).digest('hex').slice(0, 8)
}

/** Impressão do texto para a chave de idempotência (resposta aprovada + texto). */
export function textHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
}

/** A chave original da mensagem do contato (ou uma reconstruída para mensagens de antes da v0.4.0). */
export function messageKey(m: MessageRow): WaKey {
  try {
    const k = m.waKeyJson ? (JSON.parse(m.waKeyJson) as { remoteJid?: unknown; id?: unknown; participant?: unknown }) : null
    if (k && typeof k.remoteJid === 'string' && typeof k.id === 'string') {
      return { remoteJid: k.remoteJid, id: k.id, fromMe: false, ...(typeof k.participant === 'string' ? { participant: k.participant } : {}) }
    }
  } catch {
    // chave ilegível: reconstrói
  }
  return { remoteJid: m.jid, id: m.id, fromMe: false, ...(m.senderJid ? { participant: m.senderJid } : {}) }
}

/** As mensagens do contato depois da última do mentor (as que a resposta responde), em ordem. */
export function contactMessagesSinceMentor(messages: MessageRow[]): MessageRow[] {
  let i = messages.length
  while (i > 0 && !messages[i - 1].fromMe) i--
  return messages.slice(i)
}

/**
 * Grupo: a mensagem que a resposta cita. Entre as mensagens do contato depois da última do mentor, a mais recente que
 * menciona ou cita o mentor; senão a mais recente de todas. Nenhuma (o mentor falou por último): null.
 */
export function pickQuote(messages: MessageRow[]): MessageRow | null {
  const pending = contactMessagesSinceMentor(messages)
  for (let i = pending.length - 1; i >= 0; i--) if (pending[i].mentionsMe) return pending[i]
  return pending[pending.length - 1] ?? null
}

/** O `quoted` do `sendMessage`: a chave original e um conteúdo mínimo (o áudio vai como veio, para aparecer como áudio). */
export function quotedMessage(m: MessageRow): { key: WaKey; message: Record<string, unknown>; messageTimestamp: number } {
  let message: Record<string, unknown> = { conversation: m.text ?? m.transcript ?? '' }
  if (m.kind === 'audio' && m.mediaKeyJson) {
    try {
      const raw = JSON.parse(m.mediaKeyJson, BufferJSON.reviver) as { message?: Record<string, unknown> }
      if (raw.message) message = raw.message
    } catch {
      // sem o áudio original: cita como texto
    }
  }
  return { key: messageKey(m), message, messageTimestamp: Math.floor(m.ts / 1000) }
}

/**
 * As mensagens do contato que ficam "lidas" ao responder: as dessa conversa depois da última do mentor, e só as que têm
 * a chave original guardada (v0.4.0 em diante). Nunca uma chave reconstruída.
 */
export function unreadKeys(messages: MessageRow[]): WaKey[] {
  return contactMessagesSinceMentor(messages)
    .filter((m) => !!m.waKeyJson)
    .map(messageKey)
}

/** Conteúdo de verdade (texto, áudio, mídia, figurinha); reações e mensagens de controle nem chegam ao banco. */
const CONTENT_KINDS: ReadonlySet<MessageRow['kind']> = new Set(['text', 'audio', 'other'])

/** O contato (ou alguém no grupo) mandou mensagem nos últimos 30 dias? (responder, nunca iniciar conversa) */
export function hasRecentContactMessage(messages: MessageRow[], now: number): boolean {
  const since = now - SEND_LIMITS.recentContactMs
  return messages.some((m) => !m.fromMe && CONTENT_KINDS.has(m.kind) && m.ts >= since)
}

/**
 * Para onde a resposta vai. Grupo: o próprio grupo. Individual: o JID com que o contato escreveu por último (o
 * `remoteJid` original, sem dispositivo): @lid quando a conversa migrou para LID, senão o telefone. Sem chave original,
 * o JID da conversa.
 */
export function sendAddress(messages: MessageRow[], chatJid: string): string {
  if (isGroupJid(chatJid)) return chatJid
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.fromMe || !m.waKeyJson) continue
    const remote = messageKey(m).remoteJid
    if (isIndividualJid(remote)) return stripDevice(remote)
  }
  return chatJid
}

/** Id de mensagem no formato do WhatsApp Web (como o `generateMessageID` do Baileys), gerado antes de enviar. */
export function newMessageId(): string {
  return `3EB0${randomBytes(18).toString('hex').toUpperCase()}`
}

/** Erro para o banco e o registro: só o tipo e o código, nunca a mensagem (pode trazer números ou JIDs). */
export function errCode(e: unknown): string {
  const x = e as { name?: unknown; output?: { statusCode?: unknown }; status?: unknown; statusCode?: unknown } | null
  const name = typeof x?.name === 'string' && /^[A-Za-z]{1,40}$/.test(x.name) ? x.name : 'Error'
  const code = x?.output?.statusCode ?? x?.status ?? x?.statusCode
  return typeof code === 'number' ? `${name} ${code}` : name
}

/**
 * "Nunca reenviar no escuro": a mensagem com um dos ids que o próprio app gerou para este envio, minha, já está no
 * banco? (Pelo id, sem comparar relógios nem texto.)
 */
export function findSentEcho(msgIds: string[], getMessage: (id: string) => MessageRow | null): MessageRow | null {
  for (let i = msgIds.length - 1; i >= 0; i--) {
    const m = getMessage(msgIds[i])
    if (m?.fromMe) return m
  }
  return null
}
