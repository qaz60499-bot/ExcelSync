import { extname } from 'node:path'
import ExcelJS from 'exceljs'
import type { VersionDiffCellView, VersionDiffSheetView, VersionDiffView, VersionView } from '../shared/contracts'

const MAX_TOTAL_COMPARE_CELLS = 250_000
const MAX_COMPARE_CELLS_PER_SHEET = 150_000
const MAX_REPORTED_CHANGES = 5_000

interface CellSnapshot {
  value: string
  formula: string | null
}

function normalizeScalar(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (Array.isArray(record.richText)) return record.richText.map((part) => String((part as Record<string, unknown>).text ?? '')).join('')
    if (typeof record.text === 'string') return record.text
    if (typeof record.error === 'string') return record.error
    if ('result' in record) return normalizeScalar(record.result)
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return String(value)
}

function snapshotCell(cell: ExcelJS.Cell): CellSnapshot {
  const value = cell.value
  if (value && typeof value === 'object' && 'formula' in value) {
    const record = value as { formula?: unknown; result?: unknown }
    return {
      value: normalizeScalar(record.result),
      formula: typeof record.formula === 'string' ? record.formula : null
    }
  }
  return { value: normalizeScalar(value), formula: null }
}

function changedCell(address: string, oldCell: CellSnapshot, newCell: CellSnapshot): VersionDiffCellView | null {
  const valueChanged = oldCell.value !== newCell.value
  const formulaChanged = oldCell.formula !== newCell.formula
  if (!valueChanged && !formulaChanged) return null
  return {
    address,
    oldValue: oldCell.value,
    newValue: newCell.value,
    oldFormula: oldCell.formula,
    newFormula: newCell.formula,
    changeType: valueChanged && formulaChanged ? 'VALUE_AND_FORMULA' : formulaChanged ? 'FORMULA' : 'VALUE'
  }
}

async function loadWorkbook(path: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path)
  return workbook
}

function sheetDimensions(sheet: ExcelJS.Worksheet | undefined): { rows: number; columns: number } {
  if (!sheet) return { rows: 0, columns: 0 }
  return {
    rows: Math.max(sheet.actualRowCount || 0, sheet.rowCount || 0),
    columns: Math.max(sheet.actualColumnCount || 0, sheet.columnCount || 0)
  }
}

function metadataDiff(from: VersionView, to: VersionView): VersionDiffView['metadata'] {
  const values: Array<[string, unknown, unknown]> = [
    ['size', from.size, to.size],
    ['sha256', from.hash, to.hash],
    ['version', from.version, to.version],
    ['createdAt', from.created_at, to.created_at],
    ['baseVersion', from.base_version, to.base_version],
    ['restoredFromVersion', from.restored_from_version, to.restored_from_version],
    ['storage', from.storage_name ?? from.storage_connection_id, to.storage_name ?? to.storage_connection_id]
  ]
  return values
    .filter(([, oldValue, newValue]) => String(oldValue ?? '') !== String(newValue ?? ''))
    .map(([field, oldValue, newValue]) => ({ field, oldValue: String(oldValue ?? ''), newValue: String(newValue ?? '') }))
}

