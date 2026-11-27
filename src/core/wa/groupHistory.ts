/**
 * v0.8.3: "Buscar no celular o histórico dos grupos". O WhatsApp só manda o histórico ao vincular o aparelho; para os
 * grupos que já têm alguma mensagem aqui, o celular manda as anteriores sob pedido (`fetchMessageHistory`, o mesmo pedido
 * que o WhatsApp Web faz ao rolar uma conversa para cima: uma mensagem do próprio aparelho para o próprio celular, que
 * ninguém mais vê). A resposta chega como `messaging-history.set` do tipo ON_DEMAND e é gravada pela ingestão normal.
 * v0.9.0 (contrato v1.3): "Buscar no celular o histórico completo dos mentorados": conversas individuais e grupos de
 * mentorados, até o celular não ter mais nada antes da mais antiga (sem o limite dos 30 dias, que vale só para o que vai
 * ao Copiloto e para a IA). Mesmo ritmo e mesmos limites.
 *
 * Aqui ficam o estado (gravado no banco: vale entre reinícios) e os limites: no máximo um pedido a cada 20 s e 60 por
 * dia local, contados no banco. Sem rede nenhuma: quem pede é o cliente, pela fila (job `fetch_history`).
 */
import type { Repo } from '../db/repo'
import type { GroupHistoryFetchView } from '../../shared/copiloto'

const DAY = 86_400_000

export const GROUP_HISTORY_LIMITS = {
  /** mensagens por pedido (o máximo que o celular atende) */
  batch: 50,
  /** no mínimo isto entre dois pedidos */
  gapMs: 20_000,
  /** pedidos por dia local (gravado no banco) */
  perDay: 60,
  /** sem resposta do celular em 60 s: o pedido conta como perdido */
  responseWaitMs: 60_000,
  /** perdidos seguidos (qualquer grupo): o celular está desligado ou sem internet; a busca para até o mentor pedir de novo */
  maxMisses: 3,
  /** perdidos seguidos no mesmo grupo: desiste dele */
  maxGroupMisses: 2,
  /** só com a conexão aberta há este tempo */
  stableMs: 60_000,
  /** a mais antiga já está a menos disto do limite (`target`): a conversa está completa */
  doneMarginMs: 60 * 60_000
} as const

/**
 * v0.9.0: as conversas em que o celular já disse que não tem nada antes da mais antiga guardada (jid → id dessa
 * mensagem). Enquanto a mais antiga for a mesma, uma busca nova não pede de novo.
 */
export const GROUP_HISTORY_EXHAUSTED = 'wa.historyExhausted'

