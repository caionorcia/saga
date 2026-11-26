/**
 * Divide um arquivo da base em trechos: por títulos (`#` a `####`) e, se a seção passar de ~1.200 caracteres,
 * por parágrafos, com ~150 caracteres de sobreposição entre um pedaço e o seguinte. Cada trecho leva a sua
 * "trilha": "Pacote › Arquivo › Título da seção".
 */

/** tamanho-alvo de um trecho */
export const CHUNK_MAX = 1_200
/** sobreposição entre pedaços de uma seção longa */
export const CHUNK_OVERLAP = 150
/** seções com menos texto que isso (sem o título) são ignoradas */
const MIN_BODY = 20
const MAX_LABEL = 90

export interface ChunkDraft {
  ord: number
  /** título da seção (com "(parte N)" quando a seção foi dividida) */
  heading: string
  text: string
}

export interface ChunkedFile {
  chunks: ChunkDraft[]
  /** seções com texto (antes da divisão por tamanho) */
  sections: number
  /** descrição do cabeçalho YAML (`description:` de um SKILL.md), se houver */
  description: string | null
}

const clipLabel = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1).trimEnd()}…` : s)

/** Tira marcações de ênfase e links do título. */
function cleanHeading(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Cabeçalho YAML (`---` … `---`) no começo do arquivo: devolve o texto sem ele e a `description`. */
export function stripFrontmatter(text: string): { body: string; description: string | null } {
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text)
  if (!m) return { body: text, description: null }
  const lines = m[1].split('\n')
  let description: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const d = /^description:\s*(.*)$/.exec(lines[i])
    if (!d) continue
    let v = d[1].trim()
    if (v === '>' || v === '|' || v === '>-' || v === '|-' || v === '') {
      const more: string[] = []
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) more.push(lines[j].trim())
      v = more.join(' ')
    }
    description = v.replace(/^["']|["']$/g, '').trim() || null
    break
  }
  return { body: text.slice(m[0].length), description }
}

interface Section {
  label: string
  body: string
}

/** Seções por título (ignorando `#` dentro de blocos de código). */
function splitSections(text: string, fileTitle: string): Section[] {
  const out: Section[] = []
  const stack: Array<{ level: number; title: string }> = []
  let label = fileTitle
  let buf: string[] = []
  let fence = false
  const flush = () => {
    const body = buf.join('\n').trim()
    if (body.replace(/\s+/g, '').length >= MIN_BODY) out.push({ label, body })
    buf = []
  }
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const h = fence ? null : /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!h) {
      buf.push(line)
      continue
    }
    flush()
    const level = h[1].length
    const title = cleanHeading(h[2])
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    // título de 3º/4º nível leva junto o do nível de cima (ex.: "Os blocos › 1. Origem")
    const parent = level >= 3 ? stack.filter((s) => s.level >= 2).pop() : undefined
    stack.push({ level, title })
    label = clipLabel(parent ? `${parent.title} › ${title}` : title)
  }
  flush()
  return out
}

/** Pedaços de até ~CHUNK_MAX caracteres, quebrando entre parágrafos (ou linhas/frases), com sobreposição. */
export function splitLong(body: string, max = CHUNK_MAX, overlap = CHUNK_OVERLAP): string[] {
  if (body.length <= max) return [body]
  // unidades: parágrafos; um parágrafo longo demais vira linhas e, se preciso, frases
  const units: string[] = []
  for (const para of body.split(/\n\s*\n/)) {
    const p = para.trim()
    if (!p) continue
    if (p.length <= max) {
      units.push(p)
      continue
    }
    for (const line of p.split('\n')) {
      if (line.length <= max) units.push(line)
      else {
        let rest = line
        while (rest.length > max) {
          const cut = Math.max(rest.lastIndexOf('. ', max), rest.lastIndexOf(' ', max))
          const at = cut > max / 2 ? cut + 1 : max
          units.push(rest.slice(0, at).trim())
          rest = rest.slice(at)
        }
        if (rest.trim()) units.push(rest.trim())
      }
    }
  }
  const pieces: string[] = []
  let cur = ''
  for (const u of units) {
    if (cur && cur.length + 2 + u.length > max) {
      pieces.push(cur)
      cur = `${tail(cur, overlap)}\n\n${u}`
    } else cur = cur ? `${cur}\n\n${u}` : u
  }
  if (cur) pieces.push(cur)
  return pieces
}

/** Os últimos ~n caracteres, começando numa palavra inteira. */
function tail(s: string, n: number): string {
  if (s.length <= n) return s
  const t = s.slice(-n)
  const sp = t.indexOf(' ')
  // numa linha só: quem junta os pedaços de novo tira o primeiro parágrafo (o que começa com "…")
  return `…${(sp >= 0 ? t.slice(sp + 1) : t).replace(/\s+/g, ' ')}`
}

/** Trechos de um arquivo da base. */
export function chunkFile(text: string, fileTitle: string): ChunkedFile {
  const { body, description } = stripFrontmatter(text)
  const sections = splitSections(body, fileTitle)
  const chunks: ChunkDraft[] = []
  if (description) chunks.push({ ord: 0, heading: 'Descrição', text: description })
  for (const s of sections) {
    const parts = splitLong(s.body)
    parts.forEach((p, i) => chunks.push({ ord: chunks.length, heading: parts.length > 1 ? `${s.label} (parte ${i + 1})` : s.label, text: p }))
  }
  return { chunks, sections: sections.length + (description ? 1 : 0), description }
}

/** Nome do arquivo para a trilha: sem pasta, número do começo nem extensão ("01-aulas-gerais.md" → "Aulas gerais"). */
export function fileTitle(path: string): string {
  const parts = path.split('/')
  const base = parts[parts.length - 1]
  const name = base.replace(/\.[^.]+$/, '')
  const human = (s: string) => {
    const t = s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
    return t ? t[0].toUpperCase() + t.slice(1) : s
  }
  // SKILL.md, INSTRUCOES.md e afins dentro de uma pasta: o nome da pasta diz de qual parte são
  if (parts.length > 1 && /^(skill|instru[cç](oes|ões)|readme|leia-me)$/i.test(name)) return `${human(parts[parts.length - 2])} (${name})`
  return human(name.replace(/^\d+[\s._-]+/, '')) || human(name)
}

/** "Pacote › Arquivo › Seção" */
export function breadcrumb(pkg: string, file: string, heading: string): string {
  return heading && heading !== file ? `${pkg} › ${file} › ${heading}` : `${pkg} › ${file}`
}
