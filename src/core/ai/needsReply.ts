/**
 * "Para responder" (v0.2.2): nem toda conversa com a última mensagem do contato precisa de resposta.
 * - Regra barata, sem IA: as mensagens do contato depois da última do mentor são só agradecimento, "ok", emoji ou
 *   figurinha (até 4 palavras) → não precisa responder.
 * - O job `classify` (IA gratuita, Groq) também responde `needsReply` + `reason` para a última mensagem do contato.
 * - O mentor corrige ("Não precisa responder" / "Precisa sim") e confirma (👍); cada avaliação vira exemplo para a IA.
 * A decisão vale só para a última mensagem do contato: uma mensagem nova dele recomeça tudo.
 */
import { groupAnswerReason, type MessageRow, type Repo, type ReplyFeedbackRow } from '../db/repo'
import {
  REASON_TEXT_MAX,
  REPLY_REASON_LABELS,
  REPLY_VERDICT_LABELS,
  type ReplyQuality,
  type ReplyReason
} from '../../shared/feedback'
import { render } from './prompt'

/** "reason" da IA: até este tamanho */
export const REPLY_REASON_MAX = 100
/** a regra olha no máximo estas mensagens do contato (mais que isso não é "só um obrigado") */
export const RULE_MAX_MESSAGES = 6
/** palavras numa mensagem de agradecimento/ok */
export const RULE_MAX_WORDS = 4
/** o motivo mostrado quando a regra decidiu */
export const RULE_REASON = 'Só agradecimento, "ok" ou emoji.'
/** mensagens do contato guardadas como trecho da avaliação */
const CONTEXT_MESSAGES = 8
const CONTEXT_TEXT_MAX = 4000
/** exemplos do "Para responder" no prompt do classify */
export const REPLY_EXAMPLES_MAX = 4
const EXAMPLE_CONTEXT_MAX = 300
const QUALITY_DAYS = 30

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** Palavras que, sozinhas, encerram o assunto (sem acento, minúsculas). */
const ACK_CORE = new Set(
  (
    'ok okay okey okk blz beleza valeu vlw obrigado obrigada obrigadao obrigadinho obrigadinha obg obgd brigado brigada grato grata ' +
    'agradeco show top perfeito perfeita otimo otima combinado fechado certo certinho entendi entendido joia legal massa maravilha ' +
    'tranquilo tranquila demais sucesso amem tchau ate abraco abracos abs bjs bj beijo beijos uhum aham ' +
    'thanks thx'
  ).split(' ')
)
/** Palavras que só acompanham ("muito obrigado pela ajuda", "valeu mentor", "até mais"). */
const ACK_FILLER = new Set(
  'muito mt mto muitissimo mesmo entao pela pelo por tudo ajuda atencao dica dicas forca mais logo breve amanha mentor professor professora prof e de da do sim ta'.split(
    ' '
  )
)
/** Risadas: kkk, haha, rsrs. */
const LAUGH = /^(k{2,}|(ha){2,}h?|(he){2,}|(rs)+)$/
/** Emojis que pedem atenção (dúvida, tristeza, socorro): não contam como "só emoji". */
const ATTENTION_EMOJI = /[❓❔⁉‼❗😢😭😞😔😟😕🙁☹😩😫😰😥😣😖🆘💔]/u
const EMOJI = /\p{Extended_Pictographic}/u
/** sobra de um texto só de emoji: modificadores, seletor de variação, junção, espaços e pontuação leve */
const EMOJI_LEFTOVER = /^[\s\p{Emoji_Modifier}\u{FE0F}\u{200D}\u{20E3}.,!~*]*$/u

/** A mensagem é só agradecimento, "ok", despedida curta, risada, emoji ou figurinha? (Na dúvida, não.) */
export function isAckOnly(m: MessageRow): boolean {
  if (m.fromMe) return false
  if (m.kind === 'other') return m.text === '[figurinha]'
  if (m.kind !== 'text' || !m.text) return false
  const t = m.text.trim()
  if (!t || t.includes('?')) return false
  if (EMOJI.test(t) && t.replace(/\p{Extended_Pictographic}/gu, '').match(EMOJI_LEFTOVER)) return !ATTENTION_EMOJI.test(t)
  if (ATTENTION_EMOJI.test(t)) return false
  const words = fold(t.replace(/\p{Extended_Pictographic}/gu, ' '))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0 || words.length > RULE_MAX_WORDS) return false
  let core = false
  for (const w of words) {
    if (ACK_CORE.has(w) || LAUGH.test(w)) core = true
    else if (!ACK_FILLER.has(w)) return false
  }
  return core
}

