const { existsSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

const root = resolve(__dirname, '..')
const userProfile = process.env.USERPROFILE || 'C:\\Users\\gyy12'
const desktop = join(userProfile, 'Desktop')
const target = join(root, 'dist', 'win-unpacked', 'ExcelSync.exe')
const shortcut = join(desktop, 'ExcelSync.lnk')
const cleanup = join(desktop, 'ExcelSync-Cleanup-Old-Versions.cmd')
const currentVersion = '1.4.1'

if (!existsSync(target)) throw new Error(`FINAL_1_4_1_EXE_NOT_FOUND:${target}`)

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

const versionResult = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-Command', `(Get-Item ${psQuote(target)}).VersionInfo.FileVersion`],
  { encoding: 'utf8' }
)
if (versionResult.status !== 0) {
  throw new Error(versionResult.stderr || versionResult.stdout || 'VERSION_CHECK_FAILED')
}
const fileVersion = String(versionResult.stdout || '').trim()
if (!fileVersion.startsWith(currentVersion)) {
  throw new Error(`FINAL_EXE_VERSION_MISMATCH:${fileVersion}`)
}

const shortcutPs = [
  '$shell = New-Object -ComObject WScript.Shell',
  `$link = $shell.CreateShortcut(${psQuote(shortcut)})`,
  `$link.TargetPath = ${psQuote(target)}`,
  `$link.WorkingDirectory = ${psQuote(join(root, 'dist', 'win-unpacked'))}`,
  `$link.IconLocation = ${psQuote(`${target},0`)}`,
  `$link.Description = 'ExcelSync 1.4.1'`,
  '$link.Save()'
].join('; ')

const shortcutResult = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-Command', shortcutPs],
  { encoding: 'utf8' }
)
if (shortcutResult.status !== 0) {
  throw new Error(shortcutResult.stderr || shortcutResult.stdout || 'SHORTCUT_UPDATE_FAILED')
}

const lines = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal EnableExtensions EnableDelayedExpansion',
  `set "ROOT=${root}\\"`,
  `set "NEWEXE=${target}"`,
  `set "CURRENT=${currentVersion}"`,
  'set "SELF=%~f0"',
  '',
  'echo [ExcelSync 1.4.1] 最终旧版本收尾清理',
  'echo.',
  'if not exist "%NEWEXE%" (',
  '  echo [停止] 找不到当前 1.4.1 主程序：%NEWEXE%',
  '  pause',
  '  exit /b 2',
  ')',
  '',
  "for /f \"usebackq delims=\" %%V in (`powershell.exe -NoProfile -Command \"(Get-Item -LiteralPath '%NEWEXE%').VersionInfo.FileVersion\"`) do set \"FILEVER=%%V\"",
  'echo 当前主程序版本：%FILEVER%',
  'echo %FILEVER% | findstr /b /c:"1.4.1" >nul',
  'if errorlevel 1 (',
  '  echo [停止] 当前主程序不是 1.4.1，拒绝清理。',
  '  pause',
  '  exit /b 3',
  ')',
  '',
  'echo [1/4] 删除旧源码基线和临时目录...',
  'for %%D in (".baseline-1.2.4" "Tempexcel-sync-130-fresh" ".wrangler-photo-fresh") do (',
  '  if exist "%ROOT%%%~D" rmdir /s /q "%ROOT%%%~D"',
  ')',
  '',
  'echo [2/4] 删除已废弃的 1.3.0 / 1.3.1 升级与运行冒烟脚本...',
  'for %%F in (',
  '  "scripts\\desktop-upgrade-1.3.0.cjs"',
  '  "scripts\\desktop-upgrade-1.3.1.cjs"',
  '  "scripts\\run-desktop-cleanup-1.3.0.cjs"',
  '  "scripts\\run-desktop-cleanup-1.3.1.cjs"',
  '  "scripts\\runtime-production-1.3.1-smoke.cjs"',
  '  "scripts\\runtime-production-ui-smoke-1.3.1.cjs"',
  ') do (',
  '  if exist "%ROOT%%%~F" del /f /q "%ROOT%%%~F"',
  ')',
  '',
  'echo [3/4] 清理 dist 中所有非 1.4.1 的版本化安装产物...',
  "powershell.exe -NoProfile -Command \"$root = $env:ROOT; $keep = $env:CURRENT; $dist = Join-Path $root 'dist'; if (Test-Path -LiteralPath $dist) { Get-ChildItem -LiteralPath $dist -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^ExcelSync-(Setup|Portable)-[0-9]+\\.[0-9]+\\.[0-9]+-x64\\.exe(\\.blockmap)?$' -and $_.Name -notmatch ([regex]::Escape($keep)) } | Remove-Item -Force }\"",
  '',
  'echo [4/4] 清理旧桌面一次性文件和异常 nul 残留...',
  "powershell.exe -NoProfile -Command \"$self = $env:SELF; $desktop = [Environment]::GetFolderPath('Desktop'); Get-ChildItem -LiteralPath $desktop -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -ne $self -and ($_.Name -like 'ExcelSync-*-一次性清理旧版.cmd' -or $_.Name -eq 'ExcelSync-Cleanup-Old-Versions.cmd') } | Remove-Item -Force -ErrorAction SilentlyContinue\"",
  "powershell.exe -NoProfile -Command \"$p = '\\\\?\\' + (Join-Path $env:ROOT 'nul'); try { if ([System.IO.File]::Exists($p)) { [System.IO.File]::Delete($p) } } catch {}\"",
  '',
  'echo.',
  'echo 已保留：',
  'echo   - ExcelSync 1.4.1 Setup / Portable / win-unpacked',
  'echo   - tests\\enterprise-acl-1.3.1.test.ts（兼容性回归测试）',
  'echo   - %APPDATA%\\ExcelSync 用户配置、Session、本地 SQLite、缓存和同步设置',
  'echo   - 实际同步目录、用户文件、migrations 和当前测试',
  'echo.',
  'echo 清理完成。桌面 ExcelSync 快捷方式已指向 1.4.1。',
  'echo 本清理文件将在关闭窗口后自动删除。',
  'pause',
  'start "" cmd /c "timeout /t 2 /nobreak >nul & del /f /q \"%~f0\""',
  'exit /b 0',
  ''
]

writeFileSync(cleanup, lines.join('\r\n'), 'utf8')

console.log(JSON.stringify({
  shortcut,
  target,
  cleanup,
  fileVersion,
  preserved: [
    join(root, 'dist', 'ExcelSync-Setup-1.4.1-x64.exe'),
    join(root, 'dist', 'ExcelSync-Portable-1.4.1-x64.exe'),
    join(root, 'dist', 'win-unpacked'),
    join(process.env.APPDATA || '', 'ExcelSync'),
    join(root, 'tests', 'enterprise-acl-1.3.1.test.ts')
  ]
}))
