import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import type { PreviewView, SpreadsheetPreviewSheet } from '../shared/contracts'
import { mimeForFileName } from '../shared/file-types'

const MAX_PREVIEW_ROWS = 500
const MAX_PREVIEW_TEXT_BYTES = 2 * 1024 * 1024
const MAX_PREVIEW_BINARY_BYTES = 20 * 1024 * 1024

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toLocaleString('zh-CN')
  if (typeof value === 'object') {
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue)
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('')
    if ('text' in value && typeof value.text === 'string') return value.text
    if ('error' in value && typeof value.error === 'string') return value.error
    return JSON.stringify(value)
  }
  return String(value)
}

function sheetPreview(sheet: ExcelJS.Worksheet): SpreadsheetPreviewSheet {
  const rowCount = sheet.actualRowCount || sheet.rowCount
  const columnCount = sheet.actualColumnCount || sheet.columnCount
  const rows: string[][] = []
  const limit = Math.min(MAX_PREVIEW_ROWS, Math.max(rowCount, sheet.rowCount))
  for (let rowIndex = 1; rowIndex <= limit; rowIndex += 1) {
    const row = sheet.getRow(rowIndex)
    const values: string[] = []
    const width = Math.max(columnCount, row.cellCount)
    for (let columnIndex = 1; columnIndex <= width; columnIndex += 1) {
      values.push(cellText(row.getCell(columnIndex).value))
    }
    rows.push(values)
  }
  return { name: sheet.name, rowCount, columnCount, rows }
}

async function spreadsheetPreview(path: string, logicalName: string, requestedSheet?: string): Promise<PreviewView> {
  const extension = extname(logicalName).toLowerCase()
  const workbook = new ExcelJS.Workbook()
  if (extension === '.csv' || extension === '.tsv') {
    await workbook.csv.readFile(path, { parserOptions: { delimiter: extension === '.tsv' ? '\t' : ',' } })
  } else if (extension === '.xlsx' || extension === '.xlsm') {
    await workbook.xlsx.readFile(path)
  } else {
    return {
      kind: 'unsupported',
      logicalName,
      message: '这种旧版 Excel 格式暂不支持内置预览，请使用本机 Excel / 默认表格程序打开。'
    }
  }
  const sheets = workbook.worksheets.map((sheet) => ({ name: sheet.name, rowCount: sheet.actualRowCount || sheet.rowCount, columnCount: sheet.actualColumnCount || sheet.columnCount }))
  const selected = workbook.getWorksheet(requestedSheet || '') ?? workbook.worksheets[0]
  if (!selected) {
    return { kind: 'spreadsheet', logicalName, sheetNames: [], selectedSheet: null, sheet: null, sheetCount: 0 }
  }
  return {
    kind: 'spreadsheet',
    logicalName,
    sheetNames: sheets.map((sheet) => sheet.name),
    selectedSheet: selected.name,
    sheet: sheetPreview(selected),
    sheetCount: sheets.length
  }
}

export async function previewLocalFile(path: string, logicalName: string, requestedSheet?: string): Promise<PreviewView> {
  const extension = extname(logicalName).toLowerCase()
  const info = await stat(path)
  if (!info.isFile()) throw new Error('FILE_NOT_FOUND')

  if (['.xlsx', '.xlsm', '.xls', '.xlsb', '.csv', '.tsv'].includes(extension)) {
    return spreadsheetPreview(path, logicalName, requestedSheet)
  }

  if (['.txt', '.md', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.rtf'].includes(extension)) {
    if (info.size > MAX_PREVIEW_TEXT_BYTES) {
      return { kind: 'unsupported', logicalName, message: '文件过大，内置文本预览仅支持 2 MiB 以内的文件。' }
    }
    const raw = await readFile(path, 'utf8')
    if (extension === '.json') {
      try {
        const formatted = JSON.stringify(JSON.parse(raw), null, 2)
        return { kind: 'text', logicalName, format: 'json', text: formatted }
      } catch {
        return { kind: 'text', logicalName, format: 'json', text: raw }
      }
    }
    if (extension === '.md') return { kind: 'text', logicalName, format: 'markdown', text: raw }
    return { kind: 'text', logicalName, format: 'plain', text: raw }
  }

  if (extension === '.zip') {
    if (info.size > MAX_PREVIEW_BINARY_BYTES) return { kind: 'unsupported', logicalName, message: 'ZIP 文件过大，无法快速读取目录。' }
    const bytes = await readFile(path)
    const zip = await JSZip.loadAsync(bytes)
    const entries = Object.values(zip.files)
      .slice(0, 3000)
      .map((entry) => ({ name: entry.name, directory: entry.dir }))
    return { kind: 'zip', logicalName, entries, truncated: Object.keys(zip.files).length > entries.length }
  }

  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(extension)) {
    if (info.size > MAX_PREVIEW_BINARY_BYTES) return { kind: 'unsupported', logicalName, message: '图片过大，无法在内置预览中加载。' }
    const bytes = await readFile(path)
    return { kind: 'binary', logicalName, media: 'image', mimeType: mimeForFileName(logicalName), base64: bytes.toString('base64') }
  }

  if (extension === '.pdf') {
    if (info.size > MAX_PREVIEW_BINARY_BYTES) return { kind: 'unsupported', logicalName, message: 'PDF 过大，无法在内置预览中加载。' }
    const bytes = await readFile(path)
    return { kind: 'binary', logicalName, media: 'pdf', mimeType: 'application/pdf', base64: bytes.toString('base64') }
  }

  return { kind: 'unsupported', logicalName, message: '此文件类型暂不支持内置预览，请使用系统默认程序打开。' }
}
