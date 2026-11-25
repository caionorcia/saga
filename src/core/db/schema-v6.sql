-- Fila do dia e alertas (v0.2.0).
-- Um alerta por conversa e tipo enquanto ativo (dismissed_at nulo); os resolvidos ficam como histórico.
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('urgente', 'desanimo', 'reuniao', 'travado', 'esperando')),
  detail TEXT NOT NULL,
  msg_id TEXT,
  created_at INTEGER NOT NULL,
  dismissed_at INTEGER
);
CREATE UNIQUE INDEX idx_alerts_active ON alerts(jid, kind) WHERE dismissed_at IS NULL;
CREATE INDEX idx_alerts_jid_kind ON alerts(jid, kind, id);
-- Até qual mensagem a IA já procurou alertas em cada conversa (não analisa a mesma janela duas vezes).
CREATE TABLE alert_checks (
  jid TEXT PRIMARY KEY,
  last_msg_id TEXT NOT NULL,
  last_ts INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
-- "Aguardando desde": primeira mensagem do contato depois da última do mentor.
CREATE INDEX idx_messages_jid_from_me_ts ON messages(jid, from_me, ts);
