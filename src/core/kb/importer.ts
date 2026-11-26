/**
 * Importação da base de conhecimento: de um .zip/.skill (em memória), de uma pasta, de um arquivo avulso
 * (.md, .txt, .docx) ou de um texto colado. Devolve um rascunho já classificado e dividido em trechos,
 * pronto para `KbRepo.replacePackage` / `KbRepo.upsertManualFile`. Nada aqui grava no disco.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import { KB_LIMITS, KB_MANUAL_PACKAGE, type KbRole } from '../../shared/kb'
import { chunkFile, fileTitle, type ChunkDraft } from './chunk'
import { classifyFiles, headingTerms, sensitiveChunk } from './classify'
import { decodeText, docxToText, fold, looksLikeText } from './text'
import { KbImportError, readZip, safeEntryPath } from './zip'

export { KbImportError }

export interface KbChunkDraft extends ChunkDraft {
  /** dinheiro ou vários nomes: um trecho de conhecimento assim vai para a IA só como orientação */
  sensitive: boolean
}

export interface KbFileDraft {
  path: string
  title: string
  text: string
  size: number
  hash: string
  role: KbRole
  roleReason: string
  sections: number
  chunks: KbChunkDraft[]
}

export interface KbPackageDraft {
  name: string
  kind: 'package' | 'manual'
  files: KbFileDraft[]
  skipped: number
  duplicates: number
}

/** Extensões de texto aceitas dentro de um pacote (o resto é ignorado: imagens, PDFs, .zip dentro do .zip…). */
const PACKAGE_EXT = new Set(['.md', '.markdown', '.txt'])
/** Extensões aceitas em "Adicionar arquivo". */
export const SINGLE_FILE_EXT = ['md', 'markdown', 'txt', 'docx'] as const

const MAX_DEPTH = 8

/**
 * Seções sobre o próprio material (como outra IA deve usar o arquivo, qual arquivo abrir, índice): não respondem
 * a dúvidas de mentorados e atrapalham a busca, então não entram no índice.
 */
export function isMetaSection(heading: string): boolean {
  return /\b(como (a |o )?(ia|gpt|assistente|modelo) (usa|deve usar|le)|qual arquivo|que arquivo|este arquivo|nesta pasta|indice|sumario)\b/.test(fold(heading))
}

/** Seção que se diz interna ("a ficha (interna, nunca vai pro aluno)", "bastidores"): só como orientação. */
export function internalHeading(heading: string): boolean {
  return /\b(intern[oa]s?|bastidor(es)?|nunca vai pr[oa]|confidencial|sigiloso)\b/.test(fold(heading))
}

const hashOf = (text: string) => createHash('sha256').update(text.trim()).digest('hex')

interface RawFile {
  path: string
  text: string
}

/** Classifica, divide e tira repetidos (mesmo conteúdo: fica o de caminho mais curto). */
export function buildPackage(name: string, kind: 'package' | 'manual', raw: RawFile[], skipped: number): KbPackageDraft {
  const sorted = [...raw].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
  const seen = new Set<string>()
  const unique: Array<RawFile & { hash: string }> = []
  let duplicates = 0
  for (const f of sorted) {
    const text = f.text.trim()
    if (!text) {
      skipped++
      continue
    }
    const hash = hashOf(text)
    if (seen.has(hash)) {
      duplicates++
      continue
    }
    seen.add(hash)
    unique.push({ path: f.path, text, hash })
  }
  const roles = classifyFiles(unique)
  const files = unique.map((f, i): KbFileDraft => {
    const title = fileTitle(f.path)
    const c = chunkFile(f.text, title)
    const concepts = headingTerms(f.text)
    return {
      path: f.path,
      title,
      text: f.text,
      size: Buffer.byteLength(f.text, 'utf8'),
      hash: f.hash,
      role: roles[i].role,
      roleReason: roles[i].reason,
      sections: c.sections,
      chunks: c.chunks.filter((ch) => !isMetaSection(ch.heading)).map((ch, ord) => ({ ...ch, ord, sensitive: internalHeading(ch.heading) || sensitiveChunk(ch.text, concepts) }))
    }
  })
  files.sort((a, b) => a.path.localeCompare(b.path, 'pt-BR', { numeric: true }))
  return { name: name.trim() || 'Pacote', kind, files, skipped, duplicates }
}

const isPackageText = (p: string) => PACKAGE_EXT.has(extname(p).toLowerCase())

/** Pasta única no topo de todos os caminhos (o nome do pacote), ou null. */
function commonRoot(paths: string[]): string | null {
  if (paths.length === 0) return null
  const first = paths[0].split('/')
  if (first.length < 2) return null
  const root = first[0]
  return paths.every((p) => p.startsWith(`${root}/`)) ? root : null
}

