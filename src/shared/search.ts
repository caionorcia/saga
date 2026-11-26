/**
 * Busca geral (v0.3.1): procurar em todas as conversas e transcrições ("quem falou sobre precificação?").
 * Só tipos e constantes (usados pelo core, pelo processo principal e pela interface).
 */
import type { AiErrorCode } from './api'

export type SearchKind = 'all' | 'individual' | 'group'
export type SearchPeriod = '7d' | '30d' | 'all'

export const SEARCH_KINDS: ReadonlyArray<SearchKind> = ['all', 'individual', 'group']
export const SEARCH_PERIODS: ReadonlyArray<SearchPeriod> = ['7d', '30d', 'all']
export const SEARCH_PERIOD_DAYS: Record<SearchPeriod, number | null> = { '7d': 7, '30d': 30, all: null }

export interface SearchFilters {
  /** todas, só individuais ou só grupos (padrão: todas) */
  kind?: SearchKind
  /** últimos 7 dias, 30 dias ou tudo (padrão: tudo) */
  period?: SearchPeriod
  /** só áudios (procura nas transcrições) */
  audioOnly?: boolean
  /** uma conversa específica (jid); null/ausente = todas */
  jid?: string | null
}

export const SEARCH_LIMITS = {
  /** tamanho máximo do texto procurado */
  queryChars: 200,
  /** mensagens trazidas no total */
  maxHits: 300,
  /** por conversa, na lista de resultados */
  hitsPerGroup: 20,
  /** trechos mandados à IA no "Resumir com IA" */
  summarySnippets: 30,
  /** caracteres por trecho mandado à IA */
  summarySnippetChars: 240
} as const

/** Trecho da mensagem com as palavras encontradas: `ranges` são [início, fim) em `text` (para destacar). */
export interface SearchSnippet {
  text: string
  ranges: Array<[number, number]>
  /** o trecho começa depois do início da mensagem (mostrar "…") */
  cutStart: boolean
  /** o trecho termina antes do fim da mensagem */
  cutEnd: boolean
}

export interface SearchHit {
  /** id da mensagem (para abrir a conversa e destacar) */
  id: string
  jid: string
  /** epoch ms (horário do WhatsApp) */
  ts: number
  fromMe: boolean
  kind: 'text' | 'audio' | 'other'
  /** grupo: quem mandou (nome para exibir); null nas minhas e em conversas individuais */
  senderName: string | null
  snippet: SearchSnippet
}

export interface SearchGroup {
  jid: string
  name: string
  isGroup: boolean
  /** quantas mensagens dessa conversa combinam (pode passar de `hits.length`) */
  count: number
  /** as mais novas primeiro */
  hits: SearchHit[]
}

export interface SearchResult {
  /**
   * `and` todas as palavras; `or` nenhuma mensagem tinha todas, então vale qualquer uma; `empty` a pergunta não tem
   * palavras para procurar (só "quem", "falou", "sobre"…)
   */
  mode: 'and' | 'or' | 'empty'
  /** as palavras procuradas (sem acento, depois de tirar "quem", "falou", "sobre"…) */
  terms: string[]
  /** mensagens encontradas (todas as conversas) */
  total: number
  /** conversas, a mais relevante primeiro */
  groups: SearchGroup[]
  tookMs: number
}

export type SearchSummaryResult =
  | {
      ok: true
      /** resposta curta, em pt-BR */
      answer: string
      /** conversas citadas na resposta (para abrir) */
      refs: Array<{ jid: string; name: string }>
      /** quantos trechos foram mandados à IA */
      used: number
    }
  | { ok: false; code: AiErrorCode | 'no_results'; message: string }
