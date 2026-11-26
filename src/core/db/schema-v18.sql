-- Follow-up do Copiloto (v0.7.0, contrato v1.1): mensagens escritas pela equipe no Copiloto, buscadas pelo SagaZap e
-- enviadas só depois da confirmação do mentor, como mensagem avulsa (o id do follow-up é o id do rascunho: a chave de
-- idempotência do envio leva ele). `target_json` guarda o alvo como veio (hashes de telefone ou chat.key, nunca um
-- número); `jid` é a conversa local que casou (null: não encontrada). `reported` = o Copiloto já confirmou o status.
CREATE TABLE IF NOT EXISTS copiloto_followups (
  id TEXT PRIMARY KEY,
  target_json TEXT NOT NULL,
  text TEXT NOT NULL,
  author TEXT,
  created_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  jid TEXT,
  local_status TEXT NOT NULL CHECK (local_status IN ('waiting', 'sending', 'sent', 'declined', 'failed', 'cancelled')),
  send_id INTEGER,
  final_text TEXT,
  sent_at INTEGER,
  reason TEXT,
  send_error TEXT,
  reported INTEGER NOT NULL DEFAULT 0 CHECK (reported IN (0, 1)),
  report_attempts INTEGER NOT NULL DEFAULT 0,
  next_report_at INTEGER NOT NULL DEFAULT 0,
  last_result TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followups_jid ON copiloto_followups(jid, local_status);
CREATE INDEX IF NOT EXISTS idx_followups_report ON copiloto_followups(reported, local_status, next_report_at);
