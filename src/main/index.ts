import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, session, shell, Tray, type MenuItemConstructorOptions } from 'electron'
import { access, copyFile, lstat, mkdir, readdir, rename as renamePath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, parse, relative, resolve } from 'node:path'
import { hostname, release } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type {
  DashboardView,
  HealthView,
  SettingsView,
  TransferProgressView
} from '../shared/contracts'
import { SUPPORTED_DIALOG_EXTENSIONS } from '../shared/file-types'
import type { StorageBackend } from '../shared/storage-capabilities'
import { WorkerApi, ApiError } from './api'
import { APP_NAME, DEFAULT_WORKER_URL, LEGACY_WORKER_URLS, isAllowedWorkerUrl, normalizeWorkerUrl } from './config'
import { LocalDb } from './db'
import { assertSupportedFileSignature, isManagedFile, MAX_SYNC_FILE_BYTES } from './file-utils'
import { SessionStore } from './session-store'
import { SyncEngine } from './sync-engine'
import { previewLocalFile } from './preview'
import { compareVersionFiles } from './version-diff'
import { clearVersionPreviewCache, ensureVersionPreviewCopy, pruneVersionPreviewCache } from './version-cache'
import { TelegramUserStorageConfigStore, TelegramUserStorageProvider } from './telegram-user-storage'
import { DesktopStorageRouter } from './desktop-storage-router'
import { isPathWithinRoot, resolveWithinRoot, safeRelativePath } from './path-security'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// Set the product identity and user-data path before Electron creates Chromium
// services. This keeps first-run provisioning and the packaged client on the
// same %APPDATA%\ExcelSync directory instead of the npm package-name path.
app.setName(APP_NAME)
const userDataOverride = process.env.EXCELSYNC_USER_DATA_DIR?.trim()
app.setPath('userData', userDataOverride ? resolve(userDataOverride) : join(app.getPath('appData'), APP_NAME))

const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAxElEQVR4nO2W0Q2AMAhE1biJzmhn0Bl1Fv0yqXogJYBp4n3Syru0nGnT/PpYLbc4TPtuBdqWFrK6CDjXDxqwhnN9Hwa84FT/jluMMNFLPlhnHWhM73vIIYxSnQbQ0UqO28TACcqBqOZi4A4YEJqCdcY1NwM5IAehmpsBChSaAkt9bkD0INFmXKLLCVBPZ2vlnMcVeJu494cz4GUC9SWH0NpE1PXWpwPAeUbV/v7KrAAAAABJRU5ErkJggg=='

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let localDb: LocalDb | null = null
let sessionStore: SessionStore | null = null
let workerApi: WorkerApi | null = null
let syncEngine: SyncEngine | null = null
let telegramUserStorage: TelegramUserStorageProvider | null = null
let desktopStorageRouter: DesktopStorageRouter | null = null
let quitting = false
let shutdownInProgress = false
let finalQuitReady = false

function requireServices(): {
  db: LocalDb
  sessions: SessionStore
  api: WorkerApi
  sync: SyncEngine
} {
  if (!localDb || !sessionStore || !workerApi || !syncEngine) throw new Error('APP_NOT_READY')
  return { db: localDb, sessions: sessionStore, api: workerApi, sync: syncEngine }
}

function sendStateChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state:changed')
  updateTrayMenu()
}

function sendTransferProgress(progress: TransferProgressView): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('transfer:progress', progress)
}

function sendAuthChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auth:changed')
}

function validSender(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('IPC_SENDER_REJECTED')
  const url = event.senderFrame?.url ?? ''
  const devOk = !app.isPackaged && (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:'))
  const packagedOk = app.isPackaged && url.startsWith('file://')
  if (!devOk && !packagedOk) throw new Error('IPC_ORIGIN_REJECTED')
}

function publicError(error: unknown): Error {
  if (error instanceof ApiError) return new Error(`${error.code}: ${error.message}`)
  return error instanceof Error ? error : new Error('UNKNOWN_ERROR')
}

function handleIpc<TArgs extends unknown[], TResult>(
  channel: string,
  handler: (...args: TArgs) => Promise<TResult> | TResult
): void {
  ipcMain.handle(channel, async (event, ...args: TArgs) => {
    validSender(event)
    try {
      return await handler(...args)
    } catch (error) {
      throw publicError(error)
    }
  })
}

async function getHealth(): Promise<HealthView> {
  const { api } = requireServices()
  try {
    const health = await api.health()
    let reachable = false
    let detail: string | undefined
    try {
      const storage = await api.storageStatus()
      reachable = storage.reachable
      detail = storage.message
    } catch {
      // Public health intentionally avoids outbound Telegram probes; authenticated storage status is optional here.
    }
    return {
      online: true,
      worker: health.ok ? 'ok' : 'error',
      telegram: {
        tokenConfigured: health.telegram.tokenConfigured,
        chatConfigured: health.telegram.chatConfigured,
        reachable,
        detail
      }
    }
  } catch (error) {
    return {
      online: false,
      worker: error instanceof ApiError && !error.retryable ? 'error' : 'offline',
      telegram: { tokenConfigured: false, chatConfigured: false, reachable: false }
    }
  }
}

async function dashboard(): Promise<DashboardView> {
  const { db } = requireServices()
  const counts = db.counts()
  return {
    health: await getHealth(),
    syncedFiles: counts.synced,
    pending: counts.pending,
    syncing: counts.syncing,
    waitingRetry: counts.waitingRetry,
    needsAttention: counts.needsAttention,
    conflicts: counts.conflicts,
    errors: counts.errors,
    recentActivity: db.listActivity(12)
  }
}

async function applySettings(settings: SettingsView): Promise<void> {
  const { sync } = requireServices()
  await sync.setDirectory(settings.syncDirectory)
  sync.setPaused(!settings.autoSync)
  app.setLoginItemSettings({ openAtLogin: settings.startWithWindows, path: process.execPath })
}

async function nextAvailableImportPath(root: string, fileName: string): Promise<string> {
  const original = join(root, fileName)
  try {
    await access(original)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return original
    throw error
  }

  const parts = parse(fileName)
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = join(root, `${parts.name} (${index})${parts.ext}`)
    try {
      await access(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
      throw error
    }
  }
  throw new Error('IMPORT_NAME_EXHAUSTED')
}

async function copyValidatedImportFile(source: string, destination: string): Promise<void> {
  const before = await lstat(source)
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('IMPORT_SOURCE_REJECTED')
  if (before.size <= 0 || before.size > MAX_SYNC_FILE_BYTES) throw new Error('FILE_TOO_LARGE')
  await assertSupportedFileSignature(source)
  await copyFile(source, destination)
  try {
    const [after, copied] = await Promise.all([lstat(source), lstat(destination)])
    const sourceChanged = after.isSymbolicLink() || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs
    if (sourceChanged || !copied.isFile() || copied.size !== before.size) throw new Error('IMPORT_SOURCE_CHANGED')
    await assertSupportedFileSignature(destination)
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined)
    throw error
  }
}

async function showOwnedOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.moveTop()
    return dialog.showOpenDialog(mainWindow, options)
  }
  return dialog.showOpenDialog(options)
}

