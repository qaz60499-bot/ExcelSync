import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const appData = process.env.APPDATA
if (!appData) throw new Error('APPDATA_NOT_AVAILABLE')

const pendingPath = join(appData, 'ExcelSync', 'secure', 'bootstrap-nonce.pending')
const nonce = randomBytes(32).toString('base64url')
const hash = createHash('sha256').update(nonce, 'utf8').digest('base64url')

await mkdir(dirname(pendingPath), { recursive: true })
await writeFile(pendingPath, nonce, { encoding: 'utf8', mode: 0o600 })

const sql = `INSERT INTO app_settings(key,value,updated_at) VALUES ('setup_nonce_hash','${hash}',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`
const result = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'excel-sync', '--remote', '--command', sql], {
  cwd: root,
  encoding: 'utf8'
})

if (result.status !== 0) {
  throw new Error(result.stderr || result.stdout || 'D1_BOOTSTRAP_PROVISION_FAILED')
}

process.stdout.write(JSON.stringify({ ok: true, pendingPath }))
