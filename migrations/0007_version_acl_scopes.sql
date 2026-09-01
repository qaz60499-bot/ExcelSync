-- ExcelSync 1.3.1: stable logical storage domains, resource visibility ACLs,
-- and version-integrity repair audit records. Additive only.

PRAGMA foreign_keys = ON;

ALTER TABLE files ADD COLUMN home_storage_connection_id TEXT REFERENCES storage_connections(id);

-- Preserve logical storage ownership independently from where later versions live.
-- Prefer the earliest known historical storage because it best represents the file's
-- original storage domain; otherwise fall back to the workspace default / legacy storage.
UPDATE files
   SET home_storage_connection_id = COALESCE(
     home_storage_connection_id,
     (
       SELECT fv.storage_connection_id
         FROM file_versions fv
        WHERE fv.file_id = files.id
          AND fv.storage_connection_id IS NOT NULL
        ORDER BY fv.version ASC
        LIMIT 1
     ),
     (
       SELECT w.default_storage_connection_id
         FROM workspaces w
        WHERE w.id = files.workspace_id
        LIMIT 1
     ),
     '00000000-0000-4000-8000-000000000003'
   );

CREATE INDEX IF NOT EXISTS idx_files_home_storage
  ON files(workspace_id, home_storage_connection_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS resource_access_rules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL DEFAULT 'USER' CHECK (principal_type IN ('USER')),
  principal_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('WORKSPACE', 'STORAGE', 'FOLDER', 'FILE')),
  scope_value TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('VIEW', 'EDIT', 'MANAGE')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_access_unique
  ON resource_access_rules(workspace_id, principal_type, principal_id, scope_type, scope_value);
CREATE INDEX IF NOT EXISTS idx_resource_access_principal
  ON resource_access_rules(organization_id, principal_id, workspace_id, permission);
CREATE INDEX IF NOT EXISTS idx_resource_access_scope
  ON resource_access_rules(workspace_id, scope_type, scope_value, permission);

-- Backfill 1.3.0 semantics: every existing workspace membership keeps full workspace
-- visibility until an administrator explicitly narrows that user's resource scopes.
INSERT OR IGNORE INTO resource_access_rules(
  id, organization_id, workspace_id, principal_type, principal_id,
  scope_type, scope_value, permission, created_by, created_at, updated_at
)
SELECT
  lower(hex(randomblob(16))),
  w.organization_id,
  wm.workspace_id,
  'USER',
  wm.user_id,
  'WORKSPACE',
  wm.workspace_id,
  CASE wm.role WHEN 'MANAGER' THEN 'MANAGE' WHEN 'EDITOR' THEN 'EDIT' ELSE 'VIEW' END,
  w.created_by_user_id,
  wm.joined_at,
  CURRENT_TIMESTAMP
FROM workspace_members wm
JOIN workspaces w ON w.id = wm.workspace_id;

CREATE TABLE IF NOT EXISTS version_integrity_repairs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  repair_status TEXT NOT NULL CHECK (repair_status IN ('REPAIRED', 'SKIPPED', 'FAILED')),
  detail TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_version_integrity_repairs_file
  ON version_integrity_repairs(file_id, version, created_at DESC);
