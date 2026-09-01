import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { compareVersionFiles } from '../src/main/version-diff'
import type { VersionView } from '../src/shared/contracts'

function version(version: number, hash: string, size = 100): VersionView {
  return {
    version,
    hash,
    size,
    base_version: Math.max(0, version - 1),
    restored_from_version: null,
    created_at: new Date(version * 1000).toISOString(),
    status: 'active',
    storage_connection_id: 'storage-1',
    storage_name: 'Telegram Primary',
    available: true
  }
}

async function workbook(path: string, setup: (book: ExcelJS.Workbook) => void): Promise<void> {
  const book = new ExcelJS.Workbook()
  setup(book)
  await book.xlsx.writeFile(path)
}

describe('Version Diff', () => {
  it('reports sheet, cell value, formula and structural changes without executing macros', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-diff-'))
    const oldPath = join(root, 'old.xlsx')
    const newPath = join(root, 'new.xlsx')
    await workbook(oldPath, (book) => {
      const sheet = book.addWorksheet('Data')
      sheet.getCell('A1').value = 'name'
      sheet.getCell('B1').value = 'amount'
      sheet.getCell('A2').value = 'alpha'
      sheet.getCell('B2').value = 10
      sheet.getCell('C2').value = { formula: 'B2*2', result: 20 }
      book.addWorksheet('Removed').getCell('A1').value = 'gone'
    })
    await workbook(newPath, (book) => {
      const sheet = book.addWorksheet('Data')
      sheet.getCell('A1').value = 'name'
      sheet.getCell('B1').value = 'amount'
      sheet.getCell('A2').value = 'alpha-renamed'
      sheet.getCell('B2').value = 12
      sheet.getCell('C2').value = { formula: 'B2*3', result: 36 }
      sheet.getCell('A3').value = 'new row'
      book.addWorksheet('Added').getCell('A1').value = 'new'
    })

    const diff = await compareVersionFiles({
      logicalName: 'book.xlsm',
      fromPath: oldPath,
      toPath: newPath,
      from: version(1, 'a'.repeat(64)),
      to: version(2, 'b'.repeat(64), 120)
    })

    expect(diff.kind).toBe('excel')
    expect(diff.summary).toMatchObject({ sheetsAdded: 1, sheetsRemoved: 1, sheetsChanged: 1, modifiedCells: 4, truncated: false })
    const data = diff.sheets.find((sheet) => sheet.name === 'Data')
    expect(data?.status).toBe('CHANGED')
    expect(data?.addedRows).toBe(1)
    expect(data?.changes.find((cell) => cell.address === 'A2')).toMatchObject({ oldValue: 'alpha', newValue: 'alpha-renamed', changeType: 'VALUE' })
    expect(data?.changes.find((cell) => cell.address === 'C2')).toMatchObject({ oldFormula: 'B2*2', newFormula: 'B2*3', changeType: 'VALUE_AND_FORMULA' })
    expect(diff.metadata.some((row) => row.field === 'sha256')).toBe(true)
  })

  it('falls back to metadata-only comparison for non-OpenXML files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-diff-meta-'))
    const oldPath = join(root, 'old.txt')
    const newPath = join(root, 'new.txt')
    await writeFile(oldPath, 'one')
    await writeFile(newPath, 'two')
    const diff = await compareVersionFiles({
      logicalName: 'notes.txt',
      fromPath: oldPath,
      toPath: newPath,
      from: version(4, 'c'.repeat(64), 3),
      to: version(5, 'd'.repeat(64), 3)
    })
    expect(diff.kind).toBe('metadata')
    expect(diff.sheets).toHaveLength(0)
    expect(diff.metadata.map((row) => row.field)).toContain('sha256')
  })

  it('guards oversized worksheet dimensions instead of scanning every cell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-diff-guard-'))
    const oldPath = join(root, 'old.xlsx')
    const newPath = join(root, 'new.xlsx')
    await workbook(oldPath, (book) => { book.addWorksheet('Huge').getCell(400, 400).value = 'old' })
    await workbook(newPath, (book) => { book.addWorksheet('Huge').getCell(400, 400).value = 'new' })
    const diff = await compareVersionFiles({
      logicalName: 'huge.xlsx',
      fromPath: oldPath,
      toPath: newPath,
      from: version(1, 'e'.repeat(64)),
      to: version(2, 'f'.repeat(64))
    })
    expect(diff.summary.truncated).toBe(true)
    expect(diff.summary.guardReason).toBe('WORKBOOK_TOO_LARGE_FOR_CELL_DIFF')
    expect(diff.sheets[0]?.truncated).toBe(true)
  })

  it('rejects corrupted OpenXML input instead of producing an unsafe partial diff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-diff-corrupt-'))
    const oldPath = join(root, 'old.xlsx')
    const corruptPath = join(root, 'corrupt.xlsx')
    await workbook(oldPath, (book) => { book.addWorksheet('Data').getCell('A1').value = 1 })
    await writeFile(corruptPath, 'not-an-xlsx')
    await expect(compareVersionFiles({
      logicalName: 'book.xlsx',
      fromPath: oldPath,
      toPath: corruptPath,
      from: version(1, '1'.repeat(64)),
      to: version(2, '2'.repeat(64))
    })).rejects.toBeTruthy()
  })
})