async function selectSyncDirectory(title = '选择 ExcelSync 同步文件夹'): Promise<string | null> {
  const { db } = requireServices()
  const current = db.getSettings().syncDirectory
  const result = await showOwnedOpenDialog({
    title,
    defaultPath: current || app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths[0]) return null

  const next = db.setSettings({ syncDirectory: result.filePaths[0] })
  await applySettings(next)
  sendStateChanged()
  return result.filePaths[0]
}

async function openSyncDirectory(): Promise<void> {
  const { db } = requireServices()
  const dir = db.getSettings().syncDirectory || await selectSyncDirectory('选择要作为 ExcelSync 同步位置的文件夹')
  if (!dir) return
  const message = await shell.openPath(dir)
  if (message) throw new Error(message)
}

function versionPreviewCacheRoot(): string {
  return join(app.getPath('userData'), 'cache', 'version-preview')
}

async function ensureHistoricalVersionCopy(fileId: string, version: number): Promise<{ absolute: string; logicalName: string }> {
  const { db, api } = requireServices()
  const file = db.getFile(fileId)
  if (!file) throw new Error('FILE_NOT_FOUND')
  const versions = await api.versions(fileId)
  const metadata = versions.find((item) => item.version === version)
  if (!metadata || metadata.available === false || metadata.integrity_status === 'LEGACY_UNRECOVERABLE' || metadata.integrity_status === 'MISSING_REMOTE_FILE_REFERENCE') {
    throw new Error('VERSION_UNAVAILABLE')
  }
  const cached = await ensureVersionPreviewCopy({
    cacheRoot: versionPreviewCacheRoot(),
    fileId,
    version,
    logicalName: file.logical_name,
    expectedHash: metadata.hash,
    fetchToPath: async (destination) => {
      if (desktopStorageRouter) {
        await desktopStorageRouter.downloadVersionTo(fileId, version, destination)
      } else {
        const remote = await api.downloadVersion(fileId, version)
        await writeFile(destination, remote.bytes)
      }
    }
  })
  return { absolute: cached.path, logicalName: file.logical_name }
}

async function ensureLocalFile(fileId: string): Promise<{ absolute: string; logicalName: string }> {
  const { db, sync } = requireServices()
  const file = db.getFile(fileId)
  const root = db.getSettings().syncDirectory
  if (!file || !root || file.cloud_status !== 'active') throw new Error('FILE_NOT_FOUND')
  let state = db.getState(fileId)
  if (state?.exists_flag !== 1) {
    if (file.current_version <= 0) throw new Error('LOCAL_FILE_NOT_AVAILABLE')
    await sync.restoreLocalCopy(fileId)
    state = db.getState(fileId)
  }
  if (state?.exists_flag !== 1) throw new Error('LOCAL_FILE_NOT_AVAILABLE')
  const absolute = resolveWithinRoot(root, file.relative_path)
  return { absolute, logicalName: file.logical_name }
}

async function renameOrMoveManagedFile(fileId: string, targetRelativePath: string): Promise<void> {
  const { db, api, sync } = requireServices()
  const file = db.getFile(fileId)
  const root = db.getSettings().syncDirectory
  if (!file || !root || file.cloud_status !== 'active') throw new Error('FILE_NOT_FOUND')
  const relativePath = safeRelativePath(targetRelativePath)
  if (!isManagedFile(relativePath)) throw new Error('UNSUPPORTED_FILE_TYPE')
  if (extname(relativePath).toLowerCase() !== file.extension.toLowerCase()) throw new Error('FILE_EXTENSION_CHANGE_NOT_ALLOWED')
  const occupied = db.getFileByPath(relativePath)
  if (occupied && occupied.id !== file.id && occupied.cloud_status === 'active') throw new Error('PATH_ALREADY_EXISTS')
  if (relativePath.toLocaleLowerCase('en-US') === file.relative_path.replaceAll('\\', '/').toLocaleLowerCase('en-US')) return

  const state = db.getState(file.id)
  if (state?.exists_flag === 1) {
    const oldAbsolute = resolveWithinRoot(root, file.relative_path)
    const newAbsolute = resolveWithinRoot(root, relativePath)
    await mkdir(dirname(newAbsolute), { recursive: true })
    await renamePath(oldAbsolute, newAbsolute)
    await sync.handleFileDeleted(oldAbsolute)
    await sync.handleFileReady(newAbsolute)
  } else {
    await api.renameFile(file.id, basename(relativePath), relativePath, file.current_version)
    db.renameFile(file.id, relativePath, basename(relativePath), extname(relativePath).toLowerCase())
    db.upsertState(file.id, state?.size ?? 0, state?.mtime_ms ?? 0, state?.last_hash ?? file.current_hash, false)
  }
  sendStateChanged()
}

async function importExcelFiles(storageBackend?: StorageBackend): Promise<string[]> {
  const { db, sync } = requireServices()
  const selectedStorageBackend = storageBackend ?? db.getSettings().defaultStorageBackend
  const options: Electron.OpenDialogOptions = {
    title: '选择要导入的文件',
    defaultPath: app.getPath('documents'),
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '支持的文件', extensions: SUPPORTED_DIALOG_EXTENSIONS },
      { name: '所有文件', extensions: ['*'] }
    ]
  }
  const result = await showOwnedOpenDialog(options)
  const filePaths = result.canceled ? [] : result.filePaths
  if (filePaths.length === 0) return []

  const root = db.getSettings().syncDirectory || await selectSyncDirectory('选择导入文件要保存到的同步文件夹')
  if (!root) return []
  await mkdir(root, { recursive: true })
  const imported: string[] = []
  for (const source of filePaths) {
    if (!isManagedFile(source)) throw new Error('UNSUPPORTED_FILE_TYPE')
    const info = await lstat(source)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('IMPORT_SOURCE_REJECTED')
    if (info.size <= 0 || info.size > MAX_SYNC_FILE_BYTES) throw new Error('FILE_TOO_LARGE')
    await assertSupportedFileSignature(source)

    const sourceResolved = resolve(source)
    if (isPathWithinRoot(root, sourceResolved)) {
      sync.hintPathStorageBackend(sourceResolved, selectedStorageBackend)
      imported.push(sourceResolved)
      continue
    }

    const destination = await nextAvailableImportPath(root, basename(source))
    sync.hintPathStorageBackend(destination, selectedStorageBackend)
    await copyValidatedImportFile(source, destination)
    imported.push(destination)
  }
  if (imported.length > 0) {
    await sync.queueImportedPaths(imported, 3, 8, selectedStorageBackend)
    sendStateChanged()
  }
  return imported
}

async function nextAvailableImportDirectory(root: string, folderName: string): Promise<string> {
  const original = join(root, folderName)
  try {
    await access(original)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return original
    throw error
  }

  for (let index = 1; index < 10_000; index += 1) {
    const candidate = join(root, `${folderName} (${index})`)
    try {
      await access(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
      throw error
    }
  }
  throw new Error('IMPORT_NAME_EXHAUSTED')
}

async function collectManagedFiles(directory: string): Promise<string[]> {
  const collected: string[] = []
  const queue = [directory]
  while (queue.length > 0) {
    const current = queue.shift()!
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        queue.push(absolute)
        continue
      }
      if (entry.isFile() && isManagedFile(absolute)) collected.push(absolute)
      if (collected.length > 20_000) throw new Error('IMPORT_TOO_MANY_FILES')
    }
  }
  return collected
}

async function importExcelFolder(storageBackend?: StorageBackend): Promise<string[]> {
  const { db, sync } = requireServices()
  const selectedStorageBackend = storageBackend ?? db.getSettings().defaultStorageBackend
  const result = await showOwnedOpenDialog({
    title: '选择要导入的文件夹',
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory']
  })
  if (result.canceled || !result.filePaths[0]) return []

  const root = db.getSettings().syncDirectory || await selectSyncDirectory('选择导入内容要保存到的同步文件夹')
  if (!root) return []
  const sourceRoot = resolve(result.filePaths[0])
  const syncRoot = resolve(root)
  const sourceFiles = await collectManagedFiles(sourceRoot)
  if (sourceFiles.length === 0) return []

  for (const source of sourceFiles) {
    const info = await lstat(source)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`IMPORT_SOURCE_REJECTED:${relative(sourceRoot, source)}`)
    if (info.size <= 0 || info.size > MAX_SYNC_FILE_BYTES) throw new Error(`FILE_TOO_LARGE:${relative(sourceRoot, source)}`)
    await assertSupportedFileSignature(source)
  }

  if (isPathWithinRoot(syncRoot, sourceRoot)) {
    for (const source of sourceFiles) sync.hintPathStorageBackend(source, selectedStorageBackend)
    await sync.queueImportedPaths(sourceFiles, sourceFiles.length >= 500 ? 4 : 3, 8, selectedStorageBackend)
    sendStateChanged()
    return sourceFiles
  }

  const destinationRoot = await nextAvailableImportDirectory(syncRoot, basename(sourceRoot))
  const imported: string[] = []
  for (const source of sourceFiles) {
    const rel = relative(sourceRoot, source)
    const destination = join(destinationRoot, rel)
    await mkdir(dirname(destination), { recursive: true })
    sync.hintPathStorageBackend(destination, selectedStorageBackend)
    await copyValidatedImportFile(source, destination)
    imported.push(destination)
  }
  await sync.queueImportedPaths(imported, imported.length >= 500 ? 4 : 3, 8, selectedStorageBackend)
  sendStateChanged()
  return imported
}

