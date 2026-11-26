/**
 * Cópia de segurança (v0.3.1): exportar, abrir/conferir, restaurar e a cópia automática semanal. O processo principal
 * só abre os diálogos do sistema e lê/grava os arquivos escolhidos; os caminhos nunca vêm da interface.
 * O registro de diagnóstico só leva contagens e tamanhos (nunca textos, nomes ou caminhos).
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock } from '../clock'
import type { Repo } from '../db/repo'
import { countBackup, sanitizeBackupData, type BackupData } from '../db/backupRepo'
import type { Cipher, SettingsStore } from '../settings'
import {
  AUTO_BACKUP_EVERY_MS,
  AUTO_BACKUP_KEEP,
  BACKUP_ERROR_TEXT,
  BACKUP_EXT,
  type AutoBackupPatch,
  type BackupCounts,
  type BackupOpenResult,
  type BackupPreview,
  type BackupRestoreMode,
  type BackupRestoreResult,
  type BackupStatus,
  type UiPrefs
} from '../../shared/backup'
import { BackupError, decodePayload, encodeBackup, openBackup, type OpenedBackup } from './format'

const S = {
  lastAt: 'backup.lastAt',
  autoEnabled: 'backup.auto.enabled',
  autoFolder: 'backup.auto.folder',
  autoLastAt: 'backup.auto.lastAt',
  autoLastError: 'backup.auto.lastError',
  autoPassword: 'backup.auto.password'
} as const

/** Nome do arquivo: `Saga-copia-AAAA-MM-DD.sagabackup` (data local). */
export function backupFileName(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `Saga-copia-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.${BACKUP_EXT}`
}

const AUTO_RE = new RegExp(`^Saga-copia-\\d{4}-\\d{2}-\\d{2}(-\\d+)?\\.${BACKUP_EXT}$`)

/** Apaga as cópias mais velhas da pasta, deixando as `keep` mais novas (só arquivos com o nome das cópias). */
export function rotateBackups(dir: string, keep = AUTO_BACKUP_KEEP): number {
  const files = readdirSync(dir).filter((f) => AUTO_RE.test(f)).sort()
  const old = files.slice(0, Math.max(0, files.length - keep))
  for (const f of old) rmSync(join(dir, f), { force: true })
  return old.length
}

/** Uma semana desde a última cópia automática (ou nunca fez). */
export function autoBackupDue(lastAt: number | null, now: number): boolean {
  return lastAt === null || now - lastAt >= AUTO_BACKUP_EVERY_MS || now < lastAt
}

const PENDING_TTL_MS = 15 * 60_000

interface Pending {
  opened: OpenedBackup
  data: BackupData | null
  at: number
}

export interface BackupManagerDeps {
  repo: Repo
  settings: SettingsStore
  /** cifra do sistema (senha das cópias automáticas) */
  cipher: Cipher
  clock: Clock
  appVersion: string
  diag?: (kind: string, detail: string) => void
  /** depois de restaurar (listas e índices mudaram) */
  onRestored?: () => void
}

export class BackupManager {
  private pending = new Map<string, Pending>()
  private autoRunning = false

  constructor(private readonly d: BackupManagerDeps) {}

  private diag(kind: string, detail: string): void {
    try {
      this.d.diag?.(kind, detail)
    } catch {
      // registrar nunca quebra a cópia
    }
  }

  /** O conteúdo da cópia (JSON) e as contagens. */
  build(opts: { includeMessages: boolean; uiPrefs?: UiPrefs }): { json: string; counts: BackupCounts } {
    const data: BackupData & { uiPrefs?: UiPrefs } = {
      ...this.d.repo.backup.collect({ includeMessages: opts.includeMessages }),
      settings: this.d.settings.exportable()
    }
    if (opts.uiPrefs && Object.keys(opts.uiPrefs).length) data.uiPrefs = opts.uiPrefs
    return { json: JSON.stringify(data), counts: countBackup(data) }
  }

  /** Bytes do arquivo `.sagabackup`. */
  exportBytes(opts: { includeMessages: boolean; password?: string; uiPrefs?: UiPrefs }): { bytes: Buffer; counts: BackupCounts } {
    const { json, counts } = this.build(opts)
    const bytes = encodeBackup(json, { createdAt: this.d.clock.now(), appVersion: this.d.appVersion, counts }, opts.password || undefined)
    return { bytes, counts }
  }

