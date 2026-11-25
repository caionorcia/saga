-- Grupos (v0.1.5): o contato pode ser um grupo (`@g.us`); cada mensagem de grupo guarda quem mandou.
ALTER TABLE contacts ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN sender_jid TEXT;
ALTER TABLE messages ADD COLUMN sender_name TEXT;
-- A mensagem menciona o mentor (@) ou responde (cita) uma mensagem dele.
ALTER TABLE messages ADD COLUMN mentions_me INTEGER NOT NULL DEFAULT 0;
