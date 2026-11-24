-- Mantém approved_fts (tabela FTS5 independente) sincronizada com approved_replies; rowid = id.
CREATE TRIGGER approved_replies_ai AFTER INSERT ON approved_replies BEGIN
  INSERT INTO approved_fts(rowid, context_text, final_text) VALUES (new.id, new.context_text, new.final_text);
END;
CREATE TRIGGER approved_replies_au AFTER UPDATE OF context_text, final_text ON approved_replies BEGIN
  DELETE FROM approved_fts WHERE rowid = old.id;
  INSERT INTO approved_fts(rowid, context_text, final_text) VALUES (new.id, new.context_text, new.final_text);
END;
CREATE TRIGGER approved_replies_ad AFTER DELETE ON approved_replies BEGIN
  DELETE FROM approved_fts WHERE rowid = old.id;
END;
CREATE INDEX idx_approved_jid_created ON approved_replies(jid, created_at);
DELETE FROM approved_fts;
INSERT INTO approved_fts(rowid, context_text, final_text) SELECT id, context_text, final_text FROM approved_replies;
