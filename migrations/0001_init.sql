PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  logical_name TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  current_telegram_file_id TEXT,
  current_telegram_message_id INTEGER,
  current_hash TEXT,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted'))
);
CREATE INDEX IF NOT EXISTS idx_files_owner_updated ON files(owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  telegram_file_id TEXT NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  telegram_file_unique_id TEXT,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  base_version INTEGER NOT NULL,
  restored_from_version INTEGER,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'expired')),
  UNIQUE(file_id, version)
);
CREATE INDEX IF NOT EXISTS idx_file_versions_file_version ON file_versions(file_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_file_versions_status ON file_versions(file_id, status, version DESC);

CREATE TABLE IF NOT EXISTS upload_intents (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  logical_name TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'uploaded', 'committed', 'abandoned')),
  telegram_file_id TEXT,
  telegram_message_id INTEGER,
  telegram_file_unique_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_upload_intents_file ON upload_intents(file_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sync_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_events_created ON sync_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_events_file ON sync_events(file_id, created_at DESC);

CREATE TABLE IF NOT EXISTS storage_config (
  provider TEXT PRIMARY KEY,
  chat_id TEXT,
  connected_by TEXT REFERENCES users(id),
  connected_at TEXT
);
INSERT OR IGNORE INTO storage_config(provider, chat_id) VALUES ('telegram', NULL);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  retention_limit INTEGER NOT NULL DEFAULT 20 CHECK(retention_limit BETWEEN 2 AND 500),
  updated_at TEXT NOT NULL
);
