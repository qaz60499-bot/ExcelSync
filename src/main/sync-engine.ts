import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { SettingsView, TelegramUserStorageReceipt } from '../shared/contracts'
import type { StorageBackend } from '../shared/storage-capabilities'
import { ApiError, type WorkerApi } from './api'
import { type LocalDb, type LocalFileRow, type PendingRow } from './db'
import { assertSupportedFileSignature, isManagedFile, officeLockTargetPath, sha256File, waitForStableReadableFile } from './file-utils'
import { ExcelWatcher } from './watcher'
import type { DesktopStorageRouter } from './desktop-storage-router'
import type { TelegramUserStorageProvider } from './telegram-user-storage'

export interface SyncEngineCallbacks {
  onStateChanged?(): void
  canSyncCloud?(): Promise<boolean>
}

function conflictName(path: string): string {
  const extension = extname(path)
  const stem = basename(path, extension)
  const now = new Date()
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-') + ` ${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  return join(dirname(path), `${stem} (conflict ${stamp})${extension}`)
}

export class SyncEngine {
  private watcher: ExcelWatcher
  private root = ''
  private timer: NodeJS.Timeout | null = null
  private remoteTimer: NodeJS.Timeout | null = null
  private pumping = false
  private readonly activeFiles = new Set<string>()
  private readonly activeJobs = new Map<string, Promise<void>>()
  private readonly maxConcurrentJobs = 3
  private dispatchCounter = 0
  private pullingRemote = false
  private shutdownDraining = false
  private paused = false
  private stopped = true
  private cloudAccessEnabled = true
  private presenceTimer: NodeJS.Timeout | null = null
  private readonly presenceFiles = new Map<string, 'OPEN' | 'EDITING'>()
  private readonly fileLeases = new Map<string, string>()
  private readonly priorityHints = new Map<string, { priority: number; expiresAt: number }>()
  private readonly storageBackendHints = new Map<string, { backend: StorageBackend; expiresAt: number }>()
  private readonly suppressed = new Map<string, number>()

  constructor(
    private readonly db: LocalDb,
    private readonly api: WorkerApi,
    private readonly callbacks: SyncEngineCallbacks = {},
    private readonly storage?: DesktopStorageRouter,
    private readonly telegramUser?: TelegramUserStorageProvider
  ) {
    this.watcher = new ExcelWatcher({
      onFileReady: (path) => this.handleFileReady(path),
      onFileDeleted: (path) => this.handleFileDeleted(path),
      onOfficeLock: (path, active) => this.handleOfficeLock(path, active),
      onWatcherError: (error) => this.db.log('WATCHER_ERROR', null, error.message)
    })
  }

  async start(settings: SettingsView): Promise<void> {
    this.stopped = false
    this.db.setSettings(settings)
    this.paused = !settings.autoSync
    await this.setDirectory(settings.syncDirectory)
    if (!this.timer) {
      this.timer = setInterval(() => void this.processOne(), 2000)
    }
    if (!this.remoteTimer) {
      this.remoteTimer = setInterval(() => void this.pullRemoteChanges(), 15_000)
    }
    if (!this.presenceTimer) {
      this.presenceTimer = setInterval(() => void this.refreshPresence(), 25_000)
    }
    if (!this.paused) {
      void this.processOne()
      void this.pullRemoteChanges()
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.remoteTimer) clearInterval(this.remoteTimer)
    if (this.presenceTimer) clearInterval(this.presenceTimer)
    this.timer = null
    this.remoteTimer = null
    this.presenceTimer = null
    const activePresence = [...this.presenceFiles.keys()]
    const activeLeases = [...this.fileLeases.entries()]
    this.presenceFiles.clear()
    this.fileLeases.clear()
    await Promise.all([
      ...activeLeases.map(([fileId, leaseId]) => this.api.releaseFileLease(fileId, leaseId).catch(() => undefined)),
      ...activePresence.map((fileId) => this.api.clearFilePresence(fileId).catch(() => undefined))
    ])
    await this.watcher.stop()
  }

