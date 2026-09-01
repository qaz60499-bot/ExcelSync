import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ApiError, type PreflightResult, type WorkerApi } from '../src/main/api'
import { LocalDb } from '../src/main/db'
import { sha256File } from '../src/main/file-utils'
import { SyncEngine } from '../src/main/sync-engine'
import { capabilitiesForStorageProvider } from '../src/shared/storage-capabilities'

const roots: string[] = []

async function waitUntil(predicate: () => boolean, timeout = 6000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('WAIT_TIMEOUT')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('dual Telegram storage metadata', () => {
  it('defaults new uploads to Telegram User Group while preserving an explicit Bot override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-dual-storage-'))
    roots.push(root)
    const db = new LocalDb(join(root, 'state.sqlite'))
    expect(db.getSettings().defaultStorageBackend).toBe('telegram_user_group')

    const path = join(root, 'book.xlsx')
    await writeFile(path, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('dual-storage')]))
    const info = await stat(path)
    const hash = await sha256File(path)
    const file = db.ensureFile({ relativePath: 'book.xlsx', logicalName: 'book.xlsx', extension: '.xlsx', hash, size: info.size, mtimeMs: info.mtimeMs })
    const defaultPending = db.queueUpsert(file, path, hash, info.size)
    expect(defaultPending?.storage_backend).toBe('telegram_user_group')
    db.cancelPending(file.id)

    const botPending = db.queueUpsert(file, path, hash, info.size, 0, 'telegram_bot')
    expect(botPending?.storage_backend).toBe('telegram_bot')
    db.close()
  })

  it('lets an explicit import override a not-yet-uploaded pending backend but never rewrites a receipt-backed upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-dual-override-'))
    roots.push(root)
    const path = join(root, 'override.xlsx')
    await writeFile(path, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('override')]))
    const info = await stat(path)
    const hash = await sha256File(path)
    const db = new LocalDb(join(root, 'state.sqlite'))
    const file = db.ensureFile({ relativePath: 'override.xlsx', logicalName: 'override.xlsx', extension: '.xlsx', hash, size: info.size, mtimeMs: info.mtimeMs })
    const pending = db.queueUpsert(file, path, hash, info.size)!
    expect(pending.storage_backend).toBe('telegram_user_group')
    expect(db.setPendingStorageBackendForFile(file.id, 'telegram_bot')).toBe(1)
    expect(db.getPending(pending.id)?.storage_backend).toBe('telegram_bot')

    db.setPendingStorageBackendForFile(file.id, 'telegram_user_group')
    db.setUploadReceipt(pending.id, {
      backend: 'telegram_user_group', chatId: '-10088', messageId: 55, fileName: 'override.xlsx', size: info.size,
      sha256: hash, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createdAt: new Date().toISOString()
    })
    expect(db.setPendingStorageBackendForFile(file.id, 'telegram_bot')).toBe(0)
    expect(db.getPending(pending.id)?.storage_backend).toBe('telegram_user_group')
    db.close()
  })

  it('persists a User Group upload receipt so a restart can reuse the same Telegram message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-dual-receipt-'))
    roots.push(root)
    const databasePath = join(root, 'state.sqlite')
    const path = join(root, 'receipt.xlsx')
    await writeFile(path, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('receipt')]))
    const info = await stat(path)
    const hash = await sha256File(path)

    let db = new LocalDb(databasePath)
    const file = db.ensureFile({ relativePath: 'receipt.xlsx', logicalName: 'receipt.xlsx', extension: '.xlsx', hash, size: info.size, mtimeMs: info.mtimeMs })
    const pending = db.queueUpsert(file, path, hash, info.size)!
    db.setUploadReceipt(pending.id, {
      backend: 'telegram_user_group', chatId: '-10042', messageId: 77, fileName: 'receipt.xlsx', size: info.size,
      sha256: hash, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createdAt: new Date().toISOString()
    })
    db.close()

    db = new LocalDb(databasePath)
    const restored = db.getPending(pending.id)
    expect(restored?.storage_backend).toBe('telegram_user_group')
    expect(restored?.upload_receipt).toContain('"messageId":77')
    expect(restored?.storage_locator).toContain('"chatId":"-10042"')
    db.close()
  })

  it('reuses the persisted User Group receipt after a D1 commit failure instead of uploading twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-dual-idempotency-'))
    roots.push(root)
    const path = join(root, 'idempotent.xlsx')
    await writeFile(path, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('user-group-idempotency')]))
    const info = await stat(path)
    const hash = await sha256File(path)
    const db = new LocalDb(join(root, 'state.sqlite'))
    db.setSettings({ syncDirectory: root, workerUrl: 'https://example.invalid', autoSync: false, startWithWindows: false, retryBaseSeconds: 2, retentionLimit: 20, defaultStorageBackend: 'telegram_user_group' })
    const file = db.ensureFile({ relativePath: 'idempotent.xlsx', logicalName: 'idempotent.xlsx', extension: '.xlsx', hash, size: info.size, mtimeMs: info.mtimeMs })
    const pending = db.queueUpsert(file, path, hash, info.size)!

    let receiptRecorded = false
    let commitFailures = 1
    let storageUploads = 0
    const api = {
      async preflight(): Promise<PreflightResult> {
        return receiptRecorded
          ? { action: 'commit_required', fileId: file.id, intentId: 'intent-user-group' }
          : { action: 'upload_required', fileId: file.id, intentId: 'intent-user-group' }
      },
      async recordUploadReceipt(): Promise<void> { receiptRecorded = true },
      async commit(): Promise<{ fileId: string; version: number; hash: string }> {
        if (commitFailures > 0) {
          commitFailures -= 1
          throw new ApiError('D1_COMMIT_FAILED', 503, true, 'simulated commit failure')
        }
        return { fileId: file.id, version: 1, hash }
      },
      async filesList() { return [] },
      async pullTelegramImports() { return { importedCount: 0 } }
    } as unknown as WorkerApi
    const storage = {
      async upload() {
        storageUploads += 1
        return {
          backend: 'telegram_user_group' as const,
          chatId: '-10042', messageId: 9001, fileName: 'idempotent.xlsx', size: info.size, sha256: hash,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', createdAt: new Date().toISOString()
        }
      }
    }
    const engine = new SyncEngine(db, api, {}, storage as never)
    await engine.start(db.getSettings())
    engine.setPaused(false)
    await waitUntil(() => db.getPending(pending.id)?.status === 'RETRY_WAIT')
    expect(storageUploads).toBe(1)
    expect(db.getPending(pending.id)?.upload_receipt).toContain('"messageId":9001')

    expect(db.getTelegramImport('-10042', 9001)).toEqual({ status: 'IMPORTED', relative_path: 'idempotent.xlsx' })

    db.requeuePending(pending.id)
    await engine.syncNow()
    expect(storageUploads).toBe(1)
    expect(db.getFile(file.id)?.current_version).toBe(1)
    expect(db.getPending(pending.id)).toBeNull()
    await engine.stop()
    db.close()
  })

  it('preserves the remote backend and locator when a second client materializes a cloud file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-dual-remote-'))
    roots.push(root)
    const db = new LocalDb(join(root, 'state.sqlite'))
    const locator = JSON.stringify({ chatId: '-100123', messageId: 321 })
    const row = db.upsertRemoteFile({
      id: crypto.randomUUID(), relativePath: 'remote.xlsx', logicalName: 'remote.xlsx', extension: '.xlsx', version: 3,
      hash: 'a'.repeat(64), size: 1234, mtimeMs: Date.now(), storageBackend: 'telegram_user_group', storageLocator: locator
    })
    expect(row.storage_backend).toBe('telegram_user_group')
    expect(row.storage_locator).toBe(locator)
    expect(db.listFiles()[0]?.storageBackend).toBe('telegram_user_group')
    db.close()
  })

  it('keeps Bot reliability limits separate from the roughly 2GB User Group path', () => {
    const bot = capabilitiesForStorageProvider('telegram_bot')
    const user = capabilitiesForStorageProvider('telegram_user_group')
    expect(bot.maxReliableFileBytes).toBe(20 * 1024 * 1024)
    expect(user.maxReliableFileBytes).toBe(2 * 1024 * 1024 * 1024)
    expect(user.supportsLargeFiles).toBe(true)
  })
})
