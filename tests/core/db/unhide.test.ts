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
    // volta ao esquema v10: tira as colunas da v12 para a migração poder rodar de novo
    db.exec('ALTER TABLE analyses DROP COLUMN chosen_index; ALTER TABLE analyses DROP COLUMN chosen_reply_id; ALTER TABLE approved_replies DROP COLUMN rejected_json')
    db.exec('DROP TRIGGER messages_fts_ai; DROP TRIGGER messages_fts_au; DROP TRIGGER messages_fts_ad; DROP TABLE messages_fts; DROP INDEX idx_messages_ts')
    db.exec('DROP TRIGGER copiloto_group_name_au; DROP TABLE group_subjects; DROP TRIGGER copiloto_send_au; DROP TRIGGER copiloto_msg_ai; DROP TRIGGER copiloto_msg_au; DROP TRIGGER copiloto_alert_ai; DROP TRIGGER copiloto_alert_au; DROP TRIGGER copiloto_afb_ai; DROP TRIGGER copiloto_afb_au; DROP TRIGGER copiloto_rc_ai; DROP TRIGGER copiloto_rc_au; DROP TRIGGER copiloto_rf_ai; DROP TRIGGER copiloto_rf_au; DROP TRIGGER copiloto_analysis_ai; DROP TRIGGER copiloto_analysis_au; DROP TABLE copiloto_outbox; DROP TABLE copiloto_dirty; DROP TABLE copiloto_chats')
    db.exec('ALTER TABLE messages DROP COLUMN wa_key_json; DROP TABLE sends')
    db.exec('PRAGMA user_version = 10')
    db.close()

    db = openDb(file)
    repo = new Repo(db)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(21)
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
