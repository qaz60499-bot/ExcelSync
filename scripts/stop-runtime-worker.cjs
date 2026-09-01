const { execFileSync } = require('node:child_process')
const { resolve, join } = require('node:path')
const { tmpdir } = require('node:os')
const { rmSync } = require('node:fs')

const root = resolve(__dirname, '..')
const port = String(process.env.EXCELSYNC_RUNTIME_WORKER_PORT || '8788')
const statePath = join(tmpdir(), `ExcelSync-runtime-worker-${port}.json`)

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

function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      process.kill(-pid, 'SIGTERM')
    }
  } catch {}
}

const pids = ownedWorkerPids()
for (const pid of pids) killTree(pid)
try { rmSync(statePath, { force: true }) } catch {}
console.log(JSON.stringify({ stopped: pids, port: Number(port) }))
