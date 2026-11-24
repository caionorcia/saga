export interface NormalizedMessage {
  id: string
  jid: string
  fromMe: boolean
  /** epoch em milissegundos (messageTimestamp do WhatsApp) */
  ts: number
  kind: 'text' | 'audio' | 'other'
  text: string | null
  mediaKeyJson: string | null
  durationSec: number | null
}
