import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError, type PreflightResult, type WorkerApi } from '../src/main/api'
import { LocalDb, type PendingRow } from '../src/main/db'
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
  preflightGate: Promise<void> | null = null
  releasePreflight: (() => void) | null = null
  cancelRequestsCalls = 0
  cancelled = false
  uploadCalls = 0
  uploadDelayMs = 0
  activeUploads = 0
  maxActiveUploads = 0
  commitCalls = 0
  remoteBytes = new TextEncoder().encode('remote-version')
  remoteVersion = 2
  remoteHash: string | null = null
  downloadCalls = 0
  filesListCalls = 0
  importCalls = 0
  filesListFailures = 0
  downloadHook: (() => Promise<void>) | null = null
  filesListHook: (() => Promise<void>) | null = null
  deleteCalls = 0
  restoreCalls = 0
  trashCalls = 0
  permanentDeleteCalls = 0
  trashGate: Promise<void> | null = null
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
    if (this.preflightGate) await this.preflightGate
    if (this.cancelled) throw new ApiError('REQUEST_CANCELLED', 0, true, 'simulated request cancellation')
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
  cancelRequests(): void {
    this.cancelRequestsCalls += 1
    this.cancelled = true
    this.releasePreflight?.()
  }
  async releaseFileLease(): Promise<void> {}
  async clearFilePresence(): Promise<void> {}
  async deleteFile(): Promise<void> { this.deleteCalls += 1 }
  async trashFile(): Promise<void> { this.trashCalls += 1; await this.trashGate }
  async permanentlyDelete(): Promise<void> { this.permanentDeleteCalls += 1 }

  async downloadCurrent(): Promise<{ bytes: Uint8Array; version: number; hash: string | null }> {
    this.downloadCalls += 1
    await this.downloadHook?.()
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

  async filesList() {
    this.filesListCalls += 1
    await this.filesListHook?.()
    if (this.filesListFailures > 0) {
      this.filesListFailures -= 1
      throw new Error('simulated network failure')
    }
    return this.cloudFiles
  }
  async pullTelegramImports(): Promise<{ importedCount: number }> {
    this.importCalls += 1
    return { importedCount: 0 }
  }
}

