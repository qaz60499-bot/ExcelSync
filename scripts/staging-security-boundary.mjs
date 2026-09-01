import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const reportDir = join(process.cwd(), 'test-artifacts', 'security-validation', 'staging')
const base = String(process.env.E2E_BASE_URL || '').trim().replace(/\/+$/, '')
const username = String(process.env.E2E_USERNAME || '').trim()
const password = String(process.env.E2E_PASSWORD || '')
const confirmation = String(process.env.E2E_STAGING_CONFIRMATION || '')
const cases = []
let conclusion = 'PASS'
let token = null

function add(name, status, detail = '') {
  cases.push({ name, status, detail })
  if (status === 'FAIL') conclusion = 'FAIL'
}

async function req(path, init = {}, authToken = token) {
  const headers = new Headers(init.headers || {})
  if (authToken) headers.set('authorization', `Bearer ${authToken}`)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    return await fetch(`${base}${path}`, { ...init, headers, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

try {
  if (!base || !username || !password || !confirmation) throw new Error('BLOCKED: staging security secrets incomplete')
  if (confirmation !== 'EXCELSYNC_STAGING_ONLY') throw new Error('BLOCKED: staging confirmation mismatch')
  const host = new URL(base).hostname.toLowerCase()
  if (['excel-sync-worker.qaz60499.workers.dev', 'saaas.guessyy.ccwu.cc'].includes(host)) {
    throw new Error('BLOCKED: production host is forbidden')
  }

  const health = await req('/health', {}, null)
  add('health', health.ok ? 'PASS' : 'FAIL', `status=${health.status}`)

  const missing = await req('/auth/me', {}, null)
  add('missing-token-fail-closed', missing.status === 401 ? 'PASS' : 'FAIL', `status=${missing.status}`)

  const malformed = await req('/auth/me', {}, 'malformed.test.token')
  add('malformed-token-fail-closed', malformed.status === 401 ? 'PASS' : 'FAIL', `status=${malformed.status}`)

  const login = await req('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      device: {
        deviceName: 'GitHub Security Validation',
        osName: 'Windows',
        osVersion: process.env.ImageOS || 'GitHub Actions',
        clientVersion: '1.4.1',
        stableDeviceId: '11111111-2222-4333-8444-555555555555'
      }
    })
  }, null)
  let payload = null
  try { payload = await login.json() } catch {}
  token = payload?.token || null
  add('valid-login', login.ok && token ? 'PASS' : 'FAIL', `status=${login.status}`)

  if (token) {
    const me = await req('/auth/me')
    add('valid-session', me.ok ? 'PASS' : 'FAIL', `status=${me.status}`)
    const logout = await req('/auth/logout', { method: 'POST' })
    add('logout', logout.ok ? 'PASS' : 'FAIL', `status=${logout.status}`)
    const afterLogout = await req('/auth/me')
    add('revoked-after-logout', afterLogout.status === 401 ? 'PASS' : 'FAIL', `status=${afterLogout.status}`)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('BLOCKED:')) {
    conclusion = 'BLOCKED'
    add('staging-security', 'BLOCKED', message.slice(8).trim())
  } else {
    conclusion = 'FAIL'
    add('uncaught-error', 'FAIL', message)
  }
} finally {
  await mkdir(reportDir, { recursive: true })
  const report = {
    conclusion,
    runner: process.env.ImageOS || process.platform,
    commit_sha: process.env.GITHUB_SHA || null,
    target_origin: base ? new URL(base).origin : null,
    cases
  }
  await writeFile(join(reportDir, 'staging-security.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(join(reportDir, 'staging-security.md'), [
    '# Staging Security Boundary', '',
    `Conclusion: **${conclusion}**`, '',
    '| Case | Status | Detail |', '|---|---|---|',
    ...cases.map((item) => `| ${item.name} | ${item.status} | ${String(item.detail).replaceAll('|','/')} |`)
  ].join('\n'), 'utf8')
}

if (conclusion === 'FAIL') process.exitCode = 1
if (conclusion === 'BLOCKED') process.exitCode = 2
