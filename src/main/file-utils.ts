import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { fileTypeForName, isSupportedFileName, matchesExpectedFileSignature } from '../shared/file-types'
import { TELEGRAM_USER_GROUP_CAPABILITIES } from '../shared/storage-capabilities'

export const MAX_SYNC_FILE_BYTES = TELEGRAM_USER_GROUP_CAPABILITIES.maxReliableFileBytes

export function isTemporarySyncFile(path: string): boolean {
  const name = basename(path)
  const lower = name.toLowerCase()
  return name.startsWith('~$') || lower.endsWith('.tmp') || name.startsWith('.~') || name.endsWith('~') || lower.endsWith('.part') || lower.endsWith('.crdownload')
}

/** Backward-compatible name kept for existing callers/tests. */
export const isExcelTempFile = isTemporarySyncFile

export function isOfficeLockFile(path: string): boolean {
  const name = basename(path)
  if (!name.startsWith('~$') || name.length <= 2) return false
  return ['.xlsx', '.xls', '.xlsm', '.xlsb'].includes(extname(name).toLowerCase())
}

export function officeLockTargetPath(path: string): string | null {
  if (!isOfficeLockFile(path)) return null
  return join(dirname(path), basename(path).slice(2))
}

export function isManagedFile(path: string): boolean {
  return !isTemporarySyncFile(path) && isSupportedFileName(path)
}

/** Backward-compatible alias while the product transitions from Excel-only naming. */
export const isManagedExcelFile = isManagedFile

export async function assertSupportedFileSignature(path: string): Promise<void> {
  const type = fileTypeForName(path)
  if (!type) throw new Error('UNSUPPORTED_FILE_TYPE')
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)
    if (!matchesExpectedFileSignature(path, bytes)) throw new Error('FILE_SIGNATURE_MISMATCH')
  } finally {
    await handle.close()
  }
}

export async function readTextPreview(path: string, maxBytes = 128 * 1024): Promise<string | null> {
  const type = fileTypeForName(path)
  if (!type || !['text', 'structured-text'].includes(type.parser)) return null
  const bytes = await readFile(path)
  return bytes.subarray(0, Math.min(bytes.length, maxBytes)).toString('utf8')
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

export interface StableFile {
  size: number
  mtimeMs: number
}

export async function waitForStableReadableFile(
  path: string,
  options: { stableMs?: number; attempts?: number } = {}
): Promise<StableFile> {
  const stableMs = options.stableMs ?? 700
  const attempts = options.attempts ?? 12
  let previous: { size: number; mtimeMs: number } | null = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const info = await stat(path)
      if (!info.isFile()) throw new Error('NOT_A_FILE')
      if (info.size > MAX_SYNC_FILE_BYTES) throw new Error('FILE_TOO_LARGE')
      const handle = await open(path, 'r')
      await handle.close()
      const current = { size: info.size, mtimeMs: info.mtimeMs }
      if (previous && previous.size === current.size && previous.mtimeMs === current.mtimeMs) return current
      previous = current
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOENT') throw error
      if (code === 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, stableMs))
  }
  throw new Error('FILE_NOT_STABLE')
}
