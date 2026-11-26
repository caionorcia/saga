-- "Respondido no grupo" (v0.2.3).
-- Quem participa de cada grupo, pela consulta só de leitura `groupFetchAllParticipating` (uma IQ, pela fila). Um
-- participante pode ter duas linhas (telefone e @lid) para casar com o contato da conversa individual, seja qual for.
CREATE TABLE group_members (
  group_jid TEXT NOT NULL,
  member_jid TEXT NOT NULL,
  PRIMARY KEY (group_jid, member_jid)
);
CREATE INDEX idx_group_members_member ON group_members(member_jid);
-- quantos participantes o grupo tem (pela consulta; sem linha = tamanho desconhecido, tratado como grupo grande)
CREATE TABLE group_sizes (
  group_jid TEXT PRIMARY KEY,
  members INTEGER NOT NULL
);
-- minhas mensagens de grupo: quem elas mencionam (@) e o autor da mensagem citada (telefone e/ou @lid)
CREATE TABLE message_targets (
  msg_id TEXT NOT NULL,
  target_jid TEXT NOT NULL,
  PRIMARY KEY (msg_id, target_jid)
);
CREATE INDEX idx_message_targets_target ON message_targets(target_jid);
-- quem já mandou mensagem num grupo também conta como participante
CREATE INDEX idx_messages_sender ON messages(sender_jid, jid);
CREATE INDEX idx_messages_from_me_ts ON messages(from_me, ts);
-- "Já respondi por outro meio" virou dois motivos; para este mentor o padrão era "respondi no grupo dele"
UPDATE reply_feedback SET reason_code = 'respondi_grupo' WHERE reason_code = 'outro_meio';
