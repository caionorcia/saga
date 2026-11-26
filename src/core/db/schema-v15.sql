-- Horário de envio (v0.4.1): a confirmação foi feita com "Forçar envio" (pode sair fora do horário de envio).
ALTER TABLE sends ADD COLUMN forced INTEGER NOT NULL DEFAULT 0;
