import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { StorageBackend } from '../shared/storage-capabilities'
import type { TelegramUserStorageReceipt } from '../shared/contracts'
import { ApiError, type WorkerApi } from './api'
import { sha256File } from './file-utils'
import type { TelegramUserStorageProvider } from './telegram-user-storage'

export interface DesktopStorageReference {
  backend: StorageBackend
  locator: string
  hash: string | null
  size: number | null
  version: number
}

function parseLocator(locator: string): { chatId: string; messageId: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(locator)
  } catch {
    throw new Error('STORAGE_LOCATOR_INVALID')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('STORAGE_LOCATOR_INVALID')
  const value = parsed as Record<string, unknown>
  const chatId = String(value.chatId ?? '')
  const messageId = Number(value.messageId)
  if (!chatId || !Number.isSafeInteger(messageId) || messageId <= 0) throw new Error('STORAGE_LOCATOR_INVALID')
  return { chatId, messageId }
}

function referenceFromApiError(error: ApiError): DesktopStorageReference | null {
  if (error.code !== 'DESKTOP_STORAGE_REQUIRED' || !error.detail || typeof error.detail !== 'object') return null
  const detail = error.detail as Record<string, unknown>
  if (detail.backend !== 'telegram_user_group' || typeof detail.locator !== 'string') return null
  return {
    backend: 'telegram_user_group',
    locator: detail.locator,
    hash: typeof detail.hash === 'string' ? detail.hash : null,
    size: detail.size == null ? null : Number(detail.size),
    version: Number(detail.version ?? 0)
  }
}

async function atomicReplace(tempPath: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  const backup = `${destination}.excelsync-backup-${randomUUID()}`
  let backedUp = false
  try {
    try {
      await rename(destination, backup)
      backedUp = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(tempPath, destination)
    if (backedUp) await rm(backup, { force: true })
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    if (backedUp) {
      await rename(backup, destination).catch(() => undefined)
    }
    throw error
  }
}

export class DesktopStorageRouter {
  constructor(
    private readonly api: WorkerApi,
    private readonly telegramUser: TelegramUserStorageProvider
  ) {}

  async upload(backend: StorageBackend, localPath: string, expectedHash: string): Promise<TelegramUserStorageReceipt | null> {
    if (backend === 'telegram_user_group') return this.telegramUser.upload(localPath, expectedHash)
    if (backend === 'telegram_bot') return null
    throw new Error('STORAGE_BACKEND_UNSUPPORTED')
  }

  async downloadTelegramMessageTo(input: { chatId: string; messageId: number; size?: number | null; sha256?: string | null }, destination: string): Promise<{ hash: string; size: number }> {
    const tempPath = `${destination}.excelsync-download-${randomUUID()}`
    await mkdir(dirname(tempPath), { recursive: true })
    await this.telegramUser.download({ chatId: input.chatId, messageId: input.messageId }, tempPath, { size: input.size, sha256: input.sha256, fileName: basename(destination) })
    const info = await stat(tempPath)
    const hash = input.sha256 ?? await sha256File(tempPath)
    await atomicReplace(tempPath, destination)
    return { hash, size: info.size }
  }

  async downloadCurrentTo(fileId: string, destination: string): Promise<{ version: number; hash: string | null; size: number; backend: StorageBackend; locator: string | null }> {
    try {
      const remote = await this.api.downloadCurrent(fileId)
      const tempPath = `${destination}.excelsync-download-${randomUUID()}`
      await mkdir(dirname(tempPath), { recursive: true })
      await writeFile(tempPath, remote.bytes)
      if (remote.hash) {
        const actual = await sha256File(tempPath)
        if (actual.toLowerCase() !== remote.hash.toLowerCase()) {
          await rm(tempPath, { force: true })
          throw new Error('DOWNLOAD_HASH_MISMATCH')
        }
      }
      const info = await stat(tempPath)
      await atomicReplace(tempPath, destination)
      return { version: remote.version, hash: remote.hash, size: info.size, backend: 'telegram_bot', locator: null }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      const reference = referenceFromApiError(error)
      if (!reference) throw error
      return this.downloadUserReferenceTo(reference, destination)
    }
  }

  async downloadVersionTo(fileId: string, version: number, destination: string): Promise<{ version: number; hash: string | null; size: number; backend: StorageBackend; locator: string | null }> {
    try {
      const remote = await this.api.downloadVersion(fileId, version)
      const tempPath = `${destination}.excelsync-download-${randomUUID()}`
      await mkdir(dirname(tempPath), { recursive: true })
      await writeFile(tempPath, remote.bytes)
      if (remote.hash) {
        const actual = await sha256File(tempPath)
        if (actual.toLowerCase() !== remote.hash.toLowerCase()) {
          await rm(tempPath, { force: true })
          throw new Error('DOWNLOAD_HASH_MISMATCH')
        }
      }
      const info = await stat(tempPath)
      await atomicReplace(tempPath, destination)
      return { version: remote.version, hash: remote.hash, size: info.size, backend: 'telegram_bot', locator: null }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      const reference = referenceFromApiError(error)
      if (!reference) throw error
      return this.downloadUserReferenceTo({ ...reference, version: reference.version || version }, destination)
    }
  }

  async downloadVersionBytes(fileId: string, version: number, tempRoot: string): Promise<{ bytes: Uint8Array; version: number; hash: string | null }> {
    try {
      return await this.api.downloadVersion(fileId, version)
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      const reference = referenceFromApiError(error)
      if (!reference) throw error
      const path = join(tempRoot, `v-${version}-${randomUUID()}.bin`)
      const downloaded = await this.downloadUserReferenceTo(reference, path)
      try {
        return { bytes: new Uint8Array(await readFile(path)), version: downloaded.version, hash: downloaded.hash }
      } finally {
        await rm(path, { force: true }).catch(() => undefined)
      }
    }
  }

  private async downloadUserReferenceTo(reference: DesktopStorageReference, destination: string): Promise<{ version: number; hash: string | null; size: number; backend: StorageBackend; locator: string | null }> {
    const locator = parseLocator(reference.locator)
    const tempPath = `${destination}.excelsync-download-${randomUUID()}`
    await mkdir(dirname(tempPath), { recursive: true })
    await this.telegramUser.download(locator, tempPath, { size: reference.size, sha256: reference.hash, fileName: basename(destination) })
    const info = await stat(tempPath)
    const hash = reference.hash ?? await sha256File(tempPath)
    await atomicReplace(tempPath, destination)
    return { version: reference.version, hash, size: info.size, backend: reference.backend, locator: reference.locator }
  }
}
