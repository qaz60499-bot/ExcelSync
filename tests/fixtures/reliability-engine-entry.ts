import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import { app, net, safeStorage, session } from 'electron'
import { ApiError, WorkerApi } from '../../src/main/api'
import { LocalDb } from '../../src/main/db'
import { SyncEngine } from '../../src/main/sync-engine'
import { DesktopStorageRouter } from '../../src/main/desktop-storage-router'

const projectRoot = process.env.EXCELSYNC_PROJECT_ROOT || process.cwd()
const artifactRoot = process.env.EXCELSYNC_REAL_E2E_ARTIFACT_ROOT || join(projectRoot, 'test-artifacts', 'reliability-20261125', 'real-e2e')
const reportPath = process.env.EXCELSYNC_REAL_E2E_REPORT || join(artifactRoot, 'fixture-e2e-report.json')
const productionHome = join(process.env.APPDATA || '', 'ExcelSync')
// Reuse the known-good isolated Electron profile used by the read-only parity run.
const isolatedUserData = join(artifactRoot, 'electron-userdata')
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`
const fixtureRoot = join(artifactRoot, 'fixture-root', runId)
const stateRoot = join(artifactRoot, 'fixture-state', runId)
const dbPath = join(stateRoot, 'excel-sync.sqlite')
const fileName = `Codex-Reliability-${runId}.xlsx`

type EvidenceRequest = { route: string; status?: number; ms: number; serverTiming?: string | null; errorCode?: string }
const requests: EvidenceRequest[] = []
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  mode: 'fixture-sync-e2e',
  transport: 'electron.net.fetch (same as desktop main process)',
  requestBudget: 200,
  requests,
  fixtureWorkspaceCreated: false,
  ok: false
}
let stage = 'bootstrap'
let workerBase = ''
let testWorkspaceId = ''
let originalDefaultWorkspaceId: string | null = null
let localDb: LocalDb | null = null
let engine: SyncEngine | null = null
let activeApi: WorkerApi | null = null
let engineStarted = false
let commitRejectCount = 0
let fetchCount = 0
let listAllWorkspaces = false
let networkOffline = false

function reportWrite(): void {
  const snapshot = { ...report, currentStage: stage, requestCount: fetchCount, updatedAt: new Date().toISOString() }
  mkdirSync(join(reportPath, '..'), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(snapshot, null, 2), 'utf8')
}

function sha256(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function routeLabel(url: URL): string {
  return url.pathname
    .replace(/\/files\/[0-9a-f-]{36}/gi, '/files/:fileId')
    .replace(/\/versions\/[0-9a-f-]{36}/gi, '/versions/:fileId')
    .replace(/\/workspaces\/[0-9a-f-]{36}/gi, '/workspaces/:workspaceId')
}

function safeMessage(error: unknown): string {
  const message = (error as { message?: unknown })?.message
  return String(message ?? 'UNKNOWN').replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/(token|password|secret)\s*[:=]\s*[^\s&,;]+/gi, '$1=[REDACTED]')
    .replace(/[A-Z]:\\[^\s]+/gi, '[LOCAL_PATH]').slice(0, 200)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor<T>(read: () => T | null | undefined | false, label: string, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value) return value as T
    await wait(250)
  }
  throw Object.assign(new Error(label), { code: label })
}

function pendingRow(db: LocalDb, fileId: string): Record<string, unknown> | null {
  return db.db.prepare('SELECT id, status, hash, size, base_version, idempotency_key, upload_receipt, retry_state, error_code FROM pending_sync WHERE file_id = ? ORDER BY created_at DESC LIMIT 1').get(fileId) as Record<string, unknown> | undefined ?? null
}

async function workbookBytes(initial: boolean): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'ExcelSync Reliability Fixture'
  workbook.subject = 'Isolated TEST Workspace sync acceptance'
  const sheet = workbook.addWorksheet('Fixture')
  sheet.getCell('A1').value = 'ExcelSync reliability fixture'
  sheet.getCell('B2').value = initial ? 3 : 7
  sheet.getCell('C2').value = { formula: initial ? 'B2*2' : 'B2*4' }
  sheet.getCell('B2').font = { bold: !initial, color: { argb: initial ? 'FF1F4E78' : 'FFC00000' } }
  sheet.getCell('C2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: initial ? 'FFD9EAF7' : 'FFFFFF00' } }
  sheet.getColumn(2).width = initial ? 14 : 24
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

async function main(): Promise<void> {
  try {
  if (process.env.EXCELSYNC_ALLOW_REAL_FIXTURE !== '1') throw new Error('REAL_FIXTURE_EXPLICIT_OPT_IN_REQUIRED')
  if (!process.env.APPDATA) throw Object.assign(new Error('APPDATA_MISSING'), { code: 'APPDATA_MISSING' })
  stage = 'copy-local-state-before-ready'
  mkdirSync(isolatedUserData, { recursive: true })
  copyFileSync(join(productionHome, 'Local State'), join(isolatedUserData, 'Local State'))
  app.setName('ExcelSync')
  app.setPath('userData', isolatedUserData)
  await app.whenReady()
  await session.defaultSession.setProxy({ mode: 'system' })

  stage = 'decrypt-session-in-memory'
  if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error('SAFE_STORAGE_UNAVAILABLE'), { code: 'SAFE_STORAGE_UNAVAILABLE' })
  const auth = JSON.parse(safeStorage.decryptString(await readFile(join(productionHome, 'secure', 'session.bin')))) as {
    token: string; expiresAt: string; username: string; deviceId?: string | null
  }
  if (!auth.token || !Number.isFinite(Date.parse(auth.expiresAt)) || Date.parse(auth.expiresAt) <= Date.now()) {
    throw Object.assign(new Error('SESSION_UNAVAILABLE_OR_EXPIRED'), { code: 'SESSION_UNAVAILABLE_OR_EXPIRED' })
  }

  stage = 'read-production-worker-url-readonly'
  const prodDb = new DatabaseSync(join(productionHome, 'state', 'excel-sync.sqlite'), { readOnly: true })
  try {
    const row = prodDb.prepare("SELECT value_json FROM settings WHERE key = 'workerUrl'").get() as { value_json?: string } | undefined
    workerBase = String(row?.value_json ? JSON.parse(row.value_json) : '').replace(/\/+$/, '')
  } finally {
    prodDb.close()
  }
  if (!workerBase.startsWith('https://')) throw Object.assign(new Error('WORKER_URL_UNAVAILABLE'), { code: 'WORKER_URL_UNAVAILABLE' })

  const sessionStore = {
    async load() { return auth },
    async stableDeviceId() { return auth.deviceId || isolatedDeviceId }
  }
  const identity = { deviceName: 'Codex Isolated Reliability Fixture', osName: 'windows', osVersion: process.version,
    clientVersion: JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).version as string }
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    if (url.pathname === '/files/list' && testWorkspaceId && !listAllWorkspaces) url.searchParams.set('workspaceId', testWorkspaceId)
    let scopedInit = init
    if (networkOffline) {
      requests.push({ route: routeLabel(url), ms: 0, errorCode: 'INJECTED_OFFLINE' })
      throw new TypeError('Injected offline transport')
    }
    if (url.pathname === '/sync/preflight' && testWorkspaceId && typeof init?.body === 'string') {
      const input = JSON.parse(init.body) as Record<string, unknown>
      scopedInit = { ...init, body: JSON.stringify({ ...input, workspaceId: testWorkspaceId }) }
    }
    fetchCount += 1
    if (fetchCount > 200) throw Object.assign(new Error('REQUEST_BUDGET_EXCEEDED'), { code: 'REQUEST_BUDGET_EXCEEDED' })
    const started = Date.now()
    try {
      const response = await net.fetch(url.toString(), scopedInit)
      requests.push({ route: routeLabel(url), status: response.status, ms: Date.now() - started, serverTiming: response.headers.get('server-timing') })
      reportWrite()
      return response
    } catch (error) {
      const candidate = error as { code?: string; name?: string }
      requests.push({ route: routeLabel(url), ms: Date.now() - started, errorCode: candidate.code || candidate.name || 'NETWORK_ERROR' })
      reportWrite()
      throw error
    }
  }
  const api = new WorkerApi(sessionStore as never, () => workerBase, fetcher, () => identity)
  activeApi = api

  stage = 'verify-existing-bot-storage-and-default-workspace'
  const before = await api.workspaces()
  const originalDefaultId = before.defaultWorkspaceId
  originalDefaultWorkspaceId = originalDefaultId
  const originalDefaultWorkspace = before.workspaces.find((workspace) => workspace.id === originalDefaultId)
  if (!originalDefaultId || !originalDefaultWorkspace) throw Object.assign(new Error('DEFAULT_WORKSPACE_UNAVAILABLE'), { code: 'DEFAULT_WORKSPACE_UNAVAILABLE' })
  const originalStorageId = originalDefaultWorkspace.default_storage_connection_id
  if (!originalStorageId) throw Object.assign(new Error('DEFAULT_WORKER_BOT_STORAGE_UNAVAILABLE'), { code: 'DEFAULT_WORKER_BOT_STORAGE_UNAVAILABLE' })
  const connections = await api.storageConnections()
  const originalStorage = connections.find((connection) => connection.id === originalStorageId)
  if (!originalStorage || originalStorage.provider !== 'telegram' || originalStorage.credentialSource !== 'LEGACY_WORKER_SECRET' || originalStorage.status === 'DISABLED') {
    throw Object.assign(new Error('EXISTING_LEGACY_BOT_STORAGE_NOT_CONFIRMED'), { code: 'EXISTING_LEGACY_BOT_STORAGE_NOT_CONFIRMED' })
  }
  report.storageRoute = { provider: originalStorage.provider, credentialSource: originalStorage.credentialSource, status: originalStorage.status }
  report.defaultWorkspacePreserved = true

  stage = 'create-isolated-test-workspace'
  const fixtureWorkspaceName = `Codex Reliability Fixture ${runId}`
  let createdWorkspace: { id: string; name: string }
  try {
    createdWorkspace = await api.createWorkspace({ name: fixtureWorkspaceName, type: 'PROJECT', defaultStorageConnectionId: originalStorageId })
  } catch (error) {
    // A lost response must not lead us to repeat a non-idempotent Workspace create.
    const matches = (await api.workspaces()).workspaces.filter((workspace) => workspace.name === fixtureWorkspaceName)
    if (matches.length === 1) {
      testWorkspaceId = matches[0]!.id
      report.fixtureWorkspaceCreated = true
      report.fixtureWorkspaceId = testWorkspaceId
      report.fixtureWorkspaceName = fixtureWorkspaceName
      reportWrite()
    }
    throw error
  }
  testWorkspaceId = createdWorkspace.id
  report.fixtureWorkspaceCreated = true
  report.fixtureWorkspaceId = testWorkspaceId
  report.fixtureWorkspaceName = createdWorkspace.name
  reportWrite()

  // Keep the production sync engine's remote reconciliation within the fixture Workspace.
  // The general Telegram import endpoint targets the account's default Workspace, so it is
  // intentionally suppressed for this isolated fixture run.
  api.pullTelegramImports = async () => ({ importedCount: 0 })
  await mkdir(fixtureRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  localDb = new LocalDb(dbPath)
  const settings = {
    ...localDb.getSettings(), syncDirectory: fixtureRoot, workerUrl: workerBase, autoSync: true,
    retryBaseSeconds: 2, defaultStorageBackend: 'telegram_bot' as const
  }
  engine = new SyncEngine(localDb, api, {}, new DesktopStorageRouter(api, {} as never))
  await engine.start(settings)
  engineStarted = true
  await engine.pullRemoteChanges(true)
  report.localDatabasePath = '[isolated fixture database]'
  report.localRoot = '[isolated fixture root]'

  const localPath = join(fixtureRoot, fileName)
  const relativePath = basename(fileName)
  stage = 'create-real-exceljs-initial-workbook'
  const initialBytes = await workbookBytes(true)
  await import('node:fs/promises').then(({ writeFile }) => writeFile(localPath, initialBytes))
  const initialHash = sha256(initialBytes)

  stage = 'engine-first-upload-v1'
  await engine.handleFileReady(localPath, undefined, 'telegram_bot')
  await engine.syncNow()
  let localFile = await waitFor(() => localDb?.getFileByPath(relativePath), 'LOCAL_FILE_ROW_MISSING')
  await waitFor(() => {
    const current = localDb?.getFile(localFile.id)
    return current?.current_version === 1 && current.status === 'SYNCED' ? current : null
  }, 'FIRST_UPLOAD_NOT_SYNCED')
  localFile = localDb!.getFile(localFile.id)!
  const fileId = localFile.id
  const initialCloud = await api.downloadCurrent(fileId)
  const initialVersions = await api.versions(fileId)
  const initialWorkbook = new ExcelJS.Workbook()
  await initialWorkbook.xlsx.read(Readable.from([initialCloud.bytes]))
  const initialSheet = initialWorkbook.getWorksheet('Fixture')
  const initialFill = initialSheet?.getCell('C2').fill
  const initialFormula = initialSheet?.getCell('C2').value
  const initialContent = {
    cell: initialSheet?.getCell('B2').value,
    formula: typeof initialFormula === 'object' && initialFormula && 'formula' in initialFormula ? initialFormula.formula : initialFormula,
    bold: Boolean(initialSheet?.getCell('B2').font?.bold),
    fill: initialFill?.type === 'pattern' ? initialFill.fgColor?.argb : null
  }
  const initialWorkspaceFiles = await api.filesList()
  const uploadedCloudFile = initialWorkspaceFiles.find((file) => file.id === fileId) as (typeof initialWorkspaceFiles[number] & { workspace_id?: string }) | undefined
  report.firstUpload = {
    local: { version: localFile.current_version, hash: localFile.current_hash, bytesSha256: initialHash },
    cloud: { version: initialCloud.version, hash: initialCloud.hash, downloadedBytesSha256: sha256(initialCloud.bytes) },
    workspaceIdMatchesTest: uploadedCloudFile?.workspace_id === testWorkspaceId,
    versions: initialVersions.map((version) => version.version), content: initialContent,
    shaMatches: sha256(initialCloud.bytes) === initialHash && localFile.current_hash === initialHash
  }
  if (!uploadedCloudFile || uploadedCloudFile.workspace_id !== testWorkspaceId || initialCloud.version !== 1 || sha256(initialCloud.bytes) !== initialHash || localFile.current_hash !== initialHash || initialVersions.length !== 1 || initialContent.cell !== 3 || initialContent.formula !== 'B2*2') {
    throw Object.assign(new Error('FIRST_UPLOAD_PARITY_FAILED'), { code: 'FIRST_UPLOAD_PARITY_FAILED' })
  }

  stage = 'same-hash-dedupe'
  await engine.handleFileReady(localPath, undefined, 'telegram_bot')
  await engine.syncNow()
  const dedupeFile = localDb!.getFile(fileId)
  const afterDedupeVersions = await api.versions(fileId)
  report.dedupe = { localVersion: dedupeFile?.current_version, cloudVersions: afterDedupeVersions.map((version) => version.version), sameHash: dedupeFile?.current_hash === initialHash }
  if (dedupeFile?.current_version !== 1 || afterDedupeVersions.length !== 1) throw Object.assign(new Error('SAME_HASH_DEDUPE_FAILED'), { code: 'SAME_HASH_DEDUPE_FAILED' })

  stage = 'edit-cell-formula-style-and-upload-v2'
  const edited = new ExcelJS.Workbook()
  await edited.xlsx.readFile(localPath)
  const sheet = edited.getWorksheet('Fixture')
  if (!sheet) throw Object.assign(new Error('WORKSHEET_MISSING'), { code: 'WORKSHEET_MISSING' })
  sheet.getCell('B2').value = 7
  sheet.getCell('C2').value = { formula: 'B2*4' }
  sheet.getCell('B2').font = { bold: true, color: { argb: 'FFC00000' } }
  sheet.getCell('C2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }
  sheet.getColumn(2).width = 24
  await edited.xlsx.writeFile(localPath)
  const editedBytes = await readFile(localPath)
  const editedHash = sha256(editedBytes)
  await engine.handleFileReady(localPath, undefined, 'telegram_bot')
  await engine.syncNow()
  localFile = localDb!.getFile(fileId)!
  await waitFor(() => {
    const current = localDb?.getFile(fileId)
    return current?.current_version === 2 && current.status === 'SYNCED' ? current : null
  }, 'EDIT_NOT_SYNCED')
  localFile = localDb!.getFile(fileId)!
  const editedCloud = await api.downloadCurrent(fileId)
  const editedVersions = await api.versions(fileId)
  const editedWorkbook = new ExcelJS.Workbook()
  await editedWorkbook.xlsx.read(Readable.from([editedCloud.bytes]))
  const editedSheet = editedWorkbook.getWorksheet('Fixture')
  const editedFill = editedSheet?.getCell('C2').fill
  const editedFormula = editedSheet?.getCell('C2').value
  const editedContent = { cell: editedSheet?.getCell('B2').value, formula: editedSheet?.getCell('C2').value,
    bold: editedSheet?.getCell('B2').font?.bold, fill: editedFill?.type === 'pattern' ? editedFill.fgColor?.argb : null,
    width: editedSheet?.getColumn(2).width }
  report.editedUpload = {
    local: { version: localFile.current_version, hash: localFile.current_hash, bytesSha256: editedHash },
    cloud: { version: editedCloud.version, hash: editedCloud.hash, downloadedBytesSha256: sha256(editedCloud.bytes) },
    versions: editedVersions.map((version) => version.version), content: editedContent,
    shaMatches: sha256(editedCloud.bytes) === editedHash && localFile.current_hash === editedHash
  }
  const editedFormulaText = typeof editedFormula === 'object' && editedFormula && 'formula' in editedFormula ? editedFormula.formula : editedFormula
  if (editedCloud.version !== 2 || sha256(editedCloud.bytes) !== editedHash || localFile.current_hash !== editedHash ||
      editedVersions.length !== 2 || editedContent.cell !== 7 || editedFormulaText !== 'B2*4' || editedContent.bold !== true || editedContent.fill !== 'FFFFFF00') {
    throw Object.assign(new Error('EDIT_UPLOAD_PARITY_FAILED'), { code: 'EDIT_UPLOAD_PARITY_FAILED' })
  }

  stage = 'simulate-local-commit-adapter-rejection-after-real-upload'
  const receiptEdited = new ExcelJS.Workbook()
  await receiptEdited.xlsx.readFile(localPath)
  const receiptSheet = receiptEdited.getWorksheet('Fixture')!
  receiptSheet.getCell('B2').value = 11
  receiptSheet.getCell('C2').value = { formula: 'B2*5' }
  receiptSheet.getCell('B2').font = { bold: true, italic: true, color: { argb: 'FF7030A0' } }
  receiptSheet.getCell('C2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2F0D9' } }
  await receiptEdited.xlsx.writeFile(localPath)
  const receiptBytes = await readFile(localPath)
  const receiptHash = sha256(receiptBytes)
  const originalCommit = api.commit.bind(api)
  api.commit = async () => {
    commitRejectCount += 1
    engine!.setPaused(true)
    throw new ApiError('LOCAL_FIXTURE_COMMIT_REJECTED', 0, true)
  }
  await engine.handleFileReady(localPath, undefined, 'telegram_bot')
  await engine.syncNow()
  const pending = await waitFor(() => {
    const row = pendingRow(localDb!, fileId)
    return row?.upload_receipt && row.status === 'RETRY_WAIT' ? row : null
  }, 'SIGNED_RECEIPT_NOT_PERSISTED')
  const persistedReceipt = JSON.parse(String(pending.upload_receipt)) as { backend: string; intentId: string; sha256: string; size: number }
  const savedRetryState = JSON.parse(String(pending.retry_state || '{}')) as { intentId?: string }
  if (persistedReceipt.backend !== 'telegram_bot' || persistedReceipt.sha256 !== receiptHash || commitRejectCount !== 1) {
    throw Object.assign(new Error('COMMIT_REJECTION_DID_NOT_FOLLOW_REAL_UPLOAD'), { code: 'COMMIT_REJECTION_DID_NOT_FOLLOW_REAL_UPLOAD' })
  }
  const beforeRecoveryVersions = await api.versions(fileId)
  if (beforeRecoveryVersions.length !== 2) throw Object.assign(new Error('CLOUD_ADVANCED_BEFORE_COMMIT_RECOVERY'), { code: 'CLOUD_ADVANCED_BEFORE_COMMIT_RECOVERY' })
  report.receiptPersistence = { backend: persistedReceipt.backend, intentId: persistedReceipt.intentId, hash: persistedReceipt.sha256,
    size: persistedReceipt.size, tokenRedacted: true, workerVersionsBeforeRecovery: beforeRecoveryVersions.map((version) => version.version),
    retryStateIntentMatches: savedRetryState.intentId === persistedReceipt.intentId,
    commitRejectedLocally: commitRejectCount === 1, cloudD1UploadIntentRemainsLive: true }

  stage = 'restart-engine-and-sqlite-recover-same-receipt'
  api.commit = originalCommit
  await engine.stop()
  engineStarted = false
  localDb.close()
  localDb = new LocalDb(dbPath)
  const recoveredPendingBefore = pendingRow(localDb, fileId)
  if (!recoveredPendingBefore?.upload_receipt) throw Object.assign(new Error('RECEIPT_DID_NOT_SURVIVE_SQLITE_REOPEN'), { code: 'RECEIPT_DID_NOT_SURVIVE_SQLITE_REOPEN' })
  engine = new SyncEngine(localDb, api, {}, new DesktopStorageRouter(api, {} as never))
  const recoveryRequestStart = requests.length
  localDb.requeuePending(String(recoveredPendingBefore.id))
  await engine.start({ ...settings, autoSync: false })
  engineStarted = true
  engine.setPaused(false)
  await wait(2500)
  await engine.syncNow()
  localFile = localDb.getFile(fileId)!
  await waitFor(() => {
    const current = localDb?.getFile(fileId)
    return current?.current_version === 3 && current.status === 'SYNCED' ? current : null
  }, 'RECEIPT_RECOVERY_COMMIT_FAILED')
  localFile = localDb.getFile(fileId)!
  const recoveredCloud = await api.downloadCurrent(fileId)
  const recoveredVersions = await api.versions(fileId)
  const recoveredWorkbook = new ExcelJS.Workbook()
  await recoveredWorkbook.xlsx.read(Readable.from([recoveredCloud.bytes]))
  const recoveredSheet = recoveredWorkbook.getWorksheet('Fixture')
  report.receiptRecovery = {
    local: { version: localFile.current_version, hash: localFile.current_hash, bytesSha256: receiptHash },
    cloud: { version: recoveredCloud.version, hash: recoveredCloud.hash, downloadedBytesSha256: sha256(recoveredCloud.bytes) },
    versions: recoveredVersions.map((version) => version.version),
    content: { cell: recoveredSheet?.getCell('B2').value, formula: recoveredSheet?.getCell('C2').value, bold: recoveredSheet?.getCell('B2').font?.bold },
    sameIntentIdRecovered: savedRetryState.intentId === persistedReceipt.intentId && recoveredVersions.length === 3 && recoveredCloud.version === 3 && localFile.current_hash === receiptHash && sha256(recoveredCloud.bytes) === receiptHash,
    sameHashNoTelegramResend: !requests.slice(recoveryRequestStart).some((request) => request.route === '/sync/upload')
  }
  if (recoveredCloud.version !== 3 || sha256(recoveredCloud.bytes) !== receiptHash || localFile.current_hash !== receiptHash ||
      recoveredVersions.length !== 3 || recoveredSheet?.getCell('B2').value !== 11 || recoveredSheet?.getCell('C2').formula !== 'B2*5') {
    throw Object.assign(new Error('RECEIPT_RECOVERY_PARITY_FAILED'), { code: 'RECEIPT_RECOVERY_PARITY_FAILED' })
  }

  stage = 'historical-version-download-sha256'
  const history = []
  for (const [version, expectedHash] of [[1, initialHash], [2, editedHash]] as const) {
    const downloaded = await api.downloadVersion(fileId, version)
    const metadata = recoveredVersions.find(row => row.version === version)
    const actualHash = sha256(downloaded.bytes)
    history.push({ version, bytes: downloaded.bytes.byteLength, expectedHash, downloadedHash: actualHash, d1Hash: metadata?.hash })
    if (actualHash !== expectedHash || metadata?.hash !== actualHash) throw new Error('HISTORY_SHA256_MISMATCH')
  }
  report.historicalDownloads = history

  stage = 'offline-save-and-sqlite-restart'
  await engine.stop()
  engineStarted = false
  networkOffline = true
  engine = new SyncEngine(localDb, api, {}, new DesktopStorageRouter(api, {} as never))
  await engine.start(settings)
  engineStarted = true
  const offlineBook = new ExcelJS.Workbook()
  await offlineBook.xlsx.readFile(localPath)
  offlineBook.getWorksheet('Fixture')!.getCell('B2').value = 13
  await offlineBook.xlsx.writeFile(localPath)
  const offlineHash = sha256(await readFile(localPath))
  await engine.handleFileReady(localPath, undefined, 'telegram_bot')
  const offlinePending = await waitFor(() => {
    const row = pendingRow(localDb!, fileId)
    return row?.status === 'RETRY_WAIT' ? row : null
  }, 'OFFLINE_SAVE_NOT_DURABLE')
  await engine.stop()
  engineStarted = false
  localDb.close()
  localDb = new LocalDb(dbPath)
  const survived = pendingRow(localDb, fileId)
  if (survived?.hash !== offlineHash) throw new Error('OFFLINE_QUEUE_LOST_ON_RESTART')
  networkOffline = false
  localDb.requeuePending(String(offlinePending.id))
  engine = new SyncEngine(localDb, api, {}, new DesktopStorageRouter(api, {} as never))
  await engine.start({ ...settings, autoSync: false })
  engineStarted = true
  engine.setPaused(false)
  await engine.syncNow()
  await waitFor(() => localDb?.getFile(fileId)?.current_version === 4, 'OFFLINE_RECONNECT_FAILED')
  const offlineCloud = await api.downloadCurrent(fileId)
  report.offlineRestart = { fault: 'injected disconnected transport', persistedHash: survived.hash,
    downloadedHash: sha256(offlineCloud.bytes), version: offlineCloud.version, bytesPreserved: offlineHash === sha256(offlineCloud.bytes) }
  if (offlineCloud.version !== 4 || offlineHash !== sha256(offlineCloud.bytes)) throw new Error('OFFLINE_RECONNECT_HASH_MISMATCH')

  stage = 'real-large-csv-transfer'
  const csvName = fileName.replace(/\.xlsx$/, '.csv')
  const csvPath = join(fixtureRoot, csvName)
  const csvBytes = Buffer.from('sequence,value\n' + '12345678,abcdefgh\n'.repeat(500_000))
  await import('node:fs/promises').then(({ writeFile }) => writeFile(csvPath, csvBytes))
  const csvHash = sha256(csvBytes)
  const transferStarted = Date.now()
  await engine.handleFileReady(csvPath, undefined, 'telegram_bot')
  await engine.syncNow()
  const csvFile = await waitFor(() => {
    const row = localDb?.getFileByPath(csvName)
    return row?.current_version === 1 && row.status === 'SYNCED' ? row : null
  }, 'LARGE_CSV_UPLOAD_FAILED')
  const uploadMs = Date.now() - transferStarted
  const downloadStarted = Date.now()
  const csvCloud = await api.downloadCurrent(csvFile.id)
  const bufferedDownloadMs = Date.now() - downloadStarted
  const diskStarted = Date.now()
  const benchmarkBytes = await readFile(csvPath)
  const readMs = Date.now() - diskStarted
  const hashStarted = Date.now()
  const benchmarkHash = sha256(benchmarkBytes)
  const hashMs = Date.now() - hashStarted
  const streamStarted = Date.now()
  const streamed = await api.downloadTo(csvFile.id, join(stateRoot, 'large-csv-download.csv'))
  const streamDownloadMs = Date.now() - streamStarted
  const writtenHash = sha256(await readFile(join(stateRoot, 'large-csv-download.csv')))
  const csvVersion = await api.versions(csvFile.id)
  report.largeCsv = { bytes: csvBytes.byteLength, uploadMs, downloadMs: bufferedDownloadMs,
    readMs, hashMs, streamDownloadMs, streamedHash: streamed.hash, writtenHash, benchmarkHash,
    localHash: csvFile.current_hash, downloadedHash: sha256(csvCloud.bytes), d1Hash: csvVersion[0]?.hash,
    version: csvCloud.version, shaMatches: csvHash === sha256(csvCloud.bytes) && csvVersion[0]?.hash === csvHash }
  if (csvHash !== sha256(csvCloud.bytes) || csvVersion[0]?.hash !== csvHash) throw new Error('LARGE_CSV_HASH_MISMATCH')
  if (streamed.hash !== csvHash || writtenHash !== csvHash || benchmarkHash !== csvHash) throw new Error('STREAM_CSV_HASH_MISMATCH')

  report.defaultWorkspacePreserved = (await api.workspaces()).defaultWorkspaceId === originalDefaultId
  if (!report.defaultWorkspacePreserved) throw Object.assign(new Error('ACCOUNT_DEFAULT_WORKSPACE_CHANGED'), { code: 'ACCOUNT_DEFAULT_WORKSPACE_CHANGED' })
  report.ok = true
  } catch (error) {
    const candidate = error as { code?: string; name?: string }
    report.errorCode = candidate.code || candidate.name || 'ERROR'
    report.errorName = candidate.name || 'unknown'
    report.errorMessage = safeMessage(error)
    report.failedAtStage = stage
    report.ok = false
} finally {
  stage = 'cleanup-cloud-fixture-files'
  try {
    if (engine && engineStarted) {
      await engine.stop()
      engineStarted = false
    }
    if (localDb?.db.isOpen) localDb.close()
    if (testWorkspaceId && workerBase && fetchCount < 200 && activeApi) {
      listAllWorkspaces = true
      const remaining = await activeApi.filesList()
      listAllWorkspaces = false
      const exactRunFiles = remaining.filter((item) => item.logical_name.startsWith(fileName.replace(/\.xlsx$/, '.')))
      for (const file of exactRunFiles.filter((item) => item.status === 'active')) {
        await activeApi.trashFile(file.id, file.current_version)
      }
      listAllWorkspaces = true
      const globalAfter = await activeApi.filesList()
      const activeSameRun = globalAfter.filter((file) => file.logical_name.startsWith(fileName.replace(/\.xlsx$/, '.')) && file.status === 'active')
      if (activeSameRun.length !== 0) throw Object.assign(new Error('ACTIVE_FIXTURE_FILES_REMAIN'), { code: 'ACTIVE_FIXTURE_FILES_REMAIN' })
      listAllWorkspaces = false
      const after = await activeApi.filesList()
      const active = after.filter((file) => file.status === 'active')
      report.cleanup = { workspaceChecked: true, fixtureFileCount: after.length, trashedFileCount: after.filter((file) => file.status === 'trashed').length,
        activeFixtureFileCount: active.length, globalActiveExactRunFileCount: activeSameRun.length, physicalTelegramDeletes: 0, verified: active.length === 0 && activeSameRun.length === 0 }
      if (active.length !== 0) throw Object.assign(new Error('ACTIVE_FIXTURE_FILES_REMAIN'), { code: 'ACTIVE_FIXTURE_FILES_REMAIN' })
      await activeApi.archiveWorkspace(testWorkspaceId)
      const afterWorkspace = await activeApi.workspaces()
      report.defaultWorkspacePreserved = afterWorkspace.defaultWorkspaceId === originalDefaultWorkspaceId
      report.testWorkspaceArchived = afterWorkspace.workspaces.find((workspace) => workspace.id === testWorkspaceId)?.status === 'ARCHIVED'
    }
  } catch (cleanupError) {
    const e = cleanupError as { code?: string; name?: string }
    report.cleanupErrorCode = e.code || e.name || 'CLEANUP_ERROR'
    report.ok = false
  }
  // Retain the isolated SQLite and bytes under ignored test-artifacts for inspection.
  report.requestCount = fetchCount
  report.finishedAt = new Date().toISOString()
  report.errorStage = report.ok ? undefined : report.failedAtStage ?? stage
  await mkdir(join(reportPath, '..'), { recursive: true })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  app.quit()
}
}

const isolatedDeviceId = randomUUID()
void main()
