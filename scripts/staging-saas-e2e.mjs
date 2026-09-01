import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ExcelJS from 'exceljs'

const base = String(process.env.E2E_BASE_URL || '').trim().replace(/\/+$/, '')
const username = String(process.env.E2E_USERNAME || '').trim()
const password = String(process.env.E2E_PASSWORD || '')
const confirmation = String(process.env.E2E_STAGING_CONFIRMATION || '')
const runId = String(process.env.GITHUB_RUN_ID || Date.now())
const prefix = `E2E_${runId}_${randomUUID().slice(0, 8)}`
const reportDir = join(process.cwd(), 'test-artifacts', 'saas-e2e')
const started = new Date()
const cases = []
let token = null
let fileId = null
let currentVersion = 0
let conclusion = 'PASS'
let blockedReason = null

function add(name, status, detail = '') {
  cases.push({ name, status, detail })
  if (status === 'FAIL') conclusion = 'FAIL'
}
function sha256(bytes) { return createHash('sha256').update(Buffer.from(bytes)).digest('hex') }
function assert(condition, name, detail) {
  if (!condition) { add(name, 'FAIL', detail); throw new Error(`${name}: ${detail}`) }
  add(name, 'PASS', detail)
}
function authHeaders(value = token) { return value ? { authorization: `Bearer ${value}` } : {} }

async function request(path, init = {}, tokenOverride = token) {
  const headers = new Headers(init.headers || {})
  if (tokenOverride) headers.set('authorization', `Bearer ${tokenOverride}`)
  const response = await fetch(`${base}${path}`, { ...init, headers })
  const type = response.headers.get('content-type') || ''
  let body = null
  if (type.includes('application/json')) {
    try { body = await response.clone().json() } catch { body = null }
  }
  return { response, body }
}

async function login(deviceName, pass = password) {
  return request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password: pass,
      device: { deviceName, osName: 'Windows', osVersion: 'GitHub Actions', clientVersion: '1.4.1', stableDeviceId: randomUUID() }
    })
  }, null)
}

async function workbookBytes(revision) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'ExcelSync staging E2E'
  const sheet = workbook.addWorksheet('E2E')
  sheet.getCell('A1').value = prefix
  sheet.getCell('A2').value = revision
  sheet.getCell('B2').value = `中文 Unicode spaces ${revision}`
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

async function preflight({ hash, size, baseVersion, logicalName, relativePath, existingFileId }) {
  return request('/sync/preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(existingFileId ? { fileId: existingFileId } : {}),
      logicalName,
      relativePath,
      hash,
      size,
      baseVersion,
      idempotencyKey: `${prefix}-${baseVersion}-${hash}`
    })
  })
}

async function upload(intentId, bytes, name) {
  const form = new FormData()
  form.set('intentId', intentId)
  form.set('file', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name)
  return request('/sync/upload', { method: 'POST', body: form })
}

async function commit(intentId) {
  return request('/sync/commit', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intentId })
  })
}

