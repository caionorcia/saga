-- v0.8.1: nomes (assuntos) dos grupos guardados mesmo antes de o grupo ter uma conversa aqui (a consulta dos grupos
-- chega antes das mensagens do histórico); a conversa do grupo pega o nome quando é criada. E o nome novo de um grupo
-- de mentorado vai ao Copiloto (a mensagem mais recente dele volta à fila com o `chat.name` novo).
CREATE TABLE IF NOT EXISTS group_subjects (
  group_jid TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
UPDATE contacts SET push_name = (SELECT subject FROM group_subjects g WHERE g.group_jid = contacts.jid), name_rank = 2
 WHERE is_group = 1 AND push_name IS NULL AND jid IN (SELECT group_jid FROM group_subjects);
DROP TRIGGER IF EXISTS copiloto_group_name_au;
CREATE TRIGGER copiloto_group_name_au AFTER UPDATE OF push_name, custom_name ON contacts
WHEN new.is_group = 1 AND (new.push_name IS NOT old.push_name OR new.custom_name IS NOT old.custom_name)
 AND (SELECT value FROM settings_kv WHERE key = 'copiloto.enabled') = '1' BEGIN
  INSERT OR IGNORE INTO copiloto_dirty(ref, jid) VALUES ('n:' || new.jid, new.jid);
END;