  async setDirectory(directory: string): Promise<void> {
    const next = directory ? resolve(directory) : ''
    if (next === this.root) return
    await this.watcher.stop()
    this.root = next
    if (this.root) {
      await mkdir(this.root, { recursive: true })
      await this.watcher.start(this.root)
      this.db.log('WATCHER_STARTED', null, this.root)
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    this.db.log(paused ? 'SYNC_PAUSED' : 'SYNC_RESUMED', null)
    this.callbacks.onStateChanged?.()
    if (!paused) {
      void this.processOne()
      void this.pullRemoteChanges()
    }
  }

  isPaused(): boolean {
    return this.paused
  }

  setCloudAccessEnabled(enabled: boolean): void {
    this.cloudAccessEnabled = enabled
    if (!enabled) return
    if (!this.paused && !this.stopped) {
      void this.processOne()
      void this.pullRemoteChanges()
      void this.refreshPresence()
    }
  }

  async noteFileOpened(fileId: string): Promise<void> {
    if (!this.cloudAccessEnabled || this.paused || this.stopped) return
    try {
      await this.api.setFilePresence(fileId, 'OPEN')
    } catch (error) {
      if (!(error instanceof ApiError) || !['AUTH_REQUIRED', 'INVALID_SESSION', 'DEVICE_REGISTRATION_REQUIRED'].includes(error.code)) {
        this.db.log('PRESENCE_OPEN_ERROR', fileId, error instanceof Error ? error.message : String(error))
      }
    }
  }

  private async handleOfficeLock(lockPath: string, active: boolean): Promise<void> {
    const targetPath = officeLockTargetPath(lockPath)
    if (!targetPath) return
    const relativePath = this.relativePath(targetPath)
    if (!relativePath) return
    const file = this.db.getFileByPath(relativePath)
    if (!file || file.current_version <= 0) return
    if (!active) {
      this.presenceFiles.delete(file.id)
      const leaseId = this.fileLeases.get(file.id)
      this.fileLeases.delete(file.id)
      if (this.cloudAccessEnabled) {
        if (leaseId) await this.api.releaseFileLease(file.id, leaseId).catch(() => undefined)
        await this.api.clearFilePresence(file.id).catch(() => undefined)
      }
      this.callbacks.onStateChanged?.()
      return
    }
    if (this.cloudAccessEnabled) {
      try {
        const lease = await this.api.acquireFileLease(file.id, this.fileLeases.get(file.id))
        if (lease.leaseId) this.fileLeases.set(file.id, lease.leaseId)
        this.presenceFiles.set(file.id, 'EDITING')
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'FILE_LEASE_ACQUIRE_FAILED'
        this.db.log(code === 'FILE_LOCKED' ? 'FILE_EDIT_LOCKED_BY_OTHER' : 'FILE_LEASE_ERROR', file.id, error instanceof Error ? error.message : String(error))
        this.presenceFiles.delete(file.id)
      }
    }
    this.callbacks.onStateChanged?.()
  }

  private async refreshPresence(): Promise<void> {
    if (!this.cloudAccessEnabled || this.paused || this.stopped || this.presenceFiles.size === 0) return
    for (const [fileId, state] of this.presenceFiles) {
      try {
        const leaseId = this.fileLeases.get(fileId)
        if (state === 'EDITING' && leaseId) {
          const lease = await this.api.heartbeatFileLease(fileId, leaseId)
          if (!lease.currentDevice) throw new ApiError('LEASE_LOST', 409, false)
        } else {
          await this.api.setFilePresence(fileId, state)
        }
      } catch (error) {
        if (error instanceof ApiError && ['AUTH_REQUIRED', 'INVALID_SESSION'].includes(error.code)) return
        if (error instanceof ApiError && ['LEASE_LOST', 'FILE_LOCKED'].includes(error.code)) {
          this.fileLeases.delete(fileId)
          this.presenceFiles.delete(fileId)
          this.db.log('FILE_LEASE_LOST', fileId, error.message)
          continue
        }
        this.db.log('PRESENCE_HEARTBEAT_ERROR', fileId, error instanceof Error ? error.message : String(error))
      }
    }
  }

  private async downloadCurrentTo(fileId: string, destination: string): Promise<{ version: number; hash: string | null; size: number; backend: StorageBackend; locator: string | null }> {
    if (this.storage) return this.storage.downloadCurrentTo(fileId, destination)
    const remote = await this.api.downloadCurrent(fileId)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, remote.bytes)
    const info = await stat(destination)
    return { version: remote.version, hash: remote.hash, size: info.size, backend: 'telegram_bot', locator: null }
  }

