-- One transactional invalidation marker for file metadata and every ACL dependency.
-- No file bytes, credentials or per-request writes. Old Workers ignore this key.
INSERT OR IGNORE INTO app_settings(key,value,updated_at) VALUES ('file_list_revision','1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TRIGGER IF NOT EXISTS file_list_revision_files_insert
AFTER INSERT ON files
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_files_update
AFTER UPDATE ON files
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_files_delete
AFTER DELETE ON files
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_workspaces_insert
AFTER INSERT ON workspaces
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_workspaces_update
AFTER UPDATE ON workspaces
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_workspaces_delete
AFTER DELETE ON workspaces
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_workspace_members_insert
AFTER INSERT ON workspace_members
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_workspace_members_update
AFTER UPDATE ON workspace_members
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_workspace_members_delete
AFTER DELETE ON workspace_members
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_resource_access_rules_insert
AFTER INSERT ON resource_access_rules
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_resource_access_rules_update
AFTER UPDATE ON resource_access_rules
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_resource_access_rules_delete
AFTER DELETE ON resource_access_rules
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_groups_insert
AFTER INSERT ON groups
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_groups_update
AFTER UPDATE ON groups
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_groups_delete
AFTER DELETE ON groups
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_group_members_insert
AFTER INSERT ON group_members
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_group_members_update
AFTER UPDATE ON group_members
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;

CREATE TRIGGER IF NOT EXISTS file_list_revision_group_members_delete
AFTER DELETE ON group_members
BEGIN
  UPDATE app_settings SET value = CAST(value AS INTEGER) + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE key = 'file_list_revision';
END;
