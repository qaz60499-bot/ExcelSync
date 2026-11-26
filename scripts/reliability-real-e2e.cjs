#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const artifactRoot = path.join(root, 'test-artifacts', 'reliability-20261125', 'real-e2e')
const reportPath = path.join(artifactRoot, 'readonly-parity.json')

function redact(value) {
  return String(value ?? '').replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/(token|password|secret)\s*[:=]\s*[^\s&,;]+/gi, '$1=[REDACTED]')
    .replace(/[A-Z]:\\[^\s]+/gi, '[LOCAL_PATH]').slice(0, 240)
}

function launch() {
  const args = process.argv.slice(2)
  if (args.length !== 3 || args[0] !== '--readonly-parity' || args[1] !== '--file-id') {
    throw new Error('Usage: node scripts/reliability-real-e2e.cjs --readonly-parity --file-id <UUID>')
  }
  const fileId = args[2]
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new Error('--file-id must be a UUID.')
  fs.mkdirSync(artifactRoot, { recursive: true })
  const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!fs.existsSync(electron)) throw new Error('Installed Electron binary is missing.')
  const child = spawnSync(electron, [__filename], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, EXCELSYNC_PROJECT_ROOT: root, EXCELSYNC_REAL_E2E_ARTIFACT_ROOT: artifactRoot,
      EXCELSYNC_REAL_E2E_REPORT: reportPath, EXCELSYNC_REAL_E2E_FILE_ID: fileId }
  })
  let report = null
  if (fs.existsSync(reportPath)) report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  process.stdout.write(`${JSON.stringify({ exitCode: child.status, reportPath, report,
    stderr: child.stderr?.trim() ? redact(child.stderr.trim().slice(-800)) : null,
    launchError: child.error ? redact(child.error.message) : null }, null, 2)}\n`)
  if (child.status !== 0 || !report?.ok) process.exitCode = 1
}

