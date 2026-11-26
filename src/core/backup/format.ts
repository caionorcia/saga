/**
 * Arquivo `.sagabackup`: um .zip com `manifest.json` (formato, versão, data, contagens) e os dados:
 * `data.json` (sem senha, com o SHA-256 no manifesto) ou `data.enc` (com senha: AES-256-GCM, chave derivada da senha
 * por scrypt; sal, IV e etiqueta no manifesto). Funções puras sobre bytes.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { KbImportError, readZip } from '../kb/zip'
import type { BackupCounts, BackupErrorCode } from '../../shared/backup'

export const BACKUP_FORMAT = 'saga-backup'
/** versão do formato do arquivo (mudanças incompatíveis sobem este número) */
export const BACKUP_VERSION = 1

export class BackupError extends Error {
  constructor(readonly code: BackupErrorCode) {
    super(`cópia de segurança: ${code}`)
    this.name = 'BackupError'
  }
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  version: number
  createdAt: number
  appVersion: string
  encrypted: boolean
  /** sem senha: as contagens; com senha ficam dentro dos dados cifrados */
  counts?: BackupCounts
  /** sem senha: SHA-256 (hex) de `data.json` */
  sha256?: string
  /** com senha */
  kdf?: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  cipher?: { name: 'aes-256-gcm'; iv: string; tag: string }
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1 }
const MAX_MEM = 128 * SCRYPT.N * SCRYPT.r * 2

// --- zip (escrita mínima: deflate, sem pastas) ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Data/hora do DOS (horário local). */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

export function writeZip(entries: Array<{ path: string; data: Buffer }>, when = new Date()): Buffer {
  const { time, date } = dosTime(when)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8')
    const comp = deflateRawSync(e.data)
    const crc = crc32(e.data)
    const loc = Buffer.alloc(30)
    loc.writeUInt32LE(0x04034b50, 0)
    loc.writeUInt16LE(20, 4)
    loc.writeUInt16LE(0x800, 6)
    loc.writeUInt16LE(8, 8)
    loc.writeUInt16LE(time, 10)
    loc.writeUInt16LE(date, 12)
    loc.writeUInt32LE(crc, 14)
    loc.writeUInt32LE(comp.length, 18)
    loc.writeUInt32LE(e.data.length, 22)
    loc.writeUInt16LE(name.length, 26)
    loc.writeUInt16LE(0, 28)
    locals.push(loc, name, comp)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x800, 8)
    cen.writeUInt16LE(8, 10)
    cen.writeUInt16LE(time, 12)
    cen.writeUInt16LE(date, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(comp.length, 20)
    cen.writeUInt32LE(e.data.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(offset, 42)
    centrals.push(cen, name)
    offset += 30 + name.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

// --- cifra ---

function deriveKey(password: string, salt: Buffer, p = SCRYPT): Buffer {
  return scryptSync(password.normalize('NFC'), salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: Math.max(MAX_MEM, 128 * p.N * p.r * 2) })
}

const aad = (m: Pick<BackupManifest, 'format' | 'version' | 'createdAt'>) => Buffer.from(`${m.format}|${m.version}|${m.createdAt}`, 'utf8')

// --- arquivo ---

const LIMITS = { fileBytes: 900 * 1024 * 1024, totalBytes: 950 * 1024 * 1024, maxFiles: 4 }

/** Monta o arquivo. Com `password`, os dados (e as contagens) vão cifrados. */
export function encodeBackup(json: string, meta: { createdAt: number; appVersion: string; counts: BackupCounts }, password?: string): Buffer {
  const data = Buffer.from(json, 'utf8')
  const base = { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: meta.createdAt, appVersion: meta.appVersion } as const
  if (!password) {
    const manifest: BackupManifest = { ...base, encrypted: false, counts: meta.counts, sha256: createHash('sha256').update(data).digest('hex') }
    return writeZip([
      { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { path: 'data.json', data }
    ], new Date(meta.createdAt))
  }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = deriveKey(password, salt)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(aad(base))
  const enc = Buffer.concat([c.update(data), c.final()])
  const manifest: BackupManifest = {
    ...base,
    encrypted: true,
    kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') }
  }
  return writeZip([
    { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { path: 'data.enc', data: enc }
  ], new Date(meta.createdAt))
}

export interface OpenedBackup {
  manifest: BackupManifest
  /** `data.json` ou `data.enc` */
  payload: Buffer
}

/** Lê o .zip e o manifesto (sem a senha). Lança `BackupError`. */
export function openBackup(buf: Buffer): OpenedBackup {
  let entries: Map<string, Buffer>
  try {
    entries = new Map(readZip(buf, (p) => p === 'manifest.json' || p === 'data.json' || p === 'data.enc', LIMITS).entries.map((e) => [e.path, e.data]))
  } catch (e) {
    if (e instanceof KbImportError) throw new BackupError(buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50 ? 'corrupted' : 'invalid')
    throw e
  }
  const raw = entries.get('manifest.json')
  if (!raw) throw new BackupError(entries.size ? 'corrupted' : 'invalid')
  let m: BackupManifest
  try {
    m = JSON.parse(raw.toString('utf8')) as BackupManifest
  } catch {
    throw new BackupError('corrupted')
  }
  if (!m || m.format !== BACKUP_FORMAT) throw new BackupError('invalid')
  if (typeof m.version !== 'number' || m.version > BACKUP_VERSION || m.version < 1) throw new BackupError('version')
  if (typeof m.createdAt !== 'number') throw new BackupError('corrupted')
  const payload = entries.get(m.encrypted ? 'data.enc' : 'data.json')
  if (!payload) throw new BackupError('corrupted')
  return { manifest: m, payload }
}

/** Os dados (texto JSON). Senha errada → `wrong_password`; bytes alterados → `corrupted`. */
export function decodePayload(o: OpenedBackup, password?: string): string {
  const m = o.manifest
  if (!m.encrypted) {
    if (m.sha256 && createHash('sha256').update(o.payload).digest('hex') !== m.sha256) throw new BackupError('corrupted')
    return o.payload.toString('utf8')
  }
  if (!password) throw new BackupError('wrong_password')
  const k = m.kdf
  const ci = m.cipher
  if (!k || k.name !== 'scrypt' || !ci || ci.name !== 'aes-256-gcm') throw new BackupError('corrupted')
  if (![k.N, k.r, k.p].every((v) => Number.isInteger(v) && v > 0) || k.N > 1 << 20 || k.r > 32 || k.p > 4) throw new BackupError('corrupted')
  let key: Buffer
  try {
    key = deriveKey(password, Buffer.from(k.salt, 'base64'), { N: k.N, r: k.r, p: k.p })
  } catch {
    throw new BackupError('corrupted')
  }
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ci.iv, 'base64'))
    d.setAAD(aad(m))
    d.setAuthTag(Buffer.from(ci.tag, 'base64'))
    return Buffer.concat([d.update(o.payload), d.final()]).toString('utf8')
  } catch {
    // GCM não separa senha errada de bytes alterados; o caso comum é a senha
    throw new BackupError('wrong_password')
  }
}
