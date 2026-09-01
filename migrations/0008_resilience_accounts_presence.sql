-- ExcelSync 1.4.0: device/session lifecycle, account type/temporary access,
-- groups + group ACL principals, and short-lived file presence.
-- Keep this migration additive for existing users/sessions; legacy sessions may keep device_id NULL.

PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'INTERNAL'
  CHECK (account_type IN ('INTERNAL', 'EXTERNAL'));
ALTER TABLE users ADD COLUMN access_expires_at TEXT;

ALTER TABLE invites ADD COLUMN account_type TEXT NOT NULL DEFAULT 'INTERNAL'
  CHECK (account_type IN ('INTERNAL', 'EXTERNAL'));
ALTER TABLE invites ADD COLUMN user_expires_at TEXT;

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stable_device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  os_name TEXT NOT NULL,
  os_version TEXT NOT NULL,
  client_version TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  UNIQUE(user_id, stable_device_id)
);
CREATE INDEX IF NOT EXISTS idx_devices_user_last_seen
  ON devices(user_id, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_org_last_seen
  ON devices(organization_id, status, last_seen_at DESC);

ALTER TABLE sessions ADD COLUMN device_id TEXT REFERENCES devices(id);
ALTER TABLE sessions ADD COLUMN revoked_at TEXT;
ALTER TABLE sessions ADD COLUMN revoked_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_user_active
  ON sessions(user_id, revoked_at, expires_at, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_device_active
  ON sessions(device_id, revoked_at, expires_at, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_groups_org_status
  ON groups(organization_id, status, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by_user_id TEXT REFERENCES users(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id, group_id);

-- 0007 intentionally constrained resource_access_rules to USER principals.
-- Rebuild it once so GROUP principals can share the same scope/permission evaluator.
CREATE TABLE resource_access_rules_v2 (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL DEFAULT 'USER' CHECK (principal_type IN ('USER', 'GROUP')),
  principal_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('WORKSPACE', 'STORAGE', 'FOLDER', 'FILE')),
  scope_value TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('VIEW', 'EDIT', 'MANAGE')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO resource_access_rules_v2(
  id, organization_id, workspace_id, principal_type, principal_id,
  scope_type, scope_value, permission, created_by, created_at, updated_at
)
SELECT
  id, organization_id, workspace_id, principal_type, principal_id,
  scope_type, scope_value, permission, created_by, created_at, updated_at
FROM resource_access_rules;

DROP TABLE resource_access_rules;
ALTER TABLE resource_access_rules_v2 RENAME TO resource_access_rules;

CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_access_unique
  ON resource_access_rules(workspace_id, principal_type, principal_id, scope_type, scope_value);
CREATE INDEX IF NOT EXISTS idx_resource_access_principal
  ON resource_access_rules(organization_id, principal_type, principal_id, workspace_id, permission);
CREATE INDEX IF NOT EXISTS idx_resource_access_scope
  ON resource_access_rules(workspace_id, scope_type, scope_value, permission);

CREATE TABLE IF NOT EXISTS file_presence (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'EDITING')),
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (file_id, user_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_file_presence_file_seen
  ON file_presence(file_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_presence_user_seen
  ON file_presence(user_id, last_seen_at DESC);
