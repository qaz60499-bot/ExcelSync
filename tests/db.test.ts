import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalDb } from '../src/main/db'

const roots: string[] = []
const databases: LocalDb[] = []

async function makeDb(): Promise<{ root: string; path: string; db: LocalDb }> {
  const root = await mkdtemp(join(tmpdir(), 'excelsync-db-'))
  roots.push(root)
  const path = join(root, 'state.sqlite')
  const db = new LocalDb(path)
  databases.push(db)
  return { root, path, db }
}

function seed(db: LocalDb, hash = 'a'.repeat(64)) {
  return db.ensureFile({
    relativePath: 'book.xlsx',
    logicalName: 'book.xlsx',
    extension: '.xlsx',
    hash,
    size: 100,
    mtimeMs: Date.now()
  })
}

afterEach(async () => {
  for (const db of databases.splice(0)) if (db.db.isOpen) db.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('LocalDb durable queue', () => {
  it('initializes SQLite and default settings', async () => {
    const { db } = await makeDb()
    expect(db.getSettings().autoSync).toBe(true)
    expect(db.getSettings().retentionLimit).toBe(20)
  })

  it('persists settings across restart', async () => {
    const { path, db } = await makeDb()
    db.setSettings({ syncDirectory: 'D:/ExcelSyncData', retryBaseSeconds: 17 })
    db.close()
    const reopened = new LocalDb(path)
    expect(reopened.getSettings().syncDirectory).toBe('D:/ExcelSyncData')
    expect(reopened.getSettings().retryBaseSeconds).toBe(17)
    reopened.close()
  })

  it('queues first upload with base version zero', async () => {
    const { db } = await makeDb()
    const file = seed(db)
    const pending = db.queueUpsert(file, 'D:/ExcelSyncData/book.xlsx', 'a'.repeat(64), 100)
    expect(pending?.base_version).toBe(0)
    expect(pending?.status).toBe('PENDING')
    db.close()
  })

  it('deduplicates repeated filesystem events for the same hash', async () => {
    const { db } = await makeDb()
    const file = seed(db)
    expect(db.queueUpsert(file, 'D:/ExcelSyncData/book.xlsx', 'a'.repeat(64), 100)).not.toBeNull()
    expect(db.queueUpsert(file, 'D:/ExcelSyncData/book.xlsx', 'a'.repeat(64), 100)).toBeNull()
    expect(db.listPending()).toHaveLength(1)
    db.close()
  })

  it('keeps different logical paths as distinct files even when their content hash is identical', async () => {
    const { db } = await makeDb()
    const hash = 'f'.repeat(64)
    const first = db.ensureFile({
      relativePath: 'A/customer.xlsx', logicalName: 'customer.xlsx', extension: '.xlsx', hash, size: 100, mtimeMs: 1
    })
    const second = db.ensureFile({
      relativePath: 'B/customer.xlsx', logicalName: 'customer.xlsx', extension: '.xlsx', hash, size: 100, mtimeMs: 2
    })
    expect(first.id).not.toBe(second.id)
    expect(db.getFileByPath('A/customer.xlsx')?.id).toBe(first.id)
    expect(db.getFileByPath('B/customer.xlsx')?.id).toBe(second.id)
    db.close()
  })

  it('does not queue when local hash already equals current cloud hash', async () => {
    const { db } = await makeDb()
    const file = seed(db)
    db.updateCloudState(file.id, 3, 'a'.repeat(64))
    const refreshed = db.getFile(file.id)!
    expect(db.queueUpsert(refreshed, 'D:/ExcelSyncData/book.xlsx', 'a'.repeat(64), 100)).toBeNull()
    db.close()
  })

  it('keeps retry wait state durably across restart', async () => {
    const { path, db } = await makeDb()
    const file = seed(db)
    const pending = db.queueUpsert(file, 'D:/ExcelSyncData/book.xlsx', 'a'.repeat(64), 100)!
    db.markRetry(pending.id, 'NETWORK_ERROR', 'offline', new Date(Date.now() + 60_000).toISOString())
    db.close()
    const reopened = new LocalDb(path)
    expect(reopened.getPending(pending.id)?.status).toBe('RETRY_WAIT')
    expect(reopened.getPending(pending.id)?.error_code).toBe('NETWORK_ERROR')
    reopened.close()
  })

  it('recovers interrupted UPLOADING jobs to PENDING after restart', async () => {
    const { path, db } = await makeDb()
    const file = seed(db)
    const pending = db.queueUpsert(file, 'D:/ExcelSyncData/book.xlsx', 'a'.repeat(64), 100)!
    db.markUploading(pending.id)
    expect(db.getPending(pending.id)?.status).toBe('UPLOADING')
    db.close()
    const reopened = new LocalDb(path)
    expect(reopened.getPending(pending.id)?.status).toBe('PENDING')
    expect(reopened.getPending(pending.id)?.error_code).toBe('APP_RESTART_RECOVERY')
    reopened.close()
  })

  it('resumes a 50-file interrupted batch without replaying already synced files', async () => {
    const { path, db } = await makeDb()
    const pendingIds: string[] = []
    const fileIds: string[] = []
    for (let index = 0; index < 50; index += 1) {
      const hash = index.toString(16).padStart(64, '0')
      const relativePath = `batch/file-${String(index + 1).padStart(2, '0')}.xlsx`
      const file = db.ensureFile({
        relativePath,
        logicalName: `file-${String(index + 1).padStart(2, '0')}.xlsx`,
        extension: '.xlsx',
        hash,
        size: 100 + index,
        mtimeMs: Date.now() + index
      })
      const pending = db.queueUpsert(file, `D:/ExcelSyncData/${relativePath}`, hash, 100 + index)!
      fileIds.push(file.id)
      pendingIds.push(pending.id)
    }

    for (let index = 0; index < 23; index += 1) {
      db.markSynced(pendingIds[index]!, 1, index.toString(16).padStart(64, '0'), 100 + index)
    }
    for (let index = 23; index < 30; index += 1) db.markUploading(pendingIds[index]!)

    expect(db.listPending()).toHaveLength(27)
    db.close()

    const reopened = new LocalDb(path)
    const remaining = reopened.listPending()
    expect(remaining).toHaveLength(27)
    expect(remaining.every((task) => task.status === 'PENDING')).toBe(true)
    expect(remaining.filter((task) => task.errorCode === 'APP_RESTART_RECOVERY')).toHaveLength(7)
    for (let index = 0; index < 23; index += 1) {
      expect(reopened.getFile(fileIds[index]!)?.current_version).toBe(1)
      expect(reopened.getPending(pendingIds[index]!)).toBeNull()
    }
    reopened.close()
  })

  it('records synced version and removes pending atomically', async () => {
    const { db } = await makeDb()
    const file = seed(db)
    const pending = db.queueUpsert(file, 'D:/ExcelSyncData/book.xlsx', 'a'.repeat(64), 100)!
    db.markSynced(pending.id, 1, 'a'.repeat(64), 100)
    expect(db.getPending(pending.id)).toBeNull()
    expect(db.getFile(file.id)?.current_version).toBe(1)
    expect(db.getFile(file.id)?.status).toBe('SYNCED')
    db.close()
  })

  it('persists a conflict without deleting the pending record', async () => {
    const { db } = await makeDb()
    const file = seed(db)
    const pending = db.queueUpsert(file, 'D:/ExcelSyncData/book.xlsx', 'a'.repeat(64), 100)!
    db.markConflict(pending.id, 'cloud advanced')
    expect(db.getPending(pending.id)?.status).toBe('CONFLICT')
    expect(db.getFile(file.id)?.status).toBe('CONFLICT')
    db.close()
  })

  it('refuses to cancel a receipt row and retains pending work across cloud trash updates', async () => {
    const { db } = await makeDb()
    const file = seed(db)
    const hash = 'a'.repeat(64)
    const pending = db.queueUpsert(file, 'D:/ExcelSyncData/book.xlsx', hash, 100)!
    db.setUploadReceipt(pending.id, {
      backend: 'telegram_bot', intentId: 'intent-1', recoveryToken: 'recovery-1', sha256: hash,
      size: 100, fileName: 'book.xlsx', createdAt: new Date().toISOString()
    })
    const before = db.getPending(pending.id)

    expect(db.cancelPendingById(pending.id)).toBe(false)
    expect(db.getPending(pending.id)).toEqual(before)
    expect(db.getFile(file.id)?.status).toBe('PENDING')

    db.markCloudTrashed(file.id)
    expect(db.getPending(pending.id)).toEqual(before)
    expect(db.getFile(file.id)).toMatchObject({ status: 'PENDING', cloud_status: 'trashed' })
    expect(db.nextReadyPending()).toBeNull()

    db.markCloudDeleted(file.id)
    expect(db.getPending(pending.id)).toEqual(before)
    expect(db.getFile(file.id)).toMatchObject({ status: 'PENDING', cloud_status: 'deleted' })
    expect(db.nextReadyPending()).toBeNull()
    db.close()
  })

  it('atomically adopts a matching pristine initial upload as a remote baseline', async () => {
    const { db } = await makeDb()
    const file = seed(db)
    const pending = db.queueUpsert(file, 'D:/ExcelSyncData/book.xlsx', 'a'.repeat(64), 100)!

    const adopted = db.adoptRemoteBaseline(file.id, {
      id: 'cloud-book-id', relativePath: 'book.xlsx', logicalName: 'book.xlsx', extension: '.xlsx',
      version: 7, hash: 'a'.repeat(64), size: 100, mtimeMs: Date.now()
    })
    expect(adopted).toMatchObject({ id: 'cloud-book-id', current_version: 7, current_hash: 'a'.repeat(64), status: 'SYNCED' })
    expect(db.getFile(file.id)).toBeNull()
    expect(db.getPending(pending.id)).toBeNull()
    expect(db.listPending()).toHaveLength(0)
    db.close()
  })

  it('preserves attempted, receipted, in-flight, errored, multiple, and mismatched baseline work', async () => {
    const cases: Array<{
      name: string
      prepare(db: LocalDb, pendingId: string, file: ReturnType<typeof seed>): void
      hash?: string
      size?: number
    }> = [
      { name: 'attempted', prepare: (db, id) => { db.db.prepare("UPDATE pending_sync SET attempt_count = 1 WHERE id = ?").run(id) } },
      {
        name: 'upload receipt',
        prepare: (db, id) => {
          db.db.prepare('UPDATE pending_sync SET upload_receipt = ?, retry_state = ? WHERE id = ?')
            .run('{"backend":"telegram_bot","intentId":"intent"}', '{"stage":"commit_pending","intentId":"intent"}', id)
        }
      },
      { name: 'UPLOADING', prepare: (db, id) => { db.markUploading(id) } },
      {
        name: 'RETRY_WAIT',
        prepare: (db, id) => { db.markRetry(id, 'NETWORK_ERROR', 'offline', new Date(Date.now() + 60_000).toISOString()) }
      },
      { name: 'CONFLICT', prepare: (db, id) => { db.markConflict(id, 'remote advanced') } },
      { name: 'ERROR', prepare: (db, id) => { db.markError(id, 'UPLOAD_FAILED', 'upload failed') } },
      {
        name: 'multiple pending rows',
        prepare: (db, _id, file) => { db.queueUpsert(file, 'D:/ExcelSyncData/book.xlsx', 'b'.repeat(64), 101) }
      },
      { name: 'edited hash mismatch', prepare: () => undefined, hash: 'b'.repeat(64) },
      { name: 'edited size mismatch', prepare: () => undefined, size: 101 }
    ]

    for (const scenario of cases) {
      const { db } = await makeDb()
      const file = seed(db)
      const pending = db.queueUpsert(file, 'D:/ExcelSyncData/book.xlsx', 'a'.repeat(64), 100)!
      scenario.prepare(db, pending.id, file)
      const before = db.getPending(pending.id)
      const beforeRows = db.listPending().map(({ id, status }) => ({ id, status })).sort((a, b) => a.id.localeCompare(b.id))

      expect(() => db.adoptRemoteBaseline(file.id, {
        id: 'cloud-book-id', relativePath: 'book.xlsx', logicalName: 'book.xlsx', extension: '.xlsx',
        version: 7, hash: scenario.hash ?? 'a'.repeat(64), size: scenario.size ?? 100, mtimeMs: Date.now()
      }), scenario.name).toThrow('LOCAL_BASELINE_HAS_PENDING_WORK')
      expect(db.getFile(file.id)?.current_version, scenario.name).toBe(0)
      expect(db.getFile('cloud-book-id'), scenario.name).toBeNull()
      expect(db.getPending(pending.id), scenario.name).toEqual(before)
      expect(db.listPending().map(({ id, status }) => ({ id, status })).sort((a, b) => a.id.localeCompare(b.id)), scenario.name)
        .toEqual(beforeRows)
      db.close()
    }
  })

  it('requeues authentication-blocked files without losing the local queue', async () => {
    const { db } = await makeDb()
    const file = seed(db)
    const pending = db.queueUpsert(file, 'D:/ExcelSyncData/book.xlsx', 'a'.repeat(64), 100)!
    db.markError(pending.id, 'AUTH_REQUIRED', 'AUTH_REQUIRED')
    expect(db.getFile(file.id)?.status).toBe('ERROR')

    expect(db.requeueAuthBlocked()).toBe(1)
    expect(db.getPending(pending.id)?.status).toBe('PENDING')
    expect(db.getPending(pending.id)?.error_code).toBeNull()
    expect(db.getFile(file.id)?.status).toBe('PENDING')
    db.close()
  })

  it('requeues legacy permission-blocked files after the 1.3.1 access fix', async () => {
    const { db } = await makeDb()
    const file = seed(db)
    const pending = db.queueUpsert(file, 'D:/ExcelSyncData/book.xlsx', 'b'.repeat(64), 101)!
    db.markError(pending.id, 'WORKSPACE_UPLOAD_FORBIDDEN', 'WORKSPACE_UPLOAD_FORBIDDEN')
    expect(db.getFile(file.id)?.status).toBe('ERROR')

    expect(db.requeuePermissionBlocked()).toBe(1)
    expect(db.getPending(pending.id)?.status).toBe('PENDING')
    expect(db.getPending(pending.id)?.error_code).toBeNull()
    expect(db.getFile(file.id)?.status).toBe('PENDING')
    db.close()
  })

  it('ignores duplicate watcher events when the same idempotency key already exists in an error row', async () => {
    const { db } = await makeDb()
    const file = seed(db)
    const hash = 'a'.repeat(64)
    const pending = db.queueUpsert(file, 'D:/ExcelSyncData/book.xlsx', hash, 100)!
    db.markError(pending.id, 'AUTH_REQUIRED', 'AUTH_REQUIRED')
    expect(db.queueUpsert(file, 'D:/ExcelSyncData/book.xlsx', hash, 100)).toBeNull()
    db.close()
  })

  it('queues rename separately from content upload', async () => {
    const { db } = await makeDb()
    const file = seed(db)
    db.updateCloudState(file.id, 4, 'a'.repeat(64))
    db.renameFile(file.id, 'renamed.xlsx', 'renamed.xlsx', '.xlsx')
    const renamed = db.getFile(file.id)!
    const pending = db.queueRename(renamed, 'D:/ExcelSyncData/renamed.xlsx')
    expect(pending?.operation).toBe('RENAME')
    expect(pending?.hash).toBeNull()
    expect(pending?.base_version).toBe(4)
    db.close()
  })

  it('persists favorite and recently opened metadata for the file workspace', async () => {
    const { path, db } = await makeDb()
    const file = seed(db)
    db.setFavorite(file.id, true)
    db.markOpened(file.id)
    const current = db.listFiles().find((row) => row.id === file.id)
    expect(current?.favorite).toBe(true)
    expect(current?.lastOpenedAt).toBeTruthy()
    db.close()

    const reopened = new LocalDb(path)
    const persisted = reopened.listFiles().find((row) => row.id === file.id)
    expect(persisted?.favorite).toBe(true)
    expect(persisted?.lastOpenedAt).toBeTruthy()
    reopened.close()
  })

  it('promotes a locked brand-new file placeholder into one upload job without duplicating the queue', async () => {
    const { db } = await makeDb()
    const file = db.ensureWaitingFile({
      relativePath: 'new-book.xlsx',
      logicalName: 'new-book.xlsx',
      extension: '.xlsx',
      size: 64,
      mtimeMs: Date.now()
    })
    const waiting = db.queueWaitingUpsert(file, 'D:/ExcelSyncData/new-book.xlsx', 'FILE_NOT_STABLE', 'still writing', new Date(Date.now() + 30_000).toISOString())
    expect(waiting?.status).toBe('RETRY_WAIT')
    const ready = db.queueUpsert(file, 'D:/ExcelSyncData/new-book.xlsx', '9'.repeat(64), 64)
    expect(ready?.id).toBe(waiting?.id)
    expect(ready?.status).toBe('PENDING')
    expect(ready?.hash).toBe('9'.repeat(64))
    expect(db.listPending()).toHaveLength(1)
    db.close()
  })

  it('persists a file-lock wait as RETRY_WAIT and exposes it through the problem center', async () => {
    const { path, db } = await makeDb()
    const file = seed(db)
    db.updateCloudState(file.id, 3, 'a'.repeat(64))
    const retryAt = new Date(Date.now() + 30_000).toISOString()
    const pending = db.queueWaitingUpsert(file, 'D:/ExcelSyncData/book.xlsx', 'EBUSY', 'Workbook is still locked', retryAt)
    expect(pending?.status).toBe('RETRY_WAIT')
    expect(pending?.hash).toBeNull()
    expect(db.problemCenter()).toEqual([
      expect.objectContaining({
        fileId: file.id,
        logicalName: 'book.xlsx',
        severity: 'WAITING',
        automatic: true,
        title: '文件正在使用',
        action: 'NONE',
        errorCode: 'EBUSY'
      })
    ])
    db.close()

    const reopened = new LocalDb(path)
    expect(reopened.listPending()).toEqual([
      expect.objectContaining({ fileId: file.id, status: 'RETRY_WAIT', errorCode: 'EBUSY' })
    ])
    const resumed = reopened.listPending()[0]
    expect(resumed).toBeDefined()
    reopened.markUploading(resumed!.id)
    expect(reopened.markPendingNoChange(resumed!.id)).toBe(true)
    expect(reopened.listPending()).toHaveLength(0)
    expect(reopened.getFile(file.id)?.status).toBe('SYNCED')
    reopened.close()
  })

  it('neutralizes legacy DELETE jobs on restart without changing the cloud version', async () => {
    const { path, db } = await makeDb()
    const file = seed(db)
    db.updateCloudState(file.id, 6, 'a'.repeat(64))
    const timestamp = new Date().toISOString()
    db.db.prepare(
      `INSERT INTO pending_sync(
         id, file_id, operation, local_path, hash, size, base_version, idempotency_key,
         status, attempt_count, next_retry_at, error_code, error_message, created_at, updated_at
       ) VALUES (?, ?, 'DELETE', ?, NULL, NULL, 6, ?, 'PENDING', 0, NULL, NULL, NULL, ?, ?)`
    ).run(
      '11111111-1111-4111-8111-111111111111',
      file.id,
      'D:/ExcelSyncData/book.xlsx',
      `${file.id}:6:DELETE`,
      timestamp,
      timestamp
    )
    db.db.prepare("UPDATE files SET status = 'PENDING' WHERE id = ?").run(file.id)
    db.close()

    const reopened = new LocalDb(path)
    expect(reopened.listPending()).toHaveLength(0)
    expect(reopened.getFile(file.id)?.current_version).toBe(6)
    expect(reopened.getFile(file.id)?.status).toBe('SYNCED')
    expect(reopened.getFile(file.id)?.cloud_status).toBe('active')
    reopened.close()
  })
})
