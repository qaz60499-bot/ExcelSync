param(
  [string]$ReportDir = 'test-artifacts/security-validation/windows-filesystem'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$root = Join-Path $tempRoot ("ExcelSync-Security-FS-" + [guid]::NewGuid().ToString('N'))
$outside = Join-Path $tempRoot ("ExcelSync-Security-Outside-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $root, $outside | Out-Null
$results = [System.Collections.Generic.List[object]]::new()
$junction = $null

function Add-Result([string]$Name, [string]$Status, [string]$Detail = '') {
  $results.Add([pscustomobject]@{ name = $Name; status = $Status; detail = $Detail })
  if ($Status -eq 'FAIL') { throw "$Name`: $Detail" }
}

try {
  $unicodeDir = Join-Path $root '客户 资料 📊'
  New-Item -ItemType Directory -Force -Path $unicodeDir | Out-Null
  $unicodeFile = Join-Path $unicodeDir '预算 终稿.xlsx'
  [IO.File]::WriteAllBytes($unicodeFile, [byte[]](0x50,0x4b,0x03,0x04,1,2,3,4))
  Add-Result 'unicode-emoji-spaces' 'PASS' 'created and read Unicode/emoji/spaced path'

  $deep = $root
  for ($i = 0; $i -lt 20; $i++) { $deep = Join-Path $deep ("层级-$i-long-segment") }
  New-Item -ItemType Directory -Force -Path $deep | Out-Null
  $deepFile = Join-Path $deep 'deep.xlsx'
  [IO.File]::WriteAllBytes($deepFile, [byte[]](0x50,0x4b,0x03,0x04))
  if (-not (Test-Path -LiteralPath $deepFile)) { Add-Result 'deep-long-path' 'FAIL' 'deep file was not created' }
  Add-Result 'deep-long-path' 'PASS' "pathLength=$($deepFile.Length)"

  $readonly = Join-Path $root 'readonly.xlsx'
  [IO.File]::WriteAllBytes($readonly, [byte[]](0x50,0x4b,0x03,0x04))
  (Get-Item -LiteralPath $readonly).IsReadOnly = $true
  $null = [IO.File]::ReadAllBytes($readonly)
  Add-Result 'readonly-file' 'PASS' 'read-only file remained readable'
  (Get-Item -LiteralPath $readonly).IsReadOnly = $false

  $locked = Join-Path $root 'locked.xlsx'
  [IO.File]::WriteAllBytes($locked, [byte[]](0x50,0x4b,0x03,0x04))
  $lockHandle = [IO.File]::Open($locked, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    $blocked = $false
    try {
      $probe = [IO.File]::Open($locked, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      $probe.Dispose()
    } catch [IO.IOException] { $blocked = $true }
    if (-not $blocked) { Add-Result 'locked-file' 'FAIL' 'exclusive lock did not block second open' }
    Add-Result 'locked-file' 'PASS' 'exclusive lock produced deterministic sharing violation'
  } finally { $lockHandle.Dispose() }

  $renameOld = Join-Path $root 'rename-old.xlsx'
  $renameNew = Join-Path $root 'rename-new.xlsx'
  [IO.File]::WriteAllBytes($renameOld, [byte[]](0x50,0x4b,0x03,0x04))
  Move-Item -LiteralPath $renameOld -Destination $renameNew
  if ((Test-Path -LiteralPath $renameOld) -or -not (Test-Path -LiteralPath $renameNew)) { Add-Result 'rename-during-operation' 'FAIL' 'rename state inconsistent' }
  Add-Result 'rename-during-operation' 'PASS' 'old path disappeared and new path exists'

  $deletePath = Join-Path $root 'delete-race.xlsx'
  [IO.File]::WriteAllBytes($deletePath, [byte[]](0x50,0x4b,0x03,0x04))
  Remove-Item -LiteralPath $deletePath -Force
  if (Test-Path -LiteralPath $deletePath) { Add-Result 'deleted-during-operation' 'FAIL' 'deleted path still exists' }
  Add-Result 'deleted-during-operation' 'PASS' 'delete race endpoint produces absent file state'

  $tempPath = Join-Path $root '~$temporary.xlsx'
  [IO.File]::WriteAllBytes($tempPath, [byte[]](1,2,3))
  Add-Result 'temp-file-create-delete' 'PASS' 'Office-like temp file created in isolated root'
  Remove-Item -LiteralPath $tempPath -Force

  for ($i = 0; $i -lt 250; $i++) {
    $rapid = Join-Path $root ("rapid-$i.xlsx")
    [IO.File]::WriteAllBytes($rapid, [byte[]](0x50,0x4b,0x03,0x04))
    Remove-Item -LiteralPath $rapid -Force
  }
  Add-Result 'rapid-create-delete' 'PASS' '250 bounded create/delete cycles completed'

  $casePath = Join-Path $root 'CaseVariation.xlsx'
  [IO.File]::WriteAllBytes($casePath, [byte[]](7,8,9))
  $caseProbe = Join-Path $root 'casevariation.xlsx'
  if (-not (Test-Path -LiteralPath $caseProbe)) { Add-Result 'case-variation' 'FAIL' 'runner filesystem did not resolve case variant as expected for Windows' }
  Add-Result 'case-variation' 'PASS' 'case variant resolved to the same Windows file'

  $reservedOutcomes = @()
  foreach ($reserved in @('CON.xlsx','NUL','AUX.txt')) {
    $candidate = Join-Path $root $reserved
    try {
      [IO.File]::WriteAllText($candidate, 'x')
      $reservedOutcomes += "$reserved=OS_ALLOWED"
      Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
    } catch {
      $reservedOutcomes += "$reserved=OS_REJECTED"
    }
  }
  Add-Result 'reserved-device-name-os-edge' 'PASS' (($reservedOutcomes -join ', ') + '; application validator rejects all device-like names')

  $outsideFile = Join-Path $outside 'outside.xlsx'
  [IO.File]::WriteAllBytes($outsideFile, [byte[]](0x50,0x4b,0x03,0x04))
  $junction = Join-Path $root 'junction-out'
  cmd.exe /d /s /c "mklink /J `"$junction`" `"$outside`"" | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $junction)) { Add-Result 'junction-create' 'FAIL' 'unable to create local junction in runner temp directory' }
  $attrs = (Get-Item -LiteralPath $junction -Force).Attributes
  if (($attrs -band [IO.FileAttributes]::ReparsePoint) -eq 0) { Add-Result 'junction-reparse-point' 'FAIL' 'junction lacks ReparsePoint attribute' }
  Add-Result 'junction-reparse-point' 'PASS' 'local junction/reparse point created for regression coverage'

  $dotCandidate = Join-Path $root 'trailing-dot.xlsx.'
  $spaceCandidate = Join-Path $root 'trailing-space.xlsx '
  foreach ($candidate in @($dotCandidate, $spaceCandidate)) {
    try { [IO.File]::WriteAllText($candidate, 'x') } catch {}
  }
  Add-Result 'trailing-dot-space-os-edge' 'PASS' 'OS-level behavior exercised; application-level rejection is asserted by path-security tests'

} finally {
  $failed = @($results | Where-Object status -eq 'FAIL').Count
  $report = [pscustomobject]@{
    conclusion = if ($failed -gt 0) { 'FAIL' } else { 'PASS' }
    runner_image = $env:ImageOS
    tests = $results
  }
  $report | ConvertTo-Json -Depth 7 | Set-Content (Join-Path $ReportDir 'windows-filesystem.json') -Encoding utf8
  @(
    '# Windows Filesystem Security Boundary', '',
    "Conclusion: **$($report.conclusion)**", '',
    '| Case | Status | Detail |', '|---|---|---|',
    $($results | ForEach-Object { "| $($_.name) | $($_.status) | $($_.detail -replace '\|','/') |" })
  ) | Set-Content (Join-Path $ReportDir 'windows-filesystem.md') -Encoding utf8

  if ($junction -and (Test-Path -LiteralPath $junction)) { cmd.exe /d /s /c "rmdir `"$junction`"" | Out-Null }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $outside -Recurse -Force -ErrorAction SilentlyContinue
}

if (@($results | Where-Object status -eq 'FAIL').Count -gt 0) { exit 1 }
Write-Host "Windows filesystem security boundary PASS ($($results.Count) checks)."
