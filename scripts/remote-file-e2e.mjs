import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import ExcelJS from 'exceljs'
import { FormData, ProxyAgent, fetch } from 'undici'
import { Blob } from 'node:buffer'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const base = 'https://excel-sync-worker.qaz60499.workers.dev'
const dispatcher = new ProxyAgent('http://127.0.0.1:10808')
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function d1(sql) {
  const result = spawnSync('node', [wrangler, 'd1', 'execute', 'excel-sync', '--remote', '--command', sql], {
    cwd: root,
    encoding: 'utf8'
  })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'D1_EXECUTE_FAILED')
}

async function request(path, init = {}) {
  return fetch(`${base}${path}`, { ...init, dispatcher })
}

function sha256(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

async function workbookBytes(label, revision) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'ExcelSync E2E'
  const sheet = workbook.addWorksheet('Sync Test')
  sheet.getCell('A1').value = 'ExcelSync real workbook E2E'
  sheet.getCell('A2').value = label
  sheet.getCell('B2').value = revision
  sheet.getCell('A3').value = new Date('2026-08-30T09:00:00Z')
  const buffer = await workbook.xlsx.writeBuffer()
  return new Uint8Array(buffer)
}

async function jsonRequest(path, init = {}) {
  const response = await request(path, init)
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  return { response, body }
}

async function uploadIntent(auth, intentId, bytes, name = 'ExcelSync-E2E.xlsx') {
  const form = new FormData()
  form.set('intentId', intentId)
  form.set('file', new Blob([bytes], { type: XLSX_MIME }), name)
  const { response, body } = await jsonRequest('/sync/upload', { method: 'POST', headers: auth, body: form })
  if (!response.ok) throw new Error(`UPLOAD_${response.status}:${JSON.stringify(body)}`)
  return body
}

const initialHealth = await jsonRequest('/health')
if (!initialHealth.body?.telegram?.chatConfigured) {
  console.log(JSON.stringify({ blocked: 'TELEGRAM_CHAT_NOT_PAIRED', health: initialHealth.body }, null, 2))
  process.exitCode = 2
  await dispatcher.close()
}
if (!initialHealth.body?.telegram?.reachable) {
  throw new Error(`TELEGRAM_NOT_REACHABLE:${JSON.stringify(initialHealth.body.telegram)}`)
}

const setupCode = randomBytes(32).toString('base64url')
const setupHash = createHash('sha256').update(setupCode).digest('base64url')
const password = `${randomBytes(18).toString('base64url')}Aa1!`
const username = `file_e2e_${Date.now()}`
let result = null

