/**
 * Copiloto da Saga: os eventos do contrato v1 montados a partir das tabelas locais, só para conversas de mentorados.
 * - Individual: entra se o telefone da conversa está no roster.
 * - Grupo: entra se algum participante (consulta de participantes + quem já mandou mensagem) está no roster;
 *   `chat.phones` leva só esses telefones. Telefone de quem não é mentorado nunca entra num evento.
 * - @lid: vale o telefone que o app já conhece para ele (`pnForLid`); sem telefone, não casa.
 */
import { senderOf, type ContactRow, type MessageRow, type Repo } from '../db/repo'
import { REPLY_REASON_LABELS, type ReplyReasonCode } from '../../shared/feedback'
import {
  alertEventId,
  chatKey,
  inRoster,
  messageEventId,
  phoneOfJid,
  replyStateEventId,
  sha256hex,
  summaryEventId
} from './identity'

export interface Chat {
  key: string
  kind: 'individual' | 'group'
  name: string | null
  phones: string[]
}

export interface MessageEvent {
  type: 'message'
  id: string
  chat: Chat
  direction: 'inbound' | 'outbound'
  sender: { phone: string | null; name: string | null; is_mentor: boolean }
  message_type: 'text' | 'audio' | 'image' | 'document' | 'other'
  sent_at: string
  text: string | null
  is_transcription: boolean
  transcription_status: 'done' | 'failed' | 'unavailable' | 'pending' | null
  has_media: boolean
  sent_via_sagazap: boolean
}

export interface AlertEvent {
  type: 'alert'
  id: string
  chat: Chat
  kind: 'urgente' | 'desanimo' | 'reuniao' | 'travado' | 'esperando'
  detail: string
  message_id: string | null
  source: 'ai' | 'rule' | 'user'
  created_at: string
  status: 'open' | 'dismissed'
  dismissed_at: string | null
  feedback: null | { verdict: 'up' | 'down'; reason_code: string | null; reason_text: string | null; correct_kind: string | null }
}

export interface ReplyStateEvent {
  type: 'reply_state'
  id: string
  chat: Chat
  last_inbound_message_id: string | null
  waiting_since: string | null
  needs_reply: boolean | null
  decided_by: 'rule' | 'ai' | 'mentor' | null
  reason: string | null
  resolution: null | 'replied' | 'replied_in_group' | 'not_needed'
  updated_at: string
}

export interface SummaryEvent {
  type: 'summary'
  id: string
  chat: Chat
  summary: string
  last_message_id: string | null
  generated_at: string
}

export type CopilotoEvent = MessageEvent | AlertEvent | ReplyStateEvent | SummaryEvent

/** Um evento pronto para a fila: o id, a conversa local (para filtrar depois) e o JSON. */
export interface BuiltEvent {
  id: string
  jid: string
  event: CopilotoEvent
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** Rótulos que o SagaZap grava no texto de mídia sem legenda (`wa/normalize.ts`). */
export function messageType(m: MessageRow): MessageEvent['message_type'] {
  if (m.kind === 'text') return 'text'
  if (m.kind === 'audio') return 'audio'
  const t = m.text ?? ''
  if (t === '[imagem]') return 'image'
  if (t.startsWith('[documento:')) return 'document'
  return 'other'
}

const NOT_MEDIA = new Set(['[localização]', '[contato]'])

export interface BuilderDeps {
  repo: Repo
  /** hashes do roster (`sha256hex("sagazap-v1:" + telefone)`) */
  roster: ReadonlySet<string>
  /** o telefone que o app conhece para um @lid (JID `@s.whatsapp.net`), ou null */
  pnForLid?: (lid: string) => string | null
  /**
   * v0.9.0 (contrato v1.3): mensagens (e envios) com horário antes disto (epoch ms; os últimos 30 dias) nunca viram
   * evento `message`, por nenhum caminho (captura, carga, reenvio, renome de grupo, transcrição nova).
   */
  minTs?: number
}

/**
 * Monta os eventos de uma volta. Guarda em cache as conversas e a lista de contatos (uma consulta por volta).
 * Toda função devolve null (ou vazio) para o que não é de mentorado.
 */
export class EventBuilder {
  private chats = new Map<string, Chat | null>()
  private contacts: Map<string, ContactRow> | null = null

  constructor(private readonly deps: BuilderDeps) {}

  /** O telefone normalizado de um JID de pessoa (telefone ou @lid já mapeado), ou null. */
  phoneOf(jid: string | null | undefined): string | null {
    if (!jid) return null
    const direct = phoneOfJid(jid)
    if (direct) return direct
    if (jid.endsWith('@lid')) return phoneOfJid(this.deps.pnForLid?.(`${jid.slice(0, jid.lastIndexOf('@')).split(':')[0]}@lid`) ?? null)
    return null
  }

