import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalDb } from '../src/main/db'
import { safeRelativePath } from '../src/main/path-security'

describe('security validation: bounded resource exhaustion', () => {
  it('caps local history growth and individual log detail size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'excelsync-resource-history-'))
    const db = new LocalDb(join(dir, 'state.sqlite'))
    try {
      const detail = 'x'.repeat(10_000)
      for (let index = 0; index < 2_500; index += 1) db.log('SECURITY_RESOURCE_TEST', null, `${index}:${detail}`)
      const count = db.db.prepare('SELECT COUNT(*) AS count FROM sync_history').get() as { count: number }
      const maxLength = db.db.prepare('SELECT MAX(length(detail)) AS length FROM sync_history').get() as { length: number }
      expect(count.count).toBeLessThanOrEqual(2_000)
      expect(maxLength.length).toBeLessThanOrEqual(1_000)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('persists a bounded 500-file queue without duplicate active jobs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'excelsync-resource-queue-'))
    const db = new LocalDb(join(dir, 'state.sqlite'))
    try {
      for (let index = 0; index < 500; index += 1) {
        const hash = index.toString(16).padStart(64, '0')
        const relativePath = `bulk/file-${index}.xlsx`
        const file = db.ensureFile({
          relativePath,
          logicalName: `file-${index}.xlsx`,
          extension: '.xlsx',
          hash,
          size: 100 + index,
          mtimeMs: index + 1
        })
        expect(db.queueUpsert(file, `D:/security-root/${relativePath}`, hash, 100 + index)).not.toBeNull()
        expect(db.queueUpsert(file, `D:/security-root/${relativePath}`, hash, 100 + index)).toBeNull()
      }
      expect(db.listPending()).toHaveLength(500)
      const duplicateKeys = db.db.prepare(
        'SELECT COUNT(*) AS count FROM (SELECT idempotency_key FROM pending_sync GROUP BY idempotency_key HAVING COUNT(*) > 1)'
      ).get() as { count: number }
      expect(duplicateKeys.count).toBe(0)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('clamps retry configuration to a bounded range', () => {
    const dir = mkdtempSync(join(tmpdir(), 'excelsync-resource-retry-'))
    const db = new LocalDb(join(dir, 'state.sqlite'))
    try {
      expect(db.setSettings({ retryBaseSeconds: -999 }).retryBaseSeconds).toBe(2)
      expect(db.setSettings({ retryBaseSeconds: 999_999 }).retryBaseSeconds).toBe(3_600)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('completes a deterministic malformed-path loop without growing an unbounded work queue', () => {
    const invalid = ['../escape.xlsx', '..\\escape.xlsx', 'C:\\escape.xlsx', '\\\\server\\share\\escape.xlsx', 'safe/CON.xlsx']
    let rejected = 0
    for (let index = 0; index < 5_000; index += 1) {
      try {
        safeRelativePath(invalid[index % invalid.length]!)
      } catch {
        rejected += 1
      }
    }
    expect(rejected).toBe(5_000)
  }, 5_000)
})
