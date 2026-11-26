/**
 * Busca geral: da pergunta do mentor ("quem falou sobre precificação?") às palavras procuradas, à expressão do FTS5 e
 * ao trecho com as palavras destacadas. Funções puras (sem banco).
 */
import type { SearchSnippet } from '../../shared/search'

/** Sem acento e em minúsculas, como o tokenizador `unicode61 remove_diacritics 2`. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * Palavras que não ajudam a achar nada numa pergunta (já sem acento): perguntas, verbos de "falar", artigos,
 * preposições, pronomes. Valem só fora de aspas.
 */
export const STOPWORDS: ReadonlySet<string> = new Set(
  `quem que qual quais quando onde como porque porque pq por quanto quantos quantas cade
  falou falaram falei falamos fala falam falar falando disse disseram dizer diz comentou comentaram comentar mencionou
  mencionaram citou perguntou perguntaram mandou mandaram enviou escreveu escreveram conversou conversamos tocou
  sobre alguem algum alguma alguns algumas ninguem me mim meu minha meus minhas de do da dos das em no na nos nas num numa
  um uma uns umas o a os as e ou para pra pro pros pras com sem se ja foi foram era eram eh tem tinha teve ter ha
  isso isto essa esse esta este estas estes aquele aquela aquilo mais menos muito muita pouco ele ela eles elas eu voce
  voces vc vcs nos nao sim ao aos la aqui ai entao tudo todo toda todos todas tambem ainda qualquer seu sua seus suas
  dele dela deles delas lhe nosso nossa mensagem mensagens conversa conversas assunto vez vezes ate depois antes
  hoje ontem semana mes dia dias alguma coisa coisas sobre`.split(/\s+/).filter(Boolean)
)

/** Terminações comuns do português (sem acento), da mais longa para a mais curta: "precificação" → "precifica*". */
const SUFFIXES = [
  'amentos', 'imentos', 'amento', 'imento', 'mente', 'coes', 'soes', 'cao', 'sao', 'ando', 'endo', 'indo',
  'ados', 'adas', 'idos', 'idas', 'ado', 'ada', 'ido', 'ida', 'oes', 'aes', 'ao', 'ar', 'er', 'ir', 'ou', 'am', 'em',
  'as', 'es', 'os', 's'
]
const MIN_STEM = 4

/** Corta uma terminação comum, deixando pelo menos 4 letras (a busca é por prefixo: `stem*`). */
export function stem(word: string): string {
  for (const s of SUFFIXES) {
    if (word.endsWith(s) && word.length - s.length >= MIN_STEM) return word.slice(0, -s.length)
  }
  return word
}

export interface ParsedQuery {
  /** palavras soltas (sem acento), na ordem, sem repetir */
  terms: string[]
  /** prefixos procurados de cada palavra (mesma ordem de `terms`) */
  prefixes: string[]
  /** trechos entre aspas, já em palavras sem acento */
  phrases: string[][]
}

const TOKEN = /[\p{L}\p{N}]+/gu
const MIN_TERM = 3

/** Tira as perguntas e palavras vazias; guarda as com 3 letras ou mais; aspas viram frase exata. */
export function parseQuery(q: string): ParsedQuery {
  const phrases: string[][] = []
  const rest = q.replace(/["“”]([^"“”]*)["“”]/g, (_, inner: string) => {
    const toks = fold(inner).match(TOKEN) ?? []
    if (toks.length) phrases.push(toks)
    return ' '
  })
  const terms: string[] = []
  for (const t of fold(rest).match(TOKEN) ?? []) {
    if (t.length < MIN_TERM && !/^\d+$/.test(t)) continue
    if (STOPWORDS.has(t) || terms.includes(t)) continue
    terms.push(t)
  }
  return { terms, prefixes: terms.map(stem), phrases }
}

export const isEmptyQuery = (p: ParsedQuery) => p.terms.length === 0 && p.phrases.length === 0

