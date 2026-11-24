CREATE TABLE contacts (
  jid TEXT PRIMARY KEY,
  push_name TEXT,
  custom_name TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  jid TEXT NOT NULL REFERENCES contacts(jid),
  from_me INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'audio', 'other')),
  text TEXT,
  media_key_json TEXT,
  duration_sec INTEGER,
  audio_path TEXT,
  transcript TEXT,
  transcript_status TEXT CHECK (transcript_status IN ('done', 'failed', 'unavailable'))
);
CREATE INDEX idx_messages_jid_ts ON messages(jid, ts);

CREATE TABLE analyses (
  jid TEXT PRIMARY KEY REFERENCES contacts(jid),
  last_msg_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  summary TEXT NOT NULL,
  suggestions_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE approved_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  context_text TEXT NOT NULL,
  original_suggestion TEXT,
  final_text TEXT NOT NULL,
  sent_text TEXT,
  provider TEXT,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE approved_fts USING fts5(
  context_text,
  final_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX idx_jobs_status_next ON jobs(status, next_run_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE TABLE settings_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
