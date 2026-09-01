PRAGMA defer_foreign_keys = ON;

CREATE TABLE files_new (
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
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trashed', 'deleted')),
  relative_path TEXT,
  trashed_at TEXT,
  trashed_by TEXT REFERENCES users(id)
);

INSERT INTO files_new(
  id, logical_name, current_version, current_telegram_file_id, current_telegram_message_id,
  current_hash, owner_user_id, created_at, updated_at, updated_by, status, relative_path,
  trashed_at, trashed_by
)
SELECT
  id, logical_name, current_version, current_telegram_file_id, current_telegram_message_id,
  current_hash, owner_user_id, created_at, updated_at, updated_by, status, relative_path,
  CASE WHEN status = 'deleted' THEN updated_at ELSE NULL END,
  CASE WHEN status = 'deleted' THEN updated_by ELSE NULL END
FROM files;

DROP TABLE files;
ALTER TABLE files_new RENAME TO files;

CREATE INDEX IF NOT EXISTS idx_files_owner_updated ON files(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_owner_status_updated ON files(owner_user_id, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_owner_active_relative_path
  ON files(owner_user_id, relative_path COLLATE NOCASE)
  WHERE status = 'active';

PRAGMA defer_foreign_keys = OFF;