/** As mensagens do contato que esperam resposta são todas de agradecimento/ok/emoji? */
export function ruleSaysNoReply(repo: Repo, jid: string): { lastId: string } | null {
  const last = repo.lastMessage(jid)
  if (!last || last.fromMe) return null
  const run = repo.latestContactRun(jid, RULE_MAX_MESSAGES)
  if (run.more || run.messages.length === 0 || !run.messages.every(isAckOnly)) return null
  return { lastId: last.id }
}

/**
 * Aplica a regra (sem IA) à conversa: grava "não precisa responder" para a última mensagem do contato quando ela
 * fecha o assunto. Não mexe numa decisão da IA ou do mentor sobre a mesma mensagem. `true` se algo mudou.
 */
export function applyReplyRule(repo: Repo, jid: string): boolean {
  const hit = ruleSaysNoReply(repo, jid)
  if (!hit) return false
  const cur = repo.getReplyCheck(jid)
  if (cur && cur.msgId === hit.lastId && (cur.appSource === 'ai' || cur.userNeeds !== null)) return false
  return repo.setAppReply({ jid, msgId: hit.lastId, needs: false, reason: RULE_REASON, source: 'rule' })
}

/** As últimas mensagens do contato (as que esperavam resposta), como a IA as lê: o trecho da avaliação. */
export function replyContext(repo: Repo, jid: string): string {
  const run = repo.latestContactRun(jid, CONTEXT_MESSAGES)
  const isGroup = repo.isGroup(jid)
  const text = run.messages.map((m) => render(m, isGroup)).join('\n')
  return text.length > CONTEXT_TEXT_MAX ? text.slice(-CONTEXT_TEXT_MAX) : text
}

export class ReplyFeedbackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplyFeedbackError'
  }
}

const clean = (s: string | null | undefined): string | null => {
  const t = s?.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, REASON_TEXT_MAX) : null
}

/** O que o Saga achava da última mensagem do contato (vai para a avaliação). */
interface AppView {
  appNeeds: boolean | null
  appReason: string | null
  /** 'rule' | 'ai' | 'group' */
  appSource: string | null
  model: string | null
}

/**
 * A última mensagem do contato e o que o Saga tinha decidido sobre ela. A regra do grupo (o mentor escreveu num grupo
 * do contato depois da mensagem dele) vence a regra de agradecimento e a IA, como na lista.
 */
function current(repo: Repo, jid: string): { last: MessageRow; app: AppView } {
  const last = repo.lastMessage(jid)
  if (!last || last.fromMe) throw new ReplyFeedbackError('a conversa não está esperando resposta')
  const group = repo.groupAnswer(jid)
  if (group) {
    return { last, app: { appNeeds: false, appReason: groupAnswerReason(group), appSource: 'group', model: null } }
  }
  const cur = repo.getReplyCheck(jid)
  const same = cur && cur.msgId === last.id ? cur : null
  return {
    last,
    app: {
      appNeeds: same?.appNeeds ?? null,
      appReason: same?.appReason ?? null,
      appSource: same?.appSource ?? null,
      model: same?.model ?? null
    }
  }
}

/**
 * O mentor diz se a conversa precisa de resposta (vale até chegar outra mensagem do contato) e a avaliação é gravada:
 * `false` ("Não precisa responder", com o motivo) tira da lista e resolve o "esperando"; `true` ("Precisa sim", ou 👍 no
 * "esperando") devolve/mantém na lista. `alertId`: o "esperando" de onde veio a avaliação. `true` se algo mudou.
 */
export function setNeedsReply(repo: Repo, jid: string, needed: boolean, reason?: ReplyReason, alertId: number | null = null): boolean {
  if (!needed && !reason) throw new ReplyFeedbackError('falta o motivo')
  const { last, app } = current(repo, jid)
  if (alertId === null && !needed) alertId = repo.listAlerts(jid).find((a) => a.kind === 'esperando')?.id ?? null
  repo.saveReplyFeedback({
    jid,
    msgId: last.id,
    alertId,
    verdict: needed ? 'reply_needed' : 'reply_not_needed',
    ...app,
    reasonCode: needed ? null : reason!.code,
    reasonText: needed ? null : clean(reason!.text),
    contextText: replyContext(repo, jid)
  })
  let changed = repo.setUserReply(jid, last.id, needed)
  if (!needed) changed = repo.dismissAlert(jid, 'esperando') || changed
  return changed
}

