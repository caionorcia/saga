import { BufferJSON, type WAMessage, type WAMessageContent } from '@whiskeysockets/baileys'
import type { NormalizedMessage } from '../types'

const PN_SERVER = 's.whatsapp.net'
const LID_SERVER = 'lid'

/** Conversa individual: número de telefone (`@s.whatsapp.net`) ou LID (`@lid`, endereçamento do Baileys v7). */
export function isIndividualJid(jid: string | null | undefined): jid is string {
  if (!jid) return false
  const server = jid.slice(jid.lastIndexOf('@') + 1)
  return server === PN_SERVER || server === LID_SERVER
}

/** Tira o sufixo de dispositivo (`user:3@server` → `user@server`). */
export function stripDevice(jid: string): string {
  const at = jid.lastIndexOf('@')
  if (at < 0) return jid
  return `${jid.slice(0, at).split(':')[0]}@${jid.slice(at + 1)}`
}

/** JID de telefone normalizado, ou `null` se não for `@s.whatsapp.net`. */
export function toPhoneJid(jid: string | null | undefined): string | null {
  if (!jid || !jid.endsWith(`@${PN_SERVER}`)) return null
  return stripDevice(jid)
}

/**
 * JID do contato: o telefone quando o Baileys o conhece (`remoteJidAlt` em mensagens `@lid`),
 * senão o próprio `remoteJid` sem o sufixo de dispositivo.
 */
function contactJid(key: WAMessage['key']): string | null {
  const jid = key.remoteJid
  if (!isIndividualJid(jid)) return null
  if (jid.endsWith(`@${LID_SERVER}`)) return toPhoneJid(key.remoteJidAlt) ?? stripDevice(jid)
  return stripDevice(jid)
}

/** messageTimestamp (segundos; number, string ou Long) → epoch em ms. */
function toMs(ts: unknown): number | null {
  let s: number
  if (typeof ts === 'number') s = ts
  else if (typeof ts === 'string') s = Number(ts)
  else if (ts && typeof ts === 'object') {
    const o = ts as { toNumber?: () => number; low?: number; high?: number }
    if (typeof o.toNumber === 'function') s = o.toNumber()
    else if (typeof o.low === 'number' && typeof o.high === 'number') s = o.high * 2 ** 32 + (o.low >>> 0)
    else return null
  } else return null
  return Number.isFinite(s) && s > 0 ? s * 1000 : null
}

/** Desembrulha mensagens efêmeras, de visualização única e documento com legenda. */
function unwrap(content: WAMessageContent | null | undefined): WAMessageContent | null {
  let c = content ?? null
  for (let i = 0; i < 5 && c; i++) {
    const inner =
      c.ephemeralMessage?.message ??
      c.viewOnceMessage?.message ??
      c.viewOnceMessageV2?.message ??
      c.viewOnceMessageV2Extension?.message ??
      c.documentWithCaptionMessage?.message
    if (!inner) break
    c = inner
  }
  return c
}

const nonEmpty = (s: string | null | undefined): string | null => (s && s.trim() ? s : null)

type Body = Pick<NormalizedMessage, 'kind' | 'text' | 'durationSec'> & { serialize: boolean }

function body(c: WAMessageContent): Body | null {
  // apagar, editar, reações e mensagens de controle não são conversa
  if (c.protocolMessage || c.editedMessage || c.reactionMessage || c.encReactionMessage) return null

  const text = nonEmpty(c.conversation) ?? nonEmpty(c.extendedTextMessage?.text)
  if (text) return { kind: 'text', text, durationSec: null, serialize: false }

  if (c.audioMessage) {
    const sec = Number(c.audioMessage.seconds)
    return { kind: 'audio', text: null, durationSec: Number.isFinite(sec) ? sec : null, serialize: true }
  }
  const other = (label: string, caption?: string | null): Body => ({
    kind: 'other',
    text: nonEmpty(caption) ?? label,
    durationSec: null,
    serialize: false
  })
  if (c.imageMessage) return other('[imagem]', c.imageMessage.caption)
  if (c.videoMessage) return other('[vídeo]', c.videoMessage.caption)
  if (c.documentMessage) {
    const name = c.documentMessage.fileName || c.documentMessage.title || 'sem nome'
    return other(`[documento: ${name}]`, c.documentMessage.caption)
  }
  if (c.stickerMessage) return other('[figurinha]')
  if (c.locationMessage || c.liveLocationMessage) return other('[localização]')
  if (c.contactMessage || c.contactsArrayMessage) return other('[contato]')
  return null
}

/**
 * Converte uma mensagem do Baileys no formato do Saga.
 * Devolve `null` para tudo que não é conversa individual com conteúdo.
 */
export function normalize(msg: WAMessage): NormalizedMessage | null {
  const key = msg.key
  if (!key?.id) return null
  const jid = contactJid(key)
  if (!jid) return null
  const ts = toMs(msg.messageTimestamp)
  if (ts === null) return null
  const content = unwrap(msg.message)
  if (!content) return null
  const b = body(content)
  if (!b) return null

  return {
    id: key.id,
    jid,
    fromMe: key.fromMe === true,
    ts,
    kind: b.kind,
    text: b.text,
    // só o necessário para o downloadMediaMessage (chave + conteúdo + horário)
    mediaKeyJson: b.serialize
      ? JSON.stringify({ key, message: msg.message, messageTimestamp: msg.messageTimestamp }, BufferJSON.replacer)
      : null,
    durationSec: b.durationSec
  }
}
