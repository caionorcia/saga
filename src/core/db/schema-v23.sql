-- v0.10.1: quem mandou cada mensagem de grupo, pelo telefone. Nos grupos o WhatsApp manda o remetente como @lid; o
-- telefone vem (quando vem) no endereço alternativo da chave (`participantAlt`), nos pares @lid ↔ telefone do histórico e
-- dos eventos, nos contatos, nos participantes do grupo ou no armazenamento local do Baileys. `sender_pn` guarda o
-- telefone (`@s.whatsapp.net`) de quem mandou, quando conhecido; `sender_jid` continua como chegou (telefone ou @lid).
ALTER TABLE messages ADD COLUMN sender_pn TEXT;
UPDATE messages SET sender_pn = sender_jid WHERE sender_jid LIKE '%@s.whatsapp.net' AND sender_pn IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_sender_pn ON messages(sender_pn, jid) WHERE sender_pn IS NOT NULL;
-- Os pares @lid → telefone aprendidos (antes ficavam só na memória e se perdiam ao fechar o app). Só neste computador.
CREATE TABLE IF NOT EXISTS lid_pn (
  lid TEXT PRIMARY KEY,
  pn TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- O telefone de quem mandou uma mensagem de grupo apareceu depois: a mensagem volta ao Copiloto com o `sender.phone`
-- certo (o mesmo id; só sai de novo se o evento mudou).
DROP TRIGGER IF EXISTS copiloto_msg_sender_au;
CREATE TRIGGER copiloto_msg_sender_au AFTER UPDATE OF sender_pn ON messages
WHEN new.sender_pn IS NOT old.sender_pn AND new.from_me = 0 AND new.jid LIKE '%@g.us'
 AND (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('m:' || new.id, new.jid);
END;