try {
  d1("DELETE FROM sessions; DELETE FROM sync_events; DELETE FROM upload_intents; DELETE FROM file_versions; DELETE FROM files; DELETE FROM users; DELETE FROM app_settings WHERE key='setup_nonce_hash';")
  d1(`INSERT INTO app_settings(key,value,updated_at) VALUES ('setup_nonce_hash','${setupHash}',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`)

  const bootstrap = await jsonRequest('/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-setup-nonce': setupCode },
    body: JSON.stringify({ username, password })
  })
  if (bootstrap.response.status !== 201) throw new Error(`BOOTSTRAP_${bootstrap.response.status}:${JSON.stringify(bootstrap.body)}`)

  const login = await jsonRequest('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  if (!login.response.ok) throw new Error(`LOGIN_${login.response.status}:${JSON.stringify(login.body)}`)
  const auth = { authorization: `Bearer ${login.body.token}` }

  const v1Bytes = await workbookBytes('first saved version', 1)
  const v1Hash = sha256(v1Bytes)
  const p1 = await jsonRequest('/sync/preflight', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ logicalName: 'ExcelSync-E2E.xlsx', hash: v1Hash, size: v1Bytes.byteLength, baseVersion: 0, idempotencyKey: `e2e-v1-${v1Hash}` })
  })
  if (p1.response.status !== 201 || p1.body.action !== 'upload_required') throw new Error(`PREFLIGHT_V1:${JSON.stringify(p1.body)}`)
  await uploadIntent(auth, p1.body.intentId, v1Bytes)
  const c1 = await jsonRequest('/sync/commit', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ intentId: p1.body.intentId })
  })
  if (!c1.response.ok || c1.body.version !== 1 || c1.body.hash !== v1Hash) throw new Error(`COMMIT_V1:${JSON.stringify(c1.body)}`)
  const fileId = c1.body.fileId

  const dedupe = await jsonRequest('/sync/preflight', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ fileId, logicalName: 'ExcelSync-E2E.xlsx', hash: v1Hash, size: v1Bytes.byteLength, baseVersion: 1, idempotencyKey: `e2e-dedupe-${v1Hash}` })
  })
  if (!dedupe.response.ok || dedupe.body.action !== 'noop' || dedupe.body.currentVersion !== 1) throw new Error(`DEDUPE:${JSON.stringify(dedupe.body)}`)

  const v2Bytes = await workbookBytes('second saved version', 2)
  const v2Hash = sha256(v2Bytes)
  const p2 = await jsonRequest('/sync/preflight', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ fileId, logicalName: 'ExcelSync-E2E.xlsx', hash: v2Hash, size: v2Bytes.byteLength, baseVersion: 1, idempotencyKey: `e2e-v2-${v2Hash}` })
  })
  if (p2.response.status !== 201 || p2.body.action !== 'upload_required') throw new Error(`PREFLIGHT_V2:${JSON.stringify(p2.body)}`)
  await uploadIntent(auth, p2.body.intentId, v2Bytes)
  const c2 = await jsonRequest('/sync/commit', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ intentId: p2.body.intentId })
  })
  if (!c2.response.ok || c2.body.version !== 2 || c2.body.hash !== v2Hash) throw new Error(`COMMIT_V2:${JSON.stringify(c2.body)}`)

  const v3Candidate = await workbookBytes('stale local edit', 3)
  const conflict = await jsonRequest('/sync/preflight', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ fileId, logicalName: 'ExcelSync-E2E.xlsx', hash: sha256(v3Candidate), size: v3Candidate.byteLength, baseVersion: 1, idempotencyKey: `e2e-conflict-${Date.now()}` })
  })
  if (conflict.response.status !== 409 || conflict.body.action !== 'conflict' || conflict.body.currentVersion !== 2) throw new Error(`CONFLICT:${JSON.stringify(conflict.body)}`)

  const versionsBefore = await jsonRequest(`/versions/${fileId}`, { headers: auth })
  const restore = await jsonRequest(`/versions/${fileId}/restore`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, baseVersion: 2 })
  })
  if (!restore.response.ok || restore.body.version !== 3 || restore.body.restoredFromVersion !== 1 || restore.body.hash !== v1Hash) {
    throw new Error(`RESTORE:${JSON.stringify(restore.body)}`)
  }

  const download = await request(`/files/${fileId}/download`, { headers: auth })
  const downloaded = new Uint8Array(await download.arrayBuffer())
  const downloadHash = sha256(downloaded)
  const versionsAfter = await jsonRequest(`/versions/${fileId}`, { headers: auth })
  const activity = await jsonRequest('/activity', { headers: auth })

  result = {
    telegramReachable: initialHealth.body.telegram.reachable,
    fileId,
    v1: { version: c1.body.version, hash: v1Hash, bytes: v1Bytes.byteLength },
    duplicateHashAction: dedupe.body.action,
    v2: { version: c2.body.version, hash: v2Hash, bytes: v2Bytes.byteLength },
    staleBaseConflict: conflict.response.status === 409,
    versionsBeforeRestore: versionsBefore.body.versions.map((v) => v.version),
    restore: { newVersion: restore.body.version, restoredFrom: restore.body.restoredFromVersion },
    downloadedVersion: Number(download.headers.get('x-excelsync-version')),
    downloadedHashMatchesV1: downloadHash === v1Hash && download.headers.get('x-excelsync-hash') === v1Hash,
    versionsAfterRestore: versionsAfter.body.versions.map((v) => ({ version: v.version, restoredFrom: v.restored_from_version })),
    activityEvents: activity.body.events.map((e) => e.event_type)
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  d1("DELETE FROM sessions; DELETE FROM sync_events; DELETE FROM upload_intents; DELETE FROM file_versions; DELETE FROM files; DELETE FROM users; DELETE FROM app_settings WHERE key='setup_nonce_hash';")
  await dispatcher.close()
}
