-- Base de conhecimento (v0.3.0): pacotes importados (.zip/.skill/pasta) e os "Arquivos avulsos", seus arquivos
-- (com o papel: regras, conhecimento, interno ou desligado) e os trechos indexados para a busca. Só neste computador.
CREATE TABLE kb_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('package', 'manual')),
  enabled INTEGER NOT NULL DEFAULT 1,
  imported_at INTEGER NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE kb_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL REFERENCES kb_packages(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('regras', 'conhecimento', 'interno', 'desligado')),
  auto_role TEXT NOT NULL CHECK (auto_role IN ('regras', 'conhecimento', 'interno', 'desligado')),
  role_reason TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  sections INTEGER NOT NULL DEFAULT 0,
  UNIQUE (package_id, path)
);
CREATE TABLE kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES kb_files(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  heading TEXT NOT NULL,
  breadcrumb TEXT NOT NULL,
  text TEXT NOT NULL,
  -- dinheiro ou vários nomes de pessoas: vai para a IA só como orientação
  sensitive INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_kb_chunks_file ON kb_chunks(file_id, ord);
-- rowid = kb_chunks.id; `heading` leva o nome do arquivo e o título da seção
CREATE VIRTUAL TABLE kb_fts USING fts5(
  heading,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);
-- trechos de conhecimento usados na sugestão ("Baseado em"), como JSON [{chunkId, breadcrumb}]
ALTER TABLE analyses ADD COLUMN sources_json TEXT NOT NULL DEFAULT '[]';
