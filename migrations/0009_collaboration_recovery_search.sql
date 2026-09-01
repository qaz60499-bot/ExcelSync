-- ExcelSync 1.5.0 collaboration/recovery/search foundation.
-- Additive migration: file lease locks, domain activity + notifications, comments,
-- file metadata history, and resumable folder/workspace rewind operations.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS file_edit_leases (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  lease_id TEXT NOT NULL UNIQUE,
  lock_type TEXT NOT NULL DEFAULT 'EDIT' CHECK (lock_type IN ('EDIT')),
  created_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_edit_leases_workspace_expiry
  ON file_edit_leases(workspace_id, expires_at, heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_edit_leases_owner
  ON file_edit_leases(owner_user_id, owner_device_id, expires_at);

CREATE TABLE IF NOT EXISTS domain_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'FILE' CHECK (category IN ('FILE','TASK','SYSTEM','SECURITY','COLLABORATION','RECOVERY')),
  target_type TEXT NOT NULL,
  target_id TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_domain_events_org_created
  ON domain_events(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_domain_events_workspace_created
  ON domain_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_domain_events_file_created
  ON domain_events(file_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES domain_events(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'FILE' CHECK (category IN ('FILE','TASK','SYSTEM','SECURITY','COLLABORATION','RECOVERY')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  resource_type TEXT,
  resource_id TEXT,
  comment_id TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT,
  expires_at TEXT,
  UNIQUE(recipient_user_id, event_id, category)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(recipient_user_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_category
  ON notifications(recipient_user_id, category, created_at DESC);

CREATE TABLE IF NOT EXISTS file_comments (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_comment_id TEXT REFERENCES file_comments(id) ON DELETE CASCADE,
  file_version INTEGER,
  body TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_file_comments_file_created
  ON file_comments(file_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_file_comments_parent
  ON file_comments(parent_comment_id, created_at ASC);

CREATE TABLE IF NOT EXISTS comment_mentions (
  comment_id TEXT NOT NULL REFERENCES file_comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_comment_mentions_user
  ON comment_mentions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS file_state_history (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  logical_name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','trashed','deleted')),
  content_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  source_event_id TEXT REFERENCES domain_events(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_file_state_history_file_created
  ON file_state_history(file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_state_history_workspace_created
  ON file_state_history(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_state_history_workspace_path
  ON file_state_history(workspace_id, relative_path, created_at DESC);

-- Establish a baseline for all existing files. This does not invent older history;
-- rewind before this baseline remains intentionally unsupported unless prior state exists.
INSERT INTO file_state_history(
  id, file_id, workspace_id, logical_name, relative_path, status,
  content_version, event_type, actor_user_id, created_at, source_event_id
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) ||
  '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) ||
  '-' || lower(hex(randomblob(6))),
  f.id, f.workspace_id, f.logical_name, f.relative_path, f.status,
  f.current_version, 'SNAPSHOT_BASELINE', COALESCE(f.updated_by_user_id, f.updated_by), CURRENT_TIMESTAMP, NULL
FROM files f
WHERE f.workspace_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM file_state_history h WHERE h.file_id = f.id);

CREATE TABLE IF NOT EXISTS rewind_operations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('FOLDER','WORKSPACE')),
  scope_value TEXT NOT NULL,
  target_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','RUNNING','PARTIAL','COMPLETED','FAILED','CANCELLED')),
  idempotency_key TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  summary_json TEXT,
  error_text TEXT,
  UNIQUE(organization_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_rewind_operations_workspace_created
  ON rewind_operations(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rewind_items (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES rewind_operations(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('RESTORE_VERSION','RESTORE_PATH','RESTORE_STATUS','TRASH_NEW','NOOP')),
  target_version INTEGER,
  target_logical_name TEXT,
  target_relative_path TEXT,
  target_status TEXT CHECK (target_status IN ('active','trashed','deleted')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','DONE','FAILED','SKIPPED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(operation_id, file_id, action)
);
CREATE INDEX IF NOT EXISTS idx_rewind_items_operation_status
  ON rewind_items(operation_id, status, created_at);
