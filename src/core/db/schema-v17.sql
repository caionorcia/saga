-- Mensagem avulsa (v0.6.0): um envio pode não ser resposta a uma sugestão. `kind` = 'reply' (leva uma resposta
-- aprovada, `reply_id` obrigatório) ou 'avulsa' (escrita pelo mentor fora das sugestões, `reply_id` vazio; nunca cita e
-- nunca entra na memória). A chave de idempotência da avulsa é 'avulsa:' + conversa + rascunho + impressão do texto.
-- O SQLite não deixa tirar o NOT NULL de uma coluna: a tabela é refeita com os mesmos dados, índices e gatilho.
DROP TRIGGER IF EXISTS copiloto_send_au;
CREATE TABLE sends_v17 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'reply' CHECK (kind IN ('reply', 'avulsa')),
  reply_id INTEGER,
  jid TEXT NOT NULL,
  text TEXT NOT NULL,
  address TEXT NOT NULL,
  quoted_id TEXT,
  msg_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('queued', 'typing', 'sending', 'sent', 'failed', 'unknown', 'expired', 'canceled')),
  attempt INTEGER NOT NULL DEFAULT 1,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  sent_at INTEGER,
  wa_msg_id TEXT,
  error TEXT,
  forced INTEGER NOT NULL DEFAULT 0,
  -- resposta sempre com a resposta aprovada; avulsa nunca com ela, e nunca com citação
  CHECK ((kind = 'reply' AND reply_id IS NOT NULL) OR (kind = 'avulsa' AND reply_id IS NULL AND quoted_id IS NULL))
);
INSERT INTO sends_v17(id, idem_key, kind, reply_id, jid, text, address, quoted_id, msg_ids_json, status, attempt, queued_at, started_at, sent_at, wa_msg_id, error, forced)
  SELECT id, idem_key, 'reply', reply_id, jid, text, address, quoted_id, msg_ids_json, status, attempt, queued_at, started_at, sent_at, wa_msg_id, error, forced FROM sends;
DROP TABLE sends;
ALTER TABLE sends_v17 RENAME TO sends;
CREATE INDEX idx_sends_jid ON sends(jid, id);
CREATE INDEX idx_sends_status ON sends(status);
CREATE TRIGGER copiloto_send_au AFTER UPDATE OF status, wa_msg_id ON sends
WHEN new.status = 'sent' AND (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('x:' || new.id, new.jid);
END;
