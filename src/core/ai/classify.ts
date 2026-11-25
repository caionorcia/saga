/**
 * Alertas por conversa (v0.2.0): em segundo plano, a IA gratuita (Groq) procura sinais claros nas mensagens novas
 * de cada conversa — urgência, desânimo, pedido de reunião, dúvida travando — e grava em `alerts`.
 * Um job `classify` por conversa, pela fila, com limitador próprio (ritmo lento, sem rajada ao iniciar).
 * Nunca usa o Claude (pago) em segundo plano: sem chave da Groq, não há alertas da IA.
 */
import type { Clock } from '../clock'
import { AI_ALERT_KINDS, type AlertKind, type MessageRow, type Repo } from '../db/repo'
import { DeferJobError } from '../queue/queue'
import type { CostTracker } from './budget'
import { ModelUnavailableError } from './groqModels'
import { LlmRateLimitError, type LlmProvider } from './llm'
import { InvalidOutputError, extractJson, render } from './prompt'
import { InvalidKeyError, isNetworkError } from './transcriber'
import { renderAlertExamples, selectAlertExamples } from './alertFeedback'

/** no máximo estas mensagens novas do contato por chamada */
export const CLASSIFY_MAX_NEW = 20
/** mensagens anteriores (de qualquer lado) como contexto */
export const CLASSIFY_PRIOR = 6
/** mensagens mais antigas que isto não geram alerta (ex.: histórico de 30 dias ao vincular) */
export const CLASSIFY_MAX_AGE_MS = 7 * 24 * 3_600_000
/** áudio recente ainda sem transcrição: espera a transcrição (até este tempo depois do áudio) */
export const CLASSIFY_AUDIO_WAIT_MS = 30 * 60_000
const AUDIO_RETRY_MS = 2 * 60_000
const NETWORK_RETRY_MS = 2 * 60_000
export const ALERT_DETAIL_MAX = 120
/** quando o mentor responde, estes alertas se resolvem sozinhos; "desanimo" fica até ser resolvido à mão */
export const RESOLVED_BY_REPLY: ReadonlyArray<AlertKind> = ['urgente', 'travado', 'reuniao', 'esperando']

export interface ClassifyWindow {
  /** mensagens do contato ainda não olhadas (até 20, dos últimos 7 dias) */
  newMessages: MessageRow[]
  /** contexto: até 6 mensagens antes da primeira nova */
  prior: MessageRow[]
  /** última mensagem da conversa (marca até onde já se olhou), ou null */
  last: MessageRow | null
}

/** As mensagens do contato desde a última verificação (por id; se o id sumiu, pelo horário). */
export function classifyWindow(repo: Repo, jid: string, now: number): ClassifyWindow {
  const all = repo.listMessages(jid, 300)
  const check = repo.getAlertCheck(jid)
  let start = 0
  if (check) {
    const idx = all.findIndex((m) => m.id === check.lastMsgId)
    if (idx >= 0) start = idx + 1
    else {
      const t = all.findIndex((m) => m.ts > check.lastTs)
      start = t >= 0 ? t : all.length
    }
  }
  const fresh = all.slice(start).filter((m) => !m.fromMe && m.ts >= now - CLASSIFY_MAX_AGE_MS)
  const newMessages = fresh.slice(-CLASSIFY_MAX_NEW)
  const firstIdx = newMessages.length ? all.indexOf(newMessages[0]) : all.length
  return {
    newMessages,
    prior: all.slice(Math.max(0, firstIdx - CLASSIFY_PRIOR), firstIdx),
    last: all[all.length - 1] ?? null
  }
}

const SYSTEM = `Você ajuda um mentor a não deixar passar sinais importantes nas conversas de WhatsApp com os mentorados dele.
Leia as mensagens novas e diga se há algum destes sinais, apenas quando forem CLAROS:
- "urgente": pedido com urgência ou com prazo próximo (ex.: "preciso até amanhã", "é urgente").
- "desanimo": desânimo, frustração, vontade de desistir, reclamação ou insatisfação.
- "reuniao": pedido de reunião, ligação, chamada, ou de marcar ou remarcar horário.
- "travado": dúvida ou problema que está impedindo a pessoa de avançar.

Regras:
- Responda SOMENTE com um objeto JSON, sem texto fora dele, neste formato exato:
  {"alerts": [{"kind": string, "detail": string, "messageId": number}]}
- Sem sinal claro, responda {"alerts": []}. Na dúvida, não marque. Conversa comum, agradecimento ou pergunta simples não é alerta.
- No máximo um alerta por tipo.
- "detail": até 120 caracteres, em português do Brasil (pt-BR), dizendo o quê e por quê (ex.: "Pede para remarcar a reunião para sexta de manhã").
- "messageId": o número (#) da mensagem nova que mostra o sinal.
- A conversa anterior serve só de contexto: marque apenas sinais das mensagens novas (as com #).
- Áudios aparecem transcritos; "[áudio indisponível]" não tem conteúdo.`