async function importDroppedPaths(inputPaths: string[], storageBackend?: StorageBackend): Promise<string[]> {
  const { db, sync } = requireServices()
  const selectedStorageBackend = storageBackend ?? db.getSettings().defaultStorageBackend
  const root = db.getSettings().syncDirectory || await selectSyncDirectory('选择拖放内容要保存到的同步文件夹')
  if (!root) return []
  const syncRoot = resolve(root)
  await mkdir(syncRoot, { recursive: true })
  const imported: string[] = []

  for (const inputPath of [...new Set(inputPaths.map((value) => resolve(value)))]) {
    const info = await lstat(inputPath)
    if (info.isFile()) {
      if (info.isSymbolicLink() || !isManagedFile(inputPath)) continue
      if (info.size <= 0 || info.size > MAX_SYNC_FILE_BYTES) throw new Error(`FILE_TOO_LARGE:${basename(inputPath)}`)
      await assertSupportedFileSignature(inputPath)
      if (isPathWithinRoot(syncRoot, inputPath)) {
        sync.hintPathStorageBackend(inputPath, selectedStorageBackend)
        imported.push(inputPath)
      } else {
        const destination = await nextAvailableImportPath(syncRoot, basename(inputPath))
        sync.hintPathStorageBackend(destination, selectedStorageBackend)
        await copyValidatedImportFile(inputPath, destination)
        imported.push(destination)
      }
      continue
    }
    if (!info.isDirectory()) continue
    const sourceFiles = await collectManagedFiles(inputPath)
    if (sourceFiles.length === 0) continue
    for (const source of sourceFiles) {
      const sourceInfo = await lstat(source)
      if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw new Error(`IMPORT_SOURCE_REJECTED:${relative(inputPath, source)}`)
      if (sourceInfo.size <= 0 || sourceInfo.size > MAX_SYNC_FILE_BYTES) throw new Error(`FILE_TOO_LARGE:${relative(inputPath, source)}`)
      await assertSupportedFileSignature(source)
    }
    if (isPathWithinRoot(syncRoot, inputPath)) {
      for (const source of sourceFiles) sync.hintPathStorageBackend(source, selectedStorageBackend)
      imported.push(...sourceFiles)
      continue
    }
    const destinationRoot = await nextAvailableImportDirectory(syncRoot, basename(inputPath))
    for (const source of sourceFiles) {
      const destination = join(destinationRoot, relative(inputPath, source))
      await mkdir(dirname(destination), { recursive: true })
      sync.hintPathStorageBackend(destination, selectedStorageBackend)
      await copyValidatedImportFile(source, destination)
      imported.push(destination)
      if (imported.length > 20_000) throw new Error('IMPORT_TOO_MANY_FILES')
    }
  }
  if (imported.length > 0) {
    await sync.queueImportedPaths(imported, imported.length >= 500 ? 4 : 3, 8, selectedStorageBackend)
    sendStateChanged()
  }
  return imported
}

function installChineseApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '导入文件…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void importExcelFiles().catch((error) => {
            dialog.showErrorBox('导入文件失败', publicError(error).message)
          })
        },
        {
          label: '导入文件夹…',
          click: () => void importExcelFolder().catch((error) => {
            dialog.showErrorBox('导入文件夹失败', publicError(error).message)
          })
        },
        { label: requireServices().db.getSettings().syncDirectory ? '打开同步文件夹' : '选择同步文件夹…', click: () => void openSyncDirectory().catch((error) => dialog.showErrorBox('同步文件夹', publicError(error).message)) },
        { label: '立即同步', click: () => void requireServices().sync.syncNow() },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' }
      ]
    },
    {
      label: '查看',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '切换全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '关闭窗口', role: 'close' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 ExcelSync',
          click: () => {
            const options = { type: 'info' as const, title: '关于 ExcelSync', message: `ExcelSync ${app.getVersion()}`, detail: 'Windows 文件自动同步客户端 · Telegram 存储' }
            if (mainWindow) void dialog.showMessageBox(mainWindow, options)
            else void dialog.showMessageBox(options)
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc(): void {
  handleIpc('auth:state', async () => {
    const { sessions, api } = requireServices()
    const stored = await sessions.load()
    let setupProvisioned = false
    if (!stored) {
      requireServices().sync.setCloudAccessEnabled(false)
      try {
        setupProvisioned = (await api.health()).setupAvailable
      } catch {
        setupProvisioned = false
      }
      return { authenticated: false, setupProvisioned }
    }

    try {
      const auth = await api.me()
      return {
        authenticated: true,
        username: auth.user.username,
        user: auth.user,
        memberships: auth.memberships,
        defaultWorkspaceId: auth.defaultWorkspaceId,
        setupProvisioned: false
      }
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'AUTH_REQUIRED' || error.code === 'INVALID_SESSION' || error.code === 'ACCOUNT_EXPIRED' || error.status === 401)) {
        await sessions.clear()
        requireServices().sync.setCloudAccessEnabled(false)
        sendAuthChanged()
        return { authenticated: false, setupProvisioned: false }
      }
      if (stored.auth) {
        return {
          authenticated: true,
          username: stored.auth.user.username,
          user: stored.auth.user,
          memberships: stored.auth.memberships,
          defaultWorkspaceId: stored.auth.defaultWorkspaceId,
          setupProvisioned: false
        }
      }
      return { authenticated: true, username: stored.username, setupProvisioned: false }
    }
  })

  handleIpc('auth:bootstrap', async (username: unknown, password: unknown, setupCode: unknown) => {
    const parsed = z.tuple([
      z.string().min(3).max(64),
      z.string().min(12).max(256),
      z.string().max(256)
    ]).parse([username, password, setupCode])
    const { api, sync, db } = requireServices()
    await api.bootstrap(parsed[0], parsed[1], parsed[2])
    sync.setCloudAccessEnabled(true)
    db.requeueAuthBlocked()
    sendAuthChanged()
    sendStateChanged()
    void sync.syncNow().catch((error) => {
      db.log('POST_AUTH_SYNC_ERROR', null, error instanceof Error ? error.message : String(error))
      sendStateChanged()
    })
  })

  handleIpc('auth:login', async (username: unknown, password: unknown) => {
    const parsed = z.tuple([z.string().min(1).max(64), z.string().min(1).max(256)]).parse([username, password])
    const { api, sync, db } = requireServices()
    await api.login(parsed[0], parsed[1])
    sync.setCloudAccessEnabled(true)
    db.requeueAuthBlocked()
    sendAuthChanged()
    sendStateChanged()
    void sync.syncNow().catch((error) => {
      db.log('POST_AUTH_SYNC_ERROR', null, error instanceof Error ? error.message : String(error))
      sendStateChanged()
    })
  })

  handleIpc('auth:activateInvite', async (code: unknown, password: unknown) => {
    const [inviteCode, pass] = z.tuple([z.string().min(6).max(128), z.string().min(12).max(256)]).parse([code, password])
    const { api, db, sync } = requireServices()
    await api.activateInvite(inviteCode, pass)
    sync.setCloudAccessEnabled(true)
    db.requeueAuthBlocked()
    sendAuthChanged()
    sendStateChanged()
  })

  handleIpc('auth:logout', async () => {
    const { api, sync } = requireServices()
    sync.setCloudAccessEnabled(false)
    try {
      await api.logout()
    } finally {
      sendAuthChanged()
      sendStateChanged()
    }
  })
  handleIpc('auth:devices', async () => requireServices().api.devices())
  handleIpc('auth:logoutDevice', async (deviceId: unknown) => {
    await requireServices().api.logoutDevice(z.string().uuid().parse(deviceId))
    sendStateChanged()
  })
  handleIpc('auth:logoutOtherDevices', async () => requireServices().api.logoutOtherDevices())
  handleIpc('auth:logoutAllDevices', async () => {
    const { api, sync } = requireServices()
    sync.setCloudAccessEnabled(false)
    const count = await api.logoutAllDevices()
    sendAuthChanged()
    sendStateChanged()
    return count
  })

  handleIpc('dashboard:get', dashboard)
  handleIpc('files:list', () => requireServices().db.listFiles())
  handleIpc('trash:list', () => requireServices().api.trashList())
  handleIpc('activity:list', async () => {
    const { api, db } = requireServices()
    try { return await api.activity() } catch { return db.listActivity(200) }
  })
  handleIpc('notifications:list', async (filter: unknown = 'all') => requireServices().api.notifications(z.enum(['all','unread','file','task','system']).parse(filter)))
  handleIpc('notifications:read', async (notificationId: unknown) => requireServices().api.markNotificationRead(z.string().uuid().parse(notificationId)))
  handleIpc('notifications:readAll', async () => requireServices().api.markAllNotificationsRead())
  handleIpc('search:advanced', async (input: unknown) => {
    const safe = z.object({
      q: z.string().max(500).optional(),
      type: z.enum(['Excel','Word','PDF','CSV','ZIP','PPT','Image','EXE','Other','']).optional(),
      state: z.enum(['locked','editing','trashed','']).optional(),
      workspaceId: z.string().uuid().optional(),
      path: z.string().max(1000).optional(),
      modifiedBy: z.string().max(100).optional(),
      createdBy: z.string().max(100).optional(),
      modifiedFrom: z.string().max(64).optional(),
      modifiedTo: z.string().max(64).optional()
    }).parse(input)
    return requireServices().api.advancedSearch(safe)
  })
  handleIpc('pending:list', () => requireServices().db.listPending())
  handleIpc('pending:problems', () => requireServices().db.problemCenter())

  handleIpc('versions:list', async (fileId: unknown) => {
    const id = z.string().uuid().parse(fileId)
    return requireServices().api.versions(id)
  })

  handleIpc('versions:preview', async (fileId: unknown, version: unknown, sheetName: unknown = undefined) => {
    const [id, v] = z.tuple([z.string().uuid(), z.number().int().positive()]).parse([fileId, version])
    const sheet = z.string().max(200).optional().parse(sheetName)
    const historical = await ensureHistoricalVersionCopy(id, v)
    return previewLocalFile(historical.absolute, historical.logicalName, sheet)
  })

  handleIpc('versions:download', async (fileId: unknown, version: unknown) => {
    const [id, v] = z.tuple([z.string().uuid(), z.number().int().positive()]).parse([fileId, version])
    const { db, api } = requireServices()
    const file = db.getFile(id)
    if (!file) throw new Error('FILE_NOT_FOUND')
    const parts = parse(file.logical_name)
    const suggested = `${parts.name} (历史版本 V${v})${parts.ext}`
    const target = mainWindow
      ? await dialog.showSaveDialog(mainWindow, { title: `下载 V${v} 副本`, defaultPath: join(app.getPath('downloads'), suggested) })
      : await dialog.showSaveDialog({ title: `下载 V${v} 副本`, defaultPath: join(app.getPath('downloads'), suggested) })
    if (target.canceled || !target.filePath) return null
    if (desktopStorageRouter) {
      await desktopStorageRouter.downloadVersionTo(id, v, target.filePath)
    } else {
      const remote = await api.downloadVersion(id, v)
      await writeFile(target.filePath, remote.bytes)
    }
    db.log('VERSION_DOWNLOADED', id, `V${v} -> ${target.filePath}`)
    return target.filePath
  })

  handleIpc('versions:openCopy', async (fileId: unknown, version: unknown) => {
    const [id, v] = z.tuple([z.string().uuid(), z.number().int().positive()]).parse([fileId, version])
    const historical = await ensureHistoricalVersionCopy(id, v)
    const message = await shell.openPath(historical.absolute)
    if (message) throw new Error(message)
    requireServices().db.log('VERSION_COPY_OPENED', id, `V${v}`)
  })

  handleIpc('versions:restore', async (fileId: unknown, version: unknown) => {
    const [id, v] = z.tuple([z.string().uuid(), z.number().int().positive()]).parse([fileId, version])
    await requireServices().sync.restore(id, v)
  })

  handleIpc('versions:compare', async (fileId: unknown, fromVersion: unknown, toVersion: unknown) => {
    const [id, from, to] = z.tuple([z.string().uuid(), z.number().int().positive(), z.number().int().positive()]).parse([fileId, fromVersion, toVersion])
    if (from === to) throw new Error('VERSIONS_MUST_DIFFER')
    const { db, api } = requireServices()
    const file = db.getFile(id)
    if (!file) throw new Error('FILE_NOT_FOUND')
    const versions = await api.versions(id)
    const fromMeta = versions.find((item) => item.version === from)
    const toMeta = versions.find((item) => item.version === to)
    if (!fromMeta || !toMeta || fromMeta.available === false || toMeta.available === false) throw new Error('VERSION_UNAVAILABLE')
    const [fromCopy, toCopy] = await Promise.all([ensureHistoricalVersionCopy(id, from), ensureHistoricalVersionCopy(id, to)])
    return compareVersionFiles({ logicalName: file.logical_name, fromPath: fromCopy.absolute, toPath: toCopy.absolute, from: fromMeta, to: toMeta })
  })

  handleIpc('fileLease:get', async (fileId: unknown) => requireServices().api.fileLease(z.string().uuid().parse(fileId)))
  handleIpc('fileLease:requestTakeover', async (fileId: unknown) => requireServices().api.requestFileLeaseTakeover(z.string().uuid().parse(fileId)))
  handleIpc('fileLease:forceTakeover', async (fileId: unknown) => requireServices().api.forceFileLeaseTakeover(z.string().uuid().parse(fileId)))
  handleIpc('comments:list', async (fileId: unknown) => requireServices().api.comments(z.string().uuid().parse(fileId)))
  handleIpc('comments:create', async (fileId: unknown, input: unknown) => {
    const id = z.string().uuid().parse(fileId)
    const safe = z.object({ body: z.string().trim().min(1).max(8000), parentCommentId: z.string().uuid().nullable().optional(), fileVersion: z.number().int().positive().nullable().optional() }).parse(input)
    return requireServices().api.createComment(id, safe)
  })
  handleIpc('comments:resolve', async (commentId: unknown, reopen: unknown = false) => requireServices().api.resolveComment(z.string().uuid().parse(commentId), z.boolean().parse(reopen)))
  handleIpc('rewind:preview', async (input: unknown) => {
    const safe = z.object({ workspaceId: z.string().uuid(), scopeType: z.enum(['FOLDER','WORKSPACE']), scopeValue: z.string().max(1000), targetTime: z.string().datetime() }).parse(input)
    return requireServices().api.rewindPreview(safe)
  })
  handleIpc('rewind:execute', async (input: unknown) => {
    const safe = z.object({ workspaceId: z.string().uuid(), scopeType: z.enum(['FOLDER','WORKSPACE']), scopeValue: z.string().max(1000), targetTime: z.string().datetime() }).parse(input)
    return requireServices().api.executeRewind({ ...safe, idempotencyKey: randomUUID() })
  })
  handleIpc('rewind:history', async (workspaceId: unknown) => requireServices().api.rewindHistory(z.string().uuid().parse(workspaceId)))
  handleIpc('rewind:retry', async (operationId: unknown) => requireServices().api.retryRewind(z.string().uuid().parse(operationId)))
  handleIpc('admin:activeLocks', async () => requireServices().api.activeLocks())

  handleIpc('files:restoreLocal', async (fileId: unknown) => {
    const id = z.string().uuid().parse(fileId)
    await requireServices().sync.restoreLocalCopy(id)
  })

  handleIpc('files:trash', async (fileId: unknown) => {
    const id = z.string().uuid().parse(fileId)
    await requireServices().sync.trashSaasFile(id)
  })

  handleIpc('trash:restore', async (fileId: unknown) => {
    const id = z.string().uuid().parse(fileId)
    await requireServices().sync.restoreTrash(id)
  })

  handleIpc('trash:permanentDelete', async (fileId: unknown) => {
    const id = z.string().uuid().parse(fileId)
    await requireServices().sync.permanentlyDelete(id)
  })

  handleIpc('files:import', async (storageBackend: unknown = undefined) => importExcelFiles(z.enum(['telegram_user_group', 'telegram_bot']).optional().parse(storageBackend)))
  handleIpc('files:importFolder', async (storageBackend: unknown = undefined) => importExcelFolder(z.enum(['telegram_user_group', 'telegram_bot']).optional().parse(storageBackend)))
  handleIpc('files:importPaths', async (paths: unknown, storageBackend: unknown = undefined) => importDroppedPaths(
    z.array(z.string().min(1).max(4000)).max(200).parse(paths),
    z.enum(['telegram_user_group', 'telegram_bot']).optional().parse(storageBackend)
  ))

  handleIpc('files:open', async (fileId: unknown) => {
    const id = z.string().uuid().parse(fileId)
    const local = await ensureLocalFile(id)
    const message = await shell.openPath(local.absolute)
    if (message) throw new Error(message)
    const { db, sync } = requireServices()
    db.markOpened(id)
    void sync.noteFileOpened(id)
    requireServices().db.log('FILE_OPENED', id, local.logicalName)
    sendStateChanged()
  })

  handleIpc('files:favorite', async (fileId: unknown, favorite: unknown) => {
    const id = z.string().uuid().parse(fileId)
    const value = z.boolean().parse(favorite)
    requireServices().db.setFavorite(id, value)
    sendStateChanged()
  })

  handleIpc('files:preview', async (fileId: unknown, sheetName: unknown = undefined) => {
    const id = z.string().uuid().parse(fileId)
    const sheet = z.string().max(200).optional().parse(sheetName)
    const local = await ensureLocalFile(id)
    return previewLocalFile(local.absolute, local.logicalName, sheet)
  })

  handleIpc('files:download', async (fileId: unknown) => {
    const id = z.string().uuid().parse(fileId)
    const { db, api } = requireServices()
    const file = db.getFile(id)
    if (!file || file.cloud_status !== 'active') throw new Error('FILE_NOT_FOUND')
    const target = mainWindow
      ? await dialog.showSaveDialog(mainWindow, { title: '下载文件', defaultPath: join(app.getPath('downloads'), file.logical_name) })
      : await dialog.showSaveDialog({ title: '下载文件', defaultPath: join(app.getPath('downloads'), file.logical_name) })
    if (target.canceled || !target.filePath) return null
    const state = db.getState(id)
    const root = db.getSettings().syncDirectory
    if (state?.exists_flag === 1 && root) {
      await copyFile(resolveWithinRoot(root, file.relative_path), target.filePath)
    } else {
      if (file.current_version <= 0) throw new Error('FILE_NOT_AVAILABLE')
      if (desktopStorageRouter) {
        await desktopStorageRouter.downloadCurrentTo(id, target.filePath)
      } else {
        const remote = await api.downloadCurrent(id)
        await writeFile(target.filePath, remote.bytes)
      }
    }
    db.log('FILE_DOWNLOADED', id, target.filePath)
    return target.filePath
  })

  handleIpc('files:downloadMany', async (fileIds: unknown) => {
    const ids = z.array(z.string().uuid()).min(1).max(1000).parse(fileIds)
    const result = await showOwnedOpenDialog({
      title: '选择批量下载位置',
      defaultPath: app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const targetRoot = result.filePaths[0]
    const { db, api } = requireServices()
    const syncRoot = db.getSettings().syncDirectory
    const downloaded: string[] = []
    for (const id of ids) {
      const file = db.getFile(id)
      if (!file || file.cloud_status !== 'active') continue
      const targetPath = await nextAvailableImportPath(targetRoot, file.logical_name)
      const state = db.getState(id)
      if (state?.exists_flag === 1 && syncRoot) {
        await copyFile(resolveWithinRoot(syncRoot, file.relative_path), targetPath)
      } else {
        if (file.current_version <= 0) continue
        if (desktopStorageRouter) {
          await desktopStorageRouter.downloadCurrentTo(id, targetPath)
        } else {
          const remote = await api.downloadCurrent(id)
          await writeFile(targetPath, remote.bytes)
        }
      }
      db.log('FILE_DOWNLOADED', id, targetPath)
      downloaded.push(targetPath)
    }
    return downloaded
  })

  handleIpc('files:rename', async (fileId: unknown, newName: unknown) => {
    const id = z.string().uuid().parse(fileId)
    const name = z.string().min(1).max(255).parse(newName).trim()
    if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') throw new Error('INVALID_FILE_NAME')
    const file = requireServices().db.getFile(id)
    if (!file) throw new Error('FILE_NOT_FOUND')
    const parent = dirname(file.relative_path)
    await renameOrMoveManagedFile(id, parent === '.' ? name : join(parent, name))
  })

  handleIpc('files:move', async (fileId: unknown, newRelativePath: unknown) => {
    const id = z.string().uuid().parse(fileId)
    const path = z.string().min(1).max(1000).parse(newRelativePath)
    await renameOrMoveManagedFile(id, path)
  })

  handleIpc('files:copy', async (fileId: unknown) => {
    const id = z.string().uuid().parse(fileId)
    const { db, sync } = requireServices()
    const file = db.getFile(id)
    const root = db.getSettings().syncDirectory
    if (!file || !root) throw new Error('FILE_NOT_FOUND')
    const local = await ensureLocalFile(id)
    const parts = parse(file.logical_name)
    const parent = dirname(file.relative_path)
    const targetDirectory = parent === '.' ? resolve(root) : resolveWithinRoot(root, parent)
    await mkdir(targetDirectory, { recursive: true })
    const destination = await nextAvailableImportPath(targetDirectory, `${parts.name} - 副本${parts.ext}`)
    await copyFile(local.absolute, destination)
    await sync.handleFileReady(destination)
    sendStateChanged()
  })

  handleIpc('files:createFolder', async (relativeParent: unknown, folderName: unknown) => {
    const parentRaw = z.string().max(1000).parse(relativeParent)
    const name = z.string().min(1).max(255).parse(folderName).trim()
    if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') throw new Error('INVALID_FOLDER_NAME')
    const root = requireServices().db.getSettings().syncDirectory
    if (!root) throw new Error('SYNC_DIRECTORY_NOT_CONFIGURED')
    const parent = parentRaw.trim() ? safeRelativePath(parentRaw) : ''
    const destination = resolveWithinRoot(root, parent ? `${parent}/${name}` : name)
    await mkdir(destination, { recursive: false })
    requireServices().db.log('FOLDER_CREATED', null, parent ? `${parent}/${name}` : name)
    sendStateChanged()
  })

  handleIpc('pending:retry', async (taskId: unknown) => {
    const id = z.string().uuid().parse(taskId)
    const { db, sync } = requireServices()
    if (!db.requeuePending(id)) throw new Error('TASK_NOT_RETRYABLE')
    sendStateChanged()
    void sync.syncNow().catch(() => undefined)
  })

  handleIpc('pending:cancel', async (taskId: unknown) => {
    const id = z.string().uuid().parse(taskId)
    const { db } = requireServices()
    if (!db.cancelPendingById(id)) throw new Error('TASK_NOT_CANCELLABLE')
    sendStateChanged()
  })

  handleIpc('conflict:resolve', async (fileId: unknown, choice: unknown) => {
    const id = z.string().uuid().parse(fileId)
    const resolution = z.enum(['local', 'cloud', 'both']).parse(choice)
    await requireServices().sync.resolveConflict(id, resolution)
  })

  handleIpc('settings:selectDirectory', () => selectSyncDirectory())

  handleIpc('settings:openDirectory', openSyncDirectory)

  handleIpc('settings:get', () => requireServices().db.getSettings())

  handleIpc('settings:update', async (patch: unknown) => {
    const schema = z.object({
      syncDirectory: z.string().max(1000).optional(),
      workerUrl: z.string().max(1000).optional(),
      autoSync: z.boolean().optional(),
      startWithWindows: z.boolean().optional(),
      retryBaseSeconds: z.number().int().min(2).max(3600).optional(),
      retentionLimit: z.number().int().min(2).max(500).optional(),
      defaultStorageBackend: z.enum(['telegram_user_group', 'telegram_bot']).optional()
    })
    const safe = schema.parse(patch)
    if (safe.workerUrl) {
      const normalized = normalizeWorkerUrl(safe.workerUrl)
      if (!isAllowedWorkerUrl(normalized, app.isPackaged)) throw new Error('WORKER_URL_NOT_ALLOWED')
      safe.workerUrl = normalized
    }
    const next = requireServices().db.setSettings(safe)
    await applySettings(next)
    sendStateChanged()
    return next
  })

  handleIpc('telegramUser:status', async () => {
    if (!telegramUserStorage) throw new Error('TELEGRAM_USER_STORAGE_NOT_READY')
    return telegramUserStorage.status()
  })
  handleIpc('telegramUser:beginAuth', async (phone: unknown) => {
    if (!telegramUserStorage) throw new Error('TELEGRAM_USER_STORAGE_NOT_READY')
    return telegramUserStorage.beginAuthorization(z.string().trim().min(6).max(32).parse(phone))
  })
  handleIpc('telegramUser:submitCode', async (code: unknown) => {
    if (!telegramUserStorage) throw new Error('TELEGRAM_USER_STORAGE_NOT_READY')
    return telegramUserStorage.submitCode(z.string().trim().min(3).max(16).parse(code))
  })
  handleIpc('telegramUser:submitPassword', async (password: unknown) => {
    if (!telegramUserStorage) throw new Error('TELEGRAM_USER_STORAGE_NOT_READY')
    return telegramUserStorage.submitPassword(z.string().min(1).max(256).parse(password))
  })
  handleIpc('telegramUser:sync', async () => {
    const imported = await requireServices().sync.syncTelegramUserGroup()
    sendStateChanged()
    return imported
  })
  handleIpc('telegramUser:reauthorize', async () => {
    if (!telegramUserStorage) throw new Error('TELEGRAM_USER_STORAGE_NOT_READY')
    await telegramUserStorage.reauthorize()
    return telegramUserStorage.status()
  })
  handleIpc('telegramUser:restartAuth', async () => {
    if (!telegramUserStorage) throw new Error('TELEGRAM_USER_STORAGE_NOT_READY')
    return telegramUserStorage.restartAuthorization()
  })

  handleIpc('sync:now', async () => requireServices().sync.syncNow())
  handleIpc('sync:pause', async (paused: unknown) => {
    const value = z.boolean().parse(paused)
    const { db, sync } = requireServices()
    const settings = db.setSettings({ autoSync: !value })
    sync.setPaused(value)
    sendStateChanged()
    return settings
  })

  handleIpc('workspace:list', async () => requireServices().api.workspaces())
  handleIpc('workspace:setDefault', async (workspaceId: unknown) => {
    await requireServices().api.setDefaultWorkspace(z.string().uuid().parse(workspaceId))
    sendStateChanged()
  })
  handleIpc('workspace:members', async (workspaceId: unknown) => requireServices().api.workspaceMembers(z.string().uuid().parse(workspaceId)))
  handleIpc('workspace:saveMember', async (workspaceId: unknown, userId: unknown, role: unknown) => {
    const [workspace, target, safeRole] = z.tuple([z.string().uuid(), z.string().uuid(), z.enum(['MANAGER', 'EDITOR', 'VIEWER'])]).parse([workspaceId, userId, role])
    await requireServices().api.saveWorkspaceMember(workspace, target, safeRole)
    sendStateChanged()
  })
  handleIpc('workspace:removeMember', async (workspaceId: unknown, userId: unknown) => {
    const [workspace, target] = z.tuple([z.string().uuid(), z.string().uuid()]).parse([workspaceId, userId])
    await requireServices().api.removeWorkspaceMember(workspace, target)
    sendStateChanged()
  })
  handleIpc('workspace:create', async (input: unknown) => {
    const safe = z.object({
      name: z.string().trim().min(1).max(160),
      type: z.enum(['PERSONAL', 'TEAM', 'PROJECT']),
      defaultStorageConnectionId: z.string().uuid().nullable().optional()
    }).parse(input)
    const created = await requireServices().api.createWorkspace(safe)
    sendStateChanged()
    return created
  })
  handleIpc('workspace:archive', async (workspaceId: unknown) => {
    await requireServices().api.archiveWorkspace(z.string().uuid().parse(workspaceId))
    sendStateChanged()
  })
  handleIpc('workspace:setStorage', async (workspaceId: unknown, storageConnectionId: unknown) => {
    const [workspace, storage] = z.tuple([z.string().uuid(), z.string().uuid()]).parse([workspaceId, storageConnectionId])
    await requireServices().api.setWorkspaceStorage(workspace, storage)
    sendStateChanged()
  })
  handleIpc('workspace:resourceAccess', async (workspaceId: unknown, userId: unknown) => {
    const [workspace, target] = z.tuple([z.string().uuid(), z.string().uuid()]).parse([workspaceId, userId])
    return requireServices().api.resourceAccess(workspace, target)
  })
  handleIpc('workspace:replaceResourceAccess', async (workspaceId: unknown, userId: unknown, input: unknown) => {
    const [workspace, target] = z.tuple([z.string().uuid(), z.string().uuid()]).parse([workspaceId, userId])
    const safe = z.object({
      workspaceRole: z.enum(['MANAGER', 'EDITOR', 'VIEWER']),
      scopes: z.array(z.object({
        scopeType: z.enum(['WORKSPACE', 'STORAGE', 'FOLDER', 'FILE']),
        scopeValue: z.string().trim().min(1).max(1000)
      })).min(1).max(500)
    }).parse(input)
    await requireServices().api.replaceResourceAccess(workspace, target, safe)
    sendStateChanged()
  })

  const userTaskInputSchema = z.object({
    workspaceId: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(240),
    description: z.string().max(4000).default(''),
    status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).default('TODO'),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
    assigneeUserId: z.string().uuid().nullable().optional(),
    legacyAssigneeText: z.string().max(200).nullable().optional(),
    dueAt: z.string().datetime().nullable().optional(),
    fileIds: z.array(z.string().uuid()).max(50).default([]),
    legacyClientId: z.string().max(160).nullable().optional()
  })
  handleIpc('userTasks:list', async (scope: unknown, workspaceId: unknown) => {
    const safeScope = z.enum(['mine', 'all']).optional().parse(scope)
    const safeWorkspace = z.string().uuid().optional().parse(workspaceId)
    return requireServices().api.tasks(safeScope, safeWorkspace)
  })
  handleIpc('userTasks:create', async (input: unknown) => requireServices().api.createUserTask(userTaskInputSchema.parse(input)))
  handleIpc('userTasks:update', async (taskId: unknown, input: unknown) => {
    const safeInput = userTaskInputSchema.partial().omit({ workspaceId: true, legacyClientId: true, legacyAssigneeText: true }).parse(input)
    await requireServices().api.updateUserTask(z.string().uuid().parse(taskId), safeInput)
    sendStateChanged()
  })
  handleIpc('userTasks:delete', async (taskId: unknown) => {
    await requireServices().api.deleteUserTask(z.string().uuid().parse(taskId))
    sendStateChanged()
  })
  handleIpc('userTasks:migrateLocal', async (tasks: unknown) => {
    const safe = z.array(userTaskInputSchema.extend({ legacyClientId: z.string().min(1).max(160) })).max(200).parse(tasks)
    const result = await requireServices().api.migrateLocalTasks(safe)
    sendStateChanged()
    return result
  })

  handleIpc('admin:users', async () => requireServices().api.adminUsers())
  handleIpc('admin:userDevices', async (userId: unknown) => requireServices().api.adminUserDevices(z.string().uuid().parse(userId)))
  handleIpc('admin:invites', async () => requireServices().api.adminInvites())
  handleIpc('admin:createInvite', async (input: unknown) => {
    const safe = z.object({
      username: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_.-]+$/),
      displayName: z.string().trim().min(1).max(100),
      workspaceId: z.string().uuid(),
      workspaceRole: z.enum(['MANAGER', 'EDITOR', 'VIEWER']),
      accountType: z.enum(['INTERNAL', 'EXTERNAL']),
      userExpiresAt: z.string().datetime().nullable().optional(),
      expiresInHours: z.number().int().min(1).max(24 * 30)
    }).parse(input)
    return requireServices().api.createInvite(safe)
  })
  handleIpc('admin:revokeInvite', async (inviteId: unknown) => {
    await requireServices().api.revokeInvite(z.string().uuid().parse(inviteId))
    sendStateChanged()
  })
  handleIpc('admin:regenerateInvite', async (inviteId: unknown) => {
    const result = await requireServices().api.regenerateInvite(z.string().uuid().parse(inviteId))
    sendStateChanged()
    return result
  })
  handleIpc('admin:setUserLifecycle', async (userId: unknown, status: unknown, reassignToUserId: unknown) => {
    const target = z.string().uuid().parse(userId)
    const safeStatus = z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']).parse(status)
    const reassignment = z.string().uuid().nullable().optional().parse(reassignToUserId)
    const result = await requireServices().api.setUserLifecycle(target, safeStatus, reassignment)
    sendStateChanged()
    return result
  })
  handleIpc('admin:forceLogoutUser', async (userId: unknown) => {
    const target = z.string().uuid().parse(userId)
    const { api, sessions, sync } = requireServices()
    const current = await sessions.load()
    const invalidated = await api.forceLogoutUser(target)
    if (current?.auth?.user.id === target) {
      sync.setCloudAccessEnabled(false)
      sendAuthChanged()
    }
    sendStateChanged()
    return invalidated
  })
  handleIpc('admin:setUserSystemRole', async (userId: unknown, systemRole: unknown) => {
    await requireServices().api.setUserSystemRole(z.string().uuid().parse(userId), z.enum(['ADMIN', 'MEMBER']).parse(systemRole))
    sendStateChanged()
  })
  handleIpc('admin:setUserAccountPolicy', async (userId: unknown, accountType: unknown, accessExpiresAt: unknown) => {
    const target = z.string().uuid().parse(userId)
    const type = z.enum(['INTERNAL', 'EXTERNAL']).parse(accountType)
    const expiresAt = z.string().datetime().nullable().optional().parse(accessExpiresAt)
    await requireServices().api.setUserAccountPolicy(target, type, expiresAt)
    sendStateChanged()
  })
  handleIpc('admin:groups', async () => requireServices().api.groups())
  handleIpc('admin:createGroup', async (name: unknown) => requireServices().api.createGroup(z.string().trim().min(1).max(120).parse(name)))
  handleIpc('admin:archiveGroup', async (groupId: unknown) => {
    await requireServices().api.archiveGroup(z.string().uuid().parse(groupId))
    sendStateChanged()
  })
  handleIpc('admin:groupMembers', async (groupId: unknown) => requireServices().api.groupMembers(z.string().uuid().parse(groupId)))
  handleIpc('admin:replaceGroupMembers', async (groupId: unknown, userIds: unknown) => {
    await requireServices().api.replaceGroupMembers(
      z.string().uuid().parse(groupId),
      z.array(z.string().uuid()).max(1000).parse(userIds)
    )
    sendStateChanged()
  })
  handleIpc('admin:groupResourceAccess', async (workspaceId: unknown, groupId: unknown) => requireServices().api.groupResourceAccess(
    z.string().uuid().parse(workspaceId),
    z.string().uuid().parse(groupId)
  ))
  handleIpc('admin:replaceGroupResourceAccess', async (workspaceId: unknown, groupId: unknown, input: unknown) => {
    const safe = z.object({
      permission: z.enum(['VIEW', 'EDIT', 'MANAGE']),
      scopes: z.array(z.object({ scopeType: z.enum(['WORKSPACE', 'STORAGE', 'FOLDER', 'FILE']), scopeValue: z.string().trim().min(1).max(1000) })).min(1).max(500)
    }).parse(input)
    await requireServices().api.replaceGroupResourceAccess(z.string().uuid().parse(workspaceId), z.string().uuid().parse(groupId), safe)
    sendStateChanged()
  })
  handleIpc('admin:storageConnections', async () => requireServices().api.storageConnections())
  handleIpc('admin:createStorageConnection', async (name: unknown, botToken: unknown) => {
    const [safeName, safeToken] = z.tuple([z.string().trim().min(1).max(160), z.string().trim().min(20).max(256)]).parse([name, botToken])
    return requireServices().api.createStorageConnection(safeName, safeToken)
  })
  handleIpc('admin:rotateStorageToken', async (storageId: unknown, botToken: unknown) => {
    const [id, token] = z.tuple([z.string().uuid(), z.string().trim().min(20).max(256)]).parse([storageId, botToken])
    await requireServices().api.rotateStorageToken(id, token)
    sendStateChanged()
  })
  handleIpc('admin:startStoragePair', async (storageId: unknown) => requireServices().api.startStoragePair(z.string().uuid().parse(storageId)))
  handleIpc('admin:confirmStoragePair', async (storageId: unknown) => {
    const result = await requireServices().api.confirmStoragePair(z.string().uuid().parse(storageId))
    sendStateChanged()
    return result
  })
  handleIpc('admin:disableStorageConnection', async (storageId: unknown) => {
    await requireServices().api.disableStorageConnection(z.string().uuid().parse(storageId))
    sendStateChanged()
  })
  handleIpc('admin:checkStorageHealth', async () => requireServices().api.checkStorageHealth())
  handleIpc('admin:auditLogs', async () => requireServices().api.auditLogs())
  handleIpc('admin:systemStatus', async () => requireServices().api.systemStatus())
  handleIpc('admin:versionIntegrity', async () => requireServices().api.versionIntegrity())
  handleIpc('admin:repairVersionIntegrity', async (fileId: unknown = undefined) => {
    const id = z.string().uuid().optional().parse(fileId)
    return requireServices().api.repairVersionIntegrity(id)
  })

  handleIpc('presence:get', async (fileId: unknown) => requireServices().api.filePresence(z.string().uuid().parse(fileId)))
  handleIpc('presence:set', async (fileId: unknown, state: unknown) => requireServices().api.setFilePresence(
    z.string().uuid().parse(fileId),
    z.enum(['OPEN', 'EDITING']).parse(state)
  ))
  handleIpc('presence:clear', async (fileId: unknown) => requireServices().api.clearFilePresence(z.string().uuid().parse(fileId)))
  handleIpc('client:version', async () => requireServices().api.clientVersion())

  handleIpc('storage:status', async () => requireServices().api.storageStatus())
  handleIpc('storage:pairStart', async () => requireServices().api.pairStart())
  handleIpc('storage:pairConfirm', async () => {
    await requireServices().api.pairConfirm()
    sendStateChanged()
  })
  handleIpc('storage:openPairLink', async (raw: unknown) => {
    const value = z.string().url().parse(raw)
    const url = new URL(value)
    const botPath = url.pathname.replace(/^\//, '')
    if (url.protocol !== 'https:' || url.hostname !== 't.me' || !/^[A-Za-z0-9_]{5,64}$/.test(botPath)) {
      throw new Error('EXTERNAL_URL_REJECTED')
    }
    const start = url.searchParams.get('start')
    if (start !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(start)) throw new Error('EXTERNAL_URL_REJECTED')
    await shell.openExternal(url.toString())
  })
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: '#f5f7fb',
    title: APP_NAME,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (url !== current) event.preventDefault()
  })
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      window.hide()
      if (localDb?.getSettings().autoSync && localDb.counts().pending > 0) {
        void syncEngine?.syncNow().catch((error) => {
          localDb?.log('WINDOW_CLOSE_SYNC_ERROR', null, error instanceof Error ? error.message : String(error))
        })
      }
    }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  window.once('ready-to-show', () => window.show())
  return window
}

