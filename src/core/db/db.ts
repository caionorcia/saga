import { DatabaseSync } from 'node:sqlite'
import schemaV1 from './schema.sql?raw'
import schemaV2 from './schema-v2.sql?raw'
import schemaV3 from './schema-v3.sql?raw'
import schemaV4 from './schema-v4.sql?raw'
import schemaV5 from './schema-v5.sql?raw'
import schemaV6 from './schema-v6.sql?raw'
import schemaV7 from './schema-v7.sql?raw'

/** Migrações em ordem; o índice + 1 é o `user_version` resultante. */
const MIGRATIONS: string[] = [schemaV1, schemaV2, schemaV3, schemaV4, schemaV5, schemaV6, schemaV7]

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
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
}