export async function compareVersionFiles(input: {
  logicalName: string
  fromPath: string
  toPath: string
  from: VersionView
  to: VersionView
}): Promise<VersionDiffView> {
  const extension = extname(input.logicalName).toLowerCase()
  const metadata = metadataDiff(input.from, input.to)
  if (!['.xlsx', '.xlsm'].includes(extension)) {
    return {
      kind: 'metadata',
      fromVersion: input.from.version,
      toVersion: input.to.version,
      summary: { sheetsAdded: 0, sheetsRemoved: 0, sheetsChanged: 0, modifiedCells: 0, truncated: false },
      sheets: [],
      metadata
    }
  }

  // ExcelJS reads the OpenXML package only. It never executes VBA/macros; .xlsm is treated as data.
  const [oldWorkbook, newWorkbook] = await Promise.all([loadWorkbook(input.fromPath), loadWorkbook(input.toPath)])
  const oldByName = new Map(oldWorkbook.worksheets.map((sheet) => [sheet.name, sheet]))
  const newByName = new Map(newWorkbook.worksheets.map((sheet) => [sheet.name, sheet]))
  const names = [...new Set([...oldByName.keys(), ...newByName.keys()])]
  const sheets: VersionDiffSheetView[] = []
  let modifiedCells = 0
  let sheetsAdded = 0
  let sheetsRemoved = 0
  let sheetsChanged = 0
  let totalCompared = 0
  let truncated = false
  let guardReason: string | null = null

  for (const name of names) {
    const oldSheet = oldByName.get(name)
    const newSheet = newByName.get(name)
    const oldSize = sheetDimensions(oldSheet)
    const newSize = sheetDimensions(newSheet)
    if (!oldSheet) {
      sheetsAdded += 1
      sheets.push({
        name,
        status: 'ADDED',
        modifiedCells: 0,
        addedRows: newSize.rows,
        removedRows: 0,
        oldRowCount: 0,
        newRowCount: newSize.rows,
        oldColumnCount: 0,
        newColumnCount: newSize.columns,
        changes: [],
        truncated: false
      })
      continue
    }
    if (!newSheet) {
      sheetsRemoved += 1
      sheets.push({
        name,
        status: 'REMOVED',
        modifiedCells: 0,
        addedRows: 0,
        removedRows: oldSize.rows,
        oldRowCount: oldSize.rows,
        newRowCount: 0,
        oldColumnCount: oldSize.columns,
        newColumnCount: 0,
        changes: [],
        truncated: false
      })
      continue
    }

    const rows = Math.max(oldSize.rows, newSize.rows)
    const columns = Math.max(oldSize.columns, newSize.columns)
    const dimensionCells = rows * columns
    const changes: VersionDiffCellView[] = []
    let sheetModified = 0
    let sheetTruncated = false

    if (dimensionCells > MAX_COMPARE_CELLS_PER_SHEET || totalCompared + dimensionCells > MAX_TOTAL_COMPARE_CELLS) {
      sheetTruncated = true
      truncated = true
      guardReason = guardReason ?? 'WORKBOOK_TOO_LARGE_FOR_CELL_DIFF'
    } else {
      totalCompared += dimensionCells
      outer: for (let rowIndex = 1; rowIndex <= rows; rowIndex += 1) {
        for (let columnIndex = 1; columnIndex <= columns; columnIndex += 1) {
          const oldCell = snapshotCell(oldSheet.getRow(rowIndex).getCell(columnIndex))
          const newCell = snapshotCell(newSheet.getRow(rowIndex).getCell(columnIndex))
          const changed = changedCell(newSheet.getRow(rowIndex).getCell(columnIndex).address, oldCell, newCell)
          if (!changed) continue
          sheetModified += 1
          modifiedCells += 1
          if (changes.length < MAX_REPORTED_CHANGES) changes.push(changed)
          if (modifiedCells >= MAX_REPORTED_CHANGES) {
            sheetTruncated = true
            truncated = true
            guardReason = guardReason ?? 'TOO_MANY_CHANGED_CELLS'
            break outer
          }
        }
      }
    }

    const structurallyChanged = oldSize.rows !== newSize.rows || oldSize.columns !== newSize.columns
    const status = sheetModified > 0 || structurallyChanged || sheetTruncated ? 'CHANGED' : 'UNCHANGED'
    if (status === 'CHANGED') sheetsChanged += 1
    sheets.push({
      name,
      status,
      modifiedCells: sheetModified,
      addedRows: Math.max(0, newSize.rows - oldSize.rows),
      removedRows: Math.max(0, oldSize.rows - newSize.rows),
      oldRowCount: oldSize.rows,
      newRowCount: newSize.rows,
      oldColumnCount: oldSize.columns,
      newColumnCount: newSize.columns,
      changes,
      truncated: sheetTruncated
    })
  }

  return {
    kind: 'excel',
    fromVersion: input.from.version,
    toVersion: input.to.version,
    summary: { sheetsAdded, sheetsRemoved, sheetsChanged, modifiedCells, truncated, guardReason },
    sheets,
    metadata
  }
}