/** Expressão do FTS5: cada palavra como prefixo (`"precifica"*`), frases entre aspas; `and` = todas, `or` = qualquer. */
export function toFtsMatch(p: ParsedQuery, mode: 'and' | 'or'): string {
  const parts = [...p.prefixes.map((x) => `"${x}"*`), ...p.phrases.map((ph) => `"${ph.join(' ')}"`)]
  return parts.join(mode === 'and' ? ' AND ' : ' OR ')
}

/**
 * Onde as palavras procuradas aparecem no texto original: [início, fim) de cada palavra (prefixo) ou frase.
 * Feito sobre o texto sem acento, com um mapa de volta para as posições do texto original.
 */
export function matchRanges(text: string, p: ParsedQuery): Array<[number, number]> {
  // texto sem acento + posição original de cada caractere
  let folded = ''
  const map: number[] = []
  let i = 0
  for (const ch of text) {
    const f = fold(ch)
    for (let k = 0; k < f.length; k++) {
      folded += f[k]
      map.push(i)
    }
    i += ch.length
  }
  map.push(text.length)
  const toks: Array<{ t: string; s: number; e: number }> = []
  for (const m of folded.matchAll(TOKEN)) toks.push({ t: m[0], s: m.index!, e: m.index! + m[0].length })
  const out: Array<[number, number]> = []
  const orig = (s: number, e: number): [number, number] => {
    const os = map[s]
    // fim: o começo do caractere seguinte no original
    const oe = e < map.length - 1 ? map[e] : text.length
    return [os, oe > os ? oe : text.length]
  }
  for (const tk of toks) {
    if (p.prefixes.some((x) => tk.t.startsWith(x))) out.push(orig(tk.s, tk.e))
  }
  for (const ph of p.phrases) {
    for (let k = 0; k + ph.length <= toks.length; k++) {
      let ok = true
      for (let j = 0; j < ph.length; j++) {
        const want = ph[j]
        const got = toks[k + j].t
        // a última palavra da frase vale como prefixo, como no FTS5 não (exata); aqui exata
        if (got !== want) {
          ok = false
          break
        }
      }
      if (ok) out.push(orig(toks[k].s, toks[k + ph.length - 1].e))
    }
  }
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  // junta sobreposições
  const merged: Array<[number, number]> = []
  for (const r of out) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}

/**
 * Trecho de até `max` caracteres em volta da primeira palavra encontrada (começa e termina em espaço quando dá), com
 * as posições das palavras dentro do trecho.
 */
export function buildSnippet(text: string, p: ParsedQuery, max = 180): SearchSnippet {
  const clean = text.replace(/\s+/g, ' ').trim()
  const ranges = matchRanges(clean, p)
  if (clean.length <= max) return { text: clean, ranges, cutStart: false, cutEnd: false }
  const first = ranges[0]?.[0] ?? 0
  let start = Math.max(0, first - Math.floor(max / 3))
  if (start > 0) {
    const sp = clean.indexOf(' ', start)
    if (sp !== -1 && sp < first) start = sp + 1
  }
  let end = Math.min(clean.length, start + max)
  if (end < clean.length) {
    const sp = clean.lastIndexOf(' ', end)
    if (sp > start + max / 2 && sp >= (ranges[0]?.[1] ?? 0)) end = sp
  }
  const part = clean.slice(start, end)
  const inside = ranges
    .filter(([s, e]) => s < end && e > start)
    .map(([s, e]): [number, number] => [Math.max(0, s - start), Math.min(part.length, e - start)])
  return { text: part, ranges: inside, cutStart: start > 0, cutEnd: end < clean.length }
}

/** Quantas das partes procuradas (palavras e frases) aparecem no texto: para buscas em memória (pré-visualização). */
export function matchedPieces(text: string, p: ParsedQuery): number {
  let n = 0
  for (const prefix of p.prefixes) if (matchRanges(text, { terms: [], prefixes: [prefix], phrases: [] }).length) n++
  for (const ph of p.phrases) if (matchRanges(text, { terms: [], prefixes: [], phrases: [ph] }).length) n++
  return n
}
