-- Copiloto da Saga (v0.5.0). Tudo fica vazio enquanto a integração está desligada (padrão).
-- Fila de saída: um evento por id do contrato (sz1:...). Um estado mais novo do mesmo id troca o pendente (upsert).
-- Depois de aceito, o texto sai daqui (`payload_json` vazio) e fica só a impressão, para não reenviar o mesmo estado.
CREATE TABLE copiloto_outbox (
  event_id TEXT PRIMARY KEY,
  jid TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'invalid')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_status TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_copiloto_outbox_status ON copiloto_outbox(status, next_attempt_at);
CREATE INDEX idx_copiloto_outbox_jid ON copiloto_outbox(jid);
-- O que mudou desde a última volta (só referências locais; nunca vai para fora). O envio confere o roster antes de
-- transformar em evento: o que não é de mentorado é descartado aqui.
-- ref: 'm:<id da mensagem>', 'a:<id do alerta>', 'r:<jid>' (Para responder), 's:<jid>' (resumo), 'x:<id do envio>'
CREATE TABLE copiloto_dirty (
  ref TEXT PRIMARY KEY,
  jid TEXT NOT NULL
);
-- Conversas de mentorados que já tiveram a carga inicial (últimos 30 dias).
CREATE TABLE copiloto_chats (
  jid TEXT PRIMARY KEY,
  backfilled_at INTEGER NOT NULL
);

-- Gatilhos: pegam toda gravação (ingestão, IA, regras, mentor, envio), só com a integração ligada.
CREATE TRIGGER copiloto_msg_ai AFTER INSERT ON messages
WHEN (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('m:' || new.id, new.jid);
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('r:' || new.jid, new.jid);
END;
CREATE TRIGGER copiloto_msg_au AFTER UPDATE OF text, transcript, transcript_status, sender_name ON messages
WHEN (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('m:' || new.id, new.jid);
END;
CREATE TRIGGER copiloto_alert_ai AFTER INSERT ON alerts
WHEN (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('a:' || new.id, new.jid);
END;
CREATE TRIGGER copiloto_alert_au AFTER UPDATE ON alerts
WHEN (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('a:' || new.id, new.jid);
END;
CREATE TRIGGER copiloto_afb_ai AFTER INSERT ON alert_feedback
WHEN new.alert_id IS NOT NULL AND (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('a:' || new.alert_id, new.jid);
END;
CREATE TRIGGER copiloto_afb_au AFTER UPDATE ON alert_feedback
WHEN new.alert_id IS NOT NULL AND (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('a:' || new.alert_id, new.jid);
END;
CREATE TRIGGER copiloto_rc_ai AFTER INSERT ON reply_checks
WHEN (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('r:' || new.jid, new.jid);
END;
CREATE TRIGGER copiloto_rc_au AFTER UPDATE ON reply_checks
WHEN (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('r:' || new.jid, new.jid);
END;
CREATE TRIGGER copiloto_rf_ai AFTER INSERT ON reply_feedback
WHEN (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('r:' || new.jid, new.jid);
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) SELECT 'a:' || new.alert_id, new.jid WHERE new.alert_id IS NOT NULL;
END;
CREATE TRIGGER copiloto_rf_au AFTER UPDATE ON reply_feedback
WHEN (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('r:' || new.jid, new.jid);
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) SELECT 'a:' || new.alert_id, new.jid WHERE new.alert_id IS NOT NULL;
END;
CREATE TRIGGER copiloto_analysis_ai AFTER INSERT ON analyses
WHEN (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('s:' || new.jid, new.jid);
END;
CREATE TRIGGER copiloto_analysis_au AFTER UPDATE OF summary, last_msg_id ON analyses
WHEN (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('s:' || new.jid, new.jid);
END;
CREATE TRIGGER copiloto_send_au AFTER UPDATE OF status, wa_msg_id ON sends
WHEN new.status = 'sent' AND (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('x:' || new.id, new.jid);
END;
