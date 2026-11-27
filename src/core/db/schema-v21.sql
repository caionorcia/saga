-- v0.9.0 (contrato v1.3): o histórico completo fica guardado (sem a janela de 30 dias na gravação). Só índices, sem mexer
-- nos dados: quem mandou cada mensagem de grupo ("Respondido no grupo", participantes, pesquisa do Copiloto) e as
-- mensagens por tipo (áudios de uma conversa) continuam rápidos com 100 mil mensagens ou mais.
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_jid, jid) WHERE sender_jid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_jid_kind_ts ON messages(jid, kind, ts);