  /** Grava a cópia no caminho escolhido pelo mentor (arquivo temporário + renomear: nunca fica pela metade). */
  exportTo(file: string, opts: { includeMessages: boolean; password?: string; uiPrefs?: UiPrefs }, kind: 'manual' | 'auto' = 'manual'): { counts: BackupCounts; bytes: number } {
    const { bytes, counts } = this.exportBytes(opts)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, bytes)
    renameSync(tmp, file)
    const now = this.d.clock.now()
    this.d.repo.setSetting(S.lastAt, String(now))
    this.diag(
      'backup_export',
      `tipo=${kind} senha=${opts.password ? 'sim' : 'não'} mensagens=${opts.includeMessages ? 'sim' : 'não'} bytes=${bytes.length} ${countsText(counts)}`
    )
    return { counts, bytes: bytes.length }
  }

  // --- restaurar ---

  private gc(): void {
    const now = this.d.clock.now()
    for (const [k, p] of this.pending) if (now - p.at > PENDING_TTL_MS) this.pending.delete(k)
  }

  /** Abre o arquivo escolhido: sem senha, já mostra as contagens; com senha, pede a senha. */
  open(bytes: Buffer): BackupOpenResult {
    this.gc()
    try {
      const opened = openBackup(bytes)
      const token = randomUUID()
      if (opened.manifest.encrypted) {
        this.pending.set(token, { opened, data: null, at: this.d.clock.now() })
        return { status: 'needs_password', token, createdAt: opened.manifest.createdAt }
      }
      const data = parseData(decodePayload(opened))
      this.pending.set(token, { opened, data, at: this.d.clock.now() })
      return { status: 'preview', token, preview: previewOf(opened, data) }
    } catch (e) {
      return openError(e, this)
    }
  }

  unlock(token: string, password: string): BackupOpenResult {
    this.gc()
    const p = this.pending.get(token)
    if (!p) return { status: 'error', code: 'expired', message: BACKUP_ERROR_TEXT.expired }
    try {
      const data = parseData(decodePayload(p.opened, password))
      p.data = data
      return { status: 'preview', token, preview: previewOf(p.opened, data) }
    } catch (e) {
      return openError(e, this)
    }
  }

  /** Aplica a cópia aberta (`merge` junta; `replace` troca). Tudo numa transação; os índices são refeitos. */
  restore(token: string, mode: BackupRestoreMode): BackupRestoreResult {
    this.gc()
    const p = this.pending.get(token)
    if (!p?.data) return { status: 'error', code: 'expired', message: BACKUP_ERROR_TEXT.expired }
    try {
      const counts = this.d.repo.backup.apply(p.data, mode)
      counts.settings = this.d.settings.restore(p.data.settings, { onlyMissing: mode === 'merge' })
      this.pending.delete(token)
      this.diag('backup_restore', `modo=${mode} ${countsText(counts)}`)
      this.d.repo.logEvent('backup_restored', `${mode === 'merge' ? 'juntada' : 'substituída'}: ${counts.approvedReplies} resposta(s), ${counts.kbFiles} arquivo(s) da base`)
      try {
        this.d.onRestored?.()
      } catch {
        // avisar a interface nunca desfaz a restauração
      }
      return { status: 'restored', mode, counts, uiPrefs: (p.data as BackupData & { uiPrefs?: UiPrefs }).uiPrefs ?? {} }
    } catch (e) {
      this.diag('backup_restore_error', e instanceof Error ? e.name : 'erro')
      return { status: 'error', code: 'failed', message: BACKUP_ERROR_TEXT.failed }
    }
  }

  // --- cópia automática ---

  status(): BackupStatus {
    const n = (k: string) => {
      const v = Number(this.d.repo.getSetting(k))
      return Number.isFinite(v) && v > 0 ? v : null
    }
    return {
      lastAt: n(S.lastAt),
      auto: {
        enabled: this.d.repo.getSetting(S.autoEnabled) === '1',
        folder: this.d.repo.getSetting(S.autoFolder),
        hasPassword: this.d.repo.getSetting(S.autoPassword) !== null,
        lastAt: n(S.autoLastAt),
        lastError: this.d.repo.getSetting(S.autoLastError)
      }
    }
  }

  /** Pasta escolhida no diálogo do sistema (processo principal). */
  setAutoFolder(folder: string): BackupStatus {
    this.d.repo.setSetting(S.autoFolder, folder)
    this.d.repo.deleteSetting(S.autoLastError)
    return this.status()
  }

  setAuto(patch: AutoBackupPatch): BackupStatus {
    if (patch.password !== undefined) {
      const pw = patch.password
      if (!pw) this.d.repo.deleteSetting(S.autoPassword)
      else {
        if (!this.d.cipher.isAvailable()) throw new Error('criptografia do sistema indisponível')
        this.d.repo.setSetting(S.autoPassword, this.d.cipher.encrypt(pw).toString('base64'))
      }
    }
    if (patch.enabled !== undefined) this.d.repo.setSetting(S.autoEnabled, patch.enabled ? '1' : '0')
    return this.status()
  }

  private autoPassword(): string | undefined {
    const raw = this.d.repo.getSetting(S.autoPassword)
    if (!raw) return undefined
    try {
      return this.d.cipher.decrypt(Buffer.from(raw, 'base64')) || undefined
    } catch {
      return undefined
    }
  }

  /**
   * Faz a cópia automática se estiver ligada, com pasta, e a última foi há uma semana ou mais. Mantém as 5 mais novas.
   * Devolve o que aconteceu (para testes e para o registro).
   */
  runAutoIfDue(): 'off' | 'not_due' | 'done' | 'error' | 'busy' {
    const st = this.status()
    if (!st.auto.enabled || !st.auto.folder) return 'off'
    if (!autoBackupDue(st.auto.lastAt, this.d.clock.now())) return 'not_due'
    if (this.autoRunning) return 'busy'
    this.autoRunning = true
    try {
      const dir = st.auto.folder
      mkdirSync(dir, { recursive: true })
      const now = this.d.clock.now()
      let name = backupFileName(now)
      const taken = new Set(readdirSync(dir))
      for (let i = 2; taken.has(name); i++) name = backupFileName(now).replace(`.${BACKUP_EXT}`, `-${i}.${BACKUP_EXT}`)
      this.exportTo(join(dir, name), { includeMessages: false, password: this.autoPassword() }, 'auto')
      const removed = rotateBackups(dir)
      this.d.repo.setSetting(S.autoLastAt, String(now))
      this.d.repo.deleteSetting(S.autoLastError)
      this.diag('auto_backup', `ok apagadas=${removed}`)
      return 'done'
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.name : 'erro')
      this.d.repo.setSetting(S.autoLastError, code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' ? 'pasta indisponível' : 'falhou')
      this.diag('auto_backup', `erro ${String(code).slice(0, 40)}`)
      return 'error'
    } finally {
      this.autoRunning = false
    }
  }
}

