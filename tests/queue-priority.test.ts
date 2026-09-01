import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalDb } from '../src/main/db'

const roots: string[] = []

async function makeDb(): Promise<LocalDb> {
  const root = await mkdtemp(join(tmpdir(), 'excelsync-priority-'))
  roots.push(root)
  return new LocalDb(join(root, 'state.sqlite'))
}

function makeFile(db: LocalDb, index: number) {
  const name = `file-${index}.xlsx`
  return db.ensureFile({
    relativePath: `batch/${name}`,
    logicalName: name,
    extension: '.xlsx',
    hash: index.toString(16).padStart(64, '0'),
    size: 100 + index,
    mtimeMs: Date.now() + index
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Sync priority queue', () => {
  it('orders P0-P4 by priority while exclusion preserves distinct-file dispatch', async () => {
    const db = await makeDb()
    const p4File = makeFile(db, 4)
    const p0File = makeFile(db, 10)
    const p2File = makeFile(db, 22)
    const p4 = db.queueUpsert(p4File, 'D:/ExcelSyncData/batch/file-4.xlsx', '4'.repeat(64), 104, 4)!
    const p0 = db.queueUpsert(p0File, 'D:/ExcelSyncData/batch/file-10.xlsx', 'a'.repeat(64), 110, 0)!
    const p2 = db.queueUpsert(p2File, 'D:/ExcelSyncData/batch/file-22.xlsx', 'b'.repeat(64), 122, 2)!

    expect(db.nextReadyPending()?.id).toBe(p0.id)
    expect(db.nextReadyPending([p0File.id])?.id).toBe(p2.id)
    expect(db.nextReadyPending([p0File.id, p2File.id])?.id).toBe(p4.id)
    expect(db.listPending().map((row) => row.priority).sort()).toEqual([0, 2, 4])
    db.close()
  })

  it('uses oldest-ready fairness when requested so a P4 batch cannot starve forever', async () => {
    const db = await makeDb()
    const oldBatch = makeFile(db, 40)
    const freshInteractive = makeFile(db, 41)
    const p4 = db.queueUpsert(oldBatch, 'D:/ExcelSyncData/batch/file-40.xlsx', 'c'.repeat(64), 140, 4)!
    const p0 = db.queueUpsert(freshInteractive, 'D:/ExcelSyncData/batch/file-41.xlsx', 'd'.repeat(64), 141, 0)!
    db.db.prepare("UPDATE pending_sync SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(p4.id)
    db.db.prepare("UPDATE pending_sync SET created_at = '2026-08-31T00:00:00.000Z' WHERE id = ?").run(p0.id)

    expect(db.nextReadyPending()?.id).toBe(p0.id)
    expect(db.nextReadyPending([], true)?.id).toBe(p4.id)
    db.close()
  })

  it('promotes manual sync and retry priorities without losing durable queue state', async () => {
    const db = await makeDb()
    const first = makeFile(db, 50)
    const second = makeFile(db, 51)
    const p4 = db.queueUpsert(first, 'D:/ExcelSyncData/batch/file-50.xlsx', 'e'.repeat(64), 150, 4)!
    const p3 = db.queueUpsert(second, 'D:/ExcelSyncData/batch/file-51.xlsx', 'f'.repeat(64), 151, 3)!
    expect(db.boostReadyPending(1)).toBe(2)
    expect(db.getPending(p4.id)?.priority).toBe(1)
    expect(db.getPending(p3.id)?.priority).toBe(1)

    db.markError(p4.id, 'NETWORK_ERROR', 'offline')
    expect(db.requeuePending(p4.id)).toBe(true)
    expect(db.getPending(p4.id)).toMatchObject({ status: 'PENDING', priority: 2 })
    db.close()
  })

  it('rebases queued saves for one file after an earlier save advances the cloud version', async () => {
    const db = await makeDb()
    const file = makeFile(db, 60)
    const first = db.queueUpsert(file, 'D:/ExcelSyncData/batch/file-60.xlsx', '1'.repeat(64), 160, 0)!
    const second = db.queueUpsert(file, 'D:/ExcelSyncData/batch/file-60.xlsx', '2'.repeat(64), 161, 0)!
    expect(first.base_version).toBe(0)
    expect(second.base_version).toBe(0)

    db.markSynced(first.id, 1, '1'.repeat(64), 160)
    db.rebaseQueuedForFile(file.id, 1)
    const rebased = db.getPending(second.id)
    expect(rebased?.base_version).toBe(1)
    expect(rebased?.idempotency_key).toBe(`${file.id}:1:${'2'.repeat(64)}`)
    db.close()
  })

  it('handles a 1000-item mixed-priority queue and repeatedly selects distinct ready files', async () => {
    const started = performance.now()
    const db = await makeDb()
    for (let index = 0; index < 1000; index += 1) {
      const file = makeFile(db, 1000 + index)
      const hash = (1000 + index).toString(16).padStart(64, '0')
      const priority = index % 25 === 0 ? 0 : index % 10 === 0 ? 2 : index >= 500 ? 4 : 3
      db.queueUpsert(file, `D:/ExcelSyncData/${file.relative_path}`, hash, 1100 + index, priority)
    }
    expect(db.listPending()).toHaveLength(1000)

    const selected = [] as string[]
    for (let slot = 0; slot < 3; slot += 1) {
      const next = db.nextReadyPending(selected)
      expect(next).not.toBeNull()
      selected.push(next!.file_id)
    }
    expect(new Set(selected).size).toBe(3)
    expect(db.nextReadyPending()?.priority).toBe(0)
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM pending_sync WHERE priority = 4').get() as { count: number }).toMatchObject({ count: expect.any(Number) })
    db.close()
    expect(performance.now() - started).toBeLessThan(25_000)
  }, 30_000)
})
