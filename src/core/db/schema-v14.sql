-- Envio direto (v0.4.0).
-- A chave original da mensagem do contato (remoteJid, id, participant), para citar nos grupos e marcar como lida
-- exatamente essa mensagem (o `jid` da conversa pode ter virado o telefone de um @lid).
ALTER TABLE messages ADD COLUMN wa_key_json TEXT;
-- Um envio confirmado pelo mentor. `idem_key` = resposta aprovada + impressão do texto: a mesma resposta com o mesmo
-- texto nunca vira dois envios (um novo pedido só reaproveita a linha depois de falha, expiração ou estado desconhecido).
CREATE TABLE sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key TEXT NOT NULL UNIQUE,
  reply_id INTEGER NOT NULL,
  jid TEXT NOT NULL,
  text TEXT NOT NULL,
  -- para onde vai (escolhido na confirmação): o grupo, ou na individual o JID como o contato escreveu por último
  -- (@lid quando a conversa migrou para LID, senão o telefone)
  address TEXT NOT NULL,
  -- grupo: a mensagem citada que o mentor viu na confirmação (null = sem citação)
  quoted_id TEXT,
  -- os ids de mensagem que o próprio app gerou para cada tentativa (conferir na conversa pelo id, sem depender do relógio)
  msg_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('queued', 'typing', 'sending', 'sent', 'failed', 'unknown', 'expired', 'canceled')),
  attempt INTEGER NOT NULL DEFAULT 1,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  sent_at INTEGER,
  wa_msg_id TEXT,
  error TEXT
);
CREATE INDEX idx_sends_jid ON sends(jid, id);
CREATE INDEX idx_sends_status ON sends(status);
