import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError, type PreflightResult, type WorkerApi } from '../src/main/api'
import { LocalDb } from '../src/main/db'
import { sha256File } from '../src/main/file-utils'
import { SyncEngine } from '../src/main/sync-engine'

const roots: string[] = []

async function waitUntil(predicate: () => boolean, timeout = 6000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('WAIT_TIMEOUT')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

class FakeApi {
  preflightMode: 'upload' | 'conflict' | 'noop' = 'upload'
  commitFailures = 0
  uploaded = new Set<string>()
  intents = new Map<string, { baseVersion: number; hash: string }>()
  preflightCalls = 0
  uploadCalls = 0
  uploadDelayMs = 0
  activeUploads = 0
  maxActiveUploads = 0
  commitCalls = 0
  remoteBytes = new TextEncoder().encode('remote-version')
  remoteVersion = 2
  remoteHash: string | null = null
  downloadCalls = 0
  deleteCalls = 0
  restoreCalls = 0
  trashCalls = 0
  restoreTrashCalls = 0
  cloudFiles: Array<{
    id: string
    logical_name: string
    relative_path: string
    current_version: number
    current_hash: string | null
    updated_at: string
    status: 'active' | 'trashed' | 'deleted'
  }> = []

  async preflight(input: { fileId?: string; hash: string; baseVersion?: number }): Promise<PreflightResult> {
    this.preflightCalls += 1
    const fileId = input.fileId ?? crypto.randomUUID()
    if (this.preflightMode === 'conflict') {
      return { action: 'conflict', fileId, currentVersion: this.remoteVersion, currentHash: this.remoteHash }
    }
    if (this.preflightMode === 'noop') {
      return { action: 'noop', fileId, currentVersion: 1, currentHash: input.hash }
    }
    const intentId = `intent:${fileId}`
    this.intents.set(intentId, { baseVersion: input.baseVersion ?? 0, hash: input.hash })
    return this.uploaded.has(intentId)
      ? { action: 'commit_required', fileId, intentId }
      : { action: 'upload_required', fileId, intentId }
  }

  async upload(intentId: string): Promise<void> {
    this.uploadCalls += 1
    this.activeUploads += 1
    this.maxActiveUploads = Math.max(this.maxActiveUploads, this.activeUploads)
    try {
      if (this.uploadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.uploadDelayMs))
      this.uploaded.add(intentId)
    } finally {
      this.activeUploads -= 1
    }
  }

  async commit(intentId: string): Promise<{ fileId: string; version: number; hash: string }> {
    this.commitCalls += 1
    if (this.commitFailures > 0) {
      this.commitFailures -= 1
      throw new ApiError('D1_COMMIT_FAILED', 503, true, 'simulated commit failure')
    }
    const intent = this.intents.get(intentId) ?? { baseVersion: 0, hash: this.remoteHash ?? '0'.repeat(64) }
    return { fileId: 'cloud-file', version: intent.baseVersion + 1, hash: intent.hash }
  }

  async renameFile(): Promise<void> {}
  async deleteFile(): Promise<void> { this.deleteCalls += 1 }
  async trashFile(): Promise<void> { this.trashCalls += 1 }

  async downloadCurrent(): Promise<{ bytes: Uint8Array; version: number; hash: string | null }> {
    this.downloadCalls += 1
    return { bytes: this.remoteBytes, version: this.remoteVersion, hash: this.remoteHash }
  }

  async downloadVersion(_fileId: string, version: number): Promise<{ bytes: Uint8Array; version: number; hash: string | null }> {
    this.downloadCalls += 1
    return { bytes: this.remoteBytes, version, hash: this.remoteHash }
  }

  async restore(): Promise<{ version: number; hash: string }> {
    this.restoreCalls += 1
    return { version: this.remoteVersion, hash: this.remoteHash ?? '0'.repeat(64) }
  }

  async restoreTrash(fileId: string): Promise<{
    id: string
    logical_name: string
    relative_path: string
    current_version: number
    current_hash: string | null
    size: number
    status: 'active'
  }> {
    this.restoreTrashCalls += 1
    const cloud = this.cloudFiles.find((file) => file.id === fileId)
    return {
      id: fileId,
      logical_name: cloud?.logical_name ?? 'book.xlsx',
      relative_path: cloud?.relative_path ?? 'book.xlsx',
      current_version: cloud?.current_version ?? this.remoteVersion,
      current_hash: cloud?.current_hash ?? this.remoteHash,
      size: this.remoteBytes.byteLength,
      status: 'active'
    }
  }

  async filesList() { return this.cloudFiles }
  async pullTelegramImports(): Promise<{ importedCount: number }> { return { importedCount: 0 } }
}

