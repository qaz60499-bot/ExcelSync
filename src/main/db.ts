import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { ActivityView, CloudFileStatus, LocalFileView, PendingView, ProblemView, SettingsView, SyncStatus, TelegramUserStorageReceipt } from '../shared/contracts'
import type { StorageBackend } from '../shared/storage-capabilities'

export type PendingOperation = 'UPSERT' | 'DELETE' | 'RENAME'

export interface LocalFileRow {
  id: string
  relative_path: string
  logical_name: string
  extension: string
  current_version: number
  current_hash: string | null
  status: SyncStatus
  cloud_status: CloudFileStatus
  favorite?: number
  last_opened_at?: string | null
  created_at: string
  updated_at: string
  storage_backend?: StorageBackend | null
  storage_locator?: string | null
}

export interface LocalFileStateRow {
  file_id: string
  size: number
  mtime_ms: number
  last_hash: string | null
  last_seen_at: string
  exists_flag: number
}

export interface PendingRow {
  id: string
  file_id: string
  operation: PendingOperation
  local_path: string
  hash: string | null
  size: number | null
  base_version: number
  idempotency_key: string
  status: SyncStatus
  attempt_count: number
  priority: number
  next_retry_at: string | null
  error_code: string | null
  error_message: string | null
  storage_backend: StorageBackend
  storage_locator: string | null
  upload_receipt: string | null
  retry_state: string | null
  restored_from_version: number | null
  created_at: string
  updated_at: string
}

const DEFAULT_SETTINGS: SettingsView = {
  syncDirectory: '',
  workerUrl: '',
  autoSync: true,
  startWithWindows: false,
  retryBaseSeconds: 10,
  retentionLimit: 20,
  defaultStorageBackend: 'telegram_user_group'
}

function nowIso(): string {
  return new Date().toISOString()
}

