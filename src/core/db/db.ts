import { DatabaseSync } from 'node:sqlite'
import schemaV1 from './schema.sql?raw'
import schemaV2 from './schema-v2.sql?raw'
import schemaV3 from './schema-v3.sql?raw'
import schemaV4 from './schema-v4.sql?raw'
import schemaV5 from './schema-v5.sql?raw'
import schemaV6 from './schema-v6.sql?raw'
import schemaV7 from './schema-v7.sql?raw'
import schemaV8 from './schema-v8.sql?raw'
import schemaV9 from './schema-v9.sql?raw'
import schemaV10 from './schema-v10.sql?raw'
import schemaV11 from './schema-v11.sql?raw'
import schemaV12 from './schema-v12.sql?raw'
import schemaV13 from './schema-v13.sql?raw'
import schemaV14 from './schema-v14.sql?raw'
import schemaV15 from './schema-v15.sql?raw'
import schemaV16 from './schema-v16.sql?raw'
import schemaV17 from './schema-v17.sql?raw'
import schemaV18 from './schema-v18.sql?raw'
import schemaV19 from './schema-v19.sql?raw'
import schemaV20 from './schema-v20.sql?raw'
import schemaV21 from './schema-v21.sql?raw'
import schemaV22 from './schema-v22.sql?raw'

/**
 * v19 (v0.8.0): colunas novas com `ALTER TABLE ... ADD COLUMN`, que o SQLite não aceita duas vezes. Cada linha do
 * arquivo só roda se a coluna ainda não existe (um banco que voltou o `user_version` migra de novo sem erro).
 */
function migrateV19(db: DatabaseSync): void {
  for (const raw of schemaV19.replace(/^\s*--.*$/gm, '').split(';')) {
    const stmt = raw.trim()
    if (!stmt) continue
    const m = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(stmt)
    if (m) {
      const cols = db.prepare(`PRAGMA table_info(${m[1]})`).all() as Array<{ name: string }>
      if (cols.some((c) => c.name === m[2])) continue
    }
    db.exec(stmt)
  }
}

/** Migrações em ordem; o índice + 1 é o `user_version` resultante. */
const MIGRATIONS: Array<string | ((db: DatabaseSync) => void)> = [schemaV1, schemaV2, schemaV3, schemaV4, schemaV5, schemaV6, schemaV7, schemaV8, schemaV9, schemaV10, schemaV11, schemaV12, schemaV13, schemaV14, schemaV15, schemaV16, schemaV17, schemaV18, migrateV19, schemaV20, schemaV21, schemaV22]

export function openDb(file: string | ':memory:'): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      const step = MIGRATIONS[v]
      if (typeof step === 'string') db.exec(step)
      else step(db)
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
}
