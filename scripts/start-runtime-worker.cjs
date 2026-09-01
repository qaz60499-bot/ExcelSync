const { spawn, execFileSync } = require('node:child_process')
const { resolve, join } = require('node:path')
const { tmpdir } = require('node:os')
const { writeFileSync } = require('node:fs')

const root = resolve(__dirname, '..')
const wrangler = resolve(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const port = String(process.env.EXCELSYNC_RUNTIME_WORKER_PORT || '8788')
const persistTo = process.env.EXCELSYNC_RUNTIME_D1 || 'D:/Temp/excel-sync-130-runtime'
const masterKey = process.env.EXCELSYNC_RUNTIME_MASTER_KEY
const statePath = join(tmpdir(), `ExcelSync-runtime-worker-${port}.json`)

if (!masterKey || masterKey.length < 32) throw new Error('EXCELSYNC_RUNTIME_MASTER_KEY_REQUIRED')

function ownedWorkerPids() {
  if (process.platform !== 'win32') return []
  const escapedRoot = root.replaceAll("'", "''")
  const escapedPort = port.replaceAll("'", "''")
  const script = [
    `$root='${escapedRoot}'`,
    `$port='${escapedPort}'`,
    "$rows=Get-CimInstance Win32_Process | Where-Object {",
    "  $_.Name -eq 'node.exe' -and $_.CommandLine -and",
    "  $_.CommandLine.IndexOf($root,[System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and",
    "  $_.CommandLine -like '*wrangler*' -and $_.CommandLine -like '* dev *' -and",
    "  ($_.CommandLine -like ('*--port ' + $port + '*'))",
    "}",
    "$rows | ForEach-Object { $_.ProcessId }",
  ].join('\n')
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    return out.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

const existing = ownedWorkerPids()
if (existing.length > 0) {
  const pid = existing[0]
  writeFileSync(statePath, JSON.stringify({ pid, port: Number(port), persistTo, root, reusedAt: new Date().toISOString() }, null, 2))
  console.log(JSON.stringify({ pid, port: Number(port), persistTo, reused: true }))
  process.exit(0)
}

const child = spawn(process.execPath, [
  wrangler,
  'dev',
  '--port', port,
  '--persist-to', persistTo,
  '--var', `STORAGE_MASTER_KEY:${masterKey}`
], {
  cwd: root,
  detached: true,
  stdio: 'ignore',
  windowsHide: true
})

child.once('error', (error) => {
  console.error(error)
  process.exitCode = 1
})

writeFileSync(statePath, JSON.stringify({
  pid: child.pid,
  port: Number(port),
  persistTo,
  root,
  startedAt: new Date().toISOString(),
}, null, 2))
child.unref()
console.log(JSON.stringify({ pid: child.pid, port: Number(port), persistTo, reused: false }))
