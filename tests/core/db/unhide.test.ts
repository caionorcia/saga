import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('migração v11 (v0.3.0): sem conversas escondidas', () => {
  it('mostra de novo quem estava escondido e guarda a lista para devolver os áudios à fila', () => {
    dir = mkdtempSync(join(tmpdir(), 'saga-v11-'))
    const file = join(dir, 'saga.db')
    let db = openDb(file)
    let repo = new Repo(db)
    for (const jid of ['a@s.whatsapp.net', 'b@s.whatsapp.net', 'c@s.whatsapp.net']) repo.upsertContact({ jid })
    repo.setHidden('a@s.whatsapp.net', true)
    repo.setHidden('c@s.whatsapp.net', true)
    db.exec('PRAGMA user_version = 10')
    db.close()

    db = openDb(file)
    repo = new Repo(db)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(11)
    expect(repo.listContacts({ includeHidden: true }).filter((c) => c.hidden)).toEqual([])
    expect(JSON.parse(repo.getSetting('migration.unhidden_jids')!).sort()).toEqual(['a@s.whatsapp.net', 'c@s.whatsapp.net'])
    db.close()
  })

  it('banco novo / sem escondidos: nada a devolver', () => {
    dir = mkdtempSync(join(tmpdir(), 'saga-v11-'))
    const repo = new Repo(openDb(':memory:'))
    expect(repo.getSetting('migration.unhidden_jids')).toBeNull()
  })
})
