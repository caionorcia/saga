/**
 * Busca na base de conhecimento na hora de sugerir: monta a consulta com as mensagens novas do contato,
 * escolhe até 4 trechos relevantes (até ~3.000 caracteres; "conhecimento" antes de "interno", nunca "desligado")
 * e resume as regras sempre ligadas num bloco curto (até 2.500 caracteres) para o pedido à IA.
 */
import type { KbHit, KbRepo, KbRuleChunk } from '../db/kbRepo'
import type { KbSource } from '../../shared/kb'
import { fold } from './text'

export const KB_TOP_K = 4
export const KB_MAX_CHARS = 3_000
export const KB_RULES_MAX = 2_500
const MAX_TERMS = 24
const CANDIDATES = 40
const MAX_PER_FILE = 2
/** "interno" vale menos que "conhecimento" na ordenação, e entra no máximo um */
const INTERNAL_WEIGHT = 0.6
const MAX_INTERNAL = 1

/** Palavras que não ajudam a achar o assunto (português do dia a dia, WhatsApp). */
const STOPWORDS = new Set(
  `a o e é de da do das dos em no na nos nas um uma uns umas para pra pro pros pras por pelo pela pelos pelas com sem
  que se ou mas mais menos muito muita muitos muitas pouco ja já nao não sim ai aí aqui ali la lá entao então tambem também
  so só ate até como quando onde qual quais quem quanto quanta quantos quantas porque pq por que isso isto esse essa esses essas
  este esta estes estas aquele aquela aquilo meu minha meus minhas seu sua seus suas teu tua nosso nossa dele dela deles delas
  eu tu ele ela nos nós voce você voces vocês vc vcs me te lhe mim comigo contigo gente pessoal galera
  ser sou é era foi fui sao são estou esta está estao estão estava estive tenho tem temos tinha tive ter ha há haver vou vai vamos
  ir fazer faço faz fazendo fiz feito pode posso podemos poderia queria quero quer queremos preciso precisa precisamos
  acho acha achei sei sabe saber ver vejo vi olha olhar dar dou deu dá falar falei fala dizer disse
  oi ola olá bom boa bons boas dia dias tarde noite tudo bem tranquilo beleza blz obrigado obrigada obg valeu vlw abraco abraço
  ok okay certo combinado show top legal massa kkk kkkk rs haha hahaha ne né tipo coisa coisas algo alguma algum alguns
  hoje amanha amanhã ontem agora depois antes semana mes mês ano vez vezes sempre nunca ainda mentor mentora professor
  favor ajuda ajudar duvida dúvida duvidas dúvidas pergunta perguntar sobre assim outro outra outros outras cada todo toda todos todas
  devo deve devia deveria dever coloco colocar deixo deixar uso usar consigo conseguir tava tá ta to tô fica fico ficar
  alguem alguém ninguem ninguém nada nenhum nenhuma recomenda recomendo indica indicar`
    .split(/\s+/)
    .filter(Boolean)
    .map(fold)
)

/** Abreviações e sinônimos comuns em conversas (ampliam a busca; não substituem a palavra). */
const SYNONYMS: Record<string, string[]> = {
  insta: ['instagram'],
  ig: ['instagram'],
  zap: ['whatsapp'],
  wpp: ['whatsapp'],
  whats: ['whatsapp'],
  zapzap: ['whatsapp'],
  cobrar: ['preco', 'valor'],
  cobro: ['preco', 'valor'],
  orcamento: ['preco', 'proposta'],
  valores: ['preco'],
  precificar: ['preco'],
  call: ['reuniao'],
  chamada: ['reuniao'],
  videochamada: ['reuniao'],
  reuniao: ['call'],
  bio: ['perfil', 'biografia'],
  ads: ['anuncio', 'trafego'],
  impulsionar: ['anuncio', 'trafego'],
  campanha: ['trafego', 'anuncio'],
  fechar: ['fechamento'],
  fixar: ['fixados'],
  fixos: ['fixados'],
  stories: ['story'],
  script: ['roteiro', 'mensagens'],
  roteiro: ['script'],
  reels: ['video']
}

/** terminações derivadas (o radical fica com pelo menos 5 letras) */
const DERIVED = ['amentos', 'imentos', 'amento', 'imento', 'acoes', 'icoes', 'mente', 'acao', 'icao', 'adoras', 'adores', 'adora', 'ador']
/** plural e conjugações (o radical fica com pelo menos 4 letras) */
const INFLECTED = ['ando', 'endo', 'indo', 'ados', 'adas', 'idos', 'idas', 'ado', 'ada', 'ido', 'ida', 'oes', 'aes', 'ais', 'eis', 'ar', 'er', 'ir', 'es', 's']