async function writeReport() {
  await mkdir(reportDir, { recursive: true })
  const report = {
    environment: {
      commit_sha: process.env.GITHUB_SHA || null,
      excelsync_version: '1.4.1',
      runner_os: process.env.RUNNER_OS || process.platform,
      runner_image: process.env.ImageOS || null,
      start_time: started.toISOString(),
      end_time: new Date().toISOString(),
      base_origin: base ? new URL(base).origin : null,
      run_prefix: prefix
    },
    auth: cases.filter((c) => c.name.startsWith('auth-')),
    sync_e2e: cases.filter((c) => c.name.startsWith('sync-')),
    cleanup: cases.filter((c) => c.name.startsWith('cleanup-')),
    blocked: cases.filter((c) => c.status === 'BLOCKED'),
    conclusion,
    blocked_reason: blockedReason
  }
  await writeFile(join(reportDir, 'test-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  const md = [
    '# ExcelSync Staging SaaS E2E', '',
    `- Environment: ${report.environment.base_origin || 'unconfigured'}`,
    `- Commit SHA: ${report.environment.commit_sha || 'local'}`,
    `- ExcelSync version: ${report.environment.excelsync_version}`,
    `- Runner OS: ${report.environment.runner_os}`,
    `- Start: ${report.environment.start_time}`,
    `- End: ${report.environment.end_time}`,
    '', '| Case | Status | Detail |', '|---|---|---|',
    ...cases.map((c) => `| ${c.name} | ${c.status} | ${String(c.detail).replaceAll('|', '/')} |`),
    '', `Conclusion: **${conclusion}**`,
    ...(blockedReason ? ['', `Blocked reason: ${blockedReason}`] : [])
  ]
  await writeFile(join(reportDir, 'test-report.md'), md.join('\n'), 'utf8')
}

try {
  if (!base || !username || !password) throw new Error('BLOCKED: E2E staging credentials are incomplete')
  if (confirmation !== 'EXCELSYNC_STAGING_ONLY') throw new Error('BLOCKED: E2E_STAGING_CONFIRMATION must equal EXCELSYNC_STAGING_ONLY')
  const host = new URL(base).hostname.toLowerCase()
  if (['excel-sync-worker.qaz60499.workers.dev', 'saaas.guessyy.ccwu.cc'].includes(host)) {
    throw new Error(`BLOCKED: production host is forbidden: ${host}`)
  }

  const health = await request('/health', {}, null)
  assert(health.response.ok && health.body?.ok === true, 'auth-staging-health', `status=${health.response.status}`)
  if (health.body?.telegram?.reachable !== true) throw new Error('BLOCKED: staging storage is not reachable')

  const firstLogin = await login(`${prefix}-device-a`)
  assert(firstLogin.response.ok && firstLogin.body?.token, 'auth-login-success', `status=${firstLogin.response.status}`)
  const tokenA = firstLogin.body.token
  token = tokenA

  const badStatuses = []
  for (let i = 0; i < 3; i += 1) {
    const bad = await login(`${prefix}-bad-${i}`, `${password}-wrong`)
    badStatuses.push(bad.response.status)
  }
  assert(badStatuses.every((s) => s === 401 || s === 429), 'auth-repeated-bad-login', `statuses=${badStatuses.join(',')}`)

  const secondLogin = await login(`${prefix}-device-b`)
  assert(secondLogin.response.ok && secondLogin.body?.token, 'auth-login-again', `status=${secondLogin.response.status}`)
  const tokenB = secondLogin.body.token
  token = tokenB
  const logoutOthers = await request('/auth/logout-other-devices', { method: 'POST' })
  assert(logoutOthers.response.ok, 'auth-logout-other-devices', `status=${logoutOthers.response.status}; invalidated=${logoutOthers.body?.invalidated ?? 'unknown'}`)
  const oldToken = await request('/auth/me', {}, tokenA)
  assert(oldToken.response.status === 401, 'auth-old-session-invalidated', `status=${oldToken.response.status}`)

  const invalid = await request('/auth/me', {}, `${prefix}.invalid.session`)
  assert(invalid.response.status === 401, 'auth-invalid-session', `status=${invalid.response.status}`)

  add('auth-expired-session', 'BLOCKED', 'Requires staging-only short session TTL or clock control')
  add('auth-suspended-user', 'BLOCKED', 'Requires a separate staging admin fixture; not safe to suspend the sole E2E account')
  add('auth-force-logout', 'BLOCKED', 'Requires a separate staging admin fixture')

  const logicalV1 = `${prefix}_测试 文件.xlsx`
  const pathV1 = `${prefix}/中文 空格/${logicalV1}`
  const v1 = await workbookBytes(1)
  const h1 = sha256(v1)
  const p1 = await preflight({ hash: h1, size: v1.byteLength, baseVersion: 0, logicalName: logicalV1, relativePath: pathV1 })
  assert(p1.response.status === 201 && p1.body?.action === 'upload_required', 'sync-preflight-v1', `status=${p1.response.status}; action=${p1.body?.action}`)
  fileId = p1.body.fileId
  const u1 = await upload(p1.body.intentId, v1, logicalV1)
  assert(u1.response.ok, 'sync-upload-v1', `status=${u1.response.status}`)
  const c1 = await commit(p1.body.intentId)
  assert(c1.response.ok && c1.body?.version === 1 && c1.body?.hash === h1, 'sync-commit-v1', `status=${c1.response.status}; version=${c1.body?.version}`)
  currentVersion = 1

  const d1 = await request(`/files/${fileId}/download`)
  const d1Bytes = new Uint8Array(await d1.response.arrayBuffer())
  assert(d1.response.ok && sha256(d1Bytes) === h1, 'sync-download-current-v1-sha256', `status=${d1.response.status}; hashMatch=${sha256(d1Bytes) === h1}`)

  const dedupe = await preflight({ hash: h1, size: v1.byteLength, baseVersion: 1, logicalName: logicalV1, relativePath: pathV1, existingFileId: fileId })
  assert(dedupe.response.ok && dedupe.body?.action === 'noop' && dedupe.body?.currentVersion === 1, 'sync-dedupe-same-sha256', `action=${dedupe.body?.action}`)

  const v2 = await workbookBytes(2)
  const h2 = sha256(v2)
  const p2 = await preflight({ hash: h2, size: v2.byteLength, baseVersion: 1, logicalName: logicalV1, relativePath: pathV1, existingFileId: fileId })
  assert(p2.response.status === 201 && p2.body?.action === 'upload_required', 'sync-preflight-v2', `status=${p2.response.status}; action=${p2.body?.action}`)
  const u2 = await upload(p2.body.intentId, v2, logicalV1)
  assert(u2.response.ok, 'sync-upload-v2', `status=${u2.response.status}`)
  const c2 = await commit(p2.body.intentId)
  assert(c2.response.ok && c2.body?.version === 2 && c2.body?.hash === h2, 'sync-commit-v2', `status=${c2.response.status}; version=${c2.body?.version}`)
  currentVersion = 2

  const historical = await request(`/files/${fileId}/versions/1/download`)
  const historicalBytes = new Uint8Array(await historical.response.arrayBuffer())
  assert(historical.response.ok && sha256(historicalBytes) === h1, 'sync-download-historical-v1-sha256', `status=${historical.response.status}`)

  const staleBytes = await workbookBytes(3)
  const stale = await preflight({ hash: sha256(staleBytes), size: staleBytes.byteLength, baseVersion: 1, logicalName: logicalV1, relativePath: pathV1, existingFileId: fileId })
  assert(stale.response.status === 409 && stale.body?.action === 'conflict' && stale.body?.currentVersion === 2, 'sync-stale-base-conflict', `status=${stale.response.status}; current=${stale.body?.currentVersion}`)

  const renamed = `${prefix}_重命名 Unicode.xlsx`
  const renamePath = `${prefix}/renamed/${renamed}`
  const rename = await request(`/files/${fileId}/rename`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ logicalName: renamed, relativePath: renamePath, baseVersion: 2 })
  })
  assert(rename.response.ok, 'sync-rename-unicode', `status=${rename.response.status}`)

  const restore = await request(`/versions/${fileId}/restore`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, baseVersion: 2 })
  })
  assert(restore.response.ok && restore.body?.version === 3 && restore.body?.restoredFromVersion === 1, 'sync-restore-v1-as-v3', `status=${restore.response.status}; version=${restore.body?.version}; from=${restore.body?.restoredFromVersion}`)
  currentVersion = 3

  const restoredDownload = await request(`/files/${fileId}/download`)
  const restoredBytes = new Uint8Array(await restoredDownload.response.arrayBuffer())
  assert(restoredDownload.response.ok && sha256(restoredBytes) === h1, 'sync-restored-current-sha256', `status=${restoredDownload.response.status}`)

  const trash = await request(`/files/${fileId}/trash`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseVersion: currentVersion })
  })
  assert(trash.response.ok, 'sync-trash', `status=${trash.response.status}`)
  const restoreTrash = await request(`/files/${fileId}/restore-from-trash`, { method: 'POST' })
  assert(restoreTrash.response.ok && restoreTrash.body?.current_version === currentVersion, 'sync-restore-trash', `status=${restoreTrash.response.status}`)

  const trashForCleanup = await request(`/files/${fileId}/trash`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseVersion: currentVersion })
  })
  assert(trashForCleanup.response.ok, 'cleanup-trash', `status=${trashForCleanup.response.status}`)
  const permanent = await request(`/files/${fileId}/permanent-delete`, { method: 'POST' })
  assert(permanent.response.ok, 'cleanup-permanent-delete', `status=${permanent.response.status}; storageRetained=${permanent.body?.storageRetained}`)
  fileId = null

  const logout = await request('/auth/logout', { method: 'POST' })
  assert(logout.response.ok, 'auth-logout', `status=${logout.response.status}`)
  const afterLogout = await request('/auth/me')
  assert(afterLogout.response.status === 401, 'auth-token-rejected-after-logout', `status=${afterLogout.response.status}`)

  const finalLogin = await login(`${prefix}-device-final`)
  assert(finalLogin.response.ok && finalLogin.body?.token, 'auth-login-after-logout', `status=${finalLogin.response.status}`)
  token = finalLogin.body.token
  const all = await request('/auth/logout-all-devices', { method: 'POST' })
  assert(all.response.ok, 'auth-logout-all-devices', `status=${all.response.status}; invalidated=${all.body?.invalidated ?? 'unknown'}`)
  const afterAll = await request('/auth/me')
  assert(afterAll.response.status === 401, 'auth-token-rejected-after-logout-all', `status=${afterAll.response.status}`)
  token = null
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('BLOCKED:')) {
    conclusion = 'BLOCKED'
    blockedReason = message.slice('BLOCKED:'.length).trim()
    add('environment-staging-prerequisite', 'BLOCKED', blockedReason)
  } else {
    conclusion = 'FAIL'
    if (!cases.some((entry) => entry.status === 'FAIL' && message.startsWith(entry.name))) add('uncaught-error', 'FAIL', message)
  }
} finally {
  if (fileId && token) {
    try {
      await request(`/files/${fileId}/trash`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseVersion: currentVersion })
      })
      const cleanup = await request(`/files/${fileId}/permanent-delete`, { method: 'POST' })
      add('cleanup-finally', cleanup.response.ok ? 'PASS' : 'FAIL', `status=${cleanup.response.status}`)
    } catch (error) {
      add('cleanup-finally', 'FAIL', error instanceof Error ? error.message : String(error))
    }
  }
  await writeReport()
}

if (conclusion === 'FAIL') process.exitCode = 1
if (conclusion === 'BLOCKED') process.exitCode = 2
