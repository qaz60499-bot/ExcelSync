import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPathWithinRoot, resolveWithinRoot, safeRelativePath } from '../src/main/path-security'

describe('Windows path security', () => {
  const root = 'D:\\ExcelSync\\sync'

  it('rejects absolute, drive-qualified, UNC and traversal paths', () => {
    for (const value of [
      'C:/outside/file.xlsx',
      'C:\\outside\\file.xlsx',
      '\\\\server\\share\\file.xlsx',
      '/absolute/file.xlsx',
      '../outside/file.xlsx',
      'safe/../outside.xlsx',
      'safe/report.xlsx:hidden',
      'safe/CON.xlsx',
      'safe/NUL',
      'safe/trailing-dot.xlsx.',
      'safe/trailing-space.xlsx '
    ]) {
      expect(() => safeRelativePath(value), value).toThrow('PATH_REJECTED')
    }
  })

  it('resolves accepted paths only inside the configured root', () => {
    const value = resolveWithinRoot(root, '客户资料/2026/report.xlsx')
    expect(isPathWithinRoot(root, value)).toBe(true)
    expect(value.toLowerCase()).toContain('excelsync\\sync')
  })

  it('does not confuse a path prefix with containment', () => {
    expect(isPathWithinRoot('D:\\data\\sync', 'D:\\data\\sync-other\\file.xlsx')).toBe(false)
    expect(isPathWithinRoot('D:\\data\\sync', 'D:\\data\\sync\\file.xlsx')).toBe(true)
  })

  it('accepts Unicode, emoji and spaces while rejecting Windows device-like edge cases', () => {
    expect(safeRelativePath('客户 资料/📊 Q3/预算表.xlsx')).toBe('客户 资料/📊 Q3/预算表.xlsx')
    for (const value of ['aux.xlsx', 'PRN.txt', 'LPT1.xlsx', 'COM9.csv', 'name.. ', 'folder//file.xlsx']) {
      expect(() => safeRelativePath(value), value).toThrow('PATH_REJECTED')
    }
  })

  it('rejects an existing symlink or junction segment that would escape the managed root', () => {
    const base = mkdtempSync(join(tmpdir(), 'excelsync-path-security-'))
    const rootDir = join(base, 'root')
    const outside = join(base, 'outside')
    mkdirSync(rootDir)
    mkdirSync(outside)
    writeFileSync(join(outside, 'outside.xlsx'), 'not-real-excel')
    const link = join(rootDir, 'link')
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => resolveWithinRoot(rootDir, 'link/outside.xlsx')).toThrow('PATH_REJECTED')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