function updateTrayMenu(): void {
  if (!tray || !localDb || !syncEngine) return
  const counts = localDb.counts()
  const paused = syncEngine.isPaused()
  const status = paused
    ? '同步已暂停'
    : counts.errors > 0
      ? `${counts.errors} 个错误`
      : counts.conflicts > 0
        ? `${counts.conflicts} 个冲突`
        : counts.pending > 0
          ? `${counts.pending} 项等待同步`
          : '已同步'
  tray.setToolTip(`${APP_NAME} — ${status}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `状态：${status}`, enabled: false },
      { type: 'separator' },
      { label: '打开 ExcelSync', click: () => { mainWindow?.show(); mainWindow?.focus() } },
      { label: '立即同步', enabled: !paused, click: () => void syncEngine?.syncNow() },
      { label: localDb.getSettings().syncDirectory ? '打开同步文件夹' : '选择同步文件夹…', click: () => void openSyncDirectory().catch((error) => dialog.showErrorBox('同步文件夹', publicError(error).message)) },
      {
        label: paused ? '恢复同步' : '暂停同步',
        click: () => {
          const nextPaused = !syncEngine?.isPaused()
          const settings = localDb?.setSettings({ autoSync: !nextPaused })
          syncEngine?.setPaused(nextPaused)
          if (settings) sendStateChanged()
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          void requestGracefulQuit()
        }
      }
    ])
  )
}

async function requestGracefulQuit(): Promise<void> {
  if (shutdownInProgress || finalQuitReady) return
  shutdownInProgress = true
  quitting = true
  try {
    if (localDb && sessionStore && syncEngine) {
      const settings = localDb.getSettings()
      const counts = localDb.counts()
      const storedSession = await sessionStore.load()
      if (storedSession && settings.autoSync && counts.pending > 0) {
        tray?.setToolTip(`${APP_NAME} — 正在完成退出前同步…`)
        await syncEngine.flushBeforeExit()
      }
    }
  } catch (error) {
    localDb?.log('SHUTDOWN_SYNC_ERROR', null, error instanceof Error ? error.message : String(error))
  } finally {
    await telegramUserStorage?.stop().catch(() => undefined)
    await clearVersionPreviewCache(versionPreviewCacheRoot()).catch(() => undefined)
    finalQuitReady = true
    shutdownInProgress = false
    app.quit()
  }
}

function createTray(): void {
  const image = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64')).resize({ width: 16, height: 16 })
  tray = new Tray(image)
  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
  updateTrayMenu()
}

async function initialize(): Promise<void> {
  app.setName(APP_NAME)
  app.setAppUserModelId('com.excelsync.desktop')
  const stateDir = join(app.getPath('userData'), 'state')
  await mkdir(stateDir, { recursive: true })
  await pruneVersionPreviewCache(versionPreviewCacheRoot())
  localDb = new LocalDb(join(stateDir, 'excel-sync.sqlite'))
  localDb.requeueAuthBlocked()
  localDb.requeuePermissionBlocked()
  const configuredWorkerUrl = normalizeWorkerUrl(localDb.getSettings().workerUrl)
  if (!isAllowedWorkerUrl(configuredWorkerUrl, app.isPackaged) || LEGACY_WORKER_URLS.includes(configuredWorkerUrl as (typeof LEGACY_WORKER_URLS)[number])) {
    localDb.setSettings({ workerUrl: DEFAULT_WORKER_URL })
  }
  sessionStore = new SessionStore(app.getPath('userData'))
  workerApi = new WorkerApi(
    sessionStore,
    () => {
      const configured = normalizeWorkerUrl(localDb?.getSettings().workerUrl ?? '')
      return isAllowedWorkerUrl(configured, app.isPackaged) ? configured : DEFAULT_WORKER_URL
    },
    (input, init) => net.fetch(input, init),
    () => ({
      deviceName: hostname(),
      osName: process.platform === 'win32' ? 'Windows' : process.platform,
      osVersion: release(),
      clientVersion: app.getVersion()
    }),
    () => {
      syncEngine?.setCloudAccessEnabled(false)
      sendAuthChanged()
      sendStateChanged()
    }
  )
  const telegramStorageRoot = process.env.LOCALAPPDATA?.trim()
    ? join(process.env.LOCALAPPDATA, APP_NAME)
    : app.getPath('userData')
  const telegramConfigStore = new TelegramUserStorageConfigStore(telegramStorageRoot)
  telegramUserStorage = new TelegramUserStorageProvider(
    telegramConfigStore,
    app.isPackaged ? join(process.resourcesPath, 'telegram-storage-bridge.py') : join(app.getAppPath(), 'scripts', 'telegram-storage-bridge.py'),
    join(process.resourcesPath, 'telegram-storage-bridge.exe'),
    sendTransferProgress
  )
  let telegramConfig = await telegramConfigStore.load()
  if (!telegramConfig) {
    const localApiId = Number(process.env.EXCELSYNC_TELEGRAM_API_ID ?? 0)
    const localApiHash = process.env.EXCELSYNC_TELEGRAM_API_HASH?.trim() ?? ''
    if (Number.isInteger(localApiId) && localApiId > 0 && localApiHash.length >= 16) {
      await telegramUserStorage.configure(localApiId, localApiHash)
      telegramConfig = await telegramConfigStore.load()
    }
  }
  const localTelegramProxy = process.env.EXCELSYNC_TELEGRAM_PROXY_URL?.trim() ?? ''
  if (telegramConfig && localTelegramProxy && telegramConfig.proxyUrl !== localTelegramProxy) {
    await telegramUserStorage.configureProxy(localTelegramProxy)
  }
  desktopStorageRouter = new DesktopStorageRouter(workerApi, telegramUserStorage)
  syncEngine = new SyncEngine(localDb, workerApi, {
    onStateChanged: sendStateChanged,
    canSyncCloud: async () => Boolean(await sessionStore?.load())
  }, desktopStorageRouter, telegramUserStorage)
  syncEngine.setCloudAccessEnabled(Boolean(await sessionStore.load()))
  registerIpc()

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  await session.defaultSession.setProxy({ mode: 'system' })
  await session.defaultSession.forceReloadProxyConfig()

  mainWindow = createWindow()
  installChineseApplicationMenu()
  createTray()
  await syncEngine.start(localDb.getSettings())
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(initialize).catch((error) => {
    dialog.showErrorBox(APP_NAME, error instanceof Error ? error.message : String(error))
    quitting = true
    app.quit()
  })
}

app.on('before-quit', (event) => {
  quitting = true
  if (finalQuitReady) return
  event.preventDefault()
  void requestGracefulQuit()
})

app.on('window-all-closed', () => {
  // Keep the tray process alive on Windows until the user chooses Exit.
})

app.on('quit', () => {
  void syncEngine?.stop()
  void telegramUserStorage?.stop()
  localDb?.close()
})
