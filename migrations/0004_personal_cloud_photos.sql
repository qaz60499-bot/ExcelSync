-- Historical migration filename retained because deployed D1 databases may already
-- record 0004 as applied. ExcelSync no longer owns the Personal Cloud Photos domain.
-- Fresh ExcelSync databases only need the generic file-storage profile introduced
-- during that iteration.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS storage_profiles (
  profile TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose = 'files'),
  provider TEXT NOT NULL,
  chat_id TEXT,
  connected_by TEXT REFERENCES users(id),
  connected_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

INSERT OR IGNORE INTO storage_profiles(profile, purpose, provider, chat_id, connected_by, connected_at)
SELECT 'files-primary', 'files', 'telegram', chat_id, connected_by, connected_at
FROM storage_config
WHERE provider = 'telegram';

INSERT OR IGNORE INTO storage_profiles(profile, purpose, provider, chat_id)
VALUES ('files-primary', 'files', 'telegram', NULL);
