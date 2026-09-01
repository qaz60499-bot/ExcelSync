import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertSupportedFileSignature, isExcelTempFile, isManagedFile, isOfficeLockFile, officeLockTargetPath, sha256File, waitForStableReadableFile } from '../src/main/file-utils'
import { ExcelWatcher } from '../src/main/watcher'
import { FILE_CATEGORY_LABELS, FILE_PARTITIONS, fileCategoryForName, filePartitionForName, filePartitionLabel, mimeForFileName } from '../src/shared/file-types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('file utilities', () => {
  it('filters Excel lock/temp files and maps Office lock files back to the real workbook', () => {
    expect(isExcelTempFile('~$book.xlsx')).toBe(true)
    expect(isOfficeLockFile('D:/sync/~$book.xlsx')).toBe(true)
    expect(officeLockTargetPath('D:/sync/~$book.xlsx')?.replaceAll('\\', '/')).toBe('D:/sync/book.xlsx')
    expect(isOfficeLockFile('D:/sync/~$notes.docx')).toBe(false)
    expect(isManagedFile('~$book.xlsx')).toBe(false)
    expect(isManagedFile('book.tmp')).toBe(false)
  })

  it('accepts the supported SaaS file families including Windows executables while rejecting unsupported scripts', () => {
    for (const name of ['book.xlsx', 'MACRO.XLSM', 'legacy.xls', 'data.csv', 'report.pdf', 'letter.docx', 'bundle.zip', 'data.json', 'slides.pptx', 'photo.webp', 'program.exe']) {
      expect(isManagedFile(name)).toBe(true)
    }
    expect(isManagedFile('script.ps1')).toBe(false)
  })

  it('classifies files and returns stable MIME types from the shared registry', () => {
    expect(fileCategoryForName('report.pdf')).toBe('document')
    expect(FILE_CATEGORY_LABELS[fileCategoryForName('table.csv')!]).toBe('表格')
    expect(mimeForFileName('archive.zip')).toBe('application/zip')
    expect(mimeForFileName('slides.pptx')).toContain('presentationml')
  })

  it('exposes explicit UI partitions for Excel, PDF, ZIP, JSON and other common formats', () => {
    expect(filePartitionForName('book.xlsm')).toBe('excel')
    expect(filePartitionForName('report.pdf')).toBe('pdf')
    expect(filePartitionForName('bundle.zip')).toBe('zip')
    expect(filePartitionForName('events.jsonl')).toBe('json')
    expect(filePartitionLabel('report.pdf')).toBe('PDF')
    expect(filePartitionForName('installer.exe')).toBe('executable')
    expect(FILE_PARTITIONS.map((item) => item.label)).toEqual(expect.arrayContaining(['Excel', 'PDF', 'ZIP', 'JSON', 'PPTX', '图片', 'EXE']))
  })

  it('rejects spoofed files and accepts matching PDF, Office and EXE headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-signature-'))
    roots.push(root)
    const pdf = join(root, 'report.pdf')
    const docx = join(root, 'letter.docx')
    const exe = join(root, 'installer.exe')
    await writeFile(pdf, Buffer.from('%PDF-1.7\n'))
    await writeFile(docx, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))
    await writeFile(exe, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3]))
    await expect(assertSupportedFileSignature(pdf)).resolves.toBeUndefined()
    await expect(assertSupportedFileSignature(docx)).resolves.toBeUndefined()
    await expect(assertSupportedFileSignature(exe)).resolves.toBeUndefined()
    await writeFile(pdf, Buffer.from('not really a PDF'))
    await expect(assertSupportedFileSignature(pdf)).rejects.toThrow('FILE_SIGNATURE_MISMATCH')
  })

  it('computes deterministic SHA256', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-file-'))
    roots.push(root)
    const path = join(root, 'book.xlsx')
    await writeFile(path, Buffer.from('excel-v1'))
    expect(await sha256File(path)).toBe('86b2f35fdd6576cf490eb3fc990d7685483cf7edcc63011dc450bf5fdfacd076')
  })

  it('waits until a file is stable and readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-stable-'))
    roots.push(root)
    const path = join(root, 'book.xlsx')
    await writeFile(path, Buffer.alloc(128, 7))
    const stable = await waitForStableReadableFile(path, { stableMs: 5, attempts: 4 })
    expect(stable.size).toBe(128)
    expect(stable.mtimeMs).toBeGreaterThan(0)
  })

  it('handles Unicode, emoji, spaces and a deep directory with deterministic hashing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-unicode-'))
    roots.push(root)
    const directory = join(root, ...Array.from({ length: 18 }, (_, i) => `层级 ${i}`))
    await mkdir(directory, { recursive: true })
    const path = join(directory, '财务 📊 终稿.xlsx')
    await writeFile(path, Buffer.from('same-content'))
    const first = await sha256File(path)
    const stable = await waitForStableReadableFile(path, { stableMs: 5, attempts: 4 })
    expect(first).toBe(await sha256File(path))
    expect(stable.size).toBe(Buffer.byteLength('same-content'))
  })

  it('reads a read-only managed file without corrupting stability detection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-readonly-'))
    roots.push(root)
    const path = join(root, 'readonly.xlsx')
    await writeFile(path, Buffer.alloc(64, 3))
    await chmod(path, 0o444)
    const stable = await waitForStableReadableFile(path, { stableMs: 5, attempts: 4 })
    expect(stable.size).toBe(64)
  })

  it('fails deterministically when a file disappears before stability is established', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-disappear-'))
    roots.push(root)
    const path = join(root, 'gone.xlsx')
    await expect(waitForStableReadableFile(path, { stableMs: 5, attempts: 2 })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('debounces duplicate watcher add/change events into one ready callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-watcher-'))
    roots.push(root)
    const ready: string[] = []
    const watcher = new ExcelWatcher({
      async onFileReady(path) { ready.push(path) },
      async onFileDeleted() {}
    })
    try {
      await watcher.start(root)
      const path = join(root, 'duplicate.xlsx')
      await writeFile(path, Buffer.from('v1'))
      await new Promise((resolve) => setTimeout(resolve, 100))
      await writeFile(path, Buffer.from('v2'))
      await writeFile(path, Buffer.from('v3'))
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(ready.filter((item) => item === path)).toHaveLength(1)
    } finally {
      await watcher.stop()
    }
  })
})