function parseData(json: string): BackupData {
  try {
    const raw = JSON.parse(json) as unknown
    const data = sanitizeBackupData(raw)
    const ui = (raw as { uiPrefs?: unknown }).uiPrefs
    if (ui && typeof ui === 'object' && !Array.isArray(ui)) {
      const prefs: UiPrefs = {}
      for (const [k, v] of Object.entries(ui)) if (typeof v === 'string' && k.startsWith('saga.') && k.length <= 64 && v.length <= 64) prefs[k] = v
      ;(data as BackupData & { uiPrefs?: UiPrefs }).uiPrefs = prefs
    }
    return data
  } catch {
    throw new BackupError('corrupted')
  }
}

function previewOf(o: OpenedBackup, data: BackupData): BackupPreview {
  return { createdAt: o.manifest.createdAt, appVersion: String(o.manifest.appVersion ?? ''), encrypted: o.manifest.encrypted, counts: countBackup(data) }
}

function openError(e: unknown, m: BackupManager): BackupOpenResult {
  const code = e instanceof BackupError ? e.code : 'corrupted'
  ;(m as unknown as { diag(k: string, d: string): void }).diag('backup_open_error', code)
  return { status: 'error', code, message: BACKUP_ERROR_TEXT[code] }
}

export function countsText(c: BackupCounts): string {
  return `respostas=${c.approvedReplies} contatos=${c.contacts} avaliacoes=${c.alertFeedback + c.replyFeedback} pacotes=${c.kbPackages} arquivos=${c.kbFiles} config=${c.settings} mensagens=${c.messages}`
}
