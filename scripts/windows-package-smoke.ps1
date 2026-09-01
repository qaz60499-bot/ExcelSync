param(
  [string]$ArtifactsDir = "ci-dist",
  [string]$ReportDir = "test-artifacts/package-smoke"
)

$ErrorActionPreference = 'Stop'
$started = Get-Date
$results = [System.Collections.Generic.List[object]]::new()
$logs = Join-Path $ReportDir 'logs'
$stateRoot = Join-Path (Resolve-Path '.').Path $ReportDir
$env:EXCELSYNC_USER_DATA_DIR = Join-Path $stateRoot 'UserData'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\ExcelSync-E2E'

New-Item -ItemType Directory -Force -Path $ReportDir, $logs, $env:EXCELSYNC_USER_DATA_DIR | Out-Null

function Add-Result([string]$Name, [string]$Status, [string]$Detail = '') {
  $results.Add([pscustomobject]@{ name = $Name; status = $Status; detail = $Detail })
}

function Fail-Step([string]$Name, [string]$Detail) {
  Add-Result $Name 'FAIL' $Detail
  throw "$Name`: $Detail"
}

function Get-ExcelSyncPids {
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'ExcelSync*' } | ForEach-Object { $_.Id })
}

function Run-App([string]$Exe, [string]$Name) {
  $before = @(Get-ExcelSyncPids)
  $p = Start-Process -FilePath $Exe -ArgumentList '--e2e-auto-quit-ms=5000' -PassThru
  if (-not $p.WaitForExit(30000)) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Fail-Step $Name "graceful quit timeout; pid=$($p.Id)"
  }
  if ($p.ExitCode -ne 0) { Fail-Step $Name "exit=$($p.ExitCode)" }
  Start-Sleep -Milliseconds 1000
  $after = @(Get-ExcelSyncPids)
  $owned = @($after | Where-Object { $_ -notin $before })
  if ($owned.Count -gt 0) {
    foreach ($pid in $owned) { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue }
    Fail-Step "$Name-process-cleanup" "test-owned ExcelSync process remained after graceful quit: $($owned -join ',')"
  }
  Add-Result $Name 'PASS' "started and graceful quit completed; exit=0"
}

