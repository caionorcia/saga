-- De onde veio o nome em push_name, para não trocar um nome melhor por um pior:
-- 0 = nenhum/antigo, 1 = pushName de mensagem, 2 = perfil (notify/verifiedName) ou nome do chat, 3 = agenda.
ALTER TABLE contacts ADD COLUMN name_rank INTEGER NOT NULL DEFAULT 0;