/** Radical simples (português): tira plural, conjugações e terminações comuns. */
export function stem(word: string): string {
  for (const suf of DERIVED) if (word.length - suf.length >= 5 && word.endsWith(suf)) return word.slice(0, -suf.length)
  for (const suf of INFLECTED) if (word.length - suf.length >= 4 && word.endsWith(suf)) return word.slice(0, -suf.length)
  // 1ª pessoa ("fecho", "pauso", "mando"), mas não substantivos em -co ("preco", "banco")
  if (word.length >= 5 && word.endsWith('o') && !word.endsWith('co')) return word.slice(0, -1)
  return word
}

/** As palavras de busca de um texto: sem acento, sem palavras vazias, com radical; no máximo 24. */
export function queryTerms(text: string): string[] {
  const words = fold(text).match(/[a-z0-9]+/g) ?? []
  const out: string[] = []
  const seen = new Set<string>()
  const add = (w: string) => {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) return
    const s = stem(w)
    if (seen.has(s) || out.length >= MAX_TERMS) return
    seen.add(s)
    out.push(s)
  }
  for (const w of words) {
    add(w)
    for (const syn of SYNONYMS[w] ?? []) add(syn)
  }
  return out
}

/** Expressão FTS5: qualquer um dos termos, como prefixo. */
export function ftsExpression(terms: string[]): string | null {
  return terms.length ? terms.map((t) => `"${t}"*`).join(' OR ') : null
}

/** Quantos termos (prefixos) aparecem no texto já sem acento. */
function coverage(terms: string[], foldedText: string): number {
  let n = 0
  for (const t of terms) if (new RegExp(`(^|[^a-z0-9])${t}`).test(foldedText)) n++
  return n
}

export interface KbPick {
  chunkId: number
  /** "conhecimento" (pode citar, vira "Baseado em") ou "interno" (só orientação) */
  kind: 'conhecimento' | 'interno'
  breadcrumb: string
  text: string
}

/**
 * Escolhe os trechos para uma consulta. Um trecho só entra se tiver pelo menos 2 termos da consulta
 * (ou o único termo, se a consulta tiver um só); "conhecimento" sensível (dinheiro, vários nomes) vai como "interno".
 */
export function pickChunks(kb: Pick<KbRepo, 'search'>, text: string, opts: { topK?: number; maxChars?: number } = {}): KbPick[] {
  const topK = opts.topK ?? KB_TOP_K
  const maxChars = opts.maxChars ?? KB_MAX_CHARS
  const terms = queryTerms(text)
  const expr = ftsExpression(terms)
  if (!expr) return []
  const minCover = Math.min(2, terms.length)
  const scored = kb
    .search(expr, CANDIDATES)
    .map((h: KbHit) => {
      const kind: KbPick['kind'] = h.role === 'conhecimento' && !h.sensitive ? 'conhecimento' : 'interno'
      const cover = coverage(terms, fold(`${h.breadcrumb} ${h.text}`))
      // bm25 negativo: mais negativo = melhor; a cobertura de termos diferentes ajuda
      const score = -h.rank * (1 + cover / terms.length) * (kind === 'interno' ? INTERNAL_WEIGHT : 1)
      return { h, kind, cover, score }
    })
    .filter((x) => x.cover >= minCover)
    .sort((a, b) => b.score - a.score)

  const out: KbPick[] = []
  const perFile = new Map<number, number>()
  let used = 0
  for (const x of scored) {
    if (out.length >= topK) break
    if ((perFile.get(x.h.fileId) ?? 0) >= MAX_PER_FILE) continue
    if (x.kind === 'interno' && out.filter((p) => p.kind === 'interno').length >= MAX_INTERNAL) continue
    const body = x.h.text.trim()
    if (used + body.length > maxChars) {
      // cabe um pedaço razoável? então entra cortado; senão tenta o próximo (talvez menor)
      const room = maxChars - used
      if (room < 400) continue
      out.push({ chunkId: x.h.id, kind: x.kind, breadcrumb: x.h.breadcrumb, text: `${body.slice(0, room - 1).trimEnd()}…` })
      used = maxChars
      perFile.set(x.h.fileId, (perFile.get(x.h.fileId) ?? 0) + 1)
      continue
    }
    out.push({ chunkId: x.h.id, kind: x.kind, breadcrumb: x.h.breadcrumb, text: body })
    used += body.length
    perFile.set(x.h.fileId, (perFile.get(x.h.fileId) ?? 0) + 1)
  }
  // conhecimento primeiro, depois a orientação interna
  return [...out.filter((p) => p.kind === 'conhecimento'), ...out.filter((p) => p.kind === 'interno')]
}

// --- regras sempre ligadas ---

