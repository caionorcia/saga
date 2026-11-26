/**
 * Papel inicial de cada arquivo importado (o mentor pode trocar na tela). Só heurísticas, pelo nome do arquivo,
 * pelos avisos do LEIA-ME/README e por sinais do conteúdo (muitos nomes próprios ou valores em dinheiro).
 */
import type { KbRole } from '../../shared/kb'
import { fold } from './text'

export interface RoleGuess {
  role: KbRole
  /** em pt-BR, curto, para a tela */
  reason: string
}

export interface ClassifyInput {
  path: string
  text: string
}

const base = (p: string) => p.split('/').pop() ?? p
const stem = (p: string) => fold(base(p)).replace(/\.[^.]+$/, '')

const README = /^(leia[-_ ]?me|readme|indice|index|changelog|license|licenca)$/
/** anúncios, copies, ganchos de anúncio, criativos */
const ADS = /(^|[^a-z])(anuncios?|copies|copy|ads?|ganchos?|criativos?)([^a-z]|$)/
/** nome de arquivo que começa pelo assunto de anúncio ("anuncios-x.md", "01-ganchos.md") */
const ADS_START = /^(anuncios?|copies|copy|ads?|ganchos?|criativos?)([^a-z]|$)/
const RULES = /(regras?|vocabulario|checklist|glossario|tom[-_ ]de[-_ ]voz)/
const INSTRUCTIONS = /^(instrucoes|instructions|system[-_ ]?prompt)/
/** frases dos avisos que marcam material interno */
const INTERNAL_WARNING =
  /\b(material|referencia|uso|conteudo|arquivo)s?\s+intern[oa]s?\b|\(\s*intern[oa]s?\b|nao\s+(e|sao)\s+(pra|para)\s+(repassar|passar|enviar|compartilhar|mostrar)|nomes?\s+(reais|de\s+(mentorados|alunos|clientes))|precos?\s+de\s+(um|uma|outros?|outras?)\s+(mentorad|alun|client)/

/** Valores em dinheiro (R$ 1.500, US$ 20, 3 mil reais). */
const CURRENCY = /(r\$|us\$|€)\s?\d|\b\d+(?:[.,]\d+)?\s?(mil|k)\s+reais\b/gi
/** Nome e sobrenome com iniciais maiúsculas ("Maria Silva"); o começo de frase ou de linha é descartado depois. */
const NAME = /(?<!\p{L})\p{Lu}\p{Ll}{2,}(?:\s+(?:de|da|do|dos|das))?\s+\p{Lu}\p{Ll}{2,}(?!\p{L})/gu

/** O texto antes da posição termina num começo de frase/linha/item? */
function atSentenceStart(text: string, i: number): boolean {
  const before = text.slice(Math.max(0, i - 4), i).replace(/[ \t"“'(]+$/, '')
  return before === '' || /[.!?:;\n\-•|]$/.test(before)
}

export interface ContentSignals {
  /** nomes próprios distintos (aproximado) */
  names: number
  /** valores em dinheiro */
  currency: number
  /** os nomes encontrados (para conferência) */
  nameList: string[]
}

/**
 * Termos com iniciais maiúsculas que aparecem nos títulos do arquivo (conceitos do método, como "Proposta Única"):
 * não contam como nomes de pessoas.
 */
export function headingTerms(text: string): Set<string> {
  const out = new Set<string>()
  for (const line of text.split('\n')) {
    if (!/^#{1,6}\s/.test(line)) continue
    for (const m of line.replace(/[*_`#]/g, '').matchAll(NAME)) out.add(fold(m[0].replace(/\s+/g, ' ')))
  }
  return out
}

/**
 * Sinais de material interno no texto (heurística): valores em dinheiro e nomes próprios. Não contam como nomes os
 * termos em negrito/itálico (conceitos destacados), os dos títulos do arquivo (`ignore`) e os que abrem frase.
 */
export function contentSignals(text: string, ignore: ReadonlySet<string> = new Set()): ContentSignals {
  const plain = text
    .replace(/^#{1,6}\s.*$/gm, '')
    .replace(/\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|`[^`\n]+`/g, ' ')
    .replace(/[*_`>#]/g, '')
  const names = new Set<string>()
  for (const m of plain.matchAll(NAME)) {
    const n = m[0].replace(/\s+/g, ' ')
    if (!atSentenceStart(plain, m.index) && !ignore.has(fold(n))) names.add(n)
  }
  return { names: names.size, currency: [...plain.matchAll(CURRENCY)].length, nameList: [...names] }
}

/** O arquivo traz muitos nomes de pessoas (ex.: atendimentos reais), ou muitos nomes junto com valores em dinheiro? */
export function looksInternal(s: ContentSignals, chars: number): boolean {
  const per10k = (n: number) => (n * 10_000) / Math.max(chars, 1)
  return (s.names >= 10 && per10k(s.names) >= 8) || (s.names >= 6 && per10k(s.names) >= 4 && per10k(s.currency) >= 4)
}

/** Um trecho com dinheiro ou vários nomes: vai para a IA só como orientação (sem "Baseado em"). */
export function sensitiveChunk(text: string, ignore?: ReadonlySet<string>): boolean {
  const s = contentSignals(text, ignore)
  return s.currency >= 1 || s.names >= 3
}

/**
 * Arquivos citados nos avisos de material interno do LEIA-ME/README e das instruções (`SKILL.md`, `INSTRUCOES`):
 * nomes de arquivo (sem pasta, em minúsculas e sem acento) das linhas com essas frases.
 */
export function warnedFiles(files: ClassifyInput[]): Set<string> {
  const out = new Set<string>()
  for (const f of files) {
    const s = stem(f.path)
    if (!README.test(s) && s !== 'skill' && !INSTRUCTIONS.test(s)) continue
    for (const line of f.text.split('\n')) {
      if (!INTERNAL_WARNING.test(fold(line))) continue
      for (const m of line.matchAll(/[\w./ ()-]*?([\w.()-]+\.(?:md|markdown|txt|docx))/gi)) out.add(fold(base(m[1].trim())))
    }
  }
  return out
}

/** Papel inicial de cada arquivo (mesma ordem da entrada). */
export function classifyFiles(files: ClassifyInput[]): RoleGuess[] {
  const warned = warnedFiles(files)
  return files.map((f) => classifyOne(f, warned))
}

function classifyOne(f: ClassifyInput, warned: Set<string>): RoleGuess {
  const s = stem(f.path)
  const folded = fold(f.path)
  const dirs = folded.split('/').slice(0, -1)
  if (README.test(s)) return { role: 'desligado', reason: 'Instruções de uso do pacote (não é conteúdo do método)' }
  if (dirs.some((d) => ADS.test(d)) || ADS_START.test(s.replace(/^\d+[-_ .]*/, ''))) return { role: 'desligado', reason: 'Anúncios e copies: não servem para responder mentorados' }
  if (dirs.some((d) => /^exemplos?$/.test(d))) return { role: 'desligado', reason: 'Pasta de exemplos (textos prontos de outras pessoas)' }
  if (warned.has(fold(base(f.path)))) return { role: 'interno', reason: 'O próprio pacote avisa que é material interno' }
  if (/^exemplos?([-_ ]|$)/.test(s)) return { role: 'interno', reason: 'Exemplo real: serve de referência, não para citar' }
  if (s === 'skill' || INSTRUCTIONS.test(s) || RULES.test(s)) return { role: 'regras', reason: 'Regras e instruções: valem para toda sugestão' }
  if (looksInternal(contentSignals(f.text, headingTerms(f.text)), f.text.length)) return { role: 'interno', reason: 'Tem muitos nomes de pessoas ou valores em dinheiro' }
  return { role: 'conhecimento', reason: 'Conteúdo do método' }
}
