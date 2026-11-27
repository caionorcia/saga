-- v0.10.0 (contrato v2): follow-ups de conversa (onboarding e sumido). A IA conduz a conversa no grupo do mentorado
-- rumo ao objetivo (`goal_json`, como o Copiloto mandou), e o mentor confirma cada mensagem (o rascunho da vez fica
-- em `draft_*`; o envio é uma mensagem avulsa com o id do rascunho, todas as travas de sempre). `target_json` guarda o
-- alvo como veio (chat.key, nunca um número). Nada de telefone em claro aqui.
CREATE TABLE IF NOT EXISTS copiloto_convos (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('onboarding', 'sumido')),
  target_json TEXT NOT NULL,
  author TEXT,
  created_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  jid TEXT,
  goal_json TEXT NOT NULL,
  -- pendências que o mentor confirmou (JSON: textos)
  items_done_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('active', 'responded', 'scheduled', 'completed', 'no_reply', 'declined', 'failed', 'cancelled')),
  reason TEXT,
  -- dia 0: o primeiro horário permitido depois da entrega (epoch ms)
  day0_at INTEGER NOT NULL,
  -- recebida com o "Modo de teste dos follow-ups" ligado: 1 dia da cadência = 2 min (vale até o fim dela)
  test_mode INTEGER NOT NULL DEFAULT 0 CHECK (test_mode IN (0, 1)),
  -- a próxima vaga da cadência (índice em cadence_days) e as tentativas que de fato saíram
  slot INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  -- a última mensagem que saiu por esta conversa (tentativa ou resposta)
  last_sent_at INTEGER,
  -- uma tentativa saiu e a pessoa ainda não respondeu depois dela
  awaiting_reply INTEGER NOT NULL DEFAULT 0 CHECK (awaiting_reply IN (0, 1)),
  replied_at INTEGER,
  -- a mensagem mais nova do mentorado já tratada (pedida à IA, ou "precisa de você")
  handled_ts INTEGER NOT NULL DEFAULT 0,
  -- o rascunho da vez (no máximo um por conversa)
  draft_id TEXT,
  draft_kind TEXT CHECK (draft_kind IN ('attempt', 'reply')),
  draft_slot INTEGER,
  draft_text TEXT,
  draft_state TEXT CHECK (draft_state IN ('ready', 'approved', 'sending')),
  draft_at INTEGER,
  draft_forced INTEGER NOT NULL DEFAULT 0 CHECK (draft_forced IN (0, 1)),
  draft_send_id INTEGER,
  draft_error TEXT,
  draft_summary TEXT,
  needs_you TEXT,
  ai_error TEXT,
  suggest_scheduled INTEGER NOT NULL DEFAULT 0 CHECK (suggest_scheduled IN (0, 1)),
  suggest_items_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_convos_status ON copiloto_convos(status);
CREATE INDEX IF NOT EXISTS idx_convos_jid ON copiloto_convos(jid, status);

-- Os relatórios das conversas (`followup_update` v2: running a cada mensagem, responded, e o final), na ordem em que
-- aconteceram. `payload_json` é o item do contrato já montado (só o que o contrato pede; nunca telefone).
CREATE TABLE IF NOT EXISTS copiloto_convo_reports (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  convo_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  last_result TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_convo_reports_due ON copiloto_convo_reports(done, next_at);