async function fixture(content = 'local-v1', canSyncCloud?: () => Promise<boolean>) {
  const root = await mkdtemp(join(tmpdir(), 'excelsync-engine-'))
  roots.push(root)
  const path = join(root, 'book.xlsx')
  await writeFile(path, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(content)]))
  const db = new LocalDb(join(root, 'state.sqlite'))
  const api = new FakeApi()
  const engine = new SyncEngine(db, api as unknown as WorkerApi, canSyncCloud ? { canSyncCloud } : {})
  await engine.start({
    syncDirectory: root,
    workerUrl: 'https://example.invalid',
    autoSync: false,
    startWithWindows: false,
    retryBaseSeconds: 2,
    retentionLimit: 20,
    defaultStorageBackend: 'telegram_bot'
  })
  return { root, path, db, api, engine }
}

async function queueCurrent(path: string, db: LocalDb, relativePath = 'book.xlsx') {
  const hash = await sha256File(path)
  const stats = await import('node:fs/promises').then(({ stat }) => stat(path))
  const file = db.ensureFile({
    relativePath,
    logicalName: relativePath.split('/').at(-1) ?? relativePath,
    extension: '.xlsx',
    hash,
    size: stats.size,
    mtimeMs: stats.mtimeMs
  })
  return { file, pending: db.queueUpsert(file, path, hash, stats.size)!, hash, size: stats.size }
}

