-- Busca geral (v0.3.1): índice de texto de todas as mensagens (texto + transcrição dos áudios) e, nos grupos, o nome
-- de quem mandou. rowid = messages.rowid. Mantido por gatilhos; o preenchimento inicial vem no fim.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  body,
  sender,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body, sender)
    SELECT new.rowid, TRIM(COALESCE(new.text, '') || ' ' || COALESCE(new.transcript, '')), COALESCE(new.sender_name, '')
     WHERE COALESCE(new.text, new.transcript, new.sender_name) IS NOT NULL;
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE OF text, transcript, sender_name ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
  INSERT INTO messages_fts(rowid, body, sender)
    SELECT new.rowid, TRIM(COALESCE(new.text, '') || ' ' || COALESCE(new.transcript, '')), COALESCE(new.sender_name, '')
     WHERE COALESCE(new.text, new.transcript, new.sender_name) IS NOT NULL;
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;
INSERT INTO messages_fts(rowid, body, sender)
  SELECT rowid, TRIM(COALESCE(text, '') || ' ' || COALESCE(transcript, '')), COALESCE(sender_name, '')
    FROM messages WHERE COALESCE(text, transcript, sender_name) IS NOT NULL;
-- filtro de período da busca
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
