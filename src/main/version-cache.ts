import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Dirent } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CACHE_MAX_BYTES = 512 * 1024 * 1024

type CacheEntry = { path: string; size: number; mtimeMs: number }

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function safeName(input: string): string {
  const cleaned = basename(input).replace(/[\\/:*?"<>|]/g, '_').trim()
  return cleaned || 'historical-version.bin'
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

async function removeCacheFile(path: string): Promise<void> {
  await chmod(path, 0o666).catch(() => undefined)
  await rm(path, { force: true })
}

async function collectFiles(root: string): Promise<CacheEntry[]> {
  const result: CacheEntry[] = []
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()!
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(path)
      } else if (entry.isFile()) {
        const info = await stat(path)
        result.push({ path, size: info.size, mtimeMs: info.mtimeMs })
      }
    }
  }
  return result
}

export async function pruneVersionPreviewCache(cacheRoot: string): Promise<void> {
  await mkdir(cacheRoot, { recursive: true })
  const now = Date.now()
  const entries = await collectFiles(cacheRoot)
  for (const entry of entries) {
    if (now - entry.mtimeMs > CACHE_TTL_MS) await removeCacheFile(entry.path)
  }

  const remaining = (await collectFiles(cacheRoot)).sort((a, b) => a.mtimeMs - b.mtimeMs)
  let total = remaining.reduce((sum, entry) => sum + entry.size, 0)
  for (const entry of remaining) {
    if (total <= CACHE_MAX_BYTES) break
    await removeCacheFile(entry.path)
    total -= entry.size
  }
}

export async function clearVersionPreviewCache(cacheRoot: string): Promise<void> {
  for (const entry of await collectFiles(cacheRoot)) await chmod(entry.path, 0o666).catch(() => undefined)
  await rm(cacheRoot, { recursive: true, force: true })
}

export async function ensureVersionPreviewCopy(input: {
  cacheRoot: string
  fileId: string
  version: number
  logicalName: string
  expectedHash: string | null
  fetchBytes?: () => Promise<Uint8Array>
  fetchToPath?: (path: string) => Promise<void>
}): Promise<{ path: string; hash: string }> {
  const versionDir = join(input.cacheRoot, input.fileId, `V${input.version}`)
  await mkdir(versionDir, { recursive: true })
  const original = safeName(input.logicalName)
  const dot = original.lastIndexOf('.')
  const historyName = dot > 0
    ? `${original.slice(0, dot)} (历史版本 V${input.version})${original.slice(dot)}`
    : `${original} (历史版本 V${input.version})`
  const target = join(versionDir, historyName)

  try {
    const info = await stat(target)
    if (info.isFile()) {
      const currentHash = await hashFile(target)
      if (!input.expectedHash || currentHash.toLowerCase() === input.expectedHash.toLowerCase()) {
        await chmod(target, 0o444)
        const now = new Date()
        await utimes(target, now, now).catch(() => undefined)
        return { path: target, hash: currentHash }
      }
      await removeCacheFile(target)
    }
  } catch {
    // Cache miss.
  }

  const temporary = `${target}.${randomUUID()}.tmp`
  let downloadedHash: string
  if (input.fetchToPath) {
    await input.fetchToPath(temporary)
    downloadedHash = await hashFile(temporary)
  } else if (input.fetchBytes) {
    const bytes = await input.fetchBytes()
    downloadedHash = sha256(bytes)
    await writeFile(temporary, bytes)
  } else {
    throw new Error('VERSION_FETCHER_REQUIRED')
  }
  if (input.expectedHash && downloadedHash.toLowerCase() !== input.expectedHash.toLowerCase()) {
    await rm(temporary, { force: true }).catch(() => undefined)
    await rm(versionDir, { recursive: true, force: true })
    throw new Error('VERSION_HASH_MISMATCH')
  }

  await rename(temporary, target)
  await chmod(target, 0o444)
  await pruneVersionPreviewCache(input.cacheRoot)
  return { path: target, hash: downloadedHash }
}