export class LocalDb {
  readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5000 })
    try {
      this.db.exec('PRAGMA journal_mode = WAL;')
      this.db.exec('PRAGMA synchronous = NORMAL;')
      this.db.exec('PRAGMA foreign_keys = ON;')
      this.db.exec('PRAGMA busy_timeout = 5000;')
      this.migrate()
      this.neutralizeLegacyDeletes()
      this.recoverInterruptedJobs()
    } catch (error) {
      if (this.db.isOpen) this.db.close()
      throw error
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE COLLATE NOCASE,
        logical_name TEXT NOT NULL,
        extension TEXT NOT NULL,
        current_version INTEGER NOT NULL DEFAULT 0,
        current_hash TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING',
        cloud_status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_file_state (
        file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
        size INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL NOT NULL DEFAULT 0,
        last_hash TEXT,
        last_seen_at TEXT NOT NULL,
        exists_flag INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_local_state_hash ON local_file_state(last_hash, exists_flag, last_seen_at);

      CREATE TABLE IF NOT EXISTS pending_sync (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK(operation IN ('UPSERT', 'DELETE', 'RENAME')),
        local_path TEXT NOT NULL,
        hash TEXT,
        size INTEGER,
        base_version INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 0 AND 4),
        next_retry_at TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_ready ON pending_sync(status, next_retry_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_pending_file ON pending_sync(file_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS sync_history (
        id TEXT PRIMARY KEY,
        file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_history_created ON sync_history(created_at DESC);

      CREATE TABLE IF NOT EXISTS local_versions (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        base_version INTEGER NOT NULL,
        source_version INTEGER,
        synced_at TEXT NOT NULL,
        UNIQUE(file_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_local_versions_file ON local_versions(file_id, version DESC);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)

    const fileColumns = this.db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>
    if (!fileColumns.some((column) => column.name === 'cloud_status')) {
      this.db.exec("ALTER TABLE files ADD COLUMN cloud_status TEXT NOT NULL DEFAULT 'active';")
    }
    if (!fileColumns.some((column) => column.name === 'favorite')) {
      this.db.exec('ALTER TABLE files ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;')
    }
    if (!fileColumns.some((column) => column.name === 'last_opened_at')) {
      this.db.exec('ALTER TABLE files ADD COLUMN last_opened_at TEXT;')
    }
    if (!fileColumns.some((column) => column.name === 'storage_backend')) {
      this.db.exec("ALTER TABLE files ADD COLUMN storage_backend TEXT DEFAULT 'telegram_bot';")
    }
    if (!fileColumns.some((column) => column.name === 'storage_locator')) {
      this.db.exec('ALTER TABLE files ADD COLUMN storage_locator TEXT;')
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_files_cloud_status ON files(cloud_status, updated_at DESC);')
    const pendingColumns = this.db.prepare('PRAGMA table_info(pending_sync)').all() as Array<{ name: string }>
    if (!pendingColumns.some((column) => column.name === 'priority')) {
      this.db.exec('ALTER TABLE pending_sync ADD COLUMN priority INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 0 AND 4);')
    }
    if (!pendingColumns.some((column) => column.name === 'storage_backend')) {
      this.db.exec("ALTER TABLE pending_sync ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'telegram_bot';")
    }
    if (!pendingColumns.some((column) => column.name === 'storage_locator')) {
      this.db.exec('ALTER TABLE pending_sync ADD COLUMN storage_locator TEXT;')
    }
    if (!pendingColumns.some((column) => column.name === 'upload_receipt')) {
      this.db.exec('ALTER TABLE pending_sync ADD COLUMN upload_receipt TEXT;')
    }
    if (!pendingColumns.some((column) => column.name === 'retry_state')) {
      this.db.exec('ALTER TABLE pending_sync ADD COLUMN retry_state TEXT;')
    }
    if (!pendingColumns.some((column) => column.name === 'restored_from_version')) {
      this.db.exec('ALTER TABLE pending_sync ADD COLUMN restored_from_version INTEGER;')
    }
    const versionColumns = this.db.prepare('PRAGMA table_info(local_versions)').all() as Array<{ name: string }>
    if (!versionColumns.some((column) => column.name === 'storage_backend')) {
      this.db.exec("ALTER TABLE local_versions ADD COLUMN storage_backend TEXT DEFAULT 'telegram_bot';")
    }
    if (!versionColumns.some((column) => column.name === 'storage_locator')) {
      this.db.exec('ALTER TABLE local_versions ADD COLUMN storage_locator TEXT;')
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_user_imports (
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        relative_path TEXT,
        status TEXT NOT NULL DEFAULT 'DISCOVERED',
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(chat_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_user_import_status ON telegram_user_imports(status, message_id);
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_pending_priority_ready ON pending_sync(status, priority, next_retry_at, created_at);')
  }

  private neutralizeLegacyDeletes(): void {
    const legacy = this.db.prepare("SELECT DISTINCT file_id FROM pending_sync WHERE operation = 'DELETE'").all() as Array<{ file_id: string }>
    if (legacy.length === 0) return
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare("DELETE FROM pending_sync WHERE operation = 'DELETE'").run()
      const update = this.db.prepare("UPDATE files SET status = 'SYNCED', updated_at = ? WHERE id = ? AND current_version > 0")
      for (const row of legacy) update.run(timestamp, row.file_id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.log('LEGACY_DELETE_QUEUE_CLEARED', null, `${legacy.length} item(s)`)
  }

  private recoverInterruptedJobs(): void {
    const timestamp = nowIso()
    this.db
      .prepare(
        `UPDATE pending_sync
            SET status = 'PENDING', next_retry_at = NULL,
                error_code = 'APP_RESTART_RECOVERY', error_message = 'Recovered interrupted upload after app restart',
                updated_at = ?
          WHERE status = 'UPLOADING'`
      )
      .run(timestamp)
  }

  getOrCreateStableDeviceId(): string {
    const existing = this.db.prepare("SELECT value FROM local_meta WHERE key = 'stable_device_id' LIMIT 1").get() as { value: string } | undefined
    if (existing?.value) return existing.value
    const value = randomUUID()
    this.db.prepare("INSERT INTO local_meta(key, value, updated_at) VALUES ('stable_device_id', ?, ?)").run(value, nowIso())
    return value
  }

  getSettings(): SettingsView {
    const settings = { ...DEFAULT_SETTINGS }
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as Array<{
      key: keyof SettingsView
      value_json: string
    }>
    for (const row of rows) {
      if (!(row.key in settings)) continue
      try {
        ;(settings as Record<string, unknown>)[row.key] = JSON.parse(row.value_json)
      } catch {
        // Ignore a corrupt individual setting and fall back to the safe default.
      }
    }
    return settings
  }

  setSettings(patch: Partial<SettingsView>): SettingsView {
    const current = this.getSettings()
    const next: SettingsView = {
      ...current,
      ...patch,
      retryBaseSeconds: Math.min(3600, Math.max(2, Number(patch.retryBaseSeconds ?? current.retryBaseSeconds))),
      retentionLimit: Math.min(500, Math.max(2, Number(patch.retentionLimit ?? current.retentionLimit)))
    }
    const timestamp = nowIso()
    const upsert = this.db.prepare(
      `INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const [key, value] of Object.entries(next)) upsert.run(key, JSON.stringify(value), timestamp)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return next
  }

  log(eventType: string, fileId: string | null, detail?: string): void {
    this.db
      .prepare('INSERT INTO sync_history(id, file_id, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), fileId, eventType, detail?.slice(0, 1000) ?? null, nowIso())
    this.db.exec(`
      DELETE FROM sync_history
       WHERE id IN (
         SELECT id FROM sync_history ORDER BY created_at DESC LIMIT -1 OFFSET 2000
       );
    `)
  }

  getFileByPath(relativePath: string): LocalFileRow | null {
    return (
      (this.db.prepare('SELECT * FROM files WHERE relative_path = ? COLLATE NOCASE LIMIT 1').get(relativePath) as
        | LocalFileRow
        | undefined) ?? null
    )
  }

  getFile(fileId: string): LocalFileRow | null {
    return (
      (this.db.prepare('SELECT * FROM files WHERE id = ? LIMIT 1').get(fileId) as LocalFileRow | undefined) ?? null
    )
  }

  getState(fileId: string): LocalFileStateRow | null {
    return (
      (this.db.prepare('SELECT * FROM local_file_state WHERE file_id = ? LIMIT 1').get(fileId) as
        | LocalFileStateRow
        | undefined) ?? null
    )
  }

  findRecentlyMissingByHash(hash: string, cutoffIso: string): LocalFileRow | null {
    return (
      (this.db
        .prepare(
          `SELECT f.*
             FROM files f
             JOIN local_file_state s ON s.file_id = f.id
            WHERE s.exists_flag = 0 AND s.last_hash = ? AND s.last_seen_at >= ?
              AND f.cloud_status = 'active'
            ORDER BY s.last_seen_at DESC LIMIT 1`
        )
        .get(hash, cutoffIso) as LocalFileRow | undefined) ?? null
    )
  }

  ensureWaitingFile(input: {
    relativePath: string
    logicalName: string
    extension: string
    size?: number
    mtimeMs?: number
  }): LocalFileRow {
    const timestamp = nowIso()
    let file = this.getFileByPath(input.relativePath)
    if (!file) {
      const id = randomUUID()
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.prepare(
          `INSERT INTO files(id, relative_path, logical_name, extension, current_version, current_hash, status, cloud_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, NULL, 'RETRY_WAIT', 'active', ?, ?)`
        ).run(id, input.relativePath, input.logicalName, input.extension, timestamp, timestamp)
        this.db.prepare(
          `INSERT INTO local_file_state(file_id, size, mtime_ms, last_hash, last_seen_at, exists_flag)
           VALUES (?, ?, ?, NULL, ?, 1)`
        ).run(id, input.size ?? 0, input.mtimeMs ?? 0, timestamp)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      file = this.getFile(id)
    }
    if (!file) throw new Error('LOCAL_FILE_RECORD_MISSING')
    return file
  }

  ensureFile(input: {
    relativePath: string
    logicalName: string
    extension: string
    hash: string
    size: number
    mtimeMs: number
  }): LocalFileRow {
    const timestamp = nowIso()
    let file = this.getFileByPath(input.relativePath)
    if (!file) {
      file = {
        id: randomUUID(),
        relative_path: input.relativePath,
        logical_name: input.logicalName,
        extension: input.extension,
        current_version: 0,
        current_hash: null,
        status: 'PENDING',
        cloud_status: 'active',
        created_at: timestamp,
        updated_at: timestamp
      }
      this.db
        .prepare(
          `INSERT INTO files(id, relative_path, logical_name, extension, current_version, current_hash, status, cloud_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, NULL, 'PENDING', 'active', ?, ?)`
        )
        .run(file.id, input.relativePath, input.logicalName, input.extension, timestamp, timestamp)
    }
    this.upsertState(file.id, input.size, input.mtimeMs, input.hash, true)
    return this.getFile(file.id) ?? file
  }

  renameFile(fileId: string, relativePath: string, logicalName: string, extension: string): void {
    const timestamp = nowIso()
    this.db
      .prepare(
        'UPDATE files SET relative_path = ?, logical_name = ?, extension = ?, updated_at = ? WHERE id = ?'
      )
      .run(relativePath, logicalName, extension, timestamp, fileId)
    this.db
      .prepare('UPDATE local_file_state SET exists_flag = 1, last_seen_at = ? WHERE file_id = ?')
      .run(timestamp, fileId)
    this.log('RENAMED', fileId, relativePath)
  }

  upsertRemoteMetadata(input: {
    id: string
    relativePath: string
    logicalName: string
    extension: string
    version: number
    hash: string | null
    cloudStatus?: CloudFileStatus
    size?: number
    storageBackend?: StorageBackend | null
    storageLocator?: string | null
  }): LocalFileRow {
    const occupied = this.getFileByPath(input.relativePath)
    if (occupied && occupied.id !== input.id && occupied.cloud_status === 'active') throw new Error('LOCAL_PATH_OCCUPIED')
    const timestamp = nowIso()
    const existing = this.getFile(input.id)
    const cloudStatus = input.cloudStatus ?? 'active'
    const storageBackend = input.storageBackend ?? existing?.storage_backend ?? 'telegram_bot'
    const storageLocator = input.storageLocator ?? existing?.storage_locator ?? null
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (existing) {
        this.db.prepare(
          `UPDATE files SET relative_path = ?, logical_name = ?, extension = ?, current_version = ?, current_hash = ?,
                            storage_backend = ?, storage_locator = ?, status = 'SYNCED', cloud_status = ?, updated_at = ? WHERE id = ?`
        ).run(input.relativePath, input.logicalName, input.extension, input.version, input.hash, storageBackend, storageLocator, cloudStatus, timestamp, input.id)
      } else {
        this.db.prepare(
          `INSERT INTO files(id, relative_path, logical_name, extension, current_version, current_hash, storage_backend, storage_locator, status, cloud_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SYNCED', ?, ?, ?)`
        ).run(input.id, input.relativePath, input.logicalName, input.extension, input.version, input.hash, storageBackend, storageLocator, cloudStatus, timestamp, timestamp)
        this.db.prepare(
          `INSERT INTO local_file_state(file_id, size, mtime_ms, last_hash, last_seen_at, exists_flag)
           VALUES (?, ?, 0, ?, ?, 0)`
        ).run(input.id, input.size ?? 0, input.hash, timestamp)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getFile(input.id)!
  }

  markCloudTrashed(fileId: string): void {
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM pending_sync WHERE file_id = ?').run(fileId)
      this.db.prepare("UPDATE files SET status = 'SYNCED', cloud_status = 'trashed', updated_at = ? WHERE id = ?").run(timestamp, fileId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.log('SAAS_TRASHED', fileId)
  }

  markCloudDeleted(fileId: string): void {
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM pending_sync WHERE file_id = ?').run(fileId)
      this.db.prepare("UPDATE files SET status = 'SYNCED', cloud_status = 'deleted', updated_at = ? WHERE id = ?").run(timestamp, fileId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.log('SAAS_PERMANENTLY_DELETED', fileId)
  }

  upsertRemoteFile(input: {
    id: string
    relativePath: string
    logicalName: string
    extension: string
    version: number
    hash: string | null
    size: number
    mtimeMs: number
    storageBackend?: StorageBackend | null
    storageLocator?: string | null
  }): LocalFileRow {
    const occupied = this.getFileByPath(input.relativePath)
    if (occupied && occupied.id !== input.id) throw new Error('LOCAL_PATH_OCCUPIED')
    const timestamp = nowIso()
    const existing = this.getFile(input.id)
    const storageBackend = input.storageBackend ?? existing?.storage_backend ?? 'telegram_bot'
    const storageLocator = input.storageLocator ?? existing?.storage_locator ?? null
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (existing) {
        this.db.prepare(
          `UPDATE files SET relative_path = ?, logical_name = ?, extension = ?, current_version = ?,
                            current_hash = ?, storage_backend = ?, storage_locator = ?, status = 'SYNCED', cloud_status = 'active', updated_at = ? WHERE id = ?`
        ).run(input.relativePath, input.logicalName, input.extension, input.version, input.hash, storageBackend, storageLocator, timestamp, input.id)
      } else {
        this.db.prepare(
          `INSERT INTO files(id, relative_path, logical_name, extension, current_version, current_hash, storage_backend, storage_locator, status, cloud_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SYNCED', 'active', ?, ?)`
        ).run(input.id, input.relativePath, input.logicalName, input.extension, input.version, input.hash, storageBackend, storageLocator, timestamp, timestamp)
      }
      this.db.prepare(
        `INSERT INTO local_file_state(file_id, size, mtime_ms, last_hash, last_seen_at, exists_flag)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(file_id) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
           last_hash = excluded.last_hash, last_seen_at = excluded.last_seen_at, exists_flag = 1`
      ).run(input.id, input.size, input.mtimeMs, input.hash, timestamp)
      if (input.hash) {
        this.db.prepare(
          `INSERT INTO local_versions(id, file_id, version, hash, size, base_version, source_version, storage_backend, storage_locator, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
           ON CONFLICT(file_id, version) DO UPDATE SET hash = excluded.hash, size = excluded.size,
             storage_backend = excluded.storage_backend, storage_locator = excluded.storage_locator, synced_at = excluded.synced_at`
        ).run(randomUUID(), input.id, input.version, input.hash, input.size, Math.max(0, input.version - 1), storageBackend, storageLocator, timestamp)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.log('REMOTE_APPLIED', input.id, `${input.relativePath} V${input.version}`)
    return this.getFile(input.id)!
  }

  upsertState(fileId: string, size: number, mtimeMs: number, hash: string | null, exists: boolean): void {
    const timestamp = nowIso()
    this.db
      .prepare(
        `INSERT INTO local_file_state(file_id, size, mtime_ms, last_hash, last_seen_at, exists_flag)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET
           size = excluded.size,
           mtime_ms = excluded.mtime_ms,
           last_hash = COALESCE(excluded.last_hash, local_file_state.last_hash),
           last_seen_at = excluded.last_seen_at,
           exists_flag = excluded.exists_flag`
      )
      .run(fileId, size, mtimeMs, hash, timestamp, exists ? 1 : 0)
  }

  removeUnsyncedFile(fileId: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM pending_sync WHERE file_id = ?').run(fileId)
      this.db.prepare('DELETE FROM files WHERE id = ? AND current_version = 0').run(fileId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  markMissing(relativePath: string): LocalFileRow | null {
    const file = this.getFileByPath(relativePath)
    if (!file) return null
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('UPDATE local_file_state SET exists_flag = 0, last_seen_at = ? WHERE file_id = ?')
        .run(timestamp, file.id)
      if (file.current_version > 0) {
        this.db.prepare("DELETE FROM pending_sync WHERE file_id = ? AND operation IN ('UPSERT', 'RENAME', 'DELETE')").run(file.id)
        this.db.prepare("UPDATE files SET status = 'SYNCED', updated_at = ? WHERE id = ?").run(timestamp, file.id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getFile(file.id) ?? file
  }

  hasActivePendingForHash(fileId: string, hash: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM pending_sync
          WHERE file_id = ? AND hash = ? AND operation = 'UPSERT'
            AND status IN ('PENDING', 'UPLOADING', 'RETRY_WAIT') LIMIT 1`
      )
      .get(fileId, hash) as { ok: number } | undefined
    return row?.ok === 1
  }

  queueWaitingUpsert(
    file: LocalFileRow,
    absolutePath: string,
    errorCode: string,
    errorMessage: string,
    retryAt: string
  ): PendingRow | null {
    if (file.cloud_status !== 'active') return null
    const timestamp = nowIso()
    const existing = this.db.prepare(
      "SELECT * FROM pending_sync WHERE file_id = ? AND operation = 'UPSERT' AND status IN ('PENDING','UPLOADING','RETRY_WAIT') ORDER BY created_at DESC LIMIT 1"
    ).get(file.id) as PendingRow | undefined
    if (existing) {
      if (existing.status !== 'UPLOADING') {
        this.db.prepare(
          `UPDATE pending_sync
              SET local_path = ?, status = 'RETRY_WAIT', priority = MIN(priority, 2), next_retry_at = ?, error_code = ?, error_message = ?, updated_at = ?
            WHERE id = ?`
        ).run(absolutePath, retryAt, errorCode, errorMessage.slice(0, 1000), timestamp, existing.id)
        this.db.prepare("UPDATE files SET status = 'RETRY_WAIT', updated_at = ? WHERE id = ?").run(timestamp, file.id)
      }
      return this.getPending(existing.id)
    }

    const id = randomUUID()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        `INSERT INTO pending_sync(
           id, file_id, operation, local_path, hash, size, base_version, idempotency_key, storage_backend,
           status, attempt_count, priority, next_retry_at, error_code, error_message, created_at, updated_at
         ) VALUES (?, ?, 'UPSERT', ?, NULL, NULL, ?, ?, ?, 'RETRY_WAIT', 0, 2, ?, ?, ?, ?, ?)`
      ).run(
        id,
        file.id,
        absolutePath,
        file.current_version,
        `${file.id}:${file.current_version}:WAITING:${file.relative_path}`,
        this.getSettings().defaultStorageBackend,
        retryAt,
        errorCode,
        errorMessage.slice(0, 1000),
        timestamp,
        timestamp
      )
      this.db.prepare("UPDATE files SET status = 'RETRY_WAIT', updated_at = ? WHERE id = ?").run(timestamp, file.id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.log('WAITING_FOR_FILE', file.id, `${errorCode}: ${errorMessage}`)
    return this.getPending(id)
  }

  preparePendingUpload(id: string, hash: string, size: number): PendingRow | null {
    const pending = this.getPending(id)
    if (!pending || pending.operation !== 'UPSERT') return null
    this.db.prepare(
      `UPDATE pending_sync SET hash = ?, size = ?, status = 'UPLOADING', next_retry_at = NULL,
         error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`
    ).run(hash, size, nowIso(), id)
    return this.getPending(id)
  }

  markPendingNoChange(id: string): boolean {
    const pending = this.getPending(id)
    if (!pending) return false
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM pending_sync WHERE id = ?').run(id)
      this.db.prepare("UPDATE files SET status = 'SYNCED', updated_at = ? WHERE id = ?").run(timestamp, pending.file_id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.log('NO_CHANGE', pending.file_id, pending.operation)
    return true
  }

  queueUpsert(
    file: LocalFileRow,
    absolutePath: string,
    hash: string,
    size: number,
    priority = 0,
    storageBackend: StorageBackend = this.getSettings().defaultStorageBackend,
    restoredFromVersion: number | null = null
  ): PendingRow | null {
    if (file.cloud_status !== 'active') return null
    const forcedRestore = restoredFromVersion !== null
    if ((!forcedRestore && file.current_hash === hash) || this.hasActivePendingForHash(file.id, hash)) return null
    const waiting = this.db.prepare(
      "SELECT id FROM pending_sync WHERE file_id = ? AND operation = 'UPSERT' AND status = 'RETRY_WAIT' AND hash IS NULL ORDER BY created_at ASC LIMIT 1"
    ).get(file.id) as { id: string } | undefined
    if (waiting) {
      const timestamp = nowIso()
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.prepare(
          `UPDATE pending_sync SET local_path = ?, hash = ?, size = ?, base_version = ?, storage_backend = ?, restored_from_version = ?,
             status = 'PENDING', priority = ?, next_retry_at = NULL, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`
        ).run(absolutePath, hash, size, file.current_version, storageBackend, restoredFromVersion, Math.min(4, Math.max(0, priority)), timestamp, waiting.id)
        this.db.prepare("UPDATE files SET status = 'PENDING', updated_at = ? WHERE id = ?").run(timestamp, file.id)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      this.log('WAITING_FILE_READY', file.id, `hash=${hash.slice(0, 12)}`)
      return this.getPending(waiting.id)
    }
    const idempotencyKey = restoredFromVersion === null
      ? `${file.id}:${file.current_version}:${hash}`
      : `${file.id}:${file.current_version}:${hash}:RESTORE:${restoredFromVersion}`
    const existing = this.db.prepare('SELECT 1 AS ok FROM pending_sync WHERE idempotency_key = ? LIMIT 1').get(idempotencyKey) as { ok: number } | undefined
    if (existing?.ok === 1) return null
    const timestamp = nowIso()
    const pending: PendingRow = {
      id: randomUUID(),
      file_id: file.id,
      operation: 'UPSERT',
      local_path: absolutePath,
      hash,
      size,
      base_version: file.current_version,
      idempotency_key: idempotencyKey,
      status: 'PENDING',
      attempt_count: 0,
      priority: Math.min(4, Math.max(0, priority)),
      next_retry_at: null,
      error_code: null,
      error_message: null,
      storage_backend: storageBackend,
      storage_locator: null,
      upload_receipt: null,
      retry_state: null,
      restored_from_version: restoredFromVersion,
      created_at: timestamp,
      updated_at: timestamp
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `INSERT INTO pending_sync(
             id, file_id, operation, local_path, hash, size, base_version, idempotency_key,
             storage_backend, restored_from_version, status, attempt_count, priority, next_retry_at, error_code, error_message, created_at, updated_at
           ) VALUES (?, ?, 'UPSERT', ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, NULL, NULL, NULL, ?, ?)`
        )
        .run(
          pending.id,
          pending.file_id,
          pending.local_path,
          pending.hash,
          pending.size,
          pending.base_version,
          pending.idempotency_key,
          pending.storage_backend,
          pending.restored_from_version,
          pending.priority,
          timestamp,
          timestamp
        )
      this.db.prepare("UPDATE files SET status = 'PENDING', updated_at = ? WHERE id = ?").run(timestamp, file.id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      const duplicate = this.hasActivePendingForHash(file.id, hash)
      if (duplicate) return null
      throw error
    }
    this.log('PENDING', file.id, `hash=${hash.slice(0, 12)}`)
    return pending
  }

  cancelPending(fileId: string, operation?: PendingOperation): void {
    if (operation) {
      this.db.prepare('DELETE FROM pending_sync WHERE file_id = ? AND operation = ?').run(fileId, operation)
    } else {
      this.db.prepare('DELETE FROM pending_sync WHERE file_id = ?').run(fileId)
    }
  }

  requeuePending(id: string): boolean {
    const pending = this.getPending(id)
    if (!pending || pending.status === 'UPLOADING') return false
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        `UPDATE pending_sync
            SET status = 'PENDING', priority = 2, next_retry_at = NULL, error_code = NULL, error_message = NULL, updated_at = ?
          WHERE id = ? AND status != 'UPLOADING'`
      ).run(timestamp, id)
      this.db.prepare("UPDATE files SET status = 'PENDING', updated_at = ? WHERE id = ?").run(timestamp, pending.file_id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.log('TASK_REQUEUED', pending.file_id, pending.operation)
    return true
  }

  cancelPendingById(id: string): boolean {
    const pending = this.getPending(id)
    if (!pending || pending.status === 'UPLOADING') return false
    const file = this.getFile(pending.file_id)
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare("DELETE FROM pending_sync WHERE id = ? AND status != 'UPLOADING'").run(id)
      if (file) {
        const nextStatus: SyncStatus = file.current_version > 0 ? 'SYNCED' : 'ERROR'
        this.db.prepare('UPDATE files SET status = ?, updated_at = ? WHERE id = ?').run(nextStatus, timestamp, file.id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.log('TASK_CANCELLED', pending.file_id, pending.operation)
    return true
  }

  queueRename(file: LocalFileRow, absolutePath: string, priority = 0): PendingRow | null {
    if (file.cloud_status !== 'active') return null
    const active = this.db
      .prepare(
        `SELECT * FROM pending_sync WHERE file_id = ? AND operation = 'RENAME'
          AND status IN ('PENDING','UPLOADING','RETRY_WAIT') LIMIT 1`
      )
      .get(file.id) as PendingRow | undefined
    if (active) {
      this.db
        .prepare(`UPDATE pending_sync SET local_path = ?, base_version = ?, priority = ?, updated_at = ?, status = 'PENDING', next_retry_at = NULL WHERE id = ?`)
        .run(absolutePath, file.current_version, Math.min(4, Math.max(0, priority)), nowIso(), active.id)
      return this.getPending(active.id)
    }
    const timestamp = nowIso()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO pending_sync(
           id, file_id, operation, local_path, hash, size, base_version, idempotency_key,
           status, attempt_count, priority, next_retry_at, created_at, updated_at
         ) VALUES (?, ?, 'RENAME', ?, NULL, NULL, ?, ?, 'PENDING', 0, ?, NULL, ?, ?)`
      )
      .run(id, file.id, absolutePath, file.current_version, `${file.id}:${file.current_version}:RENAME:${file.logical_name}`, Math.min(4, Math.max(0, priority)), timestamp, timestamp)
    this.db.prepare("UPDATE files SET status = 'PENDING', updated_at = ? WHERE id = ?").run(timestamp, file.id)
    this.log('RENAME_PENDING', file.id, file.relative_path)
    return this.getPending(id)
  }

  getPending(id: string): PendingRow | null {
    return (
      (this.db.prepare('SELECT * FROM pending_sync WHERE id = ? LIMIT 1').get(id) as PendingRow | undefined) ?? null
    )
  }

  setUploadReceipt(id: string, receipt: TelegramUserStorageReceipt): PendingRow | null {
    const locator = JSON.stringify({ chatId: receipt.chatId, messageId: receipt.messageId })
    this.db.prepare(
      `UPDATE pending_sync SET upload_receipt = ?, storage_backend = 'telegram_user_group', storage_locator = ?, retry_state = NULL, updated_at = ? WHERE id = ?`
    ).run(JSON.stringify(receipt), locator, nowIso(), id)
    return this.getPending(id)
  }

  clearUploadReceipt(id: string): void {
    this.db.prepare('UPDATE pending_sync SET upload_receipt = NULL, storage_locator = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id)
  }

  setRetryState(id: string, state: Record<string, unknown> | null): void {
    this.db.prepare('UPDATE pending_sync SET retry_state = ?, updated_at = ? WHERE id = ?')
      .run(state ? JSON.stringify(state) : null, nowIso(), id)
  }

  getTelegramImport(chatId: string, messageId: number): { status: string; relative_path: string | null } | null {
    return (this.db.prepare('SELECT status, relative_path FROM telegram_user_imports WHERE chat_id = ? AND message_id = ? LIMIT 1')
      .get(chatId, messageId) as { status: string; relative_path: string | null } | undefined) ?? null
  }

  beginTelegramImport(input: { chatId: string; messageId: number; fileName: string; size: number }): boolean {
    const timestamp = nowIso()
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO telegram_user_imports(chat_id, message_id, file_name, size, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'DISCOVERED', ?, ?)`
    ).run(input.chatId, input.messageId, input.fileName, input.size, timestamp, timestamp)
    return Number(result.changes ?? 0) === 1
  }

  completeTelegramImport(input: { chatId: string; messageId: number; relativePath: string; sha256: string }): void {
    this.db.prepare(
      `UPDATE telegram_user_imports SET relative_path = ?, sha256 = ?, status = 'IMPORTED', last_error = NULL, updated_at = ?
       WHERE chat_id = ? AND message_id = ?`
    ).run(input.relativePath, input.sha256, nowIso(), input.chatId, input.messageId)
  }

  rememberTelegramUpload(input: { chatId: string; messageId: number; fileName: string; size: number; relativePath: string; sha256: string }): void {
    const timestamp = nowIso()
    this.db.prepare(
      `INSERT INTO telegram_user_imports(chat_id, message_id, file_name, size, relative_path, sha256, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'IMPORTED', ?, ?)
       ON CONFLICT(chat_id, message_id) DO UPDATE SET
         file_name = excluded.file_name,
         size = excluded.size,
         relative_path = excluded.relative_path,
         sha256 = excluded.sha256,
         status = 'IMPORTED',
         last_error = NULL,
         updated_at = excluded.updated_at`
    ).run(input.chatId, input.messageId, input.fileName, input.size, input.relativePath, input.sha256, timestamp, timestamp)
  }

  failTelegramImport(chatId: string, messageId: number, error: string): void {
    this.db.prepare(
      `UPDATE telegram_user_imports SET status = 'ERROR', last_error = ?, updated_at = ? WHERE chat_id = ? AND message_id = ?`
    ).run(error.slice(0, 1000), nowIso(), chatId, messageId)
  }

  telegramCheckpoint(chatId: string): number {
    const key = `telegram_user_checkpoint:${chatId}`
    const row = this.db.prepare('SELECT value FROM local_meta WHERE key = ? LIMIT 1').get(key) as { value: string } | undefined
    const value = Number(row?.value ?? 0)
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  }

  setTelegramCheckpoint(chatId: string, messageId: number): void {
    const key = `telegram_user_checkpoint:${chatId}`
    this.db.prepare(
      `INSERT INTO local_meta(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, String(Math.max(0, Math.trunc(messageId))), nowIso())
  }

  getConflictPendingForFile(fileId: string): PendingRow | null {
    return (
      (this.db.prepare("SELECT * FROM pending_sync WHERE file_id = ? AND status = 'CONFLICT' ORDER BY updated_at DESC LIMIT 1").get(fileId) as PendingRow | undefined) ?? null
    )
  }

  nextReadyPending(excludeFileIds: string[] = [], preferOldest = false): PendingRow | null {
    const now = nowIso()
    const exclusion = excludeFileIds.length > 0 ? ` AND file_id NOT IN (${excludeFileIds.map(() => '?').join(',')})` : ''
    const order = preferOldest ? 'created_at ASC' : 'priority ASC, created_at ASC'
    return (
      (this.db
        .prepare(
          `SELECT * FROM pending_sync
            WHERE (status = 'PENDING'
               OR (status = 'RETRY_WAIT' AND (next_retry_at IS NULL OR next_retry_at <= ?)))${exclusion}
            ORDER BY ${order} LIMIT 1`
        )
        .get(now, ...excludeFileIds) as PendingRow | undefined) ?? null
    )
  }

  boostReadyPending(priority = 1): number {
    const normalized = Math.min(4, Math.max(0, priority))
    const result = this.db.prepare(
      `UPDATE pending_sync SET priority = MIN(priority, ?), updated_at = ?
        WHERE status IN ('PENDING','RETRY_WAIT')`
    ).run(normalized, nowIso())
    return Number(result.changes ?? 0)
  }

  setPendingPriorityForFile(fileId: string, priority: number): void {
    const normalized = Math.min(4, Math.max(0, priority))
    this.db.prepare(
      `UPDATE pending_sync SET priority = ?, updated_at = ?
        WHERE file_id = ? AND status IN ('PENDING','RETRY_WAIT')`
    ).run(normalized, nowIso(), fileId)
  }

  setPendingStorageBackendForFile(fileId: string, backend: StorageBackend): number {
    const result = this.db.prepare(
      `UPDATE pending_sync SET storage_backend = ?, storage_locator = NULL, updated_at = ?
        WHERE file_id = ? AND operation = 'UPSERT' AND status IN ('PENDING','RETRY_WAIT')
          AND upload_receipt IS NULL`
    ).run(backend, nowIso(), fileId)
    return Number(result.changes ?? 0)
  }

  rebaseQueuedForFile(fileId: string, baseVersion: number): void {
    const rows = this.db.prepare(
      `SELECT id, hash FROM pending_sync
        WHERE file_id = ? AND status IN ('PENDING','RETRY_WAIT') ORDER BY created_at ASC`
    ).all(fileId) as Array<{ id: string; hash: string | null }>
    if (rows.length === 0) return
    const update = this.db.prepare('UPDATE pending_sync SET base_version = ?, idempotency_key = ?, updated_at = ? WHERE id = ?')
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const key = row.hash ? `${fileId}:${baseVersion}:${row.hash}` : `${fileId}:${baseVersion}:WAITING:${row.id}`
        update.run(baseVersion, key, timestamp, row.id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  markUploading(id: string): void {
    this.db
      .prepare(
        `UPDATE pending_sync SET status = 'UPLOADING', attempt_count = attempt_count + 1,
          error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`
      )
      .run(nowIso(), id)
    const pending = this.getPending(id)
    if (pending) this.db.prepare("UPDATE files SET status = 'UPLOADING', updated_at = ? WHERE id = ?").run(nowIso(), pending.file_id)
  }

  markRetry(id: string, errorCode: string, errorMessage: string, retryAt: string): void {
    const pending = this.getPending(id)
    const timestamp = nowIso()
    this.db
      .prepare(
        `UPDATE pending_sync SET status = 'RETRY_WAIT', next_retry_at = ?, error_code = ?, error_message = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(retryAt, errorCode, errorMessage.slice(0, 1000), timestamp, id)
    if (pending) this.db.prepare("UPDATE files SET status = 'RETRY_WAIT', updated_at = ? WHERE id = ?").run(timestamp, pending.file_id)
    this.log('RETRY_WAIT', pending?.file_id ?? null, `${errorCode}: ${errorMessage}`)
  }

  markError(id: string, errorCode: string, errorMessage: string): void {
    const pending = this.getPending(id)
    const timestamp = nowIso()
    this.db
      .prepare(
        `UPDATE pending_sync SET status = 'ERROR', error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`
      )
      .run(errorCode, errorMessage.slice(0, 1000), timestamp, id)
    if (pending) this.db.prepare("UPDATE files SET status = 'ERROR', updated_at = ? WHERE id = ?").run(timestamp, pending.file_id)
    this.log('ERROR', pending?.file_id ?? null, `${errorCode}: ${errorMessage}`)
  }

  requeueAuthBlocked(): number {
    return this.requeueBlockedErrors(
      ['AUTH_REQUIRED', 'INVALID_SESSION'],
      'AUTH_BLOCKED_REQUEUED'
    )
  }

  requeuePermissionBlocked(): number {
    return this.requeueBlockedErrors(
      ['WORKSPACE_UPLOAD_FORBIDDEN', 'WORKSPACE_FORBIDDEN', 'FORBIDDEN'],
      'PERMISSION_BLOCKED_REQUEUED'
    )
  }

  private requeueBlockedErrors(errorCodes: string[], eventType: string): number {
    const timestamp = nowIso()
    const placeholders = errorCodes.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT id, file_id FROM pending_sync
          WHERE status IN ('ERROR', 'RETRY_WAIT')
            AND error_code IN (${placeholders})`
      )
      .all(...errorCodes) as Array<{ id: string; file_id: string }>
    if (rows.length === 0) return 0

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `UPDATE pending_sync
              SET status = 'PENDING', next_retry_at = NULL, error_code = NULL, error_message = NULL, updated_at = ?
            WHERE status IN ('ERROR', 'RETRY_WAIT')
              AND error_code IN (${placeholders})`
        )
        .run(timestamp, ...errorCodes)
      const updateFile = this.db.prepare("UPDATE files SET status = 'PENDING', updated_at = ? WHERE id = ?")
      for (const row of rows) updateFile.run(timestamp, row.file_id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.log(eventType, null, `${rows.length} pending item(s)`)
    return rows.length
  }

  markConflict(id: string, detail: string): void {
    const pending = this.getPending(id)
    const timestamp = nowIso()
    this.db
      .prepare(
        `UPDATE pending_sync SET status = 'CONFLICT', error_code = 'BASE_VERSION_CONFLICT', error_message = ?, updated_at = ? WHERE id = ?`
      )
      .run(detail.slice(0, 1000), timestamp, id)
    if (pending) this.db.prepare("UPDATE files SET status = 'CONFLICT', updated_at = ? WHERE id = ?").run(timestamp, pending.file_id)
    this.log('CONFLICT', pending?.file_id ?? null, detail)
  }

  markSynced(id: string, version: number, hash: string, size: number, sourceVersion?: number): void {
    const pending = this.getPending(id)
    if (!pending) return
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `UPDATE files SET current_version = ?, current_hash = ?, storage_backend = ?, storage_locator = ?, status = 'SYNCED', updated_at = ? WHERE id = ?`
        )
        .run(version, hash, pending.storage_backend, pending.storage_locator, timestamp, pending.file_id)
      this.db
        .prepare(
          `INSERT INTO local_versions(id, file_id, version, hash, size, base_version, source_version, storage_backend, storage_locator, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(file_id, version) DO UPDATE SET hash = excluded.hash, size = excluded.size,
             base_version = excluded.base_version, source_version = excluded.source_version,
             storage_backend = excluded.storage_backend, storage_locator = excluded.storage_locator, synced_at = excluded.synced_at`
        )
        .run(randomUUID(), pending.file_id, version, hash, size, pending.base_version, sourceVersion ?? pending.restored_from_version ?? null,
          pending.storage_backend, pending.storage_locator, timestamp)
      this.db.prepare('DELETE FROM pending_sync WHERE id = ?').run(id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.log('SYNCED', pending.file_id, `V${version} hash=${hash.slice(0, 12)}`)
  }

  markRenameSynced(id: string): void {
    const pending = this.getPending(id)
    if (!pending) return
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare("UPDATE files SET status = 'SYNCED', updated_at = ? WHERE id = ?").run(timestamp, pending.file_id)
      this.db.prepare('DELETE FROM pending_sync WHERE id = ?').run(id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.log('RENAME_SYNCED', pending.file_id)
  }

  updateCloudState(fileId: string, version: number, hash: string | null, status: SyncStatus = 'SYNCED'): void {
    this.db
      .prepare("UPDATE files SET current_version = ?, current_hash = ?, status = ?, cloud_status = 'active', updated_at = ? WHERE id = ?")
      .run(version, hash, status, nowIso(), fileId)
  }

  setFavorite(fileId: string, favorite: boolean): void {
    this.db.prepare('UPDATE files SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, fileId)
  }

  markOpened(fileId: string): void {
    this.db.prepare('UPDATE files SET last_opened_at = ? WHERE id = ?').run(nowIso(), fileId)
  }

  listFiles(): LocalFileView[] {
    const rows = this.db
      .prepare(
        `SELECT f.*, COALESCE(s.exists_flag, 0) AS exists_flag, COALESCE(s.size, 0) AS size, COALESCE(s.mtime_ms, 0) AS mtime_ms
           FROM files f LEFT JOIN local_file_state s ON s.file_id = f.id
          WHERE f.cloud_status = 'active'
          ORDER BY f.updated_at DESC`
      )
      .all() as unknown as Array<LocalFileRow & { exists_flag: number; size: number; mtime_ms: number }>
    return rows.map((row) => ({
      id: row.id,
      relativePath: row.relative_path,
      logicalName: row.logical_name,
      extension: row.extension,
      currentVersion: row.current_version,
      currentHash: row.current_hash,
      status: row.status,
      cloudStatus: row.cloud_status,
      exists: row.exists_flag === 1,
      size: row.size,
      mtimeMs: row.mtime_ms,
      updatedAt: row.updated_at,
      favorite: row.favorite === 1,
      lastOpenedAt: row.last_opened_at ?? null,
      storageBackend: row.storage_backend ?? null
    }))
  }

  listPending(): PendingView[] {
    return (this.db
      .prepare(
        `SELECT p.*, f.logical_name
           FROM pending_sync p JOIN files f ON f.id = p.file_id
          ORDER BY p.created_at DESC LIMIT 1000`
      )
      .all() as unknown as Array<PendingRow & { logical_name: string }>).map((row) => ({
      id: row.id,
      fileId: row.file_id,
      logicalName: row.logical_name,
      operation: row.operation,
      status: row.status,
      attemptCount: row.attempt_count,
      priority: row.priority,
      nextRetryAt: row.next_retry_at,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  problemCenter(): ProblemView[] {
    return this.listPending()
      .filter((row) => row.status === 'RETRY_WAIT' || row.status === 'ERROR' || row.status === 'CONFLICT')
      .map((row) => {
        const code = row.errorCode ?? ''
        if (row.status === 'CONFLICT') {
          return {
            id: row.id,
            fileId: row.fileId,
            logicalName: row.logicalName,
            status: row.status,
            severity: 'ATTENTION' as const,
            automatic: false,
            title: '检测到其他设备修改',
            message: '已保留本地冲突副本和云端版本，请选择要保留的版本。',
            action: 'RESOLVE_CONFLICT' as const,
            nextRetryAt: null,
            errorCode: code || 'BASE_VERSION_CONFLICT'
          }
        }
        const retrying = row.status === 'RETRY_WAIT'
        const permission = ['WORKSPACE_UPLOAD_FORBIDDEN', 'WORKSPACE_FORBIDDEN', 'FORBIDDEN'].includes(code)
        const auth = ['AUTH_REQUIRED', 'INVALID_SESSION'].includes(code)
        const localMissing = code === 'LOCAL_FILE_MISSING'
        const locked = ['EBUSY', 'EPERM', 'EACCES', 'FILE_NOT_STABLE', 'FILE_LOCK_WIN32'].includes(code)
        const message = auth
          ? '登录状态已失效。重新登录后，队列会自动继续。'
          : permission
            ? '你没有修改这个文件的权限。权限恢复后可以重新尝试。'
            : localMissing
              ? '本地文件已不存在，请确认文件位置后再处理。'
              : locked
                ? '文件正在使用中，关闭或保存 Excel 后会自动继续。'
                : retrying
                  ? '网络或云端暂时不可用，ExcelSync 会自动重试。'
                  : '该同步任务需要处理后才能继续。'
        return {
          id: row.id,
          fileId: row.fileId,
          logicalName: row.logicalName,
          status: row.status,
          severity: retrying ? 'WAITING' as const : 'ATTENTION' as const,
          automatic: retrying,
          title: locked ? '文件正在使用' : auth ? '需要重新登录' : permission ? '没有写入权限' : retrying ? '等待自动重试' : '需要处理',
          message,
          action: auth ? 'LOGIN' as const : localMissing ? 'OPEN_LOCATION' as const : retrying ? 'NONE' as const : 'RETRY' as const,
          nextRetryAt: row.nextRetryAt,
          errorCode: code || null
        }
      })
  }

  listActivity(limit = 100): ActivityView[] {
    return (this.db
      .prepare('SELECT id, file_id, event_type, detail, created_at FROM sync_history ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{
      id: string
      file_id: string | null
      event_type: string
      detail: string | null
      created_at: string
    }>).map((row) => ({
      id: row.id,
      fileId: row.file_id,
      eventType: row.event_type,
      detail: row.detail,
      createdAt: row.created_at
    }))
  }

  counts(): { synced: number; pending: number; syncing: number; waitingRetry: number; needsAttention: number; conflicts: number; errors: number } {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS count FROM files WHERE cloud_status = 'active' GROUP BY status").all() as Array<{
      status: SyncStatus
      count: number
    }>
    const map = new Map(rows.map((row) => [row.status, Number(row.count)]))
    const conflicts = map.get('CONFLICT') ?? 0
    const errors = map.get('ERROR') ?? 0
    return {
      synced: map.get('SYNCED') ?? 0,
      pending: (map.get('PENDING') ?? 0) + (map.get('UPLOADING') ?? 0) + (map.get('RETRY_WAIT') ?? 0),
      syncing: map.get('UPLOADING') ?? 0,
      waitingRetry: map.get('RETRY_WAIT') ?? 0,
      needsAttention: conflicts + errors,
      conflicts,
      errors
    }
  }
}