  private rosterPhone(jid: string | null | undefined): string | null {
    const p = this.phoneOf(jid)
    return p && inRoster(p, this.deps.roster) ? p : null
  }

  /** A conversa como vai no evento, ou null se não for de mentorado. */
  chat(jid: string): Chat | null {
    if (this.chats.has(jid)) return this.chats.get(jid)!
    const out = this.computeChat(jid)
    this.chats.set(jid, out)
    return out
  }

  /** Os telefones (do roster) dos participantes do grupo, em ordem; vazio = não é grupo de mentorado. */
  groupPhones(jid: string): string[] {
    const phones = new Set<string>()
    for (const p of this.deps.repo.copiloto.groupParticipants(jid)) {
      const ph = this.rosterPhone(p)
      if (ph) phones.add(ph)
    }
    return [...phones].sort()
  }

  private computeChat(jid: string): Chat | null {
    const c = this.deps.repo.copiloto.chat(jid)
    if (!c) return null
    if (c.isGroup) {
      const phones = this.groupPhones(jid)
      if (phones.length === 0) return null
      return { key: chatKey(jid), kind: 'group', name: c.name, phones }
    }
    const phone = this.rosterPhone(jid)
    if (!phone) return null
    return { key: chatKey(jid), kind: 'individual', name: c.name, phones: [phone] }
  }

  /** v0.9.0: a mensagem está dentro da janela que vai ao Copiloto (os últimos 30 dias). */
  inWindow(ts: number): boolean {
    return this.deps.minTs === undefined || ts >= this.deps.minTs
  }

  /**
   * Exceção pedida pelo mentor (follow-ups precisam do grupo no Copiloto): grupo de mentorado sem mensagem nos últimos 30
   * dias manda a mensagem mais recente guardada (de quando for). Só essa; o resto mais antigo fica só aqui.
   */
  private latestOfIdleGroup(m: MessageRow): boolean {
    if (!m.jid.endsWith('@g.us')) return false
    const latest = this.deps.repo.copiloto.latestMessageId(m.jid)
    return latest === m.id
  }

  message(m: MessageRow): BuiltEvent | null {
    if (!this.inWindow(m.ts) && !this.latestOfIdleGroup(m)) return null
    const chat = this.chat(m.jid)
    if (!chat) return null
    const repo = this.deps.repo
    let sender: MessageEvent['sender']
    if (m.fromMe) sender = { phone: null, name: null, is_mentor: true }
    else if (chat.kind === 'individual') sender = { phone: chat.phones[0], name: chat.name, is_mentor: false }
    else {
      // v0.10.1: o telefone de quem mandou (guardado na mensagem ou pelo par @lid → telefone); nunca o @lid
      const phone = this.rosterPhone(senderOf(m))
      // o rótulo pode cair no número de quem mandou: só para mentorado
      sender = { phone, name: m.senderName ?? (phone ? m.senderLabel : null), is_mentor: false }
    }
    const isAudio = m.kind === 'audio'
    const transcribed = isAudio && m.transcriptStatus === 'done' && !!m.transcript
    const id = messageEventId(m.jid, m.id)
    const event: MessageEvent = {
      type: 'message',
      id,
      chat,
      direction: m.fromMe ? 'outbound' : 'inbound',
      sender,
      message_type: messageType(m),
      sent_at: iso(m.ts),
      text: isAudio ? (transcribed ? m.transcript : null) : m.text,
      is_transcription: transcribed,
      transcription_status: isAudio ? (m.transcriptStatus ?? 'pending') : null,
      has_media: m.kind !== 'text' && !NOT_MEDIA.has(m.text ?? ''),
      sent_via_sagazap: m.fromMe && repo.copiloto.sentViaApp(m.jid, m.id)
    }
    return { id, jid: m.jid, event }
  }

  /** Um envio direto confirmado: a mensagem do mentor (a da conversa, se o eco já chegou; senão a do envio). */
  send(sendId: number): BuiltEvent | null {
    const s = this.deps.repo.sends.get(sendId)
    if (!s || s.status !== 'sent' || !s.waMsgId) return null
    const echo = this.deps.repo.getMessage(s.waMsgId)
    if (echo && echo.jid === s.jid) return this.message(echo)
    if (!this.inWindow(s.sentAt ?? s.queuedAt)) return null
    const chat = this.chat(s.jid)
    if (!chat) return null
    const id = messageEventId(s.jid, s.waMsgId)
    const event: MessageEvent = {
      type: 'message',
      id,
      chat,
      direction: 'outbound',
      sender: { phone: null, name: null, is_mentor: true },
      message_type: 'text',
      sent_at: iso(s.sentAt ?? s.queuedAt),
      text: s.text,
      is_transcription: false,
      transcription_status: null,
      has_media: false,
      sent_via_sagazap: true
    }
    return { id, jid: s.jid, event }
  }

