export interface NormalizedMessage {
  id: string
  /** a conversa: a pessoa (telefone ou @lid) ou o grupo (`@g.us`) */
  jid: string
  fromMe: boolean
  /** epoch em milissegundos (messageTimestamp do WhatsApp) */
  ts: number
  kind: 'text' | 'audio' | 'other'
  text: string | null
  mediaKeyJson: string | null
  durationSec: number | null
  /** a conversa é um grupo (`@g.us`) */
  isGroup?: boolean
  /** grupo: quem mandou (telefone quando conhecido, senão @lid); null nas minhas */
  senderJid?: string | null
  /** grupo: o pushName de quem mandou */
  senderName?: string | null
  /** grupo: a mensagem me menciona (@) ou cita uma mensagem minha */
  mentionsMe?: boolean
}
