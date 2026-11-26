-- v0.3.0: o mentor escolhe uma sugestão (Copiar ou Salvar). A escolha fica guardada com a análise (some quando uma
-- análise nova é gerada) e as sugestões não escolhidas vão junto da resposta aprovada, como sinal de preferência.
ALTER TABLE analyses ADD COLUMN chosen_index INTEGER;
ALTER TABLE analyses ADD COLUMN chosen_reply_id INTEGER;
ALTER TABLE approved_replies ADD COLUMN rejected_json TEXT;