async function markCurrentSynced(path: string, db: LocalDb, version = 1, relativePath = 'book.xlsx') {
  const queued = await queueCurrent(path, db, relativePath)
  db.markSynced(queued.pending.id, version, queued.hash, queued.size)
  return { file: db.getFile(queued.file.id)!, hash: queued.hash, size: queued.size }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('sync engine failure and consistency behavior', () => {
  it('keeps local files pending without calling the cloud while authentication is unavailable', async () => {
    const { path, db, api, engine } = await fixture('local-auth-blocked', async () => false)
    const { pending } = await queueCurrent(path, db)
    engine.setPaused(false)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(db.getPending(pending.id)?.status).toBe('PENDING')
    expect(db.getFile(pending.file_id)?.status).toBe('PENDING')
    expect(api.preflightCalls).toBe(0)
    await engine.stop(); db.close()
  })

  it('performs a first upload and marks the local file synced only after commit', async () => {
    const { path, db, api, engine } = await fixture()
    const { file, hash } = await queueCurrent(path, db)
    api.remoteHash = hash
    engine.setPaused(false)
    await waitUntil(() => db.getFile(file.id)?.status === 'SYNCED')
    expect(db.getFile(file.id)?.current_version).toBe(1)
    expect(api.uploadCalls).toBe(1)
    expect(api.commitCalls).toBe(1)
    await engine.stop(); db.close()
  })

  it('treats a cloud same-hash preflight as a no-op without upload', async () => {
    const { path, db, api, engine } = await fixture()
    const { file } = await queueCurrent(path, db)
    api.preflightMode = 'noop'
    engine.setPaused(false)
    await waitUntil(() => db.getFile(file.id)?.status === 'SYNCED')
    expect(api.uploadCalls).toBe(0)
    expect(api.commitCalls).toBe(0)
    await engine.stop(); db.close()
  })

  it('keeps a pending retry after a simulated D1 commit failure and does not re-upload on retry', async () => {
    const { path, db, api, engine } = await fixture()
    const { pending, hash } = await queueCurrent(path, db)
    api.remoteHash = hash
    api.commitFailures = 1
    engine.setPaused(false)
    await waitUntil(() => db.getPending(pending.id)?.status === 'RETRY_WAIT')
    expect(api.uploadCalls).toBe(1)
    expect(db.getFile(pending.file_id)?.current_version).toBe(0)

    db.db.prepare("UPDATE pending_sync SET status='PENDING', next_retry_at=NULL WHERE id=?").run(pending.id)
    await engine.syncNow()
    await waitUntil(() => db.getFile(pending.file_id)?.status === 'SYNCED')
    expect(api.uploadCalls).toBe(1)
    expect(api.commitCalls).toBe(2)
    await engine.stop(); db.close()
  })

  it('creates a conflict copy and restores the cloud side to the canonical local path', async () => {
    const { root, path, db, api, engine } = await fixture('local-conflict')
    const { file } = await queueCurrent(path, db)
    api.preflightMode = 'conflict'
    api.remoteBytes = new TextEncoder().encode('cloud-wins-canonical')
    api.remoteVersion = 7
    api.remoteHash = null
    engine.setPaused(false)
    await waitUntil(() => db.getFile(file.id)?.status === 'CONFLICT' && db.getFile(file.id)?.current_version === 7)
    const names = await readdir(root)
    expect(names.some((name) => name.startsWith('book (conflict ') && name.endsWith('.xlsx'))).toBe(true)
    expect((await readFile(path, 'utf8'))).toBe('cloud-wins-canonical')
    expect(db.getFile(file.id)?.current_version).toBe(7)
    await engine.stop(); db.close()
  })

  it('resolves a conflict by keeping the cloud version and removes the preserved local copy', async () => {
    const { root, path, db, api, engine } = await fixture('local-cloud-choice')
    const { file } = await queueCurrent(path, db)
    api.preflightMode = 'conflict'
    api.remoteBytes = new TextEncoder().encode('cloud-canonical')
    api.remoteVersion = 8
    engine.setPaused(false)
    await waitUntil(() => db.getFile(file.id)?.status === 'CONFLICT')
    const conflictName = (await readdir(root)).find((name) => name.startsWith('book (conflict '))
    expect(conflictName).toBeTruthy()
    engine.setPaused(true)
    await engine.resolveConflict(file.id, 'cloud')
    expect(db.getConflictPendingForFile(file.id)).toBeNull()
    expect(db.getFile(file.id)?.status).toBe('SYNCED')
    expect((await readdir(root)).some((name) => name === conflictName)).toBe(false)
    await engine.stop(); db.close()
  })

  it('resolves a conflict by keeping both versions and queues the local copy as a separate file', async () => {
    const { root, path, db, api, engine } = await fixture('local-both-choice')
    const { file } = await queueCurrent(path, db)
    api.preflightMode = 'conflict'
    api.remoteBytes = new TextEncoder().encode('cloud-canonical')
    api.remoteVersion = 9
    engine.setPaused(false)
    await waitUntil(() => db.getFile(file.id)?.status === 'CONFLICT')
    engine.setPaused(true)
    await engine.resolveConflict(file.id, 'both')
    const conflictFile = db.listFiles().find((row) => row.logicalName.startsWith('book (conflict '))
    expect(db.getFile(file.id)?.status).toBe('SYNCED')
    expect(conflictFile?.status).toBe('PENDING')
    expect(db.listPending().some((pending) => pending.fileId === conflictFile?.id)).toBe(true)
    expect((await readdir(root)).some((name) => name.startsWith('book (conflict '))).toBe(true)
    await engine.stop(); db.close()
  })

  it('resolves a conflict by keeping local content and queues it against the latest cloud version', async () => {
    const { root, path, db, api, engine } = await fixture('local-local-choice')
    const original = await readFile(path)
    const { file } = await queueCurrent(path, db)
    api.preflightMode = 'conflict'
    api.remoteBytes = new TextEncoder().encode('cloud-canonical')
    api.remoteVersion = 10
    engine.setPaused(false)
    await waitUntil(() => db.getFile(file.id)?.status === 'CONFLICT' && db.getFile(file.id)?.current_version === 10)
    engine.setPaused(true)
    await engine.resolveConflict(file.id, 'local')
    expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array(original))
    expect((await readdir(root)).some((name) => name.startsWith('book (conflict '))).toBe(false)
    const pending = db.listPending().find((row) => row.fileId === file.id)
    expect(pending?.status).toBe('PENDING')
    expect(db.getPending(pending!.id)?.base_version).toBe(10)
    await engine.stop(); db.close()
  })

  it('waits for an in-flight upload and drains pending work before exit', async () => {
    const { path, db, api, engine } = await fixture('shutdown-flush')
    const { file, hash } = await queueCurrent(path, db)
    api.remoteHash = hash
    api.uploadDelayMs = 180
    engine.setPaused(false)
    await waitUntil(() => db.getFile(file.id)?.status === 'UPLOADING')
    await engine.flushBeforeExit(2_000)
    expect(db.getFile(file.id)?.status).toBe('SYNCED')
    expect(db.listPending()).toHaveLength(0)
    expect(api.uploadCalls).toBe(1)
    expect(api.commitCalls).toBe(1)
    await engine.stop(); db.close()
  })

  it('respects an explicit manual pause during exit flush', async () => {
    const { path, db, api, engine } = await fixture('paused-shutdown')
    const { pending } = await queueCurrent(path, db)
    await engine.flushBeforeExit(500)
    expect(db.getPending(pending.id)?.status).toBe('PENDING')
    expect(api.preflightCalls).toBe(0)
    await engine.stop(); db.close()
  })

  it('restore writes the restored cloud version locally and advances to a new version', async () => {
    const { path, db, api, engine } = await fixture('old-local')
    const { file, hash } = await queueCurrent(path, db)
    db.cancelPending(file.id)
    db.updateCloudState(file.id, 10, hash)
    api.remoteBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('restored-from-v7')])
    api.remoteVersion = 11
    api.remoteHash = await crypto.subtle.digest('SHA-256', api.remoteBytes).then((buffer) =>
      [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    )
    await engine.restore(file.id, 7)
    expect(await readFile(path)).toEqual(Buffer.from(api.remoteBytes))
    engine.setPaused(false)
    await waitUntil(() => db.getFile(file.id)?.current_version === 11)
    expect(db.getFile(file.id)?.current_version).toBe(11)
    expect(db.getFile(file.id)?.current_hash).toBe(api.remoteHash)
    await engine.stop(); db.close()
  })

  it('keeps a synced cloud file active when its local copy is deleted', async () => {
    const { path, db, api, engine } = await fixture('delete-local-only')
    const { file } = await markCurrentSynced(path, db)
    await rm(path)
    await engine.handleFileDeleted(path)
    expect(db.getState(file.id)?.exists_flag).toBe(0)
    expect(db.getFile(file.id)?.current_version).toBe(1)
    expect(db.getFile(file.id)?.cloud_status).toBe('active')
    expect(db.listPending()).toHaveLength(0)
    expect(db.listFiles().find((row) => row.id === file.id)?.exists).toBe(false)
    expect(api.deleteCalls).toBe(0)
    await engine.stop(); db.close()
  })

  it('syncNow preserves cloud-only state and does not automatically download an intentionally removed local copy', async () => {
    const { path, db, api, engine } = await fixture('delete-then-sync')
    const { file, hash } = await markCurrentSynced(path, db)
    api.remoteHash = hash
    api.remoteVersion = 1
    api.cloudFiles = [{
      id: file.id,
      logical_name: 'book.xlsx',
      relative_path: 'book.xlsx',
      current_version: 1,
      current_hash: hash,
      updated_at: new Date().toISOString(),
      status: 'active'
    }]
    await rm(path)
    await engine.handleFileDeleted(path)
    engine.setPaused(false)
    await engine.syncNow()
    expect(db.getState(file.id)?.exists_flag).toBe(0)
    expect(api.deleteCalls).toBe(0)
    expect(api.downloadCalls).toBe(0)
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await engine.stop(); db.close()
  })

  it('reconciles files removed while the app was stopped without re-downloading or deleting cloud data', async () => {
    const { path, db, api, engine } = await fixture('offline-delete')
    const { file, hash } = await markCurrentSynced(path, db)
    api.remoteHash = hash
    api.remoteVersion = 1
    api.cloudFiles = [{ id: file.id, logical_name: 'book.xlsx', relative_path: 'book.xlsx', current_version: 1, current_hash: hash, updated_at: new Date().toISOString(), status: 'active' }]
    await rm(path)
    expect(db.getState(file.id)?.exists_flag).toBe(1)
    engine.setPaused(false)
    await engine.syncNow()
    await waitUntil(() => db.getState(file.id)?.exists_flag === 0)
    expect(db.getState(file.id)?.exists_flag).toBe(0)
    expect(api.downloadCalls).toBe(0)
    expect(api.deleteCalls).toBe(0)
    await engine.stop(); db.close()
  })

  it('restores a cloud-only current version locally without creating a cloud version', async () => {
    const { path, db, api, engine } = await fixture('restore-current-local')
    const { file } = await markCurrentSynced(path, db, 5)
    await rm(path)
    await engine.handleFileDeleted(path)
    api.remoteBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x52, 0x45, 0x53, 0x54, 0x4f, 0x52, 0x45])
    api.remoteVersion = 5
    api.remoteHash = await crypto.subtle.digest('SHA-256', api.remoteBytes).then((buffer) =>
      [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    )
    await engine.restoreLocalCopy(file.id)
    expect(db.getState(file.id)?.exists_flag).toBe(1)
    expect(db.getFile(file.id)?.current_version).toBe(5)
    expect(api.downloadCalls).toBe(1)
    expect(api.restoreCalls).toBe(0)
    expect(api.deleteCalls).toBe(0)
    expect(new Uint8Array(await readFile(path))).toEqual(api.remoteBytes)
    await engine.stop(); db.close()
  })

  it('removes an unsynced local-only record when the local file is deleted', async () => {
    const { path, db, api, engine } = await fixture('never-uploaded')
    const { file } = await queueCurrent(path, db)
    await rm(path)
    await engine.handleFileDeleted(path)
    expect(db.getFile(file.id)).toBeNull()
    expect(db.listPending()).toHaveLength(0)
    expect(api.deleteCalls).toBe(0)
    await engine.stop(); db.close()
  })

  it('moves a cloud file into SaaS trash only through the explicit trash action', async () => {
    const { path, db, api, engine } = await fixture('explicit-trash')
    const { file } = await markCurrentSynced(path, db, 3)
    await engine.trashSaasFile(file.id)
    expect(api.trashCalls).toBe(1)
    expect(api.deleteCalls).toBe(0)
    expect(db.getFile(file.id)?.cloud_status).toBe('trashed')
    expect(db.listFiles().some((row) => row.id === file.id)).toBe(false)
    await engine.stop(); db.close()
  })

  it('restores a trashed file as active cloud-only when the local copy is absent', async () => {
    const { path, db, api, engine } = await fixture('trash-restore')
    const { file, hash } = await markCurrentSynced(path, db, 4)
    await rm(path)
    await engine.handleFileDeleted(path)
    db.markCloudTrashed(file.id)
    api.remoteVersion = 4
    api.remoteHash = hash
    api.cloudFiles = [{ id: file.id, logical_name: 'book.xlsx', relative_path: 'book.xlsx', current_version: 4, current_hash: hash, updated_at: new Date().toISOString(), status: 'trashed' }]
    await engine.restoreTrash(file.id)
    expect(api.restoreTrashCalls).toBe(1)
    expect(db.getFile(file.id)?.cloud_status).toBe('active')
    expect(db.listFiles().find((row) => row.id === file.id)?.exists).toBe(false)
    expect(api.downloadCalls).toBe(0)
    await engine.stop(); db.close()
  })

  it('clearing the entire sync folder never deletes cloud files and leaves all records cloud-only', async () => {
    const { root, db, api, engine } = await fixture('seed')
    await rm(join(root, 'book.xlsx'))
    db.removeUnsyncedFile(db.getFileByPath('book.xlsx')?.id ?? '')
    const records: Array<{ id: string; path: string; hash: string }> = []
    for (const name of ['a.xlsx', 'b.xlsx', 'c.xlsx']) {
      const path = join(root, name)
      await writeFile(path, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(name)]))
      const synced = await markCurrentSynced(path, db, 1, name)
      records.push({ id: synced.file.id, path, hash: synced.hash })
    }
    api.cloudFiles = records.map((record) => ({
      id: record.id,
      logical_name: record.path.split(/[\\/]/).at(-1)!,
      relative_path: record.path.split(/[\\/]/).at(-1)!,
      current_version: 1,
      current_hash: record.hash,
      updated_at: new Date().toISOString(),
      status: 'active' as const
    }))
    for (const record of records) {
      await rm(record.path)
      await engine.handleFileDeleted(record.path)
    }
    engine.setPaused(false)
    await engine.syncNow()
    expect(api.deleteCalls).toBe(0)
    expect(api.downloadCalls).toBe(0)
    expect(db.listFiles()).toHaveLength(3)
    expect(db.listFiles().every((row) => row.currentVersion === 1 && row.exists === false)).toBe(true)
    await engine.stop(); db.close()
  })

  it('runs at most three different files concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-engine-concurrency-'))
    roots.push(root)
    const db = new LocalDb(join(root, 'state.sqlite'))
    const api = new FakeApi()
    api.uploadDelayMs = 180
    const engine = new SyncEngine(db, api as unknown as WorkerApi)
    await engine.start({
      syncDirectory: root,
      workerUrl: 'https://example.invalid',
      autoSync: false,
      startWithWindows: false,
      retryBaseSeconds: 2,
      retentionLimit: 20,
      defaultStorageBackend: 'telegram_bot'
    })

    const fileIds: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const name = `parallel-${index}.xlsx`
      const path = join(root, name)
      await writeFile(path, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`parallel-${index}`)]))
      const queued = await queueCurrent(path, db, name)
      fileIds.push(queued.file.id)
    }
    try {
      engine.setPaused(false)
      await waitUntil(() => fileIds.every((id) => db.getFile(id)?.status === 'SYNCED'), 12_000)
      expect(api.maxActiveUploads).toBe(3)
      expect(api.uploadCalls).toBe(6)
    } finally {
      await engine.stop()
      db.close()
    }
  })
})