$setup = $null
$portable = $null
$uninstaller = $null
$failure = $null
try {
  $setup = Get-ChildItem $ArtifactsDir -Filter 'ExcelSync-Setup-*-x64.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $portable = Get-ChildItem $ArtifactsDir -Filter 'ExcelSync-Portable-*-x64.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $setup -or -not $portable) { Fail-Step 'artifacts-present' "Setup or Portable artifact missing in $ArtifactsDir" }
  Add-Result 'artifacts-present' 'PASS' "$($setup.Name); $($portable.Name)"

  Run-App $portable.FullName 'portable-first-start'
  if (-not (Test-Path (Join-Path $env:EXCELSYNC_USER_DATA_DIR 'state\excel-sync.sqlite'))) {
    Fail-Step 'portable-local-state' 'state/excel-sync.sqlite was not initialized'
  }
  Add-Result 'portable-local-state' 'PASS' 'SQLite initialized in isolated E2E userData'
  Run-App $portable.FullName 'portable-second-start'

  if (Test-Path $installDir) { Remove-Item $installDir -Recurse -Force -ErrorAction SilentlyContinue }
  $installer = Start-Process -FilePath $setup.FullName -ArgumentList @('/S', "/D=$installDir") -PassThru -Wait
  if ($installer.ExitCode -ne 0) { Fail-Step 'setup-install' "exit=$($installer.ExitCode)" }
  $installedExe = Join-Path $installDir 'ExcelSync.exe'
  if (-not (Test-Path $installedExe)) { Fail-Step 'installed-exe' $installedExe }
  Add-Result 'setup-install' 'PASS' $installedExe

  $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'ExcelSync.lnk'
  $startShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\ExcelSync.lnk'
  if (Test-Path $desktopShortcut) { Add-Result 'desktop-shortcut' 'PASS' $desktopShortcut } else { Add-Result 'desktop-shortcut' 'FAIL' 'ExcelSync.lnk not found on Desktop' }
  if (Test-Path $startShortcut) { Add-Result 'start-menu-shortcut' 'PASS' $startShortcut } else { Add-Result 'start-menu-shortcut' 'FAIL' 'ExcelSync.lnk not found in Start Menu' }

  Run-App $installedExe 'installed-first-start'
  Run-App $installedExe 'installed-second-start'

  $uninstaller = Get-ChildItem $installDir -Filter 'Uninstall*.exe' | Select-Object -First 1
  if (-not $uninstaller) { Fail-Step 'uninstaller-present' 'Uninstaller missing' }
  Add-Result 'uninstaller-present' 'PASS' $uninstaller.FullName
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -PassThru -Wait
  if ($uninstall.ExitCode -ne 0) { Fail-Step 'uninstall' "exit=$($uninstall.ExitCode)" }
  Start-Sleep -Seconds 2
  Add-Result 'uninstall' 'PASS' 'exit=0'

  if (Test-Path $installedExe) { Add-Result 'uninstall-install-dir-clean' 'FAIL' "installed EXE remained: $installedExe" }
  else { Add-Result 'uninstall-install-dir-clean' 'PASS' 'installed EXE removed' }
  if (Test-Path $desktopShortcut) { Add-Result 'uninstall-desktop-shortcut-clean' 'FAIL' 'desktop shortcut remained' }
  else { Add-Result 'uninstall-desktop-shortcut-clean' 'PASS' 'desktop shortcut removed' }
  if (Test-Path $startShortcut) { Add-Result 'uninstall-start-shortcut-clean' 'FAIL' 'start menu shortcut remained' }
  else { Add-Result 'uninstall-start-shortcut-clean' 'PASS' 'start menu shortcut removed' }
} catch {
  $failure = $_.Exception.Message
} finally {
  $ended = Get-Date
  $failedCount = @($results | Where-Object status -eq 'FAIL').Count
  if ($failure -and $failedCount -eq 0) { Add-Result 'uncaught-error' 'FAIL' $failure; $failedCount = 1 }
  $package = Get-Content package.json | ConvertFrom-Json
  $report = [pscustomobject]@{
    environment = [pscustomobject]@{
      commit_sha = $env:GITHUB_SHA
      excelsync_version = $package.version
      runner_os = $env:RUNNER_OS
      runner_image = $env:ImageOS
      runner_name = $env:RUNNER_NAME
      start_time = $started.ToString('o')
      end_time = $ended.ToString('o')
    }
    suite = 'Windows Package Smoke'
    results = $results
    conclusion = if ($failedCount -gt 0) { 'FAIL' } else { 'PASS' }
  }
  $report | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $ReportDir 'test-report.json') -Encoding utf8
  $md = @(
    '# Windows Package Smoke',
    '',
    "- Commit SHA: $($report.environment.commit_sha)",
    "- ExcelSync version: $($report.environment.excelsync_version)",
    "- Runner OS: $($report.environment.runner_os)",
    "- Runner image: $($report.environment.runner_image)",
    "- Start: $($report.environment.start_time)",
    "- End: $($report.environment.end_time)",
    '',
    '| Test | Status | Detail |',
    '|---|---|---|'
  )
  foreach ($r in $results) { $md += "| $($r.name) | $($r.status) | $($r.detail -replace '\|','/') |" }
  $md += ''
  $md += "Conclusion: **$($report.conclusion)**"
  if ($failure) { $md += ''; $md += "Failure: $failure" }
  $md -join "`n" | Set-Content (Join-Path $ReportDir 'test-report.md') -Encoding utf8
}

if ($failure -or @($results | Where-Object status -eq 'FAIL').Count -gt 0) { exit 1 }
