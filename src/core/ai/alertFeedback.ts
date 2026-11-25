/**
 * Avaliação dos alertas (v0.2.1): o mentor marca 👍/👎 em cada alerta da IA e avisa quando faltou um.
 * Cada avaliação guarda a janela de mensagens que a IA viu, então vira um exemplo rotulado completo:
 * - alimenta o prompt do `classify` (até 6 exemplos recentes, curtos);
 * - um 👎 impede a IA de recriar o mesmo tipo de alerta para a mesma mensagem;
 * - as contagens aparecem em "Qualidade dos alertas" e tudo pode ser exportado em CSV.
 */
import type { AlertKind, FeedbackRow, MessageRow, Repo } from '../db/repo'
import { AI_ALERT_KINDS } from '../../shared/triage'
import {
  KIND_LABELS,
  REASON_LABELS,
  REASON_TEXT_MAX,
  VERDICT_LABELS,
  type AlertQuality,
  type RateReason,
  type Verdict
} from '../../shared/feedback'
import { render } from './prompt'

/** exemplos no prompt do classify */
export const EXAMPLES_MAX = 6
/** dos quais, no máximo estes 👍 */
export const EXAMPLES_UP_MAX = 2
/** tamanho máximo do trecho de cada exemplo no prompt */
export const EXAMPLE_CONTEXT_MAX = 400
/** janela das estatísticas */
export const QUALITY_DAYS = 30
/** mensagens na janela de contexto montada na hora (alerta antigo sem janela guardada, "Faltou um alerta?") */
const CONTEXT_MESSAGES = 8
const CONTEXT_TEXT_MAX = 6000
/** detalhe do alerta criado pelo mentor quando ele não escreve nada */
export const USER_ALERT_DETAIL = 'Marcado por você'

const clean = (s: string | null | undefined): string | null => {
  const t = s?.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, REASON_TEXT_MAX) : null
}

/**
 * Janela de mensagens até `msgId` (ou até a última), como a IA as lê ("Mentorado: …").
 * Para alertas sem janela guardada e para "Faltou um alerta?".
 */
export function contextFor(repo: Repo, jid: string, msgId: string | null): string {
  const all = repo.listMessages(jid, 300)
  let end = all.length
  if (msgId) {
    const i = all.findIndex((m) => m.id === msgId)
    if (i >= 0) end = i + 1
  }
  const isGroup = repo.isGroup(jid)
  const win: MessageRow[] = all.slice(Math.max(0, end - CONTEXT_MESSAGES), end)
  const text = win.map((m) => render(m, isGroup)).join('\n')
  return text.length > CONTEXT_TEXT_MAX ? text.slice(-CONTEXT_TEXT_MAX) : text
}

export class FeedbackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedbackError'
  }
}

/**
 * 👍 ou 👎 num alerta. 👍: o alerta continua até ser resolvido. 👎: grava o motivo, resolve o alerta e, se o mentor
 * escolheu o tipo certo, cria esse alerta (marcado como dele). Mudar de ideia atualiza a mesma avaliação.
 * Devolve `true` se os alertas ativos mudaram.
 */
export function rateAlert(repo: Repo, alertId: number, verdict: 'up' | 'down', reason?: RateReason): boolean {
  const a = repo.getAlert(alertId)
  if (!a) throw new FeedbackError('alerta não encontrado')
  if (verdict === 'down' && !reason) throw new FeedbackError('falta o motivo')
  const correctKind = verdict === 'down' && reason?.code === 'tipo_errado' && reason.correctKind && reason.correctKind !== a.kind ? reason.correctKind : null
  repo.saveFeedback({
    alertId: a.id,
    jid: a.jid,
    kind: a.kind,
    msgId: a.msgId,
    verdict,
    reasonCode: verdict === 'down' ? reason!.code : null,
    reasonText: verdict === 'down' ? clean(reason!.text) : null,
    correctKind,
    contextText: a.contextText ?? contextFor(repo, a.jid, a.msgId),
    detail: a.detail,
    model: a.model
  })
  if (verdict === 'up') return false
  let changed = repo.dismissAlertById(a.id)
  if (correctKind) {
    changed =
      repo.upsertAlert({
        jid: a.jid,
        kind: correctKind,
        detail: clean(reason!.text)?.slice(0, 120) ?? USER_ALERT_DETAIL,
        msgId: a.msgId,
        source: 'user',
        contextText: a.contextText
      }) || changed
  }
  return changed
}

/** "Faltou um alerta?": grava o exemplo (verdict 'missed') e cria o alerta, marcado como do mentor. */
export function reportMissedAlert(repo: Repo, jid: string, kind: AlertKind, msgId: string | null, text: string | null): boolean {
  if (!AI_ALERT_KINDS.includes(kind)) throw new FeedbackError('tipo de alerta inválido')
  if (msgId !== null && repo.getMessage(msgId)?.jid !== jid) throw new FeedbackError('mensagem não encontrada')
  const note = clean(text)
  repo.saveFeedback({
    alertId: null,
    jid,
    kind,
    msgId,
    verdict: 'missed',
    reasonCode: null,
    reasonText: note,
    correctKind: null,
    contextText: contextFor(repo, jid, msgId),
    detail: '',
    model: null
  })
  if (repo.listAlerts(jid).some((a) => a.kind === kind)) return false
  return repo.upsertAlert({ jid, kind, detail: note?.slice(0, 120) ?? USER_ALERT_DETAIL, msgId, source: 'user' })
}

/** Serve de exemplo? "Já foi resolvido" não diz nada sobre a mensagem (o mentor resolveu por outro caminho). */
const teaches = (f: FeedbackRow): boolean => f.contextText.trim() !== '' && !(f.verdict === 'down' && f.reasonCode === 'resolvido')