  alert(alertId: number): BuiltEvent | null {
    const a = this.deps.repo.copiloto.getAlert(alertId)
    if (!a) return null
    const chat = this.chat(a.jid)
    if (!chat) return null
    const id = alertEventId(a.id)
    const event: AlertEvent = {
      type: 'alert',
      id,
      chat,
      kind: a.kind as AlertEvent['kind'],
      detail: a.detail,
      message_id: a.msgId ? messageEventId(a.jid, a.msgId) : null,
      source: a.source,
      created_at: iso(a.createdAt),
      status: a.dismissedAt === null ? 'open' : 'dismissed',
      dismissed_at: a.dismissedAt === null ? null : iso(a.dismissedAt),
      feedback: a.feedback
        ? { verdict: a.feedback.verdict, reason_code: a.feedback.reasonCode, reason_text: a.feedback.reasonText, correct_kind: a.feedback.correctKind }
        : null
    }
    return { id, jid: a.jid, event }
  }

  private contact(jid: string): ContactRow | null {
    this.contacts ??= new Map(this.deps.repo.listContacts({ includeHidden: true }).map((c) => [c.jid, c]))
    return this.contacts.get(jid) ?? null
  }

  /** O "Para responder" da conversa (um por conversa). Sem mensagens: null. */
  replyState(jid: string): BuiltEvent | null {
    const chat = this.chat(jid)
    if (!chat) return null
    const c = this.contact(jid)
    if (!c || c.lastTs === null) return null
    const repo = this.deps.repo.copiloto
    const lastIn = repo.lastInbound(jid)
    // v0.9.0: mensagem de fora da janela (mais de 30 dias) não foi ao Copiloto: o estado não aponta para ela
    const inbound = lastIn && this.inWindow(lastIn.ts) ? lastIn : null
    let needs: boolean | null = false
    let decidedBy: ReplyStateEvent['decided_by'] = null
    let reason: string | null = null
    let resolution: ReplyStateEvent['resolution'] = inbound ? 'replied' : null
    if (!c.awaitingReply && lastIn && c.lastTs === lastIn.ts) {
      // o contato falou por último, mas há mais de 30 dias: não fica em "Para responder"
      decidedBy = 'rule'
      reason = 'Sem mensagem nos últimos 30 dias'
      resolution = 'not_needed'
    }
    if (c.awaitingReply) {
      const d = c.replyDecision
      resolution = null
      needs = d ? d.needed : null
      if (d?.by === 'user') {
        decidedBy = 'mentor'
        if (!d.needed && inbound) {
          const code = repo.replyReasonCode(jid, inbound.id)
          resolution = code === 'respondi_grupo' ? 'replied_in_group' : 'not_needed'
          reason = code && code in REPLY_REASON_LABELS ? REPLY_REASON_LABELS[code as ReplyReasonCode] : null
        }
      } else if (d?.by === 'group') {
        decidedBy = 'rule'
        reason = d.reason
        resolution = 'replied_in_group'
      } else if (d) {
        decidedBy = d.by === 'rule' ? 'rule' : 'ai'
        reason = d.reason
        if (!d.needed) resolution = 'not_needed'
      }
    }
    const updated = Math.max(c.lastTs, repo.replyUpdatedAt(jid) ?? 0)
    const id = replyStateEventId(jid)
    const event: ReplyStateEvent = {
      type: 'reply_state',
      id,
      chat,
      last_inbound_message_id: inbound ? messageEventId(jid, inbound.id) : null,
      waiting_since: c.waitingSince === null ? null : iso(c.waitingSince),
      needs_reply: needs,
      decided_by: decidedBy,
      reason,
      resolution,
      updated_at: iso(updated)
    }
    return { id, jid, event }
  }

  /** O resumo mais recente da conversa (da última análise), ou null. */
  summary(jid: string): BuiltEvent | null {
    const chat = this.chat(jid)
    if (!chat) return null
    const a = this.deps.repo.getAnalysis(jid)
    if (!a || !a.summary.trim()) return null
    const id = summaryEventId(jid)
    const event: SummaryEvent = {
      type: 'summary',
      id,
      chat,
      summary: a.summary,
      last_message_id: a.lastMsgId ? messageEventId(jid, a.lastMsgId) : null,
      generated_at: iso(a.createdAt)
    }
    return { id, jid, event }
  }
}

/** JSON do evento e a impressão dele (o mesmo estado nunca entra duas vezes na fila). */
export function serialize(e: CopilotoEvent): { json: string; hash: string } {
  const json = JSON.stringify(e)
  return { json, hash: sha256hex(json) }
}
