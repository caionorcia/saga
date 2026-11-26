import type { Repo } from '../db/repo'
import type { SendRow } from '../db/sendRepo'
import { findSentEcho } from './logic'

/**
 * "Nunca reenviar no escuro": um envio de estado desconhecido vira `sent` se a mensagem (mesmo texto, minha, nessa
 * conversa, até 10 min do começo do envio) já aparece na conversa. `true` se achou.
 */
export function verifyUnknownSend(repo: Repo, s: SendRow): boolean {
  if (s.status !== 'unknown') return false
  const echo = findSentEcho(repo.listMessages(s.jid, 300), s.text, s.startedAt ?? s.queuedAt)
  if (!echo) return false
  if (!repo.sends.transition(s.id, ['unknown'], 'sent', { sentAt: echo.ts, waMsgId: echo.id, error: null })) return false
  repo.setApprovedSentText(s.replyId, echo.text ?? s.text)
  return true
}