const SYSTEM_GROUP_EXTRA = `
- Esta conversa é um GRUPO: cada mensagem aparece como "Nome: texto"; "Mentor" é o próprio mentor e "(menciona você)" marca quem mencionou o mentor ou respondeu a ele.
- Num grupo, marque só sinais dirigidos ao mentor (perguntas, pedidos, menções a ele) ou sobre a mentoria; ignore conversas entre os participantes. Diga no "detail" quem é a pessoa.`

/** A janela de mensagens como a IA a vê (guardada no alerta: vira o exemplo quando o mentor avalia). */
export function windowText(p: { isGroup: boolean; prior: MessageRow[]; newMessages: MessageRow[] }): string {
  const parts: string[] = []
  if (p.prior.length) parts.push(`Conversa anterior (só contexto):\n${p.prior.map((m) => render(m, p.isGroup)).join('\n')}`)
  parts.push(`Mensagens novas:\n${p.newMessages.map((m, i) => `#${i + 1} ${render(m, p.isGroup)}`).join('\n')}`)
  return parts.join('\n\n')
}

export function buildAlertPrompt(p: {
  contactName: string
  isGroup: boolean
  prior: MessageRow[]
  newMessages: MessageRow[]
  /** avaliações anteriores do mentor (`renderAlertExamples`), ou vazio */
  examples?: string
}): { system: string; user: string } {
  const parts: string[] = [p.isGroup ? `Grupo: ${p.contactName}` : `Mentorado: ${p.contactName}`]
  if (p.examples?.trim()) parts.push(p.examples.trim())
  parts.push(windowText(p))
  parts.push('Responda agora apenas com o JSON pedido.')
  return { system: p.isGroup ? SYSTEM + SYSTEM_GROUP_EXTRA : SYSTEM, user: parts.join('\n\n') }
}

export interface ParsedAlert {
  kind: AlertKind
  detail: string
  msgId: string | null
}

function clipDetail(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > ALERT_DETAIL_MAX ? `${t.slice(0, ALERT_DETAIL_MAX - 1).trimEnd()}…` : t
}

/** Lê a resposta da IA com cuidado: tipos desconhecidos, detalhes vazios e repetidos são descartados. */
export function parseAlerts(raw: string, newMessages: MessageRow[]): ParsedAlert[] {
  const j = extractJson(raw) as { alerts?: unknown } | null
  if (!j || typeof j !== 'object' || !Array.isArray(j.alerts)) throw new InvalidOutputError('campo "alerts" ausente')
  const out: ParsedAlert[] = []
  for (const a of j.alerts as unknown[]) {
    if (!a || typeof a !== 'object') continue
    const { kind, detail, messageId } = a as { kind?: unknown; detail?: unknown; messageId?: unknown }
    if (typeof kind !== 'string' || !(AI_ALERT_KINDS as readonly string[]).includes(kind)) continue
    if (typeof detail !== 'string' || !detail.trim()) continue
    if (out.some((o) => o.kind === kind)) continue
    const n = typeof messageId === 'number' ? messageId : typeof messageId === 'string' ? Number(messageId.replace(/^#/, '')) : NaN
    const msg = Number.isInteger(n) && n >= 1 && n <= newMessages.length ? newMessages[n - 1] : null
    out.push({ kind: kind as AlertKind, detail: clipDetail(detail), msgId: msg?.id ?? null })
  }
  return out
}

export interface ClassifyDeps {
  repo: Repo
  clock: Clock
  /** a IA gratuita (Groq), ou null sem chave da Groq: nunca o Claude */
  getLlm: () => LlmProvider | null
  cost: CostTracker
  getCapUsd: () => number
  /** registro de diagnóstico: uma linha por job, sem jid nem texto */
  diag: (kind: string, detail: string) => void
  /** os alertas da conversa mudaram */
  onChanged: (jid: string) => void
}

/**
 * Procura alertas nas mensagens novas de uma conversa. Erros da IA não viram "falha" na fila
 * (a barra de status mostraria "áudios com falha"): ficam no registro e a próxima mensagem tenta de novo.
 * Lança `DeferJobError` quando vale esperar (429, sem internet, áudio sendo transcrito, teto de gasto).
 */
export async function classifyChat(deps: ClassifyDeps, jid: string, signal?: AbortSignal): Promise<void> {
  const { repo, clock } = deps
  const t0 = Date.now()
  const log = (result: string, alerts = 0, reason?: string): void => {
    deps.diag('classify', `result=${result}${reason ? ` reason=${reason}` : ''} alerts=${alerts} ms=${Date.now() - t0}`)
  }

  const contact = repo.listContacts({ includeHidden: true }).find((c) => c.jid === jid)
  if (!contact) return log('skip', 0, 'no_contact')
  if (contact.hidden) return log('skip', 0, 'hidden')
  const llm = deps.getLlm()
  if (!llm) return log('skip', 0, 'no_groq_key')

  const now = clock.now()
  const win = classifyWindow(repo, jid, now)
  if (win.newMessages.length === 0) {
    if (win.last) repo.setAlertCheck(jid, win.last.id, win.last.ts)
    return log('skip', 0, 'nothing_new')
  }
  if (win.newMessages.some((m) => m.kind === 'audio' && m.transcriptStatus === null && m.ts > now - CLASSIFY_AUDIO_WAIT_MS)) {
    log('deferred', 0, 'audio_pending')
    throw new DeferJobError('aguardando a transcrição de um áudio', AUDIO_RETRY_MS)
  }
  if (deps.cost.overCap(deps.getCapUsd())) {
    log('deferred', 0, 'budget')
    throw new DeferJobError('teto diário de gasto atingido', deps.cost.msUntilTomorrow())
  }

  const examples = renderAlertExamples(selectAlertExamples(repo, jid))
  const prompt = buildAlertPrompt({ contactName: contact.displayName, isGroup: contact.isGroup, prior: win.prior, newMessages: win.newMessages, examples })
  let text: string
  let model: string | null = null
  try {
    const res = await llm.complete({ ...prompt, temperature: 0.2 })
    signal?.throwIfAborted()
    deps.cost.add(llm.name, res.inputTokens, res.outputTokens, res.model)
    text = res.text
    model = res.model ?? null
  } catch (e) {
    if (signal?.aborted) throw e
    if (e instanceof LlmRateLimitError) {
      log('deferred', 0, 'rate_limited')
      throw new DeferJobError('a IA pediu para esperar', e.retryAfterMs)
    }
    if (isNetworkError(e)) {
      log('deferred', 0, 'network')
      throw new DeferJobError('sem conexão com a IA', NETWORK_RETRY_MS)
    }
    if (e instanceof InvalidOutputError) text = ''
    else {
      const reason = e instanceof InvalidKeyError ? 'invalid_key' : e instanceof ModelUnavailableError ? 'model_unavailable' : 'unknown'
      return log('error', 0, reason)
    }
  }

  let alerts: ParsedAlert[]
  try {
    alerts = parseAlerts(text, win.newMessages)
  } catch {
    // saída inválida: nenhum alerta; a janela fica marcada (não repete a mesma chamada)
    if (win.last) repo.setAlertCheck(jid, win.last.id, win.last.ts)
    return log('invalid_output')
  }
  // o mentor já respondeu depois dessas mensagens: só o desânimo continua valendo
  if (win.last?.fromMe) alerts = alerts.filter((a) => !RESOLVED_BY_REPLY.includes(a.kind))
  // o mentor já disse 👎 para este tipo nesta mensagem: não volta
  alerts = alerts.filter((a) => !(a.msgId && repo.hasDownFeedback(jid, a.kind, a.msgId)))
  const contextText = windowText({ isGroup: contact.isGroup, prior: win.prior, newMessages: win.newMessages })
  let changed = false
  for (const a of alerts) changed = repo.upsertAlert({ jid, ...a, source: 'ai', contextText, model }) || changed
  if (win.last) repo.setAlertCheck(jid, win.last.id, win.last.ts)
  log('ok', alerts.length)
  if (changed) deps.onChanged(jid)
}
