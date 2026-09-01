import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalDb } from '../src/main/db'

const roots: string[] = []
const requested = Number.parseInt(process.env.EXCELSYNC_STRESS_FILES || '50', 10)
const FILE_COUNT = Number.isFinite(requested) ? Math.min(1000, Math.max(1, requested)) : 50

function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]!
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe(`queue/restart stress (${FILE_COUNT} files)`, () => {
  it('has no duplicate, lost or ghost versions across abrupt-restart recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-stress-'))
    roots.push(root)
    const dbPath = join(root, 'state.sqlite')
    let db = new LocalDb(dbPath)
    try {
    const started = performance.now()
    const queueLatency: number[] = []
    const expected = new Map<string, { hash: string; size: number }>()

    for (let i = 0; i < FILE_COUNT; i += 1) {
      const name = `E2E_STRESS_${String(i).padStart(4, '0')}.xlsx`
      const path = join(root, name)
      const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`stress-${i}-${'x'.repeat(128)}`)])
      await writeFile(path, bytes)
      const hash = sha256(bytes)
      const t0 = performance.now()
      const file = db.ensureFile({
        relativePath: name,
        logicalName: name,
        extension: '.xlsx',
        hash,
        size: bytes.length,
        mtimeMs: Date.now() + i
      })
      const first = db.queueUpsert(file, path, hash, bytes.length)
      const duplicateEvent = db.queueUpsert(file, path, hash, bytes.length)
      queueLatency.push(performance.now() - t0)
      expect(first).toBeTruthy()
      expect(duplicateEvent).toBeNull()
      expected.set(file.id, { hash, size: bytes.length })
    }

    const beforeRestart = db.listPending()
    expect(beforeRestart).toHaveLength(FILE_COUNT)
    for (let i = 0; i < Math.max(1, Math.floor(FILE_COUNT / 10)); i += 1) {
      db.markUploading(beforeRestart[i]!.id)
    }
    const ghostBeforeRestart = db.listFiles().filter((row) => row.currentVersion > 0).length
    db.close()

    db = new LocalDb(dbPath)
    const recovered = db.listPending()
    const recoveredUploading = recovered.filter((row) => row.status === 'UPLOADING').length
    const pendingIds = new Set(recovered.map((row) => row.id))
    const duplicatePending = recovered.length - pendingIds.size
    const filesAfterRestart = db.listFiles()
    const fileIds = new Set(filesAfterRestart.map((row) => row.id))
    const duplicateFiles = filesAfterRestart.length - fileIds.size
    const lostBeforeCompletion = Math.max(0, FILE_COUNT - filesAfterRestart.length)
    const ghostAfterRestart = filesAfterRestart.filter((row) => row.currentVersion > 0).length

    const completionLatency: number[] = []
    for (const pending of recovered) {
      const expectedFile = expected.get(pending.fileId)
      expect(expectedFile).toBeTruthy()
      const t0 = performance.now()
      db.markSynced(pending.id, 1, expectedFile!.hash, expectedFile!.size)
      completionLatency.push(performance.now() - t0)
    }

    const finalFiles = db.listFiles()
    const finalPending = db.listPending()
    const success = finalFiles.filter((row) => row.currentVersion === 1 && row.status === 'SYNCED').length
    const failed = FILE_COUNT - success
    const lost = Math.max(0, FILE_COUNT - finalFiles.length)
    const duplicate = duplicatePending + duplicateFiles
    const ghostVersion = ghostBeforeRestart + ghostAfterRestart
    const duration = performance.now() - started
    const allLatency = queueLatency.map((value, i) => value + (completionLatency[i] || 0))
    const report = {
      environment: process.platform,
      file_count: FILE_COUNT,
      total: FILE_COUNT,
      success,
      failed,
      retry: Math.max(1, Math.floor(FILE_COUNT / 10)),
      duplicate,
      lost,
      ghost_version: ghostVersion,
      recovered_uploading: recoveredUploading,
      total_duration_ms: Number(duration.toFixed(2)),
      avg_ms: Number((allLatency.reduce((a, b) => a + b, 0) / allLatency.length).toFixed(3)),
      p50_ms: Number(percentile(allLatency, 50).toFixed(3)),
      p95_ms: Number(percentile(allLatency, 95).toFixed(3)),
      p99_ms: Number(percentile(allLatency, 99).toFixed(3)),
      max_ms: Number(Math.max(...allLatency).toFixed(3)),
      pending_final: finalPending.length,
      lost_before_completion: lostBeforeCompletion,
      conclusion: failed === 0 && duplicate === 0 && lost === 0 && ghostVersion === 0 && finalPending.length === 0 && recoveredUploading === 0 ? 'PASS' : 'FAIL'
    }

    const artifactDir = join(process.cwd(), 'test-artifacts', 'stress')
    await mkdir(artifactDir, { recursive: true })
    await writeFile(join(artifactDir, 'test-report.json'), JSON.stringify(report, null, 2), 'utf8')
    await writeFile(join(artifactDir, 'test-report.md'), [
      '# ExcelSync Queue/Restart Stress',
      '',
      `- total=${report.total}`,
      `- success=${report.success}`,
      `- failed=${report.failed}`,
      `- retry=${report.retry}`,
      `- duplicate=${report.duplicate}`,
      `- lost=${report.lost}`,
      `- ghost_version=${report.ghost_version}`,
      `- total_duration_ms=${report.total_duration_ms}`,
      `- avg_ms=${report.avg_ms}`,
      `- P50=${report.p50_ms}`,
      `- P95=${report.p95_ms}`,
      `- P99=${report.p99_ms}`,
      `- max=${report.max_ms}`,
      `- pending_final=${report.pending_final}`,
      '',
      `Conclusion: **${report.conclusion}**`
    ].join('\n'), 'utf8')

    expect(recoveredUploading).toBe(0)
    expect(duplicate).toBe(0)
    expect(lost).toBe(0)
    expect(ghostVersion).toBe(0)
    expect(failed).toBe(0)
    expect(finalPending).toHaveLength(0)
    } finally {
      db.close()
    }
  }, 120_000)
})
