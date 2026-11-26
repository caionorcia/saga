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
  /**
   * grupo, só nas minhas: quem a mensagem menciona (@) e o autor da mensagem citada (sem dispositivo), para saber se
   * respondi a alguém num grupo grande ("Respondido no grupo")
   */
  targets?: string[]
  /**
   * v0.4.0, só nas do contato: a chave original no WhatsApp (`{ remoteJid, id, participant? }`, JSON), para citar a
   * mensagem num grupo e marcar como lida ao responder. Sem conteúdo.
   */
  waKeyJson?: string | null
}