/** Seções que não entram no resumo das regras (listas de conferência, exemplos, casos, contas, instruções de outra IA). */
const RULE_SKIP = /(checklist|conferencia|exemplo|caso|contas?\b|modelo|template|instala|como usar|passo a passo|referencias|fluxo|leia|\bia\b|gpt|assistente)/
/** Nas instruções gerais (prompt de outro assistente), só as seções que falam de regra, tom e postura. */
const RULE_TOPIC = /(regra|tom\b|voz|estilo|postura|nunca|proib|vocabul|bastidor|linguagem|escrita|nao faz|evitar|sempre)/
/** Ordem dentro dos arquivos de regras: postura e bastidor primeiro, depois regras, depois vocabulário. */
const RULE_ORDER = [/(postura|bastidor|tom\b|voz|copy|escrita)/, /regra/, /vocabul|glossario/]
const isRulesFile = (path: string) => /(regras?|vocabulario|glossario|tom[-_ ]de[-_ ]voz)/.test(fold(path))
const isSkillFile = (path: string) => /(^|\/)skill\.md$/.test(fold(path))
const baseHeading = (h: string) => h.replace(/\s*\(parte \d+\)$/, '')

function condense(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*[-*]\s*\[[ x]\]/i.test(l)) // itens de checklist
    .map((l) =>
      l
        .replace(/\*\*|__|`/g, '')
        .replace(/^\s*>\s?/, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean)
    .map((l) => (l.length > 400 ? `${l.slice(0, 399).trimEnd()}…` : l))
    .join('\n')
}

/** Junta de novo os pedaços de uma seção longa (tirando a sobreposição que começa com "…"). */
function mergeParts(chunks: KbRuleChunk[]): KbRuleChunk[] {
  const out: KbRuleChunk[] = []
  for (const c of chunks) {
    const prev = out[out.length - 1]
    if (prev && prev.fileId === c.fileId && /\(parte \d+\)$/.test(c.heading) && baseHeading(prev.heading) === baseHeading(c.heading)) {
      prev.text = `${prev.text}\n\n${c.text.replace(/^…[^\n]*\n*/, '')}`
      prev.sensitive = prev.sensitive || c.sensitive
    } else out.push({ ...c, heading: baseHeading(c.heading) })
  }
  return out
}

/**
 * Resumo das regras dos arquivos "regras" (até `max` caracteres): primeiro os arquivos de regras/vocabulário,
 * depois a descrição de cada SKILL.md, depois as seções de regra/tom/postura das instruções. Fora: checklists,
 * exemplos, casos, instruções para outra IA e trechos com dinheiro ou vários nomes.
 */
export function buildRulesBlock(chunks: KbRuleChunk[], max = KB_RULES_MAX): string {
  const tier = (c: KbRuleChunk) => (isRulesFile(c.path) ? 0 : isSkillFile(c.path) ? 1 : 2)
  const order = (c: KbRuleChunk) => {
    const i = RULE_ORDER.findIndex((r) => r.test(fold(c.heading)))
    return i < 0 ? RULE_ORDER.length : i
  }
  const picked = mergeParts(chunks)
    .filter((c) => !c.sensitive && !RULE_SKIP.test(fold(c.heading)))
    .filter((c) => {
      const t = tier(c)
      if (t === 1) return c.heading === 'Descrição'
      if (t === 2) return RULE_TOPIC.test(fold(c.heading))
      return true
    })
    .sort((a, b) => tier(a) - tier(b) || order(a) - order(b) || a.path.localeCompare(b.path) || a.ord - b.ord)
  const parts: string[] = []
  let used = 0
  const seen = new Set<string>()
  for (const c of picked) {
    const body = condense(c.text)
    if (!body || seen.has(body)) continue
    seen.add(body)
    const head = c.heading === 'Descrição' ? `${c.title.replace(/\s*\([^)]*\)$/, '')}:` : `${c.heading}:`
    let piece = `${head}\n${body}`
    const room = max - used - (parts.length ? 2 : 0)
    if (room < 120) break
    if (piece.length > room) {
      // corta no fim de uma linha
      const cut = piece.lastIndexOf('\n', room - 1)
      piece = cut > head.length ? piece.slice(0, cut) : `${piece.slice(0, room - 1).trimEnd()}…`
    }
    parts.push(piece)
    used += piece.length + (parts.length > 1 ? 2 : 0)
  }
  return parts.join('\n\n')
}

/** O que vai para o pedido da sugestão. */
export interface KbContext {
  rules: string
  chunks: KbPick[]
}

/** Regras + trechos para as mensagens novas do contato. Sem base em uso: `null`. */
export function knowledgeFor(kb: KbRepo, queryText: string): KbContext | null {
  if (!kb.hasActive()) return null
  const rules = buildRulesBlock(kb.ruleChunks())
  const chunks = pickChunks(kb, queryText)
  if (!rules && chunks.length === 0) return null
  return { rules, chunks }
}

/** "Baseado em": só os trechos de conhecimento. */
export function sourcesOf(ctx: KbContext | null): KbSource[] {
  return (ctx?.chunks ?? []).filter((c) => c.kind === 'conhecimento').map((c) => ({ chunkId: c.chunkId, breadcrumb: c.breadcrumb }))
}
