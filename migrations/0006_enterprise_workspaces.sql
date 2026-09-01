-- ExcelSync 1.3.0 enterprise/workspace foundation.
-- Compatibility strategy: preserve all legacy columns and Telegram object metadata,
-- add organization/workspace boundaries, and backfill a single default workspace.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO organizations(id, name, status, created_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'ExcelSync Organization', 'ACTIVE', CURRENT_TIMESTAMP);

ALTER TABLE users ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN system_role TEXT NOT NULL DEFAULT 'MEMBER' CHECK (system_role IN ('OWNER', 'ADMIN', 'MEMBER'));
ALTER TABLE users ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle_status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'));
ALTER TABLE users ADD COLUMN last_login_at TEXT;

UPDATE users
   SET organization_id = COALESCE(organization_id, '00000000-0000-4000-8000-000000000001'),
       display_name = COALESCE(NULLIF(trim(display_name), ''), username),
       lifecycle_status = CASE WHEN status = 'active' THEN 'ACTIVE' ELSE 'DEACTIVATED' END;

UPDATE users
   SET system_role = 'OWNER'
 WHERE id = (SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1);

CREATE INDEX IF NOT EXISTS idx_users_org_role ON users(organization_id, system_role);
CREATE INDEX IF NOT EXISTS idx_users_org_lifecycle ON users(organization_id, lifecycle_status);

CREATE TABLE IF NOT EXISTS storage_connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  telegram_bot_id TEXT,
  telegram_bot_username TEXT,
  telegram_bot_name TEXT,
  credential_ciphertext TEXT,
  credential_iv TEXT,
  credential_source TEXT NOT NULL DEFAULT 'ENCRYPTED' CHECK (credential_source IN ('ENCRYPTED', 'LEGACY_WORKER_SECRET')),
  chat_id TEXT,
  chat_title TEXT,
  status TEXT NOT NULL DEFAULT 'DEGRADED' CHECK (status IN ('ACTIVE', 'DEGRADED', 'DISABLED')),
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_health_check_at TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_storage_connections_org_status ON storage_connections(organization_id, status, created_at DESC);

INSERT OR IGNORE INTO storage_connections(
  id, organization_id, provider, name, credential_source, chat_id, status,
  created_by_user_id, created_at, updated_at
)
SELECT
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000001',
  'telegram',
  'Legacy Telegram Storage',
  'LEGACY_WORKER_SECRET',
  COALESCE(sp.chat_id, sc.chat_id),
  CASE WHEN COALESCE(sp.chat_id, sc.chat_id) IS NULL THEN 'DEGRADED' ELSE 'ACTIVE' END,
  COALESCE(sp.connected_by, sc.connected_by, (SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1)),
  COALESCE(sp.connected_at, sc.connected_at, CURRENT_TIMESTAMP),
  CURRENT_TIMESTAMP
FROM (SELECT 1) seed
LEFT JOIN storage_profiles sp ON sp.profile = 'files-primary'
LEFT JOIN storage_config sc ON sc.provider = 'telegram'
LIMIT 1;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'TEAM' CHECK (type IN ('PERSONAL', 'TEAM', 'PROJECT')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  default_storage_connection_id TEXT REFERENCES storage_connections(id),
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workspaces_org_status ON workspaces(organization_id, status, name COLLATE NOCASE);

INSERT OR IGNORE INTO workspaces(
  id, organization_id, name, type, status, default_storage_connection_id, created_by_user_id, created_at
)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  'Default Workspace',
  'TEAM',
  'ACTIVE',
  '00000000-0000-4000-8000-000000000003',
  (SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1),
  CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('MANAGER', 'EDITOR', 'VIEWER')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id, workspace_id);

INSERT OR IGNORE INTO workspace_members(workspace_id, user_id, role, joined_at)
SELECT
  '00000000-0000-4000-8000-000000000002',
  u.id,
  CASE WHEN u.system_role = 'OWNER' THEN 'MANAGER' ELSE 'EDITOR' END,
  CURRENT_TIMESTAMP
FROM users u
WHERE u.organization_id = '00000000-0000-4000-8000-000000000001';

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  username TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT REFERENCES workspaces(id),
  workspace_role TEXT CHECK (workspace_role IN ('MANAGER', 'EDITOR', 'VIEWER')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'USED', 'REVOKED', 'EXPIRED')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_org_status ON invites(organization_id, status, expires_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_pending_username
  ON invites(organization_id, username COLLATE NOCASE)
  WHERE status = 'PENDING';

ALTER TABLE files ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE files ADD COLUMN created_by_user_id TEXT REFERENCES users(id);
ALTER TABLE files ADD COLUMN updated_by_user_id TEXT REFERENCES users(id);

UPDATE files
   SET workspace_id = COALESCE(workspace_id, '00000000-0000-4000-8000-000000000002'),
       created_by_user_id = COALESCE(created_by_user_id, owner_user_id),
       updated_by_user_id = COALESCE(updated_by_user_id, updated_by);

DROP INDEX IF EXISTS idx_files_owner_active_relative_path;
CREATE INDEX IF NOT EXISTS idx_files_workspace_updated ON files(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_workspace_status_updated ON files(workspace_id, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_workspace_active_relative_path
  ON files(workspace_id, relative_path COLLATE NOCASE)
  WHERE status = 'active';

ALTER TABLE upload_intents ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE upload_intents ADD COLUMN storage_connection_id TEXT REFERENCES storage_connections(id);
UPDATE upload_intents
   SET workspace_id = COALESCE(workspace_id, (SELECT workspace_id FROM files WHERE files.id = upload_intents.file_id)),
       storage_connection_id = COALESCE(storage_connection_id, '00000000-0000-4000-8000-000000000003');
CREATE INDEX IF NOT EXISTS idx_upload_intents_workspace ON upload_intents(workspace_id, created_at DESC);

ALTER TABLE file_versions ADD COLUMN storage_connection_id TEXT REFERENCES storage_connections(id);
UPDATE file_versions
   SET storage_connection_id = COALESCE(storage_connection_id, '00000000-0000-4000-8000-000000000003');
CREATE INDEX IF NOT EXISTS idx_file_versions_storage ON file_versions(storage_connection_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO', 'IN_PROGRESS', 'DONE')),
  priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  assignee_user_id TEXT REFERENCES users(id),
  legacy_assignee_text TEXT,
  legacy_client_id TEXT,
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status ON tasks(workspace_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks(assignee_user_id, status, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_legacy_client
  ON tasks(created_by_user_id, legacy_client_id)
  WHERE legacy_client_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_file_links (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, file_id)
);
CREATE INDEX IF NOT EXISTS idx_task_file_links_file ON task_file_links(file_id, task_id);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_workspace_id TEXT REFERENCES workspaces(id),
  file_view_mode TEXT NOT NULL DEFAULT 'list' CHECK (file_view_mode IN ('list', 'grid')),
  sort_by TEXT NOT NULL DEFAULT 'updated_desc',
  page_size INTEGER NOT NULL DEFAULT 100 CHECK (page_size BETWEEN 20 AND 500),
  ui_density TEXT NOT NULL DEFAULT 'comfortable' CHECK (ui_density IN ('compact', 'comfortable')),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO user_preferences(user_id, default_workspace_id, updated_at)
SELECT u.id, '00000000-0000-4000-8000-000000000002', CURRENT_TIMESTAMP
FROM users u;

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  actor_user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created ON audit_logs(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id, created_at DESC);
