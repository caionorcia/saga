-- Follow-up com envio automático (v0.8.0, contrato v1.2). Em `copiloto_followups`: `auto_send` (o Copiloto marcou o
-- item para envio automático; só vale com a opção ligada nas Configurações), `auto_at` (o horário escolhido para o
-- envio automático, gravado para um reinício não sortear de novo nem enviar na abertura do horário), `auto_off` (o
-- envio automático deste item acabou: estado desconhecido, falha ou tentativas demais; volta ao cartão da v1.1) e
-- `auto_attempts`. Em `sends`: `auto` (o envio saiu sem a tela de confirmação; conta no limite de 30 por dia).
ALTER TABLE copiloto_followups ADD COLUMN auto_send INTEGER NOT NULL DEFAULT 0 CHECK (auto_send IN (0, 1));
ALTER TABLE copiloto_followups ADD COLUMN auto_at INTEGER;
ALTER TABLE copiloto_followups ADD COLUMN auto_off INTEGER NOT NULL DEFAULT 0 CHECK (auto_off IN (0, 1));
ALTER TABLE copiloto_followups ADD COLUMN auto_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sends ADD COLUMN auto INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0, 1));
CREATE INDEX IF NOT EXISTS idx_sends_auto ON sends(auto, queued_at);
