import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { previewLocalFile } from '../src/main/preview'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'excelsync-preview-'))
})

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe('local file preview', () => {
  it('previews XLSX sheets with bounded rows and sheet switching', async () => {
    const path = join(root, 'book.xlsx')
    const workbook = new ExcelJS.Workbook()
    const first = workbook.addWorksheet('嘉兴')
    first.addRow(['企业', '地区', '数量'])
    first.addRow(['A公司', '浙江省嘉兴市', 12])
    const second = workbook.addWorksheet('温州')
    second.addRow(['企业', '地区'])
    second.addRow(['B公司', '浙江省温州市'])
    await workbook.xlsx.writeFile(path)

    const preview = await previewLocalFile(path, 'book.xlsx', '温州')
    expect(preview.kind).toBe('spreadsheet')
    if (preview.kind !== 'spreadsheet') return
    expect(preview.sheetNames).toEqual(['嘉兴', '温州'])
    expect(preview.selectedSheet).toBe('温州')
    expect(preview.sheet?.rowCount).toBe(2)
    expect(preview.sheet?.columnCount).toBe(2)
    expect(preview.sheet?.rows[1]).toEqual(['B公司', '浙江省温州市'])
  })

  it('previews CSV as a spreadsheet', async () => {
    const path = join(root, 'items.csv')
    await writeFile(path, 'name,region\nalpha,嘉兴\nbeta,温州\n', 'utf8')
    const preview = await previewLocalFile(path, 'items.csv')
    expect(preview.kind).toBe('spreadsheet')
    if (preview.kind !== 'spreadsheet') return
    expect(preview.sheet?.rows[0]).toEqual(['name', 'region'])
    expect(preview.sheet?.rows[2]).toEqual(['beta', '温州'])
  })

  it('previews TXT as plain text', async () => {
    const path = join(root, 'notes.txt')
    await writeFile(path, '第一行\n第二行', 'utf8')
    const preview = await previewLocalFile(path, 'notes.txt')
    expect(preview.kind).toBe('text')
    if (preview.kind !== 'text') return
    expect(preview.format).toBe('plain')
    expect(preview.text).toContain('第二行')
  })

  it('formats JSON for readable text preview', async () => {
    const path = join(root, 'data.json')
    await writeFile(path, '{"region":"嘉兴","count":3}', 'utf8')
    const preview = await previewLocalFile(path, 'data.json')
    expect(preview.kind).toBe('text')
    if (preview.kind !== 'text') return
    expect(preview.format).toBe('json')
    expect(preview.text).toContain('\n  "region": "嘉兴"')
  })

  it('returns image bytes for inline PNG preview', async () => {
    const path = join(root, 'pixel.png')
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nMsAAAAASUVORK5CYII=', 'base64')
    await writeFile(path, png)
    const preview = await previewLocalFile(path, 'pixel.png')
    expect(preview.kind).toBe('binary')
    if (preview.kind !== 'binary') return
    expect(preview.media).toBe('image')
    expect(preview.mimeType).toBe('image/png')
    expect(preview.base64.length).toBeGreaterThan(20)
  })

  it('returns PDF bytes for Chromium PDF preview', async () => {
    const path = join(root, 'sample.pdf')
    await writeFile(path, Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF'))
    const preview = await previewLocalFile(path, 'sample.pdf')
    expect(preview.kind).toBe('binary')
    if (preview.kind !== 'binary') return
    expect(preview.media).toBe('pdf')
    expect(preview.mimeType).toBe('application/pdf')
    expect(Buffer.from(preview.base64, 'base64').subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('lists ZIP entries without extracting the archive', async () => {
    const path = join(root, 'data.zip')
    const zip = new JSZip()
    zip.file('a.xlsx', 'fake')
    zip.folder('nested')?.file('readme.txt', 'hello')
    await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))

    const preview = await previewLocalFile(path, 'data.zip')
    expect(preview.kind).toBe('zip')
    if (preview.kind !== 'zip') return
    expect(preview.entries.map((entry) => entry.name)).toContain('a.xlsx')
    expect(preview.entries.map((entry) => entry.name)).toContain('nested/readme.txt')
  })

  it('returns an explicit message for legacy Excel formats instead of failing silently', async () => {
    const path = join(root, 'legacy.xls')
    await writeFile(path, Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
    const preview = await previewLocalFile(path, 'legacy.xls')
    expect(preview.kind).toBe('unsupported')
    if (preview.kind !== 'unsupported') return
    expect(preview.message).toContain('Excel')
  })
})
