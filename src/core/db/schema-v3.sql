-- A análise vale enquanto a última mensagem E as transcrições do contexto não mudarem.
ALTER TABLE analyses ADD COLUMN transcript_fp TEXT NOT NULL DEFAULT '';
-- Quantos áudios do contexto ainda estavam sendo transcritos quando a análise foi feita.
ALTER TABLE analyses ADD COLUMN pending_audios INTEGER NOT NULL DEFAULT 0;