/**
 * Até 6 avaliações recentes para o prompt: primeiro as da mesma conversa, depois as outras alternando os tipos
 * (cada tipo aparece); no máximo 2 👍, o resto 👎 com motivo e "faltou".
 */
export function selectAlertExamples(repo: Repo, jid: string, max = EXAMPLES_MAX): FeedbackRow[] {
  const pool = repo.listFeedback({ limit: 300 }).filter(teaches)
  const isUp = (f: FeedbackRow) => f.verdict === 'up'
  const same = pool.filter((f) => f.jid === jid)
  const others = pool.filter((f) => f.jid !== jid)
  const ups = [...same.filter(isUp), ...others.filter(isUp)].slice(0, Math.min(EXAMPLES_UP_MAX, max))
  const cap = max - ups.length
  const corrective = same.filter((f) => !isUp(f)).slice(0, cap)
  // outras conversas: um de cada tipo por vez, do mais novo para o mais antigo
  const byKind = new Map<AlertKind, FeedbackRow[]>()
  for (const f of others.filter((f) => !isUp(f))) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f])
  const queues = [...byKind.values()]
  for (let i = 0; corrective.length < cap && queues.some((q) => i < q.length); i++) {
    for (const q of queues) if (i < q.length && corrective.length < cap) corrective.push(q[i])
  }
  return [...corrective, ...ups]
}

/** Trecho curto numa linha: o fim da janela (as mensagens mais novas, onde está o sinal). */
function snippet(context: string): string {
  const t = context.replace(/\s*\n+\s*/g, ' / ').replace(/\s+/g, ' ').trim()
  return t.length > EXAMPLE_CONTEXT_MAX ? `…${t.slice(-(EXAMPLE_CONTEXT_MAX - 1)).trimStart()}` : t
}

function verdictLine(f: FeedbackRow): string {
  const note = f.reasonText ? ` (comentário do mentor: "${f.reasonText.slice(0, 200)}")` : ''
  if (f.verdict === 'missed') return `→ deveria ter alertado "${f.kind}"${note}`
  if (f.verdict === 'up') return `→ alerta "${f.kind}" estava CERTO`
  const why = f.reasonCode ? REASON_LABELS[f.reasonCode].toLowerCase() : 'não informado'
  const right = f.reasonCode === 'tipo_errado' ? `; o certo seria ${f.correctKind ? `"${f.correctKind}"` : 'nenhum alerta'}` : ''
  return `→ alerta "${f.kind}" estava ERRADO porque: ${why}${right}${note}`
}

/** Bloco de exemplos para o prompt (vazio sem exemplos). */
export function renderAlertExamples(rows: FeedbackRow[]): string {
  if (rows.length === 0) return ''
  return [
    'Avaliações anteriores do mentor (exemplos para calibrar; não são as mensagens a analisar):',
    ...rows.map((f) => `Exemplo: mensagens "${snippet(f.contextText)}" ${verdictLine(f)}.`)
  ].join('\n')
}

/** Contagens por tipo nos últimos 30 dias, com a taxa de acerto 👍/(👍+👎). */
export function alertQuality(repo: Repo, now: number): AlertQuality {
  const since = now - QUALITY_DAYS * 86_400_000
  const counts = repo.feedbackCounts(since)
  const n = (kind: AlertKind, v: Verdict) => counts.find((c) => c.kind === kind && c.verdict === v)?.n ?? 0
  return {
    since,
    days: QUALITY_DAYS,
    kinds: AI_ALERT_KINDS.map((kind) => {
      const up = n(kind, 'up')
      const down = n(kind, 'down')
      return { kind, up, down, missed: n(kind, 'missed'), correctRate: up + down > 0 ? up / (up + down) : null }
    })
  }
}

// --- exportação (CSV) ---

export const CSV_COLUMNS = ['data', 'tipo', 'avaliação', 'motivo', 'motivo_texto', 'tipo_correto', 'conversa', 'trecho', 'detalhe', 'modelo'] as const

/** Campo de CSV: entre aspas, aspas dobradas; começo com = + - @ ganha ' (o Excel não executa fórmula). */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return `"${safe.replace(/"/g, '""')}"`
}

const pad = (n: number) => String(n).padStart(2, '0')
/** "2026-11-25 14:03" no fuso do computador (o Excel entende como data e hora). */
export function csvDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * CSV das avaliações (UTF-8 com BOM e ";" como separador, como o Excel em português espera).
 * `anonymize`: o nome da conversa vira "Contato 1", "Contato 2"… (o mesmo número para a mesma conversa).
 */
export function feedbackCsv(rows: FeedbackRow[], nameOf: (jid: string) => string, anonymize: boolean): string {
  const pseudo = new Map<string, string>()
  const who = (jid: string): string => {
    if (!anonymize) return nameOf(jid)
    if (!pseudo.has(jid)) pseudo.set(jid, `Contato ${pseudo.size + 1}`)
    return pseudo.get(jid)!
  }
  const lines = [CSV_COLUMNS.join(';')]
  for (const f of [...rows].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)) {
    lines.push(
      [
        csvDate(f.createdAt),
        KIND_LABELS[f.kind],
        VERDICT_LABELS[f.verdict],
        f.reasonCode ? REASON_LABELS[f.reasonCode] : '',
        f.reasonText ?? '',
        f.reasonCode === 'tipo_errado' ? (f.correctKind ? KIND_LABELS[f.correctKind] : 'Nenhum') : '',
        who(f.jid),
        f.contextText,
        f.detail,
        f.model ?? ''
      ]
        .map(csvCell)
        .join(';')
    )
  }
  return `﻿${lines.join('\r\n')}\r\n`
}
