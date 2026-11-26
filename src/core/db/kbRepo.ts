import type { DatabaseSync } from 'node:sqlite'
import { systemClock, type Clock } from '../clock'
import { breadcrumb } from '../kb/chunk'
import type { KbFileDraft, KbPackageDraft } from '../kb/importer'
import { KB_MANUAL_PACKAGE, type KbChunkView, type KbFilePatch, type KbPackageView, type KbRole } from '../../shared/kb'

type Row = Record<string, any>

/** Um trecho candidato da busca. */
export interface KbHit {
  id: number
  fileId: number
  ord: number
  heading: string
  breadcrumb: string
  text: string
  role: Exclude<KbRole, 'desligado' | 'regras'>
  sensitive: boolean
  /** bm25 do FTS5 (menor = mais relevante) */
  rank: number
}

/** Um trecho de um arquivo de regras (para o resumo das regras). */
export interface KbRuleChunk {
  fileId: number
  path: string
  title: string
  ord: number
  heading: string
  text: string
  sensitive: boolean
}

export interface KbCounts {
  packages: number
  files: number
  chunks: number
}

/** Base de conhecimento no SQLite (tabelas `kb_*` e o índice `kb_fts`). */
export class KbRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock
  ) {}

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  private deleteFts(where: string, ...args: Array<number | string>): void {
    this.db.prepare(`DELETE FROM kb_fts WHERE rowid IN (SELECT c.id FROM kb_chunks c JOIN kb_files f ON f.id = c.file_id WHERE ${where})`).run(...args)
  }

  private insertFile(packageId: number, packageName: string, f: KbFileDraft, keep?: { role: KbRole; enabled: boolean }): void {
    const res = this.db
      .prepare(
        `INSERT INTO kb_files(package_id, path, title, role, auto_role, role_reason, enabled, size, hash, sections)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(packageId, f.path, f.title, keep?.role ?? f.role, f.role, f.roleReason, keep && !keep.enabled ? 0 : 1, f.size, f.hash, f.sections)
    const fileId = Number(res.lastInsertRowid)
    const ins = this.db.prepare('INSERT INTO kb_chunks(file_id, ord, heading, breadcrumb, text, sensitive) VALUES (?, ?, ?, ?, ?, ?)')
    const fts = this.db.prepare('INSERT INTO kb_fts(rowid, heading, text) VALUES (?, ?, ?)')
    for (const c of f.chunks) {
      const r = ins.run(fileId, c.ord, c.heading, breadcrumb(packageName, f.title, c.heading), c.text, c.sensitive ? 1 : 0)
      fts.run(Number(r.lastInsertRowid), `${f.title} ${c.heading}`, c.text)
    }
  }

  /**
   * Troca, de uma vez (transação), o pacote com esse nome pelo novo. O papel e o "Usar" que o mentor mudou à mão
   * num arquivo continuam valendo para o arquivo de mesmo caminho.
   */
  replacePackage(draft: KbPackageDraft): { packageId: number; replaced: boolean } {
    return this.tx(() => {
      const old = this.db.prepare('SELECT id FROM kb_packages WHERE name = ?').get(draft.name) as Row | undefined
      const kept = new Map<string, { role: KbRole; enabled: boolean }>()
      if (old) {
        for (const f of this.db.prepare('SELECT path, role, auto_role, enabled FROM kb_files WHERE package_id = ?').all(old.id) as Row[]) {
          if (f.role !== f.auto_role || f.enabled === 0) kept.set(f.path, { role: f.role, enabled: f.enabled === 1 })
        }
        this.deleteFts('f.package_id = ?', old.id)
        this.db.prepare('DELETE FROM kb_packages WHERE id = ?').run(old.id)
      }
      const res = this.db
        .prepare('INSERT INTO kb_packages(name, kind, enabled, imported_at, skipped, duplicates) VALUES (?, ?, 1, ?, ?, ?)')
        .run(draft.name, draft.kind, this.clock.now(), draft.skipped, draft.duplicates)
      const packageId = Number(res.lastInsertRowid)
      for (const f of draft.files) this.insertFile(packageId, draft.name, f, kept.get(f.path))
      return { packageId, replaced: !!old }
    })
  }

  /** Arquivo avulso ou texto colado: entra nos "Arquivos avulsos" (substitui o de mesmo nome). */
  upsertManualFiles(draft: KbPackageDraft): { packageId: number; replaced: boolean } {
    return this.tx(() => {
      let pkg = this.db.prepare('SELECT id FROM kb_packages WHERE name = ?').get(KB_MANUAL_PACKAGE) as Row | undefined
      if (!pkg) {
        const r = this.db
          .prepare("INSERT INTO kb_packages(name, kind, enabled, imported_at) VALUES (?, 'manual', 1, ?)")
          .run(KB_MANUAL_PACKAGE, this.clock.now())
        pkg = { id: Number(r.lastInsertRowid) }
      } else this.db.prepare('UPDATE kb_packages SET imported_at = ? WHERE id = ?').run(this.clock.now(), pkg.id)
      let replaced = false
      for (const f of draft.files) {
        const old = this.db.prepare('SELECT id, role, auto_role, enabled FROM kb_files WHERE package_id = ? AND path = ?').get(pkg.id, f.path) as Row | undefined
        let keep: { role: KbRole; enabled: boolean } | undefined
        if (old) {
          replaced = true
          if (old.role !== old.auto_role || old.enabled === 0) keep = { role: old.role, enabled: old.enabled === 1 }
          this.deleteFts('f.id = ?', old.id)
          this.db.prepare('DELETE FROM kb_files WHERE id = ?').run(old.id)
        }
        this.insertFile(pkg.id, KB_MANUAL_PACKAGE, f, keep)
      }
      return { packageId: pkg.id, replaced }
    })
  }

  listPackages(): KbPackageView[] {
    const pkgs = this.db.prepare("SELECT * FROM kb_packages ORDER BY kind = 'manual', name").all() as Row[]
    const files = this.db.prepare('SELECT * FROM kb_files ORDER BY path').all() as Row[]
    return pkgs.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      enabled: p.enabled === 1,
      importedAt: p.imported_at,
      skipped: p.skipped,
      duplicates: p.duplicates,
      files: files
        .filter((f) => f.package_id === p.id)
        .map((f) => ({
          id: f.id,
          path: f.path,
          title: f.title,
          role: f.role,
          autoRole: f.auto_role,
          roleReason: f.role_reason,
          enabled: f.enabled === 1,
          size: f.size,
          sections: f.sections
        }))
    }))
  }

  /** `false` se o arquivo não existe. */
  updateFile(id: number, patch: KbFilePatch): boolean {
    if (!this.db.prepare('SELECT 1 FROM kb_files WHERE id = ?').get(id)) return false
    if (patch.role !== undefined) this.db.prepare('UPDATE kb_files SET role = ? WHERE id = ?').run(patch.role, id)
    if (patch.enabled !== undefined) this.db.prepare('UPDATE kb_files SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id)
    return true
  }

  setPackageEnabled(id: number, enabled: boolean): boolean {
    return Number(this.db.prepare('UPDATE kb_packages SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes) > 0
  }

  deletePackage(id: number): boolean {
    return this.tx(() => {
      this.deleteFts('f.package_id = ?', id)
      return Number(this.db.prepare('DELETE FROM kb_packages WHERE id = ?').run(id).changes) > 0
    })
  }

  /**
   * Busca no índice (expressão FTS5 já montada). Só arquivos ligados, de pacotes ligados, com papel
   * "conhecimento" ou "interno".
   */
  search(match: string, limit: number): KbHit[] {
    let rows: Row[]
    try {
      rows = this.db
        .prepare(
          `SELECT c.id, c.file_id, c.ord, c.heading, c.breadcrumb, c.text, c.sensitive, f.role, bm25(kb_fts, 2.0, 1.0) AS rank
             FROM kb_fts JOIN kb_chunks c ON c.id = kb_fts.rowid
             JOIN kb_files f ON f.id = c.file_id JOIN kb_packages p ON p.id = f.package_id
            WHERE kb_fts MATCH ? AND f.enabled = 1 AND p.enabled = 1 AND f.role IN ('conhecimento', 'interno')
            ORDER BY rank LIMIT ?`
        )
        .all(match, limit) as Row[]
    } catch {
      // expressão inválida para o FTS5: sem resultados
      return []
    }
    return rows.map((r) => ({
      id: r.id,
      fileId: r.file_id,
      ord: r.ord,
      heading: r.heading,
      breadcrumb: r.breadcrumb,
      text: r.text,
      role: r.role,
      sensitive: r.sensitive === 1,
      rank: r.rank
    }))
  }

  /** Trechos dos arquivos de regras ligados (pacotes ligados), na ordem do arquivo. */
  ruleChunks(): KbRuleChunk[] {
    const rows = this.db
      .prepare(
        `SELECT c.file_id, f.path, f.title, c.ord, c.heading, c.text, c.sensitive
           FROM kb_chunks c JOIN kb_files f ON f.id = c.file_id JOIN kb_packages p ON p.id = f.package_id
          WHERE f.role = 'regras' AND f.enabled = 1 AND p.enabled = 1
          ORDER BY p.name, f.path, c.ord`
      )
      .all() as Row[]
    return rows.map((r) => ({
      fileId: r.file_id,
      path: r.path,
      title: r.title,
      ord: r.ord,
      heading: r.heading,
      text: r.text,
      sensitive: r.sensitive === 1
    }))
  }

  getChunk(id: number): KbChunkView | null {
    const r = this.db.prepare('SELECT id, breadcrumb, text FROM kb_chunks WHERE id = ?').get(id) as Row | undefined
    return r ? { id: r.id, breadcrumb: r.breadcrumb, text: r.text } : null
  }

  /** Há algum arquivo em uso (para não buscar à toa)? */
  hasActive(): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM kb_files f JOIN kb_packages p ON p.id = f.package_id
          WHERE f.enabled = 1 AND p.enabled = 1 AND f.role <> 'desligado' LIMIT 1`
      )
      .get()
  }

  counts(): KbCounts {
    const n = (sql: string) => (this.db.prepare(sql).get() as Row).n as number
    return {
      packages: n('SELECT COUNT(*) AS n FROM kb_packages'),
      files: n('SELECT COUNT(*) AS n FROM kb_files'),
      chunks: n('SELECT COUNT(*) AS n FROM kb_chunks')
    }
  }
}
