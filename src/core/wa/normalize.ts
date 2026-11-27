import { BufferJSON, type WAMessage, type WAMessageContent } from '@whiskeysockets/baileys'
import type { NormalizedMessage } from '../types'

const PN_SERVER = 's.whatsapp.net'
const LID_SERVER = 'lid'
const GROUP_SERVER = 'g.us'

/** Grupo do WhatsApp (`@g.us`). Status, newsletters e listas de transmissão não são grupos. */
export function isGroupJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith(`@${GROUP_SERVER}`)
}

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

export interface NormalizeOptions {
  /** meu próprio JID (`creds.me.id`), para não confundir minhas respostas com o contato */
  ownJid?: string | null
  /** meu próprio @lid (`creds.me.lid`), para reconhecer menções em grupos que usam LID */
  ownLid?: string | null
}

/**
 * JID do contato: o telefone quando o Baileys o conhece (`remoteJidAlt` em mensagens `@lid`),
 * senão o próprio `remoteJid` sem o sufixo de dispositivo.
 *
 * No rc14 o `remoteJidAlt` é o endereço alternativo do REMETENTE: numa mensagem minha
 * (`fromMe`) ele tende a ser o meu próprio número. Por isso, em mensagens minhas, só vale
 * quando sei o meu número e ele é diferente; senão fica o `@lid` (o cliente resolve depois).
 */
function contactJid(key: WAMessage['key'], opts: NormalizeOptions): string | null {
  const jid = key.remoteJid
  if (jid && isGroupJid(jid)) return jid
  if (!isIndividualJid(jid)) return null
  if (!jid.endsWith(`@${LID_SERVER}`)) return stripDevice(jid)
  const alt = toPhoneJid(key.remoteJidAlt)
  if (alt && key.fromMe) {
    const own = toPhoneJid(opts.ownJid)
    if (!own || own === alt) return stripDevice(jid)
  }
  return alt ?? stripDevice(jid)
}

