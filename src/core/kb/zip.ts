/**
 * Leitor mínimo de .zip (e .skill, que é um .zip) só em memória: nada é gravado no disco.
 * Lê o diretório central, ignora pastas, links, arquivos criptografados e caminhos perigosos ("zip-slip":
 * `..`, caminho absoluto, letra de unidade) e respeita limites de tamanho (por arquivo e no total),
 * inclusive na descompactação (o tamanho declarado no .zip não é confiável).
 */
import { inflateRawSync } from 'node:zlib'

export class KbImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KbImportError'
  }
}

export interface ZipLimits {
  /** maior arquivo aceito (descompactado) */
  fileBytes: number
  /** soma dos arquivos aceitos */
  totalBytes: number
  /** quantos arquivos aceitos, no máximo */
  maxFiles: number
}

export interface ZipEntry {
  path: string
  data: Buffer
}

export interface ZipResult {
  entries: ZipEntry[]
  /** entradas ignoradas (não aceitas, grandes demais, criptografadas, caminho inválido…) */
  skipped: number
}

const EOCD = 0x06054b50
const CEN = 0x02014b50
const LOC = 0x04034b50
/** o diretório central não pode ter mais entradas que isso (proteção contra .zip malformado) */
const MAX_ENTRIES = 10_000

/**
 * Caminho seguro e normalizado ("a/b.md") de uma entrada, ou null se for perigoso ou oculto
 * (`..`, absoluto, `C:`, NUL, `__MACOSX`, nomes começando com ponto).
 */
export function safeEntryPath(raw: string): string | null {
  if (!raw || raw.includes('\0')) return null
  const p = raw.replace(/\\/g, '/')
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null
  const parts = p.split('/').filter((s) => s !== '' && s !== '.')
  if (parts.length === 0) return null
  for (const s of parts) {
    if (s === '..' || s.startsWith('.') || s === '__MACOSX') return null
  }
  return parts.join('/')
}

function decodeName(buf: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) return buf.toString('utf8')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return buf.toString('latin1')
  }
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i
  }
  return -1
}

/**
 * Lê as entradas aceitas por `accept(caminho)`. Lança `KbImportError` se o arquivo não for um .zip
 * que dê para ler (ou se for ZIP64, que não é suportado).
 */
export function readZip(buf: Buffer, accept: (path: string) => boolean, limits: ZipLimits): ZipResult {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new KbImportError('O arquivo não é um .zip válido.')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new KbImportError('Este .zip usa um formato (ZIP64) que o SagaZap não lê. Descompacte e importe a pasta.')
  }
  if (count > MAX_ENTRIES) throw new KbImportError('O .zip tem arquivos demais.')
  if (cdOffset + cdSize > buf.length) throw new KbImportError('O arquivo .zip está incompleto ou corrompido.')

  const entries: ZipEntry[] = []
  let skipped = 0
  let total = 0
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw new KbImportError('O arquivo .zip está corrompido.')
    const madeBy = buf.readUInt16LE(p + 4) >> 8
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const extAttr = buf.readUInt32LE(p + 38)
    const local = buf.readUInt32LE(p + 42)
    const rawName = decodeName(buf.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0)
    p += 46 + nameLen + extraLen + commentLen

    if (rawName.endsWith('/') || rawName.endsWith('\\')) continue // pasta
    const unixMode = madeBy === 3 ? extAttr >>> 16 : 0
    const isLink = (unixMode & 0xf000) === 0xa000
    const path = safeEntryPath(rawName)
    if (!path || isLink || (flags & 0x1) !== 0 || !accept(path)) {
      skipped++
      continue
    }
    if (size > limits.fileBytes || entries.length >= limits.maxFiles || total + size > limits.totalBytes) {
      skipped++
      continue
    }
    if (method !== 0 && method !== 8) {
      skipped++
      continue
    }
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOC) {
      skipped++
      continue
    }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    if (start + compSize > buf.length) {
      skipped++
      continue
    }
    const raw = buf.subarray(start, start + compSize)
    let data: Buffer
    try {
      data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: limits.fileBytes + 1 })
    } catch {
      // descompactação maior que o limite ("zip bomb") ou dados corrompidos
      skipped++
      continue
    }
    if (data.length > limits.fileBytes || total + data.length > limits.totalBytes) {
      skipped++
      continue
    }
    total += data.length
    entries.push({ path, data })
  }
  return { entries, skipped }
}