export function loadExhausted(repo: Repo): Record<string, string> {
  try {
    const v = JSON.parse(repo.getSetting(GROUP_HISTORY_EXHAUSTED) ?? '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function markExhausted(repo: Repo, jid: string, anchorId: string): void {
  const cur = loadExhausted(repo)
  cur[jid] = anchorId
  repo.setSetting(GROUP_HISTORY_EXHAUSTED, JSON.stringify(cur))
}

/** A conversa ainda pode ter histórico no celular (nunca chegou ao fim, ou chegou com outra mensagem mais antiga). */
export function mayHaveOlder(repo: Repo, jid: string, oldestId: string): boolean {
  return loadExhausted(repo)[jid] !== oldestId
}

/** o estado da busca (JSON) */
export const GROUP_HISTORY_RUN = 'wa.groupHistoryRun'
/** quando cada pedido saiu (epoch ms; só os de hoje e o último) */
export const GROUP_HISTORY_LOG = 'wa.groupHistoryLog'

/**
 * A unidade do horário do pedido: o protocolo chama o campo de `oldestMsgTimestampMs`, mas o exemplo do Baileys passa
 * segundos. Começa em milissegundos; sem resposta, o mesmo ponto vai de novo em segundos; a primeira unidade que trouxer
 * resposta fica gravada e vale daí em diante.
 */
export type HistoryTsUnit = 'ms' | 's'
export const HISTORY_TS_UNIT = 'wa.historyTsUnit'

export function savedTsUnit(repo: Repo): HistoryTsUnit | null {
  const v = repo.getSetting(HISTORY_TS_UNIT)
  return v === 'ms' || v === 's' ? v : null
}

export const tsForUnit = (ts: number, unit: HistoryTsUnit): number => (unit === 's' ? Math.floor(ts / 1000) : ts)

/** A mensagem a partir da qual o celular manda as anteriores (a mais antiga conhecida do grupo). */
export interface HistoryAnchor {
  id: string
  fromMe: boolean
  /** epoch ms */
  ts: number
  participant?: string
}

export interface GroupHistoryGroup {
  s: 'pending' | 'done' | 'gave_up'
  anchor?: HistoryAnchor
  misses: number
  /** a unidade ainda não é conhecida e o pedido em milissegundos ficou sem resposta: o próximo deste ponto vai em segundos */
  nextUnit?: HistoryTsUnit
}

export interface GroupHistoryRun {
  state: GroupHistoryFetchView['state']
  startedAt: number
  finishedAt: number | null
  /** até onde buscar (epoch ms). v0.9.0: 0 = todo o histórico que o celular tiver */
  target: number
  order: string[]
  groups: Record<string, GroupHistoryGroup>
  noAnchor: number
  requests: number
  received: number
  /** o pedido que espera resposta */
  pending: { jid: string; anchorId: string; at: number; unit?: HistoryTsUnit } | null
  /** pedidos seguidos sem resposta */
  misses: number
}

export function loadRun(repo: Repo): GroupHistoryRun | null {
  try {
    const v = JSON.parse(repo.getSetting(GROUP_HISTORY_RUN) ?? 'null') as GroupHistoryRun | null
    if (!v || typeof v !== 'object' || !Array.isArray(v.order) || typeof v.groups !== 'object' || !v.groups) return null
    return v
  } catch {
    return null
  }
}

export function saveRun(repo: Repo, run: GroupHistoryRun): void {
  repo.setSetting(GROUP_HISTORY_RUN, JSON.stringify(run))
}

export function newRun(now: number, target: number, jids: string[], noAnchor: number): GroupHistoryRun {
  const order = [...new Set(jids)]
  return {
    state: order.length ? 'running' : 'done',
    startedAt: now,
    finishedAt: order.length ? null : now,
    target,
    order,
    groups: Object.fromEntries(order.map((j) => [j, { s: 'pending', misses: 0 } as GroupHistoryGroup])),
    noAnchor,
    requests: 0,
    received: 0,
    pending: null,
    misses: 0
  }
}

/** meia-noite (local) do dia de `now` */
export const localDayStart = (now: number): number => {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function requestLog(repo: Repo): number[] {
  try {
    const v = JSON.parse(repo.getSetting(GROUP_HISTORY_LOG) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : []
  } catch {
    return []
  }
}

/** Pedidos feitos hoje (dia local). */
export function requestsToday(repo: Repo, now: number): number {
  const day = localDayStart(now)
  return requestLog(repo).filter((t) => t >= day && t <= now + DAY).length
}

/** Quando o próximo pedido pode sair (epoch ms): 20 s depois do último e, com o dia esgotado, a meia-noite seguinte. */
export function nextRequestAt(repo: Repo, now: number): number {
  const past = requestLog(repo).filter((t) => t <= now + DAY)
  let at = past.length ? Math.max(...past) + GROUP_HISTORY_LIMITS.gapMs : now
  if (requestsToday(repo, now) >= GROUP_HISTORY_LIMITS.perDay) {
    const d = new Date(now)
    at = Math.max(at, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime())
  }
  return at
}

/** Grava um pedido (antes de ele sair: um pedido que trava ainda conta). */
export function recordRequest(repo: Repo, now: number): void {
  const day = localDayStart(now)
  const keep = requestLog(repo).filter((t) => t >= Math.min(day, now - GROUP_HISTORY_LIMITS.gapMs) && t <= now)
  repo.setSetting(GROUP_HISTORY_LOG, JSON.stringify([...keep, now]))
}

/** Até onde buscar. v0.9.0: todo o histórico que o celular tiver (antes: 30 dias atrás). */
export function historyTarget(_repo: Repo, _now: number): number {
  return 0
}

/** A mensagem guardada mais antiga do grupo como ponto de partida, ou null. */
export function oldestAnchor(repo: Repo, jid: string): HistoryAnchor | null {
  const m = repo.oldestMessage(jid)
  if (!m) return null
  let participant: string | undefined
  try {
    const k = m.waKeyJson ? (JSON.parse(m.waKeyJson) as { participant?: unknown }) : null
    if (typeof k?.participant === 'string') participant = k.participant
  } catch {
    // sem a chave original: o pedido vai sem o participante (o celular acha pela id)
  }
  return { id: m.id, fromMe: m.fromMe, ts: m.ts, ...(participant ? { participant } : {}) }
}

/** A conversa já tem mensagem até (quase) o limite (`target`; com 0, nunca: vale a resposta vazia do celular). */
export const reachedTarget = (ts: number, target: number): boolean => ts - target <= GROUP_HISTORY_LIMITS.doneMarginMs

/** Para a tela (só contagens). */
export function runView(repo: Repo, now: number): GroupHistoryFetchView | null {
  const run = loadRun(repo)
  if (!run) return null
  const groups = run.order.length
  const done = run.order.filter((j) => run.groups[j] && run.groups[j].s !== 'pending').length
  return {
    state: run.state,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    groups,
    done,
    requests: run.requests,
    received: run.received,
    noAnchor: run.noAnchor,
    capped: run.state === 'running' && requestsToday(repo, now) >= GROUP_HISTORY_LIMITS.perDay
  }
}