async function fixture(
  content = 'local-v1',
  canSyncCloud?: () => Promise<boolean>,
  autoSync = false,
  prepareApi?: (api: FakeApi) => void,
  cloudAccessEnabled = true
) {
  const root = await mkdtemp(join(tmpdir(), 'excelsync-engine-'))
  roots.push(root)
  const path = join(root, 'book.xlsx')
  await writeFile(path, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(content)]))
  const db = new LocalDb(join(root, 'state.sqlite'))
  const api = new FakeApi()
  prepareApi?.(api)
  const engine = new SyncEngine(db, api as unknown as WorkerApi, canSyncCloud ? { canSyncCloud } : {})
  if (!cloudAccessEnabled) engine.setCloudAccessEnabled(false)
  await engine.start({
    syncDirectory: root,
    workerUrl: 'https://example.invalid',
    autoSync,
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

  it('re-checks the workbook when the Office lock disappears so the final save is queued', async () => {
    const { root, path, db, engine } = await fixture('office-lock-release')
    const { file } = await markCurrentSynced(path, db, 1)
    await writeFile(path, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('final-after-close')]))
    const expectedHash = await sha256File(path)
    const lockPath = join(root, '~$book.xlsx')
    await (engine as unknown as { handleOfficeLock(path: string, active: boolean): Promise<void> }).handleOfficeLock(lockPath, false)
    const pending = db.listPending().find((row) => row.fileId === file.id)
    expect(pending?.status).toBe('PENDING')
    expect(db.getPending(pending!.id)?.hash).toBe(expectedHash)
    await engine.stop(); db.close()
  })

  it('flushes watcher debounce before exit so an immediate app quit does not lose the last edit', async () => {
    const { path, db, api, engine } = await fixture('shutdown-debounce')
    const { file } = await markCurrentSynced(path, db, 1)
    await writeFile(path, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('save-then-exit')]))
    ;(engine as unknown as { watcher: { schedule(path: string): void } }).watcher.schedule(path)
    engine.setPaused(false)
    await engine.flushBeforeExit(2_000)
    expect(db.getFile(file.id)?.status).toBe('SYNCED')
    expect(db.listPending()).toHaveLength(0)
    expect(api.uploadCalls).toBe(1)
    expect(api.commitCalls).toBe(1)
    await engine.stop(); db.close()
  })

  it('parks D1 daily-quota failures until the next UTC reset instead of repeatedly retrying', async () => {
    const { path, db, engine } = await fixture('d1-quota-wait')
    const { pending } = await queueCurrent(path, db)
    await (engine as unknown as { handleProcessingError(pending: PendingRow, error: unknown): Promise<void> }).handleProcessingError(
      pending,
      new ApiError('D1_DAILY_WRITE_LIMIT', 503, true, 'D1_DAILY_WRITE_LIMIT')
    )
    const retry = db.getPending(pending.id)
    expect(retry?.status).toBe('RETRY_WAIT')
    const retryAt = new Date(retry?.next_retry_at ?? '')
    expect(retryAt.getUTCHours()).toBe(0)
    expect(retryAt.getUTCMinutes()).toBe(0)
    expect(retryAt.getUTCSeconds()).toBe(30)
    expect(retryAt.getTime()).toBeGreaterThan(Date.now())
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

  it('cancels and awaits active cloud jobs before stop allows the database to close', async () => {
    const { root, path, db, api, engine } = await fixture('shutdown-cancel-job')
    await (engine as any).watcher.stop()
    const { file, pending } = await queueCurrent(path, db)
    api.preflightGate = new Promise<void>((resolve) => { api.releasePreflight = resolve })
    engine.setPaused(false)
    await waitUntil(() => api.preflightCalls === 1)

    await engine.stop()
    const stoppedPending = db.getPending(pending.id)
    expect(api.cancelRequestsCalls).toBe(1)
    expect(stoppedPending?.status).toBe('RETRY_WAIT')
    expect(db.getFile(file.id)?.status).toBe('RETRY_WAIT')
    db.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const reopened = new LocalDb(join(root, 'state.sqlite'))
    expect(reopened.getPending(pending.id)?.status).toBe(stoppedPending?.status)
    reopened.close()
  })

  it('persists watcher work during a paused no-session exit without making cloud requests', async () => {
    const { path, db, api, engine } = await fixture('paused-shutdown', async () => false)
    const { file } = await markCurrentSynced(path, db, 1)
    await writeFile(path, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('paused-local-save')]))
    ;(engine as unknown as { watcher: { schedule(path: string): void } }).watcher.schedule(path)
    await engine.flushBeforeExit(500)
    const pending = db.listPending().find((row) => row.fileId === file.id)
    expect(pending?.status).toBe('PENDING')
    expect(db.getPending(pending!.id)?.hash).toBe(await sha256File(path))
    expect(api.preflightCalls).toBe(0)
    expect(api.uploadCalls).toBe(0)
    expect(api.commitCalls).toBe(0)
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

  it('keeps a pending local conflict and its bytes when a cloud baseline has the same cached hash', async () => {
    const { root, path, db, api, engine } = await fixture('recovered-same-hash')
    const { file, pending, hash } = await queueCurrent(path, db)
    const conflictBaseName = 'book (conflict recovered).xlsx'
    const conflictPath = join(root, conflictBaseName)
    await writeFile(conflictPath, await readFile(path))
    db.markConflict(pending.id, `Preflight conflict: PATH_ALREADY_EXISTS; local copy=${conflictBaseName}; remote refresh required`)
    api.cloudFiles = [{
      id: 'cloud-book-id',
      logical_name: 'book.xlsx',
      relative_path: 'book.xlsx',
      current_version: 7,
      current_hash: hash,
      updated_at: new Date().toISOString(),
      status: 'active'
    }]

    ;(engine as any).paused = false
    await engine.pullRemoteChanges(true)

    expect(db.getFile(file.id)).toMatchObject({ current_version: 0, status: 'CONFLICT' })
    expect(db.getFile('cloud-book-id')).toBeNull()
    expect(db.getPending(pending.id)?.status).toBe('CONFLICT')
    expect(api.downloadCalls).toBe(0)
    expect(await sha256File(path)).toBe(hash)
    expect(await sha256File(conflictPath)).toBe(hash)
    await engine.stop(); db.close()
  })

  it('adopts a remote baseline only after a fresh stable hash matches and no pending work exists', async () => {
    const { path, db, api, engine } = await fixture('fresh-baseline-adoption')
    const hash = await sha256File(path)
    const info = await import('node:fs/promises').then(({ stat }) => stat(path))
    const local = db.ensureFile({ relativePath: 'book.xlsx', logicalName: 'book.xlsx', extension: '.xlsx', hash, size: info.size, mtimeMs: info.mtimeMs })
    api.cloudFiles = [{
      id: 'cloud-book-id', logical_name: 'book.xlsx', relative_path: 'book.xlsx', current_version: 7,
      current_hash: hash, updated_at: new Date().toISOString(), status: 'active'
    }]

    ;(engine as any).paused = false
    await engine.pullRemoteChanges(true)

    expect(db.getFile(local.id)).toBeNull()
    expect(db.getFile('cloud-book-id')).toMatchObject({ current_version: 7, current_hash: hash, status: 'SYNCED' })
    expect(db.listPending()).toHaveLength(0)
    expect(api.downloadCalls).toBe(0)
    await engine.stop(); db.close()
  })

  it('holds first-start queue dispatch until a matching cloud baseline is adopted', async () => {
    let releaseListing!: () => void
    let markListingStarted!: () => void
    const listingStarted = new Promise<void>((resolve) => { markListingStarted = resolve })
    const listingGate = new Promise<void>((resolve) => { releaseListing = resolve })
    const cloudId = 'cloud-startup-book-id'
    const { path, db, api, engine } = await fixture('startup-baseline-adoption', undefined, true, (fakeApi) => {
      fakeApi.filesListHook = async () => {
        markListingStarted()
        await listingGate
      }
    })
    await listingStarted
    await (engine as any).watcher.stop()

    await engine.handleFileReady(path)
    const local = db.getFileByPath('book.xlsx')!
    const pending = db.db.prepare('SELECT id FROM pending_sync WHERE file_id = ?').get(local.id) as { id: string } | undefined
    const hash = await sha256File(path)
    expect(pending).toBeDefined()
    api.cloudFiles = [{
      id: cloudId, logical_name: 'book.xlsx', relative_path: 'book.xlsx', current_version: 7,
      current_hash: hash, updated_at: new Date().toISOString(), status: 'active'
    }]

    await (engine as any).processOne()
    expect(api.preflightCalls).toBe(0)
    expect(api.uploadCalls).toBe(0)

    releaseListing()
    await engine.pullRemoteChanges(true)

    expect(db.getFile(local.id)).toBeNull()
    expect(db.getFile(cloudId)).toMatchObject({ current_version: 7, current_hash: hash, status: 'SYNCED' })
    expect(db.getPending(pending!.id)).toBeNull()
    expect(api.preflightCalls).toBe(0)
    expect(api.uploadCalls).toBe(0)
    expect(api.commitCalls).toBe(0)
    expect(db.db.prepare("SELECT 1 AS found FROM sync_history WHERE event_type = 'REMOTE_PATH_CONFLICT' LIMIT 1").get()).toBeUndefined()
    await engine.stop(); db.close()
  })

  it('adopts an already queued pristine file while excluding it from ordinary dispatch', async () => {
    const { path, db, api, engine } = await fixture('queued-baseline-adoption')
    const { file, pending, hash } = await queueCurrent(path, db)
    api.cloudFiles = [{
      id: 'cloud-queued-book-id', logical_name: 'book.xlsx', relative_path: 'book.xlsx', current_version: 4,
      current_hash: hash, updated_at: new Date().toISOString(), status: 'active'
    }]
    let releaseSnapshot!: () => void
    let markSnapshotStarted!: () => void
    const snapshotStarted = new Promise<void>((resolve) => { markSnapshotStarted = resolve })
    const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve })
    const engineInternals = engine as any
    const stableSnapshot = engineInternals.stableSnapshot.bind(engine)
    engineInternals.stableSnapshot = async (targetPath: string) => {
      if (targetPath === path) {
        markSnapshotStarted()
        await snapshotGate
      }
      return stableSnapshot(targetPath)
    }
    engineInternals.paused = false

    const pull = engine.pullRemoteChanges(true)
    await snapshotStarted
    await engineInternals.processOne()
    expect(api.preflightCalls).toBe(0)
    expect(db.getPending(pending.id)?.status).toBe('PENDING')

    releaseSnapshot()
    await pull

    expect(db.getFile(file.id)).toBeNull()
    expect(db.getFile('cloud-queued-book-id')).toMatchObject({ current_version: 4, current_hash: hash, status: 'SYNCED' })
    expect(db.getPending(pending.id)).toBeNull()
    expect(db.listPending()).toHaveLength(0)
    expect(api.preflightCalls).toBe(0)
    expect(api.uploadCalls).toBe(0)
    await engine.stop(); db.close()
  })

  it('waits for the first baseline handoff after a signed-out startup before dispatching queued files', async () => {
    let authenticated = false
    const remoteId = 'cloud-signed-in-book-id'
    const { path, db, api, engine } = await fixture('signed-out-startup', async () => authenticated, true, undefined, false)
    const { file, pending, hash } = await queueCurrent(path, db)
    await waitUntil(() => db.getPending(pending.id)?.status === 'PENDING')
    expect(api.preflightCalls).toBe(0)
    api.cloudFiles = [{
      id: remoteId, logical_name: 'book.xlsx', relative_path: 'book.xlsx', current_version: 5,
      current_hash: hash, updated_at: new Date().toISOString(), status: 'active'
    }]

    authenticated = true
    engine.setCloudAccessEnabled(true)
    await waitUntil(() => db.getFile(remoteId)?.current_version === 5)
    expect(db.getFile(file.id)).toBeNull()
    expect(db.getPending(pending.id)).toBeNull()
    expect(api.preflightCalls).toBe(0)
    expect(api.uploadCalls).toBe(0)
    await engine.stop(); db.close()
  })

  it('preserves a queued edit when its fresh bytes do not match the pending baseline hash', async () => {
    const { path, db, api, engine } = await fixture('queued-edited-baseline')
    const { file, pending, hash: queuedHash, size: queuedSize } = await queueCurrent(path, db)
    await (engine as any).watcher.stop()
    const editedBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('edited-after-queue')])
    await writeFile(path, editedBytes)
    const freshHash = await sha256File(path)
    api.cloudFiles = [{
      id: 'cloud-edited-book-id', logical_name: 'book.xlsx', relative_path: 'book.xlsx', current_version: 3,
      current_hash: freshHash, updated_at: new Date().toISOString(), status: 'active'
    }]
    ;(engine as any).paused = false

    await engine.pullRemoteChanges(true)

    expect(db.getFile(file.id)).toMatchObject({ current_version: 0 })
    expect(db.getFile('cloud-edited-book-id')).toBeNull()
    expect(db.getPending(pending.id)).toMatchObject({ status: 'PENDING', hash: queuedHash, size: queuedSize })
    expect(await readFile(path)).toEqual(editedBytes)
    expect(api.preflightCalls).toBe(0)
    expect(api.uploadCalls).toBe(0)
    expect(api.downloadCalls).toBe(0)
    await engine.stop(); db.close()
  })

  it('does not adopt a baseline from a stale cached hash when the actual local bytes diverged', async () => {
    const { path, db, api, engine } = await fixture('stale-baseline-hash')
    const cachedHash = await sha256File(path)
    const info = await import('node:fs/promises').then(({ stat }) => stat(path))
    const local = db.ensureFile({ relativePath: 'book.xlsx', logicalName: 'book.xlsx', extension: '.xlsx', hash: cachedHash, size: info.size, mtimeMs: info.mtimeMs })
    const changedBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('fresh-local-edits')])
    await writeFile(path, changedBytes)
    api.cloudFiles = [{
      id: 'cloud-book-id', logical_name: 'book.xlsx', relative_path: 'book.xlsx', current_version: 7,
      current_hash: cachedHash, updated_at: new Date().toISOString(), status: 'active'
    }]

    ;(engine as any).paused = false
    await engine.pullRemoteChanges(true)

    expect(db.getFile(local.id)).toMatchObject({ current_version: 0 })
    expect(db.getFile('cloud-book-id')).toBeNull()
    expect(await readFile(path)).toEqual(changedBytes)
    expect(api.downloadCalls).toBe(0)
    await engine.stop(); db.close()
  })

  it('queues a fresh edit inside the watcher debounce instead of downloading over it', async () => {
    const { path, db, api, engine } = await fixture('remote-pull-debounce-edit')
    const { file } = await markCurrentSynced(path, db, 1)
    await (engine as any).watcher.stop()
    const changedBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('edit-before-pull')])
    await writeFile(path, changedBytes)
    api.remoteBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('advanced-cloud')])
    api.remoteHash = createHash('sha256').update(api.remoteBytes).digest('hex')
    api.remoteVersion = 2
    api.cloudFiles = [{
      id: file.id, logical_name: 'book.xlsx', relative_path: 'book.xlsx', current_version: 2,
      current_hash: api.remoteHash, updated_at: new Date().toISOString(), status: 'active'
    }]

    ;(engine as any).paused = false
    await engine.pullRemoteChanges(true)

    const pending = db.listPending().find((row) => row.fileId === file.id)
    expect(await readFile(path)).toEqual(changedBytes)
    expect(db.getPending(pending!.id)?.hash).toBe(createHash('sha256').update(changedBytes).digest('hex'))
    expect(api.downloadCalls).toBe(0)
    expect(api.preflightCalls).toBe(0)
    expect(api.uploadCalls).toBe(0)
    expect(api.commitCalls).toBe(0)
    await engine.stop(); db.close()
  })

  it('leaves edits made during a remote download in place and queues them for conflict handling', async () => {
    const { path, db, api, engine } = await fixture('remote-pull-download-edit')
    const { file } = await markCurrentSynced(path, db, 1)
    await (engine as any).watcher.stop()
    const changedBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('edit-during-download')])
    api.remoteBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('advanced-cloud')])
    api.remoteHash = createHash('sha256').update(api.remoteBytes).digest('hex')
    api.remoteVersion = 2
    api.cloudFiles = [{
      id: file.id, logical_name: 'book.xlsx', relative_path: 'book.xlsx', current_version: 2,
      current_hash: api.remoteHash, updated_at: new Date().toISOString(), status: 'active'
    }]
    api.downloadHook = async () => { await writeFile(path, changedBytes) }

    ;(engine as any).paused = false
    await engine.pullRemoteChanges(true)

    const pending = db.listPending().find((row) => row.fileId === file.id)
    expect(await readFile(path)).toEqual(changedBytes)
    expect(db.getPending(pending!.id)?.hash).toBe(createHash('sha256').update(changedBytes).digest('hex'))
    expect(api.downloadCalls).toBe(1)
    expect(api.preflightCalls).toBe(0)
    expect(api.uploadCalls).toBe(0)
    expect(api.commitCalls).toBe(0)
    await engine.stop(); db.close()
  })

  it('backs off failed remote polling while manual sync still pulls immediately', async () => {
    const { db, api, engine } = await fixture('remote-pull-backoff')
    api.filesListFailures = 1
    ;(engine as any).paused = false
    await engine.pullRemoteChanges(true)
    await engine.pullRemoteChanges()
    expect(api.filesListCalls).toBe(1)
    expect(api.importCalls).toBe(1)

    await engine.syncNow()
    expect(api.filesListCalls).toBe(3)
    expect(api.importCalls).toBe(3)
    await engine.stop(); db.close()
  })

  it('keeps unchanged trashed and cloud-only metadata pulls inside adaptive backoff', async () => {
    const { path, db, api, engine } = await fixture('remote-pull-metadata-backoff')
    const { file, hash } = await markCurrentSynced(path, db, 1)
    const trashed = db.upsertRemoteMetadata({
      id: file.id, relativePath: file.relative_path, logicalName: file.logical_name, extension: file.extension,
      version: 1, hash, cloudStatus: 'trashed'
    })
    const missing = db.ensureFile({
      relativePath: 'gone.xlsx', logicalName: 'gone.xlsx', extension: '.xlsx', hash: 'b'.repeat(64), size: 64, mtimeMs: 1
    })
    db.markMissing(missing.relative_path)
    const trashedUpdatedAt = db.getFile(file.id)?.updated_at
    const missingUpdatedAt = db.getFile(missing.id)?.updated_at
    api.cloudFiles = [
      { id: trashed.id, logical_name: 'book.xlsx', relative_path: 'book.xlsx', current_version: 1, current_hash: hash, updated_at: new Date().toISOString(), status: 'trashed' },
      { id: missing.id, logical_name: 'gone.xlsx', relative_path: 'gone.xlsx', current_version: 1, current_hash: 'b'.repeat(64), updated_at: new Date().toISOString(), status: 'active' }
    ]
    ;(engine as any).paused = false

    await engine.pullRemoteChanges(true)
    await engine.pullRemoteChanges(true)
    await engine.pullRemoteChanges()

    expect(api.filesListCalls).toBe(2)
    expect(api.downloadCalls).toBe(0)
    expect(db.getFile(file.id)?.updated_at).toBe(trashedUpdatedAt)
    expect(db.getFile(missing.id)?.updated_at).toBe(missingUpdatedAt)
    expect((engine as any).remotePullUnchangedStreak).toBe(2)
    await engine.stop(); db.close()
  })

  it('shares one in-flight remote pull among concurrent callers', async () => {
    const { db, api, engine } = await fixture('remote-pull-single-flight')
    let release!: () => void
    api.filesListHook = () => new Promise<void>((resolve) => { release = resolve })
    ;(engine as any).paused = false
    const first = engine.pullRemoteChanges(true)
    await waitUntil(() => api.filesListCalls === 1)
    let secondFinished = false
    const second = engine.pullRemoteChanges(true).then(() => { secondFinished = true })
    await Promise.resolve()
    expect(secondFinished).toBe(false)
    release()
    await Promise.all([first, second])
    expect(api.filesListCalls).toBe(1)
    await engine.stop(); db.close()
  })

  it('lets local uploads proceed while a remote file listing is in flight', async () => {
    const { path, db, api, engine } = await fixture('remote-pull-local-upload')
    const { file } = await queueCurrent(path, db)
    let release!: () => void
    api.filesListHook = () => new Promise<void>((resolve) => { release = resolve })
    ;(engine as any).paused = false
    const pull = engine.pullRemoteChanges(true)
    await waitUntil(() => api.filesListCalls === 1)

    await (engine as any).processOne()
    await waitUntil(() => api.preflightCalls === 1)
    release()
    await pull
    await waitUntil(() => db.getFile(file.id)?.status === 'SYNCED')
    expect(api.uploadCalls).toBe(1)
    expect(api.commitCalls).toBe(1)
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

  it('blocks SaaS trash and permanent deletion when local work is queued', async () => {
    const { path, db, api, engine } = await fixture('trash-pending-guard')
    const { file } = await markCurrentSynced(path, db, 3)
    await (engine as any).watcher.stop()
    await writeFile(path, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('newer-local-save')]))
    const { pending } = await queueCurrent(path, db)

    await expect(engine.trashSaasFile(file.id)).rejects.toThrow('FILE_HAS_PENDING_SYNC')
    expect(api.trashCalls).toBe(0)
    expect(db.getPending(pending.id)).not.toBeNull()

    db.markCloudTrashed(file.id)
    await expect(engine.permanentlyDelete(file.id)).rejects.toThrow('FILE_HAS_PENDING_SYNC')
    expect(api.permanentDeleteCalls).toBe(0)
    expect(db.getPending(pending.id)).not.toBeNull()
    await engine.stop(); db.close()
  })

  it('reserves a file during cloud trash and retains saves that arrive during the request', async () => {
    const { path, db, api, engine } = await fixture('trash-racing-save')
    const { file } = await markCurrentSynced(path, db, 3)
    await (engine as any).watcher.stop()
    let releaseTrash!: () => void
    api.trashGate = new Promise<void>((resolve) => { releaseTrash = resolve })
    ;(engine as any).paused = false

    const trash = engine.trashSaasFile(file.id)
    await waitUntil(() => api.trashCalls === 1)
    const editedBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('saved-during-trash')])
    await writeFile(path, editedBytes)
    await engine.handleFileReady(path)
    const queued = db.db.prepare('SELECT id FROM pending_sync WHERE file_id = ?').get(file.id) as { id: string } | undefined
    expect(queued).toBeDefined()
    const pending = db.getPending(queued!.id)
    expect(pending?.status).toBe('PENDING')
    expect(api.preflightCalls).toBe(0)

    releaseTrash()
    await trash
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(db.getFile(file.id)).toMatchObject({ status: 'PENDING', cloud_status: 'trashed' })
    expect(db.getPending(pending!.id)?.hash).toBe(await sha256File(path))
    expect(await readFile(path)).toEqual(editedBytes)
    expect(db.nextReadyPending()).toBeNull()
    expect(api.preflightCalls).toBe(0)
    expect(api.uploadCalls).toBe(0)
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
