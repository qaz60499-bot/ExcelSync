import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError, type WorkerApi } from '../src/main/api'
import { LocalDb } from '../src/main/db'
import { sha256File } from '../src/main/file-utils'
import { SyncEngine } from '../src/main/sync-engine'
import type { TelegramBotStorageReceipt } from '../src/shared/contracts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'excelsync-bot-receipt-'))
  roots.push(root)
  const path = join(root, 'saved.txt')
  await writeFile(path, 'original saved content')
  const info = await stat(path)
  const hash = await sha256File(path)
  const dbPath = join(root, 'state.sqlite')
  const db = new LocalDb(dbPath)
  db.setSettings({ syncDirectory: root, autoSync: false, defaultStorageBackend: 'telegram_bot' })
  const file = db.ensureFile({ relativePath: 'saved.txt', logicalName: 'saved.txt', extension: '.txt', hash, size: info.size, mtimeMs: info.mtimeMs })
  const pending = db.queueUpsert(file, path, hash, info.size)!
  const receipt: TelegramBotStorageReceipt = { backend: 'telegram_bot', intentId: randomUUID(), recoveryToken: 'authenticated-test-capability', sha256: hash, size: info.size, fileName: 'saved.txt', createdAt: new Date().toISOString() }
  return { root, path, dbPath, db, file, pending, receipt }
}

describe('Bot desktop receipt recovery', () => {
  for (const change of ['edited', 'removed'] as const) {
    it(`commits a saved receipt after restart when local file was ${change}, without uploading again`, async () => {
      const f = await fixture()
      let uploads = 0, preflights = 0, commits = 0, recordings = 0
      const api = {
        async preflight() { preflights++; return { action: 'upload_required', fileId: f.file.id, intentId: f.receipt.intentId } },
        async upload() { uploads++; return f.receipt },
        async recordUploadReceipt(intentId: string) { expect(intentId).toBe(f.receipt.intentId); recordings++ },
        async commit() { commits++; if (commits === 1) throw new ApiError('D1_COMMIT_FAILED', 503, true); return { fileId: f.file.id, version: 1, hash: f.receipt.sha256 } }
      } as unknown as WorkerApi
      let db = f.db
      let engine = new SyncEngine(db, api)
      await engine.start(db.getSettings())
      try {
        await expect((engine as any).processUpsert(db.getPending(f.pending.id))).rejects.toMatchObject({ code: 'D1_COMMIT_FAILED' })
        expect(db.getPending(f.pending.id)?.upload_receipt).toContain('authenticated-test-capability')
        expect(db.listPending()[0]).toMatchObject({ storageBackend: 'telegram_bot', syncStage: 'commit_pending', hasUploadReceipt: true })
      } finally { await engine.stop(); db.close() }
      if (change === 'edited') await writeFile(f.path, 'newer unsynchronized local content')
      else await rm(f.path)
      db = new LocalDb(f.dbPath)
      engine = new SyncEngine(db, api)
      await engine.start(db.getSettings())
      try {
        await (engine as any).processUpsert(db.getPending(f.pending.id))
        expect(uploads).toBe(1)
        expect(preflights).toBe(1)
        expect(recordings).toBe(2)
        expect(db.getPending(f.pending.id)).toBeNull()
        expect(db.getFile(f.file.id)?.current_version).toBe(1)
        if (change === 'edited') {
          expect(await readFile(f.path, 'utf8')).toBe('newer unsynchronized local content')
          expect(db.listPending()).toHaveLength(1)
          const next = db.nextReadyPending()!
          expect(next.hash).toBe(await sha256File(f.path))
          expect(next.base_version).toBe(1)
          expect(db.getFile(f.file.id)?.status).toBe('PENDING')
        } else {
          expect(db.listPending()).toHaveLength(0)
          expect(db.getState(f.file.id)?.exists_flag).toBe(0)
        }
      } finally { await engine.stop(); db.close() }
    })
  }

  it('keeps an invalid persisted receipt for diagnosis and never resends', async () => {
    const f = await fixture()
    f.db.db.prepare('UPDATE pending_sync SET upload_receipt = ? WHERE id = ?').run('{broken', f.pending.id)
    const api = { async upload() { throw new Error('MUST_NOT_UPLOAD') }, async preflight() { throw new Error('MUST_NOT_PREFLIGHT') } } as unknown as WorkerApi
    const engine = new SyncEngine(f.db, api)
    try {
      await expect((engine as any).processUpsert(f.db.getPending(f.pending.id))).rejects.toMatchObject({ code: 'INVALID_UPLOAD_RECEIPT' })
      expect(f.db.getPending(f.pending.id)?.upload_receipt).toBe('{broken')
      expect(await readFile(f.path, 'utf8')).toBe('original saved content')
    } finally { await engine.stop(); f.db.close() }
  })

  it('retains receipt-bearing and in-flight jobs across local removal and queue cancellation', async () => {
    const f = await fixture()
    try {
      f.db.setUploadReceipt(f.pending.id, f.receipt)
      f.db.cancelPending(f.file.id)
      f.db.markMissing(f.file.relative_path)
      f.db.removeUnsyncedFile(f.file.id)
      expect(f.db.getPending(f.pending.id)?.upload_receipt).toContain(f.receipt.recoveryToken)
      expect(f.db.getFile(f.file.id)).not.toBeNull()
      f.db.clearUploadReceipt(f.pending.id)
      f.db.markUploading(f.pending.id)
      f.db.markMissing(f.file.relative_path)
      f.db.removeUnsyncedFile(f.file.id)
      expect(f.db.getPending(f.pending.id)?.status).toBe('UPLOADING')
    } finally { f.db.close() }
  })

  it('blocks a newer save behind an uncommitted receipt and retains pending status after earlier commit', async () => {
    const f = await fixture()
    try {
      f.db.setUploadReceipt(f.pending.id, f.receipt)
      f.db.markRetry(f.pending.id, 'D1_COMMIT_FAILED', 'temporary metadata failure', new Date(Date.now() + 3600000).toISOString())
      const newer = f.db.queueUpsert(f.file, f.path, 'b'.repeat(64), 20)!
      expect(f.db.nextReadyPending()).toBeNull()
      f.db.requeuePending(f.pending.id)
      expect(f.db.nextReadyPending()?.id).toBe(f.pending.id)
      f.db.markSynced(f.pending.id, 1, f.receipt.sha256, f.receipt.size)
      f.db.rebaseQueuedForFile(f.file.id, 1)
      expect(f.db.getFile(f.file.id)?.status).toBe('PENDING')
      expect(f.db.getPending(newer.id)?.base_version).toBe(1)
    } finally { f.db.close() }
  })
})