/** 👍 no "O Saga acha que esta conversa não precisa de resposta": grava `reply_ok` (fica fora da lista). */
export function confirmNoReply(repo: Repo, jid: string): boolean {
  const { last, app } = current(repo, jid)
  if (app.appNeeds !== false) throw new ReplyFeedbackError('o Saga não decidiu que esta conversa dispensa resposta')
  repo.saveReplyFeedback({
    jid,
    msgId: last.id,
    alertId: null,
    verdict: 'reply_ok',
    ...app,
    reasonCode: null,
    reasonText: null,
    contextText: replyContext(repo, jid)
  })
  return repo.setUserReply(jid, last.id, false)
}

// --- aprendizado ---

/** Motivos que não dizem nada sobre as mensagens (o mentor respondeu em outro lugar): não viram exemplo para a IA. */
const ANSWERED_ELSEWHERE = new Set(['respondi_grupo', 'ligacao'])

/** Serve de exemplo? "Respondi no grupo dele" e "Respondi por ligação/pessoalmente" não dizem nada sobre as mensagens. */
const teaches = (f: ReplyFeedbackRow): boolean => f.contextText.trim() !== '' && !ANSWERED_ELSEWHERE.has(f.reasonCode ?? '')

/** Até 4 avaliações recentes para o prompt do classify: primeiro as da mesma conversa. */
export function selectReplyExamples(repo: Repo, jid: string, max = REPLY_EXAMPLES_MAX): ReplyFeedbackRow[] {
  const pool = repo.listReplyFeedback({ limit: 200 }).filter(teaches)
  return [...pool.filter((f) => f.jid === jid), ...pool.filter((f) => f.jid !== jid)].slice(0, max)
}

function snippet(context: string): string {
  const t = context.replace(/\s*\n+\s*/g, ' / ').replace(/\s+/g, ' ').trim()
  return t.length > EXAMPLE_CONTEXT_MAX ? `…${t.slice(-(EXAMPLE_CONTEXT_MAX - 1)).trimStart()}` : t
}

function replyVerdictLine(f: ReplyFeedbackRow): string {
  const note = f.reasonText ? ` (comentário do mentor: "${f.reasonText.slice(0, 200)}")` : ''
  if (f.verdict === 'reply_needed') return `→ o mentor PRECISAVA responder${note}`
  const why = f.reasonCode ? `: ${REPLY_REASON_LABELS[f.reasonCode].toLowerCase()}` : ''
  return `→ o mentor NÃO precisava responder${why}${note}`
}

/** Bloco de exemplos do "Para responder" para o prompt (vazio sem exemplos). */
export function renderReplyExamples(rows: ReplyFeedbackRow[]): string {
  if (rows.length === 0) return ''
  return [
    'Correções anteriores do mentor sobre precisar ou não de resposta (exemplos para calibrar "needsReply"):',
    ...rows.map((f) => `Exemplo: mensagens "${snippet(f.contextText)}" ${replyVerdictLine(f)}.`)
  ].join('\n')
}

/** O Saga acertou nesta avaliação? (o que ele achava na hora × o que o mentor disse; sem decisão = "precisa") */
export function sagaWasRight(f: Pick<ReplyFeedbackRow, 'verdict' | 'appNeeds'>): boolean {
  const sagaNeeds = f.appNeeds !== false
  if (f.verdict === 'reply_ok') return true
  return f.verdict === 'reply_needed' ? sagaNeeds : !sagaNeeds
}

/** "Para responder" nos últimos 30 dias: removidos pelo mentor, devolvidos, confirmados e % de acerto do Saga. */
export function replyQuality(repo: Repo, now: number): ReplyQuality {
  const rows = repo.listReplyFeedback({ since: now - QUALITY_DAYS * 86_400_000 })
  const right = rows.filter(sagaWasRight).length
  return {
    removed: rows.filter((f) => f.verdict === 'reply_not_needed').length,
    restored: rows.filter((f) => f.verdict === 'reply_needed' && f.appNeeds === false).length,
    confirmed: rows.filter((f) => f.verdict === 'reply_ok' || (f.verdict === 'reply_needed' && f.appNeeds !== false)).length,
    correctRate: rows.length ? right / rows.length : null
  }
}

/** Detalhe da linha no CSV: o que o Saga achava. */
export function replyCsvDetail(f: ReplyFeedbackRow): string {
  if (f.appNeeds === null) return 'Saga: deixou em "Para responder"'
  if (f.appSource === 'group') return `Saga (grupo): não precisa responder${f.appReason ? ` — ${f.appReason}` : ''}`
  const by = f.appSource === 'rule' ? 'regra' : 'IA'
  return f.appNeeds ? `Saga (${by}): precisa responder` : `Saga (${by}): não precisa responder${f.appReason ? ` — ${f.appReason}` : ''}`
}

export { REPLY_VERDICT_LABELS }