  private async downloadVersionTo(fileId: string, version: number, destination: string): Promise<{ version: number; hash: string | null; size: number; backend: StorageBackend; locator: string | null }> {
    if (this.storage) return this.storage.downloadVersionTo(fileId, version, destination)
    const remote = await this.api.downloadVersion(fileId, version)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, remote.bytes)
    const info = await stat(destination)
    return { version: remote.version, hash: remote.hash, size: info.size, backend: 'telegram_bot', locator: null }
  }

  private relativePath(absolutePath: string): string | null {
    if (!this.root) return null
    const normalizedRoot = resolve(this.root)
    const normalizedFile = resolve(absolutePath)
    const rel = relative(normalizedRoot, normalizedFile)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    return rel.replaceAll('\\', '/')
  }

  private isSuppressed(path: string): boolean {
    const until = this.suppressed.get(resolve(path)) ?? 0
    if (until <= Date.now()) {
      this.suppressed.delete(resolve(path))
      return false
    }
    return true
  }

  private suppress(path: string, ms = 2500): void {
    this.suppressed.set(resolve(path), Date.now() + ms)
  }

  hintPathPriority(path: string, priority: number, ttlMs = 30_000): void {
    this.priorityHints.set(resolve(path), {
      priority: Math.min(4, Math.max(0, Math.trunc(priority))),
      expiresAt: Date.now() + ttlMs
    })
  }

  async queueImportedPaths(paths: string[], priority: number, concurrency = 8, storageBackend?: StorageBackend): Promise<void> {
    const normalizedPriority = Math.min(4, Math.max(0, Math.trunc(priority)))
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < paths.length) {
        const index = cursor
        cursor += 1
        const path = paths[index]
        if (!path) continue
        this.hintPathPriority(path, normalizedPriority, 120_000)
        if (storageBackend) this.hintPathStorageBackend(path, storageBackend, 120_000)
        await this.handleFileReady(path, undefined, storageBackend)
        const relativePath = this.relativePath(path)
        const file = relativePath ? this.db.getFileByPath(relativePath) : null
        if (file) {
          this.db.setPendingPriorityForFile(file.id, normalizedPriority)
          if (storageBackend) this.db.setPendingStorageBackendForFile(file.id, storageBackend)
        }
      }
    }
    const workers = Math.max(1, Math.min(concurrency, paths.length || 1))
    await Promise.all(Array.from({ length: workers }, () => worker()))
    if (!this.paused) void this.processOne()
  }

  hintPathStorageBackend(path: string, backend: StorageBackend, ttlMs = 120_000): void {
    this.storageBackendHints.set(resolve(path), { backend, expiresAt: Date.now() + ttlMs })
  }

  private storageBackendForPath(path: string): StorageBackend | undefined {
    const key = resolve(path)
    const hint = this.storageBackendHints.get(key)
    if (!hint) return undefined
    if (hint.expiresAt < Date.now()) {
      this.storageBackendHints.delete(key)
      return undefined
    }
    return hint.backend
  }

  private priorityForPath(path: string): number {
    const key = resolve(path)
    const hint = this.priorityHints.get(key)
    if (!hint) return 0
    this.priorityHints.delete(key)
    return hint.expiresAt >= Date.now() ? hint.priority : 0
  }

  async handleFileReady(path: string, importReceipt?: TelegramUserStorageReceipt, storageBackendOverride?: StorageBackend): Promise<void> {
    if (this.stopped || (!importReceipt && this.isSuppressed(path)) || !isManagedFile(path)) return
    const relativePath = this.relativePath(path)
    if (!relativePath) return
    const priority = this.priorityForPath(path)
    const selectedStorageBackend = storageBackendOverride ?? importReceipt?.backend ?? this.storageBackendForPath(path)

    try {
      const stable = await waitForStableReadableFile(path)
      if (this.stopped) return
      await assertSupportedFileSignature(path)
      const hash = await sha256File(path)
      if (this.stopped) return
      let file = this.db.getFileByPath(relativePath)

      if (!file) {
        const cutoff = new Date(Date.now() - 10_000).toISOString()
        const renamed = this.db.findRecentlyMissingByHash(hash, cutoff)
        if (renamed) {
          this.db.cancelPending(renamed.id, 'DELETE')
          this.db.renameFile(renamed.id, relativePath, basename(path), extname(path).toLowerCase())
          this.db.upsertState(renamed.id, stable.size, stable.mtimeMs, hash, true)
          file = this.db.getFile(renamed.id) ?? renamed
          if (file.current_version > 0 && file.current_hash === hash) {
            this.db.queueRename(file, path, priority)
          } else {
            this.db.cancelPending(file.id)
            const queued = this.db.queueUpsert(file, path, hash, stable.size, priority, selectedStorageBackend)
            if (queued && importReceipt) this.db.setUploadReceipt(queued.id, { ...importReceipt, sha256: hash, size: stable.size })
          }
          this.callbacks.onStateChanged?.()
          if (!this.paused) void this.processOne()
          return
        }

        file = this.db.ensureFile({
          relativePath,
          logicalName: basename(path),
          extension: extname(path).toLowerCase(),
          hash,
          size: stable.size,
          mtimeMs: stable.mtimeMs
        })
      } else {
        this.db.upsertState(file.id, stable.size, stable.mtimeMs, hash, true)
        if (file.cloud_status !== 'active') {
          this.db.log('TRASHED_LOCAL_CHANGE_IGNORED', file.id, relativePath)
          this.callbacks.onStateChanged?.()
          return
        }
      }

      const queued = this.db.queueUpsert(file, path, hash, stable.size, priority, selectedStorageBackend)
      if (queued && importReceipt) this.db.setUploadReceipt(queued.id, { ...importReceipt, sha256: hash, size: stable.size })
      if (queued) this.db.log('FILE_CHANGED', file.id, relativePath)
      this.callbacks.onStateChanged?.()
      if (!this.paused) void this.processOne()
    } catch (error) {
      if (this.stopped) return
      const message = error instanceof Error ? error.message : String(error)
      const code = (error as NodeJS.ErrnoException).code ?? message
      const waitingForRelease = ['FILE_NOT_STABLE', 'EBUSY', 'EPERM', 'EACCES', 'FILE_LOCK_WIN32'].includes(String(code))
      let file = this.db.getFileByPath(relativePath)
      if (!file && waitingForRelease) {
        try {
          const info = await stat(path)
          if (info.isFile()) {
            file = this.db.ensureWaitingFile({
              relativePath,
              logicalName: basename(path),
              extension: extname(path).toLowerCase(),
              size: info.size,
              mtimeMs: info.mtimeMs
            })
          }
        } catch {
          // A transient new file can disappear before the placeholder is recorded.
        }
      }
      if (file && waitingForRelease) {
        const retryAt = new Date(Date.now() + Math.max(3, this.db.getSettings().retryBaseSeconds) * 1000).toISOString()
        this.db.queueWaitingUpsert(file, path, String(code), message, retryAt)
        this.db.setPendingPriorityForFile(file.id, Math.min(2, priority))
        this.db.log('FILE_WAITING_FOR_RELEASE', file.id, relativePath)
        if (!this.paused && this.cloudAccessEnabled) void this.processOne()
      } else {
        this.db.log('FILE_STABILITY_ERROR', file?.id ?? null, `${relativePath}: ${message}`)
      }
      this.callbacks.onStateChanged?.()
    }
  }

  async handleFileDeleted(path: string): Promise<void> {
    if (this.stopped || this.isSuppressed(path)) return
    const relativePath = this.relativePath(path)
    if (!relativePath) return
    const file = this.db.markMissing(relativePath)
    if (!file) return
    if (file.current_version === 0) {
      this.db.log('UNSYNCED_FILE_REMOVED', file.id, relativePath)
      this.db.removeUnsyncedFile(file.id)
    } else {
      this.db.log('LOCAL_COPY_REMOVED', file.id, `${relativePath}; cloud version V${file.current_version} retained`)
    }
    this.callbacks.onStateChanged?.()
  }

  async syncNow(): Promise<void> {
    if (this.paused || this.stopped || !this.cloudAccessEnabled) return
    if (this.callbacks.canSyncCloud && !(await this.callbacks.canSyncCloud())) return
    this.db.boostReadyPending(1)
    await this.pullRemoteChanges()
    for (let completed = 0; completed < 200; completed += 1) {
      await this.processOne()
      const active = [...this.activeJobs.values()]
      if (active.length === 0) {
        if (!this.db.nextReadyPending()) break
        continue
      }
      await Promise.race(active)
    }
    while (this.activeJobs.size > 0) await Promise.race([...this.activeJobs.values()])
    await this.pullRemoteChanges()
  }

  async flushBeforeExit(maxWaitMs = 180_000): Promise<void> {
    if (this.paused || this.stopped || !this.cloudAccessEnabled) return
    if (this.callbacks.canSyncCloud && !(await this.callbacks.canSyncCloud())) return

    this.shutdownDraining = true
    if (this.timer) clearInterval(this.timer)
    if (this.remoteTimer) clearInterval(this.remoteTimer)
    this.timer = null
    this.remoteTimer = null

    const deadline = Date.now() + maxWaitMs
    try {
      while ((this.activeJobs.size > 0 || this.pullingRemote) && Date.now() < deadline) {
        if (this.activeJobs.size > 0) await Promise.race([...this.activeJobs.values()])
        else await new Promise((resolve) => setTimeout(resolve, 50))
      }
      for (let i = 0; i < 200 && Date.now() < deadline; i += 1) {
        const pending = this.db.nextReadyPending()
        if (!pending) break
        this.db.markUploading(pending.id)
        await this.runPending(pending)
      }
    } finally {
      this.shutdownDraining = false
    }
  }

  async syncTelegramUserGroup(): Promise<number> {
    if (!this.telegramUser || !this.storage || !this.root) return 0
    const status = await this.telegramUser.status()
    if (!status.authorized || !status.chatId) return 0
    let checkpoint = this.db.telegramCheckpoint(status.chatId)
    const candidates = await this.telegramUser.catchUp(checkpoint)
    let imported = 0
    for (const candidate of candidates) {
      if (candidate.messageId <= checkpoint) continue
      if (!isManagedFile(candidate.fileName)) {
        checkpoint = candidate.messageId
        this.db.setTelegramCheckpoint(status.chatId, checkpoint)
        continue
      }
      const existing = this.db.getTelegramImport(status.chatId, candidate.messageId)
      if (existing?.status === 'IMPORTED') {
        checkpoint = candidate.messageId
        this.db.setTelegramCheckpoint(status.chatId, checkpoint)
        continue
      }
      if (!existing) this.db.beginTelegramImport({ chatId: status.chatId, messageId: candidate.messageId, fileName: candidate.fileName, size: candidate.size })
      const safeName = basename(candidate.fileName)
      const relativePath = `Telegram Imports/${candidate.messageId}-${safeName}`
      const absolutePath = resolve(this.root, relativePath)
      try {
        this.suppress(absolutePath, 3500)
        const downloaded = await this.storage.downloadTelegramMessageTo({
          chatId: status.chatId,
          messageId: candidate.messageId,
          size: candidate.size
        }, absolutePath)
        const receipt: TelegramUserStorageReceipt = {
          backend: 'telegram_user_group',
          chatId: status.chatId,
          messageId: candidate.messageId,
          fileName: candidate.fileName,
          size: downloaded.size,
          sha256: downloaded.hash,
          mimeType: candidate.mimeType,
          createdAt: candidate.createdAt
        }
        await this.handleFileReady(absolutePath, receipt)
        this.db.completeTelegramImport({ chatId: status.chatId, messageId: candidate.messageId, relativePath, sha256: downloaded.hash })
        checkpoint = candidate.messageId
        this.db.setTelegramCheckpoint(status.chatId, checkpoint)
        imported += 1
      } catch (error) {
        this.db.failTelegramImport(status.chatId, candidate.messageId, error instanceof Error ? error.message : String(error))
        this.db.log('TELEGRAM_USER_IMPORT_ERROR', null, `${candidate.messageId}: ${error instanceof Error ? error.message : String(error)}`)
        break
      }
    }
    if (imported > 0) this.callbacks.onStateChanged?.()
    return imported
  }

  async pullRemoteChanges(): Promise<void> {
    if (this.paused || this.stopped || !this.cloudAccessEnabled || this.pullingRemote || !this.root) return
    if (this.callbacks.canSyncCloud && !(await this.callbacks.canSyncCloud())) return
    this.pullingRemote = true
    try {
      try {
        await this.syncTelegramUserGroup()
      } catch (error) {
        this.db.log('TELEGRAM_USER_CATCHUP_ERROR', null, error instanceof Error ? error.message : String(error))
      }
      try {
        await this.api.pullTelegramImports()
      } catch (error) {
        if (!(error instanceof ApiError) || !['AUTH_REQUIRED', 'INVALID_SESSION', 'TELEGRAM_CHAT_NOT_CONNECTED'].includes(error.code)) {
          throw error
        }
        if (error.code === 'AUTH_REQUIRED' || error.code === 'INVALID_SESSION') return
      }

      const cloudFiles = await this.api.filesList()
      for (const cloud of cloudFiles) {
        if (cloud.current_version <= 0) continue
        const relativePath = cloud.relative_path.replaceAll('\\', '/').replace(/^\/+/, '')
        const segments = relativePath.split('/')
        if (!relativePath || segments.some((part) => !part || part === '.' || part === '..') || !isManagedFile(relativePath)) {
          this.db.log('REMOTE_PATH_REJECTED', cloud.id, cloud.relative_path)
          continue
        }
        const absolutePath = resolve(this.root, relativePath)
        const normalizedRoot = resolve(this.root)
        if (!absolutePath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}\\`)) {
          this.db.log('REMOTE_PATH_REJECTED', cloud.id, cloud.relative_path)
          continue
        }

        let local = this.db.getFile(cloud.id)
        if (cloud.status !== 'active') {
          if (local) {
            this.db.upsertRemoteMetadata({
              id: cloud.id,
              relativePath,
              logicalName: basename(relativePath),
              extension: extname(relativePath).toLowerCase(),
              version: cloud.current_version,
              hash: cloud.current_hash,
              cloudStatus: cloud.status,
              storageBackend: cloud.current_storage_backend,
              storageLocator: cloud.current_storage_locator
            })
          }
          continue
        }
        if (local && ['PENDING', 'UPLOADING', 'RETRY_WAIT'].includes(local.status)) continue
        if (local && local.cloud_status !== 'active') {
          local = this.db.upsertRemoteMetadata({
            id: cloud.id,
            relativePath,
            logicalName: basename(relativePath),
            extension: extname(relativePath).toLowerCase(),
            version: cloud.current_version,
            hash: cloud.current_hash,
            cloudStatus: 'active',
            storageBackend: cloud.current_storage_backend,
            storageLocator: cloud.current_storage_locator
          })
        }
        if (local) {
          let state = this.db.getState(local.id)
          if (state?.exists_flag === 1) {
            try {
              await stat(absolutePath)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                local = this.db.markMissing(relativePath) ?? local
                state = this.db.getState(local.id)
                this.db.log('LOCAL_COPY_MISSING_RECONCILED', local.id, relativePath)
              } else {
                throw error
              }
            }
          }
          if (state?.exists_flag === 0) {
            this.db.upsertRemoteMetadata({
              id: cloud.id,
              relativePath,
              logicalName: basename(relativePath),
              extension: extname(relativePath).toLowerCase(),
              version: cloud.current_version,
              hash: cloud.current_hash,
              cloudStatus: 'active',
              storageBackend: cloud.current_storage_backend,
              storageLocator: cloud.current_storage_locator
            })
            continue
          }
          if (local.current_version >= cloud.current_version && local.current_hash === cloud.current_hash) continue
        }
        const occupied = this.db.getFileByPath(relativePath)
        if (occupied && occupied.id !== cloud.id) {
          this.db.log('REMOTE_PATH_CONFLICT', cloud.id, `${relativePath} occupied by ${occupied.id}`)
          continue
        }

        this.suppress(absolutePath, 3500)
        const remote = await this.downloadCurrentTo(cloud.id, absolutePath)
        const info = await stat(absolutePath)
        const hash = remote.hash ?? (await sha256File(absolutePath))
        this.db.upsertRemoteFile({
          id: cloud.id,
          relativePath,
          logicalName: basename(relativePath),
          extension: extname(relativePath).toLowerCase(),
          version: remote.version || cloud.current_version,
          hash,
          size: info.size,
          mtimeMs: info.mtimeMs,
          storageBackend: remote.backend,
          storageLocator: remote.locator ?? cloud.current_storage_locator
        })
      }
      this.callbacks.onStateChanged?.()
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'AUTH_REQUIRED' || error.code === 'INVALID_SESSION')) return
      this.db.log('REMOTE_PULL_ERROR', null, error instanceof Error ? error.message : String(error))
      this.callbacks.onStateChanged?.()
    } finally {
      this.pullingRemote = false
    }
  }

  private async processOne(): Promise<void> {
    if (this.pumping || this.paused || this.stopped || !this.cloudAccessEnabled || this.shutdownDraining) return
    if (this.callbacks.canSyncCloud && !(await this.callbacks.canSyncCloud())) return
    this.pumping = true
    try {
      while (this.activeJobs.size < this.maxConcurrentJobs) {
        this.dispatchCounter += 1
        const pending = this.db.nextReadyPending([...this.activeFiles], this.dispatchCounter % 10 === 0)
        if (!pending) break
        this.activeFiles.add(pending.file_id)
        this.db.markUploading(pending.id)
        this.callbacks.onStateChanged?.()
        const job = this.runPending(pending).finally(() => {
          this.activeJobs.delete(pending.id)
          this.activeFiles.delete(pending.file_id)
          this.callbacks.onStateChanged?.()
          if (!this.paused && !this.stopped && this.cloudAccessEnabled && !this.shutdownDraining) {
            setTimeout(() => void this.processOne(), 25)
          }
        })
        this.activeJobs.set(pending.id, job)
      }
    } finally {
      this.pumping = false
    }
  }

  private async runPending(pending: PendingRow): Promise<void> {
    try {
      if (pending.operation === 'DELETE') {
        this.db.cancelPending(pending.file_id, 'DELETE')
        this.db.log('LEGACY_DELETE_IGNORED', pending.file_id, 'Local deletion no longer deletes SaaS files')
      } else if (pending.operation === 'RENAME') {
        await this.processRename(pending)
      } else {
        await this.processUpsert(pending)
      }
    } catch (error) {
      await this.handleProcessingError(pending, error)
    }
  }

  private async processUpsert(initialPending: PendingRow): Promise<void> {
    let pending = initialPending
    const file = this.db.getFile(pending.file_id)
    if (!file) throw new Error('LOCAL_FILE_RECORD_MISSING')

    const cachedState = this.db.getState(file.id)
    const canReuseVerifiedSnapshot = Boolean(
      pending.attempt_count === 0 &&
      pending.hash &&
      pending.size !== null &&
      cachedState?.last_hash === pending.hash &&
      cachedState.size === pending.size
    )

    let stable: { size: number; mtimeMs: number }
    let currentHash: string
    let reusedVerifiedSnapshot = false

    if (canReuseVerifiedSnapshot && cachedState) {
      const info = await stat(pending.local_path)
      const sameSnapshot = info.isFile() &&
        info.size === cachedState.size &&
        Math.abs(info.mtimeMs - cachedState.mtime_ms) < 1
      if (sameSnapshot) {
        stable = { size: info.size, mtimeMs: info.mtimeMs }
        currentHash = pending.hash as string
        reusedVerifiedSnapshot = true
      } else {
        stable = await waitForStableReadableFile(pending.local_path)
        currentHash = await sha256File(pending.local_path)
      }
    } else {
      stable = await waitForStableReadableFile(pending.local_path)
      currentHash = await sha256File(pending.local_path)
    }

    await assertSupportedFileSignature(pending.local_path)
    if (!pending.hash || pending.size === null) {
      if (file.current_hash === currentHash) {
        this.db.markPendingNoChange(pending.id)
        this.db.upsertState(file.id, stable.size, stable.mtimeMs, currentHash, true)
        return
      }
      pending = this.db.preparePendingUpload(pending.id, currentHash, stable.size) ?? pending
    }
    if (!pending.hash || pending.size === null) throw new Error('PENDING_UPLOAD_INVALID')
    if (currentHash !== pending.hash || stable.size !== pending.size) {
      this.db.cancelPending(file.id)
      await this.handleFileReady(pending.local_path)
      return
    }

    let preflight
    try {
      preflight = await this.api.preflight({
        fileId: file.id,
        logicalName: file.logical_name,
        relativePath: file.relative_path,
        hash: pending.hash,
        size: pending.size,
        baseVersion: pending.base_version,
        idempotencyKey: pending.idempotency_key,
        storageBackend: pending.storage_backend,
        restoredFromVersion: pending.restored_from_version
      })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await this.createConflict(pending, file, `Preflight conflict: ${error.code}`)
        return
      }
      throw error
    }

    if (preflight.action === 'conflict') {
      await this.createConflict(pending, file, `Cloud advanced to V${preflight.currentVersion}`)
      return
    }
    if (preflight.action === 'noop' || preflight.action === 'committed') {
      if (reusedVerifiedSnapshot) {
        const verifiedHash = await sha256File(pending.local_path)
        if (verifiedHash !== pending.hash) {
          this.db.cancelPending(file.id)
          await this.handleFileReady(pending.local_path)
          return
        }
      }
      this.db.markSynced(pending.id, preflight.currentVersion, preflight.currentHash, pending.size)
      this.db.rebaseQueuedForFile(file.id, preflight.currentVersion)
      return
    }

    const intentId = preflight.intentId
    if (preflight.action === 'upload_required') {
      let receipt: TelegramUserStorageReceipt | null = null
      if (pending.upload_receipt) {
        try {
          receipt = JSON.parse(pending.upload_receipt) as TelegramUserStorageReceipt
        } catch {
          this.db.clearUploadReceipt(pending.id)
        }
      }
      if (!receipt) {
        if (!this.storage) {
          if (pending.storage_backend === 'telegram_user_group') throw new Error('TELEGRAM_USER_STORAGE_UNAVAILABLE')
          await this.api.upload(intentId, pending.local_path)
        } else {
          receipt = await this.storage.upload(pending.storage_backend, pending.local_path, pending.hash)
          if (receipt) this.db.setUploadReceipt(pending.id, receipt)
          else await this.api.upload(intentId, pending.local_path)
        }
      }
      if (receipt) {
        this.db.rememberTelegramUpload({
          chatId: receipt.chatId,
          messageId: receipt.messageId,
          fileName: receipt.fileName,
          size: receipt.size,
          relativePath: file.relative_path,
          sha256: receipt.sha256
        })
        await this.api.recordUploadReceipt(intentId, receipt)
      }
    }
    const committed = await this.api.commit(intentId)
    this.db.markSynced(pending.id, committed.version, committed.hash, pending.size)
    this.db.rebaseQueuedForFile(file.id, committed.version)
  }

  private async processRename(pending: PendingRow): Promise<void> {
    const file = this.db.getFile(pending.file_id)
    if (!file) throw new Error('LOCAL_FILE_RECORD_MISSING')
    await this.api.renameFile(file.id, file.logical_name, file.relative_path, pending.base_version)
    this.db.markRenameSynced(pending.id)
  }

  private async createConflict(pending: PendingRow, file: LocalFileRow, detail: string): Promise<void> {
    const conflictPath = conflictName(pending.local_path)
    this.suppress(conflictPath, 24 * 60 * 60 * 1000)
    await copyFile(pending.local_path, conflictPath)
    let remoteReady = false

    try {
      this.suppress(pending.local_path, 3500)
      const remote = await this.downloadCurrentTo(file.id, pending.local_path)
      const info = await stat(pending.local_path)
      const remoteHash = remote.hash ?? (await sha256File(pending.local_path))
      this.db.updateCloudState(file.id, remote.version, remoteHash, 'SYNCED')
      this.db.upsertState(file.id, info.size, info.mtimeMs, remoteHash, true)
      this.db.log('CONFLICT_REMOTE_RESTORED', file.id, `V${remote.version}`)
      remoteReady = true
    } catch (error) {
      this.db.log('CONFLICT_REMOTE_DOWNLOAD_FAILED', file.id, error instanceof Error ? error.message : String(error))
    }

    this.db.markConflict(pending.id, `${detail}; local copy=${basename(conflictPath)}${remoteReady ? '' : '; remote refresh required'}`)
  }

  async resolveConflict(fileId: string, choice: 'local' | 'cloud' | 'both'): Promise<void> {
    const pending = this.db.getConflictPendingForFile(fileId)
    const file = this.db.getFile(fileId)
    if (!pending || !file || pending.operation !== 'UPSERT') throw new Error('CONFLICT_NOT_FOUND')
    const match = pending.error_message?.match(/local copy=([^;]+)/)
    const conflictBaseName = match?.[1]?.trim()
    if (!conflictBaseName || basename(conflictBaseName) !== conflictBaseName) throw new Error('CONFLICT_COPY_NOT_FOUND')
    const conflictPath = join(dirname(pending.local_path), conflictBaseName)

    this.suppress(pending.local_path, 3500)
    const remote = await this.downloadCurrentTo(file.id, pending.local_path)
    const remoteInfo = await stat(pending.local_path)
    const remoteHash = remote.hash ?? (await sha256File(pending.local_path))
    this.db.updateCloudState(file.id, remote.version, remoteHash, 'CONFLICT')
    this.db.upsertState(file.id, remoteInfo.size, remoteInfo.mtimeMs, remoteHash, true)

    if (choice === 'cloud') {
      this.suppress(conflictPath, 3500)
      await rm(conflictPath, { force: true })
      if (!this.db.cancelPendingById(pending.id)) throw new Error('CONFLICT_NOT_RESOLVED')
      this.db.log('CONFLICT_RESOLVED_CLOUD', file.id, `V${file.current_version}`)
    } else if (choice === 'both') {
      if (!this.db.cancelPendingById(pending.id)) throw new Error('CONFLICT_NOT_RESOLVED')
      this.suppressed.delete(resolve(conflictPath))
      await this.handleFileReady(conflictPath)
      this.db.log('CONFLICT_RESOLVED_BOTH', file.id, conflictBaseName)
    } else {
      await copyFile(conflictPath, pending.local_path)
      this.suppress(conflictPath, 3500)
      await rm(conflictPath, { force: true })
      if (!this.db.cancelPendingById(pending.id)) throw new Error('CONFLICT_NOT_RESOLVED')
      this.suppressed.delete(resolve(pending.local_path))
      await this.handleFileReady(pending.local_path)
      this.db.log('CONFLICT_RESOLVED_LOCAL', file.id, `base=V${file.current_version}`)
    }

    this.callbacks.onStateChanged?.()
    if (!this.paused) void this.processOne()
  }

  private async handleProcessingError(pending: PendingRow, error: unknown): Promise<void> {
    if (error instanceof ApiError) {
      if (error.code === 'AUTH_REQUIRED' || error.code === 'INVALID_SESSION') {
        this.db.markRetry(pending.id, error.code, error.message, new Date(Date.now() + 60 * 60 * 1000).toISOString())
        return
      }
      if (error.status === 409 || error.code === 'BASE_VERSION_CONFLICT') {
        const file = this.db.getFile(pending.file_id)
        if (file && pending.operation === 'UPSERT') {
          await this.createConflict(pending, file, `Commit conflict: ${error.code}`)
        } else {
          this.db.markConflict(pending.id, error.message)
        }
        return
      }
      if (!error.retryable || error.status === 401 || error.status === 403 || error.status === 413) {
        this.db.markError(pending.id, error.code, error.message)
        return
      }
      this.scheduleRetry(pending, error.code, error.message)
      return
    }

    const nodeError = error as NodeJS.ErrnoException
    const code = nodeError.code ?? (error instanceof Error ? error.message : 'SYNC_ERROR')
    if (code === 'ENOENT' && pending.operation === 'UPSERT') {
      this.db.markError(pending.id, 'LOCAL_FILE_MISSING', 'File disappeared before upload')
      return
    }
    if (code === 'FILE_TOO_LARGE') {
      this.db.markError(pending.id, 'FILE_TOO_LARGE', 'Telegram-backed V1 supports files up to 20 MB')
      return
    }
    this.scheduleRetry(pending, String(code), error instanceof Error ? error.message : String(error))
  }

  private scheduleRetry(pending: PendingRow, code: string, message: string): void {
    const settings = this.db.getSettings()
    const attempt = Math.max(1, pending.attempt_count + 1)
    const delaySeconds = Math.min(3600, settings.retryBaseSeconds * 2 ** Math.min(8, attempt - 1))
    const retryAt = new Date(Date.now() + delaySeconds * 1000).toISOString()
    this.db.markRetry(pending.id, code, message, retryAt)
  }

  async restore(fileId: string, sourceVersion: number): Promise<void> {
    const file = this.db.getFile(fileId)
    if (!file) throw new Error('LOCAL_FILE_RECORD_MISSING')
    if (sourceVersion <= 0 || sourceVersion > file.current_version) throw new Error('VERSION_NOT_AVAILABLE')
    const absolutePath = this.root ? join(this.root, file.relative_path) : ''
    if (!absolutePath) throw new Error('SYNC_DIRECTORY_NOT_CONFIGURED')

    this.suppress(absolutePath, 3500)
    const source = await this.downloadVersionTo(file.id, sourceVersion, absolutePath)
    const info = await stat(absolutePath)
    const hash = source.hash ?? await sha256File(absolutePath)
    this.db.upsertState(file.id, info.size, info.mtimeMs, hash, true)
    const queued = this.db.queueUpsert(
      file,
      absolutePath,
      hash,
      info.size,
      0,
      this.db.getSettings().defaultStorageBackend,
      sourceVersion
    )
    if (!queued) throw new Error('RESTORE_QUEUE_FAILED')
    this.db.log('RESTORE_QUEUED', file.id, `from V${sourceVersion}`)
    this.callbacks.onStateChanged?.()
    if (!this.cloudAccessEnabled || (this.callbacks.canSyncCloud && !(await this.callbacks.canSyncCloud()))) {
      throw new Error('AUTH_REQUIRED')
    }
    this.db.markUploading(queued.id)
    await this.runPending(queued)
    const remaining = this.db.getPending(queued.id)
    if (remaining) throw new Error(remaining.error_code ?? 'RESTORE_SYNC_INCOMPLETE')
  }

  async restoreLocalCopy(fileId: string): Promise<void> {
    const file = this.db.getFile(fileId)
    if (!file || file.current_version <= 0 || file.cloud_status !== 'active') throw new Error('CLOUD_FILE_NOT_AVAILABLE')
    const absolutePath = this.root ? join(this.root, file.relative_path) : ''
    if (!absolutePath) throw new Error('SYNC_DIRECTORY_NOT_CONFIGURED')

    this.suppress(absolutePath, 3500)
    const remote = await this.downloadCurrentTo(file.id, absolutePath)
    const info = await stat(absolutePath)
    const hash = remote.hash ?? (await sha256File(absolutePath))
    this.db.updateCloudState(file.id, remote.version || file.current_version, hash, 'SYNCED')
    this.db.upsertState(file.id, info.size, info.mtimeMs, hash, true)
    this.db.log('LOCAL_COPY_RESTORED', file.id, `V${remote.version || file.current_version}`)
    this.callbacks.onStateChanged?.()
  }

  async trashSaasFile(fileId: string): Promise<void> {
    const file = this.db.getFile(fileId)
    if (!file || file.current_version <= 0 || file.cloud_status !== 'active') throw new Error('CLOUD_FILE_NOT_AVAILABLE')
    await this.api.trashFile(file.id, file.current_version)
    this.db.markCloudTrashed(file.id)
    this.callbacks.onStateChanged?.()
  }

  async permanentlyDelete(fileId: string): Promise<void> {
    const file = this.db.getFile(fileId)
    if (!file || file.cloud_status !== 'trashed') throw new Error('FILE_NOT_TRASHED')
    await this.api.permanentlyDelete(fileId)
    this.db.markCloudDeleted(fileId)
    this.callbacks.onStateChanged?.()
  }

  async restoreTrash(fileId: string): Promise<void> {
    const restored = await this.api.restoreTrash(fileId)
    const local = this.db.upsertRemoteMetadata({
      id: restored.id,
      relativePath: restored.relative_path,
      logicalName: restored.logical_name,
      extension: extname(restored.relative_path).toLowerCase(),
      version: restored.current_version,
      hash: restored.current_hash,
      cloudStatus: 'active',
      size: restored.size
    })
    const state = this.db.getState(local.id)
    if (state?.exists_flag === 1 && state.last_hash && state.last_hash !== restored.current_hash && this.root) {
      const absolutePath = join(this.root, local.relative_path)
      await this.handleFileReady(absolutePath)
    }
    this.db.log('SAAS_TRASH_RESTORED', restored.id, `V${restored.current_version}`)
    this.callbacks.onStateChanged?.()
  }
}
