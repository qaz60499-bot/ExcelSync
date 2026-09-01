import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureVersionPreviewCopy } from '../src/main/version-cache'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('historical version preview cache', () => {
  it('stores a historical copy outside the sync root and reuses a valid hash-matched cache entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-version-cache-'))
    roots.push(root)
    const bytes = new TextEncoder().encode('version-one')
    let downloads = 0
    const input = {
      cacheRoot: join(root, 'cache', 'version-preview'),
      fileId: '11111111-1111-4111-8111-111111111111',
      version: 1,
      logicalName: 'book.xlsx',
      expectedHash: hash(bytes),
      fetchBytes: async () => {
        downloads += 1
        return bytes
      }
    }

    const first = await ensureVersionPreviewCopy(input)
    const second = await ensureVersionPreviewCopy(input)

    expect(first.path).toContain(join('cache', 'version-preview'))
    expect(first.path).toContain('历史版本 V1')
    expect(second.path).toBe(first.path)
    expect(downloads).toBe(1)
    expect(new Uint8Array(await readFile(first.path))).toEqual(bytes)
    expect((await stat(first.path)).mode & 0o222).toBe(0)
  })

  it('discards a corrupt cached copy and downloads the version again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-version-cache-'))
    roots.push(root)
    const bytes = new TextEncoder().encode('trusted-version')
    let downloads = 0
    const input = {
      cacheRoot: join(root, 'cache'),
      fileId: '22222222-2222-4222-8222-222222222222',
      version: 3,
      logicalName: 'notes.txt',
      expectedHash: hash(bytes),
      fetchBytes: async () => {
        downloads += 1
        return bytes
      }
    }

    const first = await ensureVersionPreviewCopy(input)
    await chmod(first.path, 0o666)
    await writeFile(first.path, 'tampered')
    const second = await ensureVersionPreviewCopy(input)

    expect(downloads).toBe(2)
    expect(await readFile(second.path, 'utf8')).toBe('trusted-version')
  })

  it('rejects downloaded bytes whose hash does not match version metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-version-cache-'))
    roots.push(root)
    const expected = new TextEncoder().encode('expected')
    const wrong = new TextEncoder().encode('wrong')
    await expect(ensureVersionPreviewCopy({
      cacheRoot: join(root, 'cache'),
      fileId: '33333333-3333-4333-8333-333333333333',
      version: 9,
      logicalName: 'report.pdf',
      expectedHash: hash(expected),
      fetchBytes: async () => wrong
    })).rejects.toThrow('VERSION_HASH_MISMATCH')
    await expect(stat(join(root, 'cache', '33333333-3333-4333-8333-333333333333', 'V9'))).rejects.toThrow()
  })
})
