-- Avaliação dos alertas (v0.2.1).
-- De onde veio o alerta (ai = IA, rule = regra "esperando", user = marcado pelo mentor), a janela de mensagens que a
-- IA viu (para a avaliação virar um exemplo completo) e o modelo que respondeu.
ALTER TABLE alerts ADD COLUMN source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'rule', 'user'));
ALTER TABLE alerts ADD COLUMN context_text TEXT;
ALTER TABLE alerts ADD COLUMN model TEXT;
UPDATE alerts SET source = 'rule' WHERE kind = 'esperando';
-- Uma avaliação por alerta (mudar de ideia atualiza); "missed" (faltou um alerta) não tem alert_id.
CREATE TABLE alert_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER UNIQUE,
  jid TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('urgente', 'desanimo', 'reuniao', 'travado', 'esperando')),
  msg_id TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('up', 'down', 'missed')),
  reason_code TEXT,
  reason_text TEXT,
  correct_kind TEXT,
  context_text TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  model TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_alert_feedback_created ON alert_feedback(created_at);
CREATE INDEX idx_alert_feedback_jid ON alert_feedback(jid, created_at);
CREATE INDEX idx_alert_feedback_msg ON alert_feedback(jid, kind, msg_id);
