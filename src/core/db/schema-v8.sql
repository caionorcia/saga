-- "Para responder" (v0.2.2).
-- Uma linha por conversa: a decisão sobre a ÚLTIMA mensagem do contato (`msg_id`). Mensagem nova do contato = decisão
-- velha (não vale mais): a conversa volta para "Para responder" até ser classificada de novo.
-- `app_*`: o que o Saga decidiu (regra de agradecimento/emoji ou IA); `user_needs`: o que o mentor disse (vence).
CREATE TABLE reply_checks (
  jid TEXT PRIMARY KEY,
  msg_id TEXT NOT NULL,
  app_needs INTEGER CHECK (app_needs IN (0, 1)),
  app_reason TEXT,
  app_source TEXT CHECK (app_source IN ('rule', 'ai')),
  model TEXT,
  user_needs INTEGER CHECK (user_needs IN (0, 1)),
  updated_at INTEGER NOT NULL
);
-- Avaliações do "Para responder": cada linha é um exemplo rotulado (as últimas mensagens do contato + o veredito).
-- Uma por conversa e mensagem (mudar de ideia atualiza). `app_needs`: o que o Saga achava na hora (NULL = não tinha
-- decidido, ou seja, deixava na lista). `alert_id`: o alerta "esperando" avaliado, se veio de lá.
CREATE TABLE reply_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  alert_id INTEGER,
  verdict TEXT NOT NULL CHECK (verdict IN ('reply_not_needed', 'reply_needed', 'reply_ok')),
  app_needs INTEGER,
  app_reason TEXT,
  app_source TEXT,
  reason_code TEXT,
  reason_text TEXT,
  context_text TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (jid, msg_id)
);
CREATE INDEX idx_reply_feedback_created ON reply_feedback(created_at);
CREATE INDEX idx_reply_feedback_alert ON reply_feedback(alert_id);
