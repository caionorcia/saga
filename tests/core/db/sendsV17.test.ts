import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { SendConflictError } from '../../../src/core/db/sendRepo'

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const JID = '5500000000001@s.whatsapp.net'
const OTHER = '5500000000002@s.whatsapp.net'

describe('migração v17 (v0.6.0): envios avulsos', () => {
  it('refaz `sends` com `kind` e `reply_id` opcional, mantendo os envios, o próximo id e o gatilho do Copiloto', () => {
    dir = mkdtempSync(join(tmpdir(), 'saga-v17-'))
    const file = join(dir, 'saga.db')
    let db = openDb(file)
    // volta ao esquema v16 de `sends` (reply_id obrigatório, sem kind)
    db.exec(`DROP TRIGGER copiloto_send_au; DROP TABLE sends;
      CREATE TABLE sends (id INTEGER PRIMARY KEY AUTOINCREMENT, idem_key TEXT NOT NULL UNIQUE, reply_id INTEGER NOT NULL, jid TEXT NOT NULL,
        text TEXT NOT NULL, address TEXT NOT NULL, quoted_id TEXT, msg_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('queued', 'typing', 'sending', 'sent', 'failed', 'unknown', 'expired', 'canceled')),
        attempt INTEGER NOT NULL DEFAULT 1, queued_at INTEGER NOT NULL, started_at INTEGER, sent_at INTEGER, wa_msg_id TEXT, error TEXT,
        forced INTEGER NOT NULL DEFAULT 0);
      CREATE TRIGGER copiloto_send_au AFTER UPDATE OF status, wa_msg_id ON sends
      WHEN new.status = 'sent' AND (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
        INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('x:' || new.id, new.jid);
      END;
      INSERT INTO sends(id, idem_key, reply_id, jid, text, address, quoted_id, msg_ids_json, status, queued_at, sent_at, wa_msg_id, forced)
        VALUES (7, '3:abc', 3, '${JID}', 'Oi', '${JID}', 'Q1', '["3EB0AA"]', 'sent', 1000, 2000, '3EB0AA', 1);
      PRAGMA user_version = 16;`)
    db.close()

    db = openDb(file)
    const repo = new Repo(db)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(17)
    expect(repo.sends.get(7)).toMatchObject({ kind: 'reply', replyId: 3, quotedId: 'Q1', msgIds: ['3EB0AA'], status: 'sent', forced: true, waMsgId: '3EB0AA' })
    // avulsa: sem resposta aprovada e sem citação (mesmo se pedirem)
    const { send } = repo.sends.enqueue({ idemKey: `avulsa:${JID}:d1:x`, kind: 'avulsa', replyId: null, jid: JID, text: 'Aviso', address: JID, quotedId: 'Q1' })
    expect(send).toMatchObject({ id: 8, kind: 'avulsa', replyId: null, quotedId: null, status: 'queued' })
    // o banco recusa uma avulsa com resposta aprovada, ou uma resposta sem ela
    expect(() => db.prepare(`INSERT INTO sends(idem_key, kind, reply_id, jid, text, address, status, queued_at) VALUES ('k1', 'avulsa', 1, 'j', 't', 'j', 'queued', 1)`).run()).toThrow()
    expect(() => db.prepare(`INSERT INTO sends(idem_key, kind, reply_id, jid, text, address, status, queued_at) VALUES ('k2', 'reply', NULL, 'j', 't', 'j', 'queued', 1)`).run()).toThrow()
    expect(() => repo.sends.enqueue({ idemKey: 'k3', kind: 'reply', replyId: null, jid: JID, text: 't', address: JID, quotedId: null })).toThrow()
    // a mesma chave em outra conversa, ou como resposta, é conflito
    expect(() => repo.sends.enqueue({ idemKey: `avulsa:${JID}:d1:x`, kind: 'avulsa', replyId: null, jid: OTHER, text: 'Aviso', address: OTHER, quotedId: null })).toThrow(SendConflictError)
    expect(() => repo.sends.enqueue({ idemKey: `avulsa:${JID}:d1:x`, kind: 'reply', replyId: 9, jid: JID, text: 'Aviso', address: JID, quotedId: null })).toThrow(SendConflictError)
    // o gatilho do Copiloto continua: avulsa enviada entra na fila de saída como qualquer envio
    repo.setSetting('copiloto.enabled', '1')
    expect(repo.sends.transition(send.id, send.attempt, ['queued'], 'sent', { sentAt: 3000, waMsgId: '3EB0BB' })).toBe(true)
    expect(db.prepare('SELECT ref FROM copiloto_dirty').all()).toEqual([{ ref: `x:${send.id}` }])
    db.close()
  })
})
