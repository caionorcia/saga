import type { ApprovedRow, MessageRow, Repo } from '../db/repo'
import type { NormalizedMessage } from '../types'

export interface Example {
  context: string
  reply: string
  source: 'same_contact' | 'similar' | 'recent' | 'sent_history'
}

const SIX_HOURS = 6 * 3_600_000
/** Tolerância entre o relógio local (created_at) e o horário do WhatsApp. */
const CLOCK_SLACK = 60_000

function replyOf(a: ApprovedRow): string {
  return a.sentText ?? a.finalText
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/** 1 − Levenshtein normalizado, sobre texto minúsculo sem pontuação. */
export function similarity(a: string, b: string): number {
  const x = norm(a)
  const y = norm(b)
  const max = Math.max(x.length, y.length)
  if (max === 0) return 1
  return 1 - levenshtein(x, y) / max
}

function ftsQuery(contextText: string): string | null {
  const words = [...new Set((contextText.toLowerCase().match(/\p{L}{4,}/gu) ?? []))].slice(0, 12)
  return words.length ? words.map((w) => `"${w}"`).join(' OR ') : null
}

export function selectExamples(repo: Repo, jid: string, contextText: string): Example[] {
  const out: Example[] = []
  const usedIds: number[] = []
  const usedReplies = new Set<string>()
  const take = (a: ApprovedRow, source: Example['source']): boolean => {
    const reply = replyOf(a)
    const key = norm(reply)
    usedIds.push(a.id)
    if (usedReplies.has(key)) return false
    usedReplies.add(key)
    out.push({ context: a.contextText, reply, source })
    return true
  }
  const fill = (rows: (excl: number[]) => ApprovedRow[], max: number, source: Example['source']) => {
    let n = 0
    for (const a of rows([...usedIds])) {
      if (n >= max) break
      if (take(a, source)) n++
    }
  }

  fill((ex) => repo.listApproved({ jid, limit: 12, excludeIds: ex }), 3, 'same_contact')
  const q = ftsQuery(contextText)
  if (q) fill((ex) => repo.searchApproved(q, 12, ex), 3, 'similar')
  fill((ex) => repo.listApproved({ limit: 12, excludeIds: ex }), 2, 'recent')

  // histórico real: mensagens fromMe de texto, com a mensagem anterior do contato como contexto
  const msgs = repo.listMessages(jid, 300)
  let n = 0
  for (let i = msgs.length - 1; i >= 0 && n < 3; i--) {
    const m = msgs[i]
    if (!m.fromMe || m.kind !== 'text' || !m.text?.trim()) continue
    const prev = findPrevContactText(msgs, i)
    if (prev === null) continue
    const key = norm(m.text)
    if (usedReplies.has(key)) continue
    usedReplies.add(key)
    out.push({ context: prev, reply: m.text, source: 'sent_history' })
    n++
  }
  return out
}

function findPrevContactText(msgs: MessageRow[], idx: number): string | null {
  for (let i = idx - 1; i >= 0; i--) {
    if (msgs[i].fromMe) return null
    const t = msgs[i].kind === 'text' ? msgs[i].text : msgs[i].transcript
    if (t?.trim()) return t
  }
  return null
}

export function saveApproved(
  repo: Repo,
  a: { jid: string; contextText: string; originalSuggestion: string | null; finalText: string; provider: string | null }
): number {
  return repo.insertApproved(a)
}

/** Liga uma mensagem realmente enviada à resposta aprovada correspondente (se houver). */
export function reconcileSent(repo: Repo, msg: NormalizedMessage): void {
  if (!msg.fromMe || msg.kind !== 'text' || !msg.text?.trim()) return
  const candidates = repo.listUnsentApproved(msg.jid, msg.ts - SIX_HOURS, msg.ts + CLOCK_SLACK)
  let best: { id: number; score: number } | null = null
  for (const c of candidates) {
    const score = similarity(c.finalText, msg.text)
    if (score >= 0.6 && (!best || score > best.score)) best = { id: c.id, score }
  }
  if (best) repo.setApprovedSentText(best.id, msg.text)
}