/** messageTimestamp (segundos; number, string ou Long) → epoch em ms. */
export function toMs(ts: unknown): number | null {
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

/** Grupo: quem mandou. O telefone (`participantAlt` ou `participant`) quando há; senão o @lid sem dispositivo. */
function groupSender(key: WAMessage['key']): string | null {
  const k = key as WAMessage['key'] & { participantAlt?: string | null }
  const pn = toPhoneJid(k.participantAlt) ?? toPhoneJid(k.participant)
  if (pn) return pn
  const p = k.participant ?? k.participantAlt
  return p && isIndividualJid(p) ? stripDevice(p) : null
}

/**
 * v0.10.1: o par @lid ↔ telefone que a chave da mensagem traz. No Baileys 7 o endereço alternativo do remetente vem em
 * `participantAlt` (grupos) ou `remoteJidAlt` (individuais), tirado do `participant_pn`/`sender_pn` (ou `*_lid`) da
 * mensagem. Nas minhas, o alternativo tende a ser o meu próprio número: não vale. Os dois sem dispositivo; null sem par.
 */
export function keyLidPair(key: WAMessage['key'] | null | undefined): { lid: string; pn: string } | null {
  if (!key || key.fromMe) return null
  const k = key as WAMessage['key'] & { participantAlt?: string | null; remoteJidAlt?: string | null }
  const pair = isGroupJid(k.remoteJid) ? [k.participant, k.participantAlt] : [k.remoteJid, k.remoteJidAlt]
  const lid = pair.find((j): j is string => typeof j === 'string' && j.endsWith(`@${LID_SERVER}`))
  const pn = pair.map((j) => toPhoneJid(j)).find((j): j is string => !!j)
  return lid && pn ? { lid: stripDevice(lid), pn } : null
}

/** v0.10.1: o telefone de quem mandou, se a chave traz (`participantAlt` ou o próprio `participant`). */
function groupSenderPn(key: WAMessage['key']): string | null {
  const k = key as WAMessage['key'] & { participantAlt?: string | null }
  return toPhoneJid(k.participantAlt) ?? toPhoneJid(k.participant)
}

interface ContextInfoLike {
  mentionedJid?: string[] | null
  participant?: string | null
}

/** O `contextInfo` da mensagem (texto, áudio, imagem…), onde ficam menções e a citação. */
function contextInfoOf(c: WAMessageContent): ContextInfoLike | null {
  for (const v of Object.values(c)) {
    const ci = (v as { contextInfo?: ContextInfoLike | null } | null)?.contextInfo
    if (ci && typeof ci === 'object') return ci
  }
  return null
}

/** A mensagem de grupo me menciona ou cita uma mensagem minha (pelo meu telefone ou pelo meu @lid). */
function mentionsMe(c: WAMessageContent, opts: NormalizeOptions): boolean {
  const mine = new Set([opts.ownJid, opts.ownLid].filter((j): j is string => !!j).map(stripDevice))
  if (mine.size === 0) return false
  const ci = contextInfoOf(c)
  if (!ci) return false
  if (ci.participant && mine.has(stripDevice(ci.participant))) return true
  return (ci.mentionedJid ?? []).some((j) => typeof j === 'string' && mine.has(stripDevice(j)))
}

/** Minha mensagem de grupo: quem ela menciona (@) e o autor da mensagem que ela cita (sem dispositivo, sem repetir). */
function targetsOf(c: WAMessageContent): string[] {
  const ci = contextInfoOf(c)
  if (!ci) return []
  const raw = [...(ci.mentionedJid ?? []), ci.participant]
  return [...new Set(raw.filter((j): j is string => typeof j === 'string' && isIndividualJid(j)).map(stripDevice))]
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
 * Converte uma mensagem do Baileys no formato do SagaZap.
 * Devolve `null` para tudo que não é conversa individual ou de grupo com conteúdo
 * (status, newsletters, listas de transmissão, reações, edições…).
 */
export function normalize(msg: WAMessage, opts: NormalizeOptions = {}): NormalizedMessage | null {
  const key = msg.key
  if (!key?.id) return null
  const jid = contactJid(key, opts)
  if (!jid) return null
  const ts = toMs(msg.messageTimestamp)
  if (ts === null) return null
  const content = unwrap(msg.message)
  if (!content) return null
  const b = body(content)
  if (!b) return null

  const fromMe = key.fromMe === true
  const group = isGroupJid(jid)
    ? {
        isGroup: true,
        senderJid: fromMe ? null : groupSender(key),
        ...(fromMe ? {} : { senderPn: groupSenderPn(key) }),
        senderName: fromMe ? null : nonEmpty(msg.pushName?.trim()),
        mentionsMe: !fromMe && mentionsMe(content, opts),
        ...(fromMe ? { targets: targetsOf(content) } : {})
      }
    : {}

  return {
    id: key.id,
    jid,
    fromMe,
    ts,
    kind: b.kind,
    text: b.text,
    // só o necessário para o downloadMediaMessage (chave + conteúdo + horário)
    mediaKeyJson: b.serialize
      ? JSON.stringify({ key, message: msg.message, messageTimestamp: msg.messageTimestamp }, BufferJSON.replacer)
      : null,
    durationSec: b.durationSec,
    // v0.4.0: a chave original da mensagem do contato (citar nos grupos, marcar como lida ao responder)
    ...(fromMe ? {} : { waKeyJson: waKeyOf(key) }),
    ...group
  }
}

/** Só o que identifica a mensagem no WhatsApp: a conversa como veio, o id e (grupos) quem mandou, sem conteúdo. */
function waKeyOf(key: WAMessage['key']): string {
  const k: { remoteJid: string | null | undefined; id: string | null | undefined; participant?: string } = { remoteJid: key.remoteJid, id: key.id }
  if (key.participant) k.participant = key.participant
  return JSON.stringify(k)
}

/** O que o cliente lê de um participante de grupo do Baileys (`GroupParticipant`): só as formas do JID. */
export interface ParticipantLike {
  id?: string | null
  phoneNumber?: string | null
  lid?: string | null
}

/**
 * Todas as formas conhecidas de um participante (sem dispositivo): o telefone (`@s.whatsapp.net`) e o @lid, para casar
 * com a conversa individual seja qual for o JID dela. `pnForLid`: o telefone de um @lid já conhecido (mapeamento local).
 */
export function participantJids(p: ParticipantLike | null | undefined, pnForLid: (lid: string) => string | null = () => null): string[] {
  if (!p) return []
  const raw = [p.id, p.phoneNumber, p.lid]
    .filter((j): j is string => typeof j === 'string' && (j.endsWith(`@${PN_SERVER}`) || j.endsWith('@lid')))
    .map(stripDevice)
  const out = new Set(raw)
  for (const j of raw) {
    if (!j.endsWith('@lid')) continue
    const pn = toPhoneJid(pnForLid(j))
    if (pn) out.add(pn)
  }
  return [...out]
}
