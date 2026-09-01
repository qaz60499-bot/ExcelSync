import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalDb } from '../src/main/db'
import { isManagedFile, isTemporarySyncFile } from '../src/main/file-utils'
import { safeRelativePath } from '../src/main/path-security'
import { fileTypeForName, matchesExpectedFileSignature } from '../src/shared/file-types'

describe('security validation: local state and hostile metadata', () => {
  it('falls back safely when one persisted setting contains malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'excelsync-state-json-'))
    const dbPath = join(dir, 'state.sqlite')
    const db = new LocalDb(dbPath)
    try {
      db.setSettings({ retryBaseSeconds: 9, autoSync: false })
      db.db.prepare("UPDATE settings SET value_json = '{bad-json' WHERE key = 'retryBaseSeconds'").run()
      const settings = db.getSettings()
      expect(settings.retryBaseSeconds).toBe(10)
      expect(settings.autoSync).toBe(false)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not silently treat a truncated or malformed SQLite database as valid state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'excelsync-state-corrupt-'))
    const dbPath = join(dir, 'state.sqlite')
    const db = new LocalDb(dbPath)
    db.close()
    writeFileSync(dbPath, Buffer.from('SQLite format 3\0corrupt-test-payload'))
    try {
      expect(() => new LocalDb(dbPath)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('handles hostile metadata without misclassifying temp or misleading extensions', () => {
    expect(isManagedFile('报告.xlsx.exe')).toBe(true)
    expect(fileTypeForName('报告.xlsx.exe')?.extension).toBe('.exe')
    expect(matchesExpectedFileSignature('报告.xlsx.exe', new TextEncoder().encode('PK fake spreadsheet bytes'))).toBe(false)
    expect(isManagedFile('report.xlsx.txt')).toBe(true)
    expect(fileTypeForName('report.xlsx.txt')?.extension).toBe('.txt')
    expect(isTemporarySyncFile('~$report.xlsx')).toBe(true)
    expect(isTemporarySyncFile('report.xlsx.part')).toBe(true)
    expect(isManagedFile('客户资料/预算 2026.xlsx')).toBe(true)
    expect(isManagedFile('客户资料/预算📊.xlsx')).toBe(true)
  })

  it('keeps deterministic bounded filename fuzz inside the path validator contract', () => {
    const accepted = ['客户', 'emoji📊', 'space name', 'é', 'e\u0301', 'Ω', '日本語']
    for (let seed = 0; seed < 512; seed += 1) {
      const left = accepted[seed % accepted.length]
      const right = accepted[(seed * 7 + 3) % accepted.length]
      const value = `${left}/${right}-${seed}.xlsx`
      try {
        expect(safeRelativePath(value)).toBe(value)
      } catch (error) {
        throw new Error(`SECURITY_FUZZ_SEED=${seed}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const rejectedSeeds = ['../x.xlsx', '..\\x.xlsx', 'C:\\x.xlsx', '\\\\server\\share\\x.xlsx', 'safe/CON.xlsx', 'safe/x.xlsx.', 'safe//x.xlsx']
    for (let seed = 0; seed < rejectedSeeds.length; seed += 1) {
      try {
        expect(() => safeRelativePath(rejectedSeeds[seed]!)).toThrow('PATH_REJECTED')
      } catch (error) {
        throw new Error(`SECURITY_FUZZ_REJECT_SEED=${seed}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })
})
