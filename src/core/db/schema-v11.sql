-- v0.3.0: o telefone do mentor é só profissional, então a interface não esconde mais conversas. Quem estava escondido
-- volta a aparecer; a lista fica em settings_kv para o serviço devolver à fila (no ritmo normal) os áudios que não foram
-- baixados/transcritos enquanto o contato estava escondido. A coluna `hidden` continua (sempre 0).
INSERT OR REPLACE INTO settings_kv(key, value)
  SELECT 'migration.unhidden_jids', json_group_array(jid) FROM contacts WHERE hidden = 1 HAVING COUNT(*) > 0;
UPDATE contacts SET hidden = 0 WHERE hidden <> 0;