/** Pacote de um .zip ou .skill (`fileName`: nome do arquivo, para o nome do pacote). */
export function importArchive(buf: Buffer, fileName: string): KbPackageDraft {
  if (buf.length > KB_LIMITS.archiveBytes) throw new KbImportError('O arquivo é grande demais (máximo de 25 MB).')
  const { entries, skipped } = readZip(buf, isPackageText, {
    fileBytes: KB_LIMITS.fileBytes,
    totalBytes: KB_LIMITS.totalBytes,
    maxFiles: KB_LIMITS.files
  })
  let skip = skipped
  const raw: RawFile[] = []
  for (const e of entries) {
    if (!looksLikeText(e.data)) {
      skip++
      continue
    }
    raw.push({ path: e.path, text: decodeText(e.data) })
  }
  if (raw.length === 0) throw new KbImportError('Não há arquivos de texto (.md ou .txt) neste pacote.')
  const root = commonRoot(raw.map((r) => r.path))
  const name = root ?? basename(fileName).replace(/\.(zip|skill)$/i, '')
  const files = root ? raw.map((r) => ({ ...r, path: r.path.slice(root.length + 1) })) : raw
  return buildPackage(name, 'package', files, skip)
}

/** Pacote de uma pasta (sem seguir atalhos/links nem entrar em pastas ocultas). */
export function importFolder(dir: string): KbPackageDraft {
  const raw: RawFile[] = []
  let skipped = 0
  let total = 0
  const walk = (d: string, depth: number) => {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      skipped++
      return
    }
    for (const n of names.sort()) {
      const full = join(d, n)
      const rel = relative(dir, full).split(sep).join('/')
      if (!safeEntryPath(rel)) {
        skipped++
        continue
      }
      let st
      try {
        st = lstatSync(full)
      } catch {
        skipped++
        continue
      }
      if (st.isSymbolicLink()) {
        skipped++
        continue
      }
      if (st.isDirectory()) {
        if (depth < MAX_DEPTH) walk(full, depth + 1)
        else skipped++
        continue
      }
      if (!st.isFile() || !isPackageText(n) || st.size > KB_LIMITS.fileBytes || raw.length >= KB_LIMITS.files || total + st.size > KB_LIMITS.totalBytes) {
        skipped++
        continue
      }
      const buf = readFileSync(full)
      if (!looksLikeText(buf)) {
        skipped++
        continue
      }
      total += buf.length
      raw.push({ path: rel, text: decodeText(buf) })
    }
  }
  walk(dir, 0)
  if (raw.length === 0) throw new KbImportError('Não há arquivos de texto (.md ou .txt) nesta pasta.')
  return buildPackage(basename(dir), 'package', raw, skipped)
}

/** Um arquivo avulso (.md, .txt, .docx), para os "Arquivos avulsos". */
export function importSingleFile(file: string): KbPackageDraft {
  const ext = extname(file).toLowerCase().slice(1)
  if (!(SINGLE_FILE_EXT as readonly string[]).includes(ext)) throw new KbImportError('Escolha um arquivo .md, .txt ou .docx.')
  const st = lstatSync(file)
  if (!st.isFile()) throw new KbImportError('Escolha um arquivo.')
  const limit = ext === 'docx' ? KB_LIMITS.archiveBytes : KB_LIMITS.fileBytes
  if (st.size > limit) throw new KbImportError('O arquivo é grande demais (máximo de 2 MB de texto).')
  const buf = readFileSync(file)
  let text: string
  if (ext === 'docx') text = docxToText(buf, KB_LIMITS.fileBytes)
  else {
    if (!looksLikeText(buf)) throw new KbImportError('Este arquivo não parece ser de texto.')
    text = decodeText(buf)
  }
  if (Buffer.byteLength(text, 'utf8') > KB_LIMITS.fileBytes) throw new KbImportError('O arquivo é grande demais (máximo de 2 MB de texto).')
  if (!text.trim()) throw new KbImportError('O arquivo está vazio.')
  const name = basename(file).replace(/\.docx$/i, '.md')
  return buildPackage(KB_MANUAL_PACKAGE, 'manual', [{ path: name, text }], 0)
}

/** Um texto colado (título + texto), para os "Arquivos avulsos". */
export function importPastedText(title: string, text: string): KbPackageDraft {
  const t = title.replace(/[\\/:*?"<>|\0]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, KB_LIMITS.titleChars)
  if (!t) throw new KbImportError('Dê um título ao texto.')
  const body = text.replace(/\r\n?/g, '\n').trim()
  if (!body) throw new KbImportError('Cole algum texto.')
  if (body.length > KB_LIMITS.pasteChars) throw new KbImportError('O texto é longo demais. Salve num arquivo .md e use "Adicionar arquivo".')
  return buildPackage(KB_MANUAL_PACKAGE, 'manual', [{ path: `${t}.md`, text: body }], 0)
}
