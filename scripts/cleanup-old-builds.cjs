const { existsSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

const root = resolve(__dirname, '..')
const latestDir = join(root, 'dist', 'win-unpacked')
const latestExe = join(latestDir, 'ExcelSync.exe')

if (!existsSync(latestExe) || !statSync(latestExe).isFile()) {
  throw new Error(`LATEST_EXE_MISSING:${latestExe}`)
}

const oldBuildDirs = [
  'dist-dual-storage-release',
  'dist-dual-storage-release-final',
  'installer-dist-signcheck',
  'dist-dual-storage',
  'dist-dual-storage-authfix',
  'dist-dual-storage-authfix2',
  'dist-dual-storage-final',
  'dist-dual-storage-final-installers',
  'dist-dual-storage-final2',
  'dist-dual-storage-final3',
  'dist-dual-storage-final4',
  'dist-dual-storage-final5',
  'dist-dual-storage-final6',
  'dist-dual-storage-nsis',
  'dist-dual-storage-release-installers'
]

const desktop = join(process.env.USERPROFILE || '', 'Desktop')
const shortcut = join(desktop, 'ExcelSync.lnk')
const cleanupCmd = join(desktop, 'ExcelSync-Cleanup-Old-Versions.cmd')
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`

function updateShortcut() {
  const command = [
    '$shell = New-Object -ComObject WScript.Shell',
    `$link = $shell.CreateShortcut(${psQuote(shortcut)})`,
    `$link.TargetPath = ${psQuote(latestExe)}`,
    `$link.WorkingDirectory = ${psQuote(latestDir)}`,
    `$link.IconLocation = ${psQuote(`${latestExe},0`)}`,
    `$link.Description = 'ExcelSync 1.4.1 - Latest local build'`,
    '$link.Save()'
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`SHORTCUT_UPDATE_FAILED:${result.stderr || result.stdout || result.status}`)
  }
}

function writeOneTimeCleanupCmd() {
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    `cd /d "${root}"`,
    'echo ExcelSync old-build cleanup...',
    'node scripts\\cleanup-old-builds.cjs --desktop-run',
    'if errorlevel 1 (',
    '  echo.',
    '  echo Cleanup failed. Nothing else will be removed.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo.',
    'echo Cleanup completed.',
    'echo This one-time cleanup file will now remove itself.',
    'timeout /t 2 /nobreak >nul',
    'del "%~f0"',
    ''
  ]
  writeFileSync(cleanupCmd, lines.join('\r\n'), 'utf8')
}

updateShortcut()

function stopProcessesFromOldBuilds() {
  const oldRoots = oldBuildDirs.map((relative) => join(root, relative).toLowerCase())
  const script = [
    '$targets = @(' + oldRoots.map((value) => psQuote(value)).join(',') + ')',
    '$procs = Get-CimInstance Win32_Process | Where-Object {',
    '  $path = [string]$_.ExecutablePath',
    '  if (-not $path) { return $false }',
    '  $lower = $path.ToLowerInvariant()',
    '  foreach ($target in $targets) { if ($lower.StartsWith($target + "\\")) { return $true } }',
    '  return $false',
    '}',
    '$ids = @($procs | Select-Object -ExpandProperty ProcessId)',
    'foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }',
    'if ($ids.Count -gt 0) { Start-Sleep -Milliseconds 800 }',
    '$ids -join ","'
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`OLD_PROCESS_STOP_FAILED:${result.stderr || result.stdout || result.status}`)
  }
  return result.stdout.trim()
}

const stoppedProcesses = stopProcessesFromOldBuilds()
const deleted = []
const skipped = []
for (const relative of oldBuildDirs) {
  const target = join(root, relative)
  if (!existsSync(target)) {
    skipped.push(relative)
    continue
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
  if (existsSync(target)) throw new Error(`OLD_BUILD_DELETE_FAILED:${target}`)
  deleted.push(relative)
}

if (!process.argv.includes('--desktop-run')) {
  writeOneTimeCleanupCmd()
}

console.log(JSON.stringify({
  ok: true,
  shortcut,
  shortcutTarget: latestExe,
  stoppedOldProcessIds: stoppedProcesses || null,
  cleanupCmd: process.argv.includes('--desktop-run') ? null : cleanupCmd,
  preserved: [
    'dist',
    'installer-dist',
    'bridge-dist',
    'out',
    'src',
    'worker',
    'migrations',
    'tests',
    'user data under %LOCALAPPDATA%\\ExcelSync'
  ],
  deleted,
  skipped
}, null, 2))