async function hashFile(filePath) {
  const { createHash } = require('node:crypto')
  const { createReadStream } = require('node:fs')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function runElectron() {
  const { app, net, safeStorage, session } = require('electron')
  const { DatabaseSync } = require('node:sqlite')
  const projectRoot = process.env.EXCELSYNC_PROJECT_ROOT || root
  const artifacts = process.env.EXCELSYNC_REAL_E2E_ARTIFACT_ROOT || artifactRoot
  const output = process.env.EXCELSYNC_REAL_E2E_REPORT || reportPath
  const id = process.env.EXCELSYNC_REAL_E2E_FILE_ID || ''
  const evidence = []
  const report = { startedAt: new Date().toISOString(), mode: 'readonly-parity', transport: 'globalThis.fetch', fileId: id,
      requestBudget: 3, requests: evidence, ok: false }
  let db = null
  let stage = 'copy-production-local-state-before-ready'
  try {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw Object.assign(new Error('FILE_ID_REQUIRED'), { code: 'FILE_ID_REQUIRED' })
    const appData = process.env.APPDATA
    if (!appData) throw Object.assign(new Error('APPDATA_MISSING'), { code: 'APPDATA_MISSING' })
    const productionHome = path.join(appData, 'ExcelSync')
    const isolatedUserData = path.join(artifacts, 'electron-userdata')
    fs.mkdirSync(isolatedUserData, { recursive: true })
    fs.copyFileSync(path.join(productionHome, 'Local State'), path.join(isolatedUserData, 'Local State'))
    app.setName('ExcelSync')
    app.setPath('userData', isolatedUserData)
    stage = 'electron-ready-system-proxy'
    await app.whenReady()
    await session.defaultSession.setProxy({ mode: 'system' })
    stage = 'decrypt-session-in-memory'
    const auth = JSON.parse(safeStorage.decryptString(fs.readFileSync(path.join(productionHome, 'secure', 'session.bin'))))
    if (!auth.token || Date.parse(auth.expiresAt) <= Date.now()) throw Object.assign(new Error('SESSION_UNAVAILABLE_OR_EXPIRED'), { code: 'SESSION_UNAVAILABLE_OR_EXPIRED' })
    stage = 'read-local-sqlite-row'
    db = new DatabaseSync(path.join(productionHome, 'state', 'excel-sync.sqlite'), { readOnly: true })
    const setting = (key) => {
      const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key)
      return row?.value_json ? JSON.parse(row.value_json) : ''
    }
    const base = String(setting('workerUrl')).replace(/\/+$/, '')
    const syncRoot = path.resolve(String(setting('syncDirectory')))
    const local = db.prepare('SELECT id, relative_path, current_version, current_hash FROM files WHERE id = ? LIMIT 1').get(id)
    if (!local) throw Object.assign(new Error('LOCAL_FILE_ID_NOT_FOUND'), { code: 'LOCAL_FILE_ID_NOT_FOUND' })
    const localPath = path.resolve(syncRoot, local.relative_path)
    if (!localPath.toLowerCase().startsWith(`${syncRoot.toLowerCase()}${path.sep}`)) throw Object.assign(new Error('LOCAL_PATH_OUTSIDE_SYNC_ROOT'), { code: 'LOCAL_PATH_OUTSIDE_SYNC_ROOT' })
    const stat = fs.statSync(localPath)
    if (!stat.isFile()) throw Object.assign(new Error('LOCAL_TARGET_NOT_FILE'), { code: 'LOCAL_TARGET_NOT_FILE' })
    const localSha = await hashFile(localPath)
    const versionClient = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version
    if (!base.startsWith('https://')) throw Object.assign(new Error('WORKER_URL_UNAVAILABLE'), { code: 'WORKER_URL_UNAVAILABLE' })
    const headers = { authorization: `Bearer ${auth.token}`, 'x-excelsync-client-version': versionClient,
      'x-excelsync-api-version': '2026-08-31' }
    const request = async (route, label) => {
      const started = Date.now()
      try {
        const response = await globalThis.fetch(`${base}${route}`, { method: 'GET', headers, signal: AbortSignal.timeout(60_000) })
        let errorCode = null
        if (!response.ok) {
          try { errorCode = (await response.clone().json()).error?.code || `HTTP_${response.status}` }
          catch { errorCode = `HTTP_${response.status}` }
        }
        evidence.push({ route: label, status: response.status, ms: Date.now() - started, errorCode })
        return response
      } catch (error) {
        evidence.push({ route: label, ms: Date.now() - started, errorCode: error.code || error.name || 'NETWORK_ERROR' })
        throw error
      }
    }
    const encodedId = encodeURIComponent(id)
    stage = 'worker-d1-version-metadata'
    const versionResponse = await request(`/versions/${encodedId}`, '/versions/:fileId')
    if (!versionResponse.ok) throw Object.assign(new Error(`WORKER_VERSIONS_${versionResponse.status}`), { code: `HTTP_${versionResponse.status}` })
    const versions = (await versionResponse.json()).versions || []
    const d1Current = versions.find((row) => row.version === local.current_version) || null
    report.workerHost = new URL(base).host
    report.local = { sqliteVersion: local.current_version, sqliteHash: local.current_hash, bytesSha256: localSha, bytes: stat.size }
    report.workerMetadata = { localCurrentVersion: local.current_version,
      matchingD1Version: d1Current ? { version: d1Current.version, hash: d1Current.hash, size: d1Current.size, status: d1Current.status } : null,
      returnedVersionCount: versions.length, buildVersion: 'not exposed by these endpoints' }
    stage = 'worker-current-download-and-hash'
    let download = null
    let bytes = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      download = await request(`/files/${encodedId}/download`, '/files/:fileId/download')
      if (!download.ok) throw Object.assign(new Error(`WORKER_DOWNLOAD_${download.status}`), { code: `HTTP_${download.status}` })
      try {
        bytes = new Uint8Array(await download.arrayBuffer())
        break
      } catch (error) {
        const message = String(error.message || error)
        evidence.push({ route: '/files/:fileId/download-body', status: download.status, attempt,
          errorCode: message.match(/net::ERR_[A-Z_]+/)?.[0] || error.code || error.name || 'BODY_READ_ERROR' })
        if (attempt === 2) throw error
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
    }
    if (!download || !bytes) throw Object.assign(new Error('DOWNLOAD_BODY_UNAVAILABLE'), { code: 'DOWNLOAD_BODY_UNAVAILABLE' })
    const { createHash } = require('node:crypto')
    const cloudSha = createHash('sha256').update(bytes).digest('hex')
    const cloudVersion = Number(download.headers.get('x-excelsync-version') || 0)
    const headerHash = download.headers.get('x-excelsync-hash')?.toLowerCase() || null
    const d1DownloadVersion = versions.find((row) => row.version === cloudVersion) || null
    const checks = {
      localBytesMatchLocalSqliteHash: Boolean(local.current_hash && localSha === local.current_hash.toLowerCase()),
      localBytesMatchWorkerDownload: localSha === cloudSha,
      downloadMatchesWorkerHashHeader: Boolean(headerHash && cloudSha === headerHash),
      localVersionMatchesWorkerVersion: local.current_version === cloudVersion,
      currentWorkerVersionHasD1Metadata: Boolean(d1DownloadVersion),
      downloadMatchesD1VersionHash: Boolean(d1DownloadVersion?.hash && cloudSha === d1DownloadVersion.hash.toLowerCase())
    }
    report.worker = { responseVersion: cloudVersion, responseHash: headerHash, downloadedBytesSha256: cloudSha,
      downloadedBytes: bytes.byteLength, d1ResponseVersion: d1DownloadVersion ? { version: d1DownloadVersion.version, hash: d1DownloadVersion.hash, size: d1DownloadVersion.size, status: d1DownloadVersion.status } : null }
    report.checks = checks
    report.ok = Object.values(checks).every(Boolean)
  } catch (error) {
    report.errorStage = stage
    report.errorCode = error.code || error.name || 'ERROR'
    report.errorMessage = redact(error.message)
  } finally {
    db?.close()
    report.finishedAt = new Date().toISOString()
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf8')
    app.quit()
  }
}

if (process.versions.electron) runElectron().catch((error) => {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify({ mode: 'readonly-parity', fileId: process.env.EXCELSYNC_REAL_E2E_FILE_ID,
    ok: false, errorStage: 'electron-entry', errorCode: error.code || error.name || 'ERROR', errorMessage: redact(error.message) }, null, 2), 'utf8')
  process.exitCode = 1
})
else { try { launch() } catch (error) { process.stderr.write(`${redact(error.message)}\n`); process.exitCode = 1 } }
