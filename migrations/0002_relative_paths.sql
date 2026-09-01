ALTER TABLE files ADD COLUMN relative_path TEXT;

UPDATE files
   SET relative_path = logical_name
 WHERE relative_path IS NULL OR trim(relative_path) = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_files_owner_active_relative_path
  ON files(owner_user_id, relative_path COLLATE NOCASE)
  WHERE status = 'active';
