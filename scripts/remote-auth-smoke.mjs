import { readFile } from 'node:fs/promises'
import { ProxyAgent, fetch } from 'undici'

const base = 'https://excel-sync-worker.qaz60499.workers.dev'
const dispatcher = new ProxyAgent('http://127.0.0.1:10808')
const credentials = JSON.parse(await readFile(new URL('../e2e-login.json', import.meta.url), 'utf8'))

async function request(path, init = {}) {
  return fetch(`${base}${path}`, { ...init, dispatcher })
}

const health = await request('/health')
const healthJson = await health.json()

const anonymous = await request('/files/list')
const badLogin = await request('/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: credentials.username, password: `${credentials.password}x` })
})
const login = await request('/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(credentials)
})
if (!login.ok) throw new Error(`LOGIN_FAILED_${login.status}:${await login.text()}`)
const loginJson = await login.json()
const auth = { authorization: `Bearer ${loginJson.token}` }
const files = await request('/files/list', { headers: auth })
const storage = await request('/storage/status', { headers: auth })
const storageJson = await storage.json()
const logout = await request('/auth/logout', { method: 'POST', headers: auth })
const rejectedAfterLogout = await request('/files/list', { headers: auth })

console.log(JSON.stringify({
  health: health.status,
  worker: healthJson.worker,
  database: healthJson.database,
  tokenConfigured: healthJson.telegram?.tokenConfigured,
  chatConfigured: healthJson.telegram?.chatConfigured,
  anonymousRejected: anonymous.status === 401,
  badLoginRejected: badLogin.status === 401,
  login: login.status,
  authenticatedFiles: files.status,
  storage: storage.status,
  storageReachable: storageJson.reachable,
  logout: logout.status,
  tokenRejectedAfterLogout: rejectedAfterLogout.status === 401
}, null, 2))
