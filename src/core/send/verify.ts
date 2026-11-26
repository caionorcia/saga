import type { Repo } from '../db/repo'
import type { SendRow } from '../db/sendRepo'
import { findSentEcho } from './logic'

/**
 * "Nunca reenviar no escuro": um envio de estado desconhecido vira `sent` se uma mensagem com um dos ids que o app gerou
 * para ele (uma por tentativa) já chegou na conversa. `true` se achou.
 */
export function verifyUnknownSend(repo: Repo, s: SendRow): boolean {
  if (s.status !== 'unknown') return false
  const echo = findSentEcho(s.msgIds, (id) => repo.getMessage(id))
  if (!echo) return false
  if (!repo.sends.transition(s.id, s.attempt, ['unknown'], 'sent', { sentAt: echo.ts, waMsgId: echo.id, error: null })) return false
  // a mensagem avulsa não tem resposta aprovada: nunca ensina a memória
  if (s.replyId !== null) repo.setApprovedSentText(s.replyId, echo.text ?? s.text)
  return true
}
