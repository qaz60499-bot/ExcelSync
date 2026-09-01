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
})
