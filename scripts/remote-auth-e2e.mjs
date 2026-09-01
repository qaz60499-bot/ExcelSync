import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { ProxyAgent, fetch } from 'undici'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const base = 'https://excel-sync-worker.qaz60499.workers.dev'
const dispatcher = new ProxyAgent('http://127.0.0.1:10808')

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

const setupCode = randomBytes(32).toString('base64url')
const setupHash = createHash('sha256').update(setupCode).digest('base64url')
const password = `${randomBytes(18).toString('base64url')}Aa1!`
const username = `e2e_${Date.now()}`

try {
  d1(`INSERT INTO app_settings(key,value,updated_at) VALUES ('setup_nonce_hash','${setupHash}',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`)

  const healthBefore = await request('/health')
  const healthBeforeJson = await healthBefore.json()
  const anonymous = await request('/files/list')

  const bootstrap = await request('/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-setup-nonce': setupCode },
    body: JSON.stringify({ username, password })
  })
  if (bootstrap.status !== 201) throw new Error(`BOOTSTRAP_${bootstrap.status}:${await bootstrap.text()}`)

  const badLogin = await request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: `${password}x` })
  })
  const login = await request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  if (!login.ok) throw new Error(`LOGIN_${login.status}:${await login.text()}`)
  const loginJson = await login.json()
  const auth = { authorization: `Bearer ${loginJson.token}` }
  const files = await request('/files/list', { headers: auth })
  const storage = await request('/storage/status', { headers: auth })
  const storageJson = await storage.json()
  const logout = await request('/auth/logout', { method: 'POST', headers: auth })
  const afterLogout = await request('/files/list', { headers: auth })

  console.log(JSON.stringify({
    setupAvailableBefore: healthBeforeJson.setupAvailable,
    anonymousRejected: anonymous.status === 401,
    bootstrap: bootstrap.status,
    badLoginRejected: badLogin.status === 401,
    login: login.status,
    authenticatedFiles: files.status,
    storageStatus: storage.status,
    telegramTokenConfigured: storageJson.tokenConfigured,
    telegramChatConfigured: storageJson.chatConfigured,
    logout: logout.status,
    tokenRejectedAfterLogout: afterLogout.status === 401
  }, null, 2))
} finally {
  d1("DELETE FROM sessions; DELETE FROM sync_events; DELETE FROM upload_intents; DELETE FROM file_versions; DELETE FROM files; DELETE FROM users; DELETE FROM app_settings WHERE key='setup_nonce_hash';")
  await dispatcher.close()
}
