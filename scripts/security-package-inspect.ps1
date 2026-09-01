param(
  [string]$ArtifactsDir = 'ci-security-dist',
  [string]$ReportDir = 'test-artifacts/security-validation/package-inspect'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

$sevenZipCommand = Get-Command 7z.exe -ErrorAction SilentlyContinue
if (-not $sevenZipCommand) { $sevenZipCommand = Get-Command 7z -ErrorAction SilentlyContinue }
$sevenZipPath = if ($sevenZipCommand) { $sevenZipCommand.Source } else { $null }
if (-not $sevenZipPath) {
  $vendored = Join-Path (Resolve-Path '.').Path 'node_modules\electron-winstaller\vendor\7z-x64.exe'
  if (Test-Path -LiteralPath $vendored) { $sevenZipPath = $vendored }
}
if (-not $sevenZipPath) { throw 'BLOCKED_BY_ENVIRONMENT: 7-Zip not available from runner or locked dependencies' }

$artifacts = @(Get-ChildItem -LiteralPath $ArtifactsDir -Filter 'ExcelSync-*.exe' -File)
if ($artifacts.Count -lt 2) { throw "Expected Setup and Portable artifacts in $ArtifactsDir" }

$forbiddenName = '(?i)(^|[\\/])(\.env(?:\.|$)|\.dev\.vars(?:\.|$)|secrets?\.json$|credentials?|private[-_ ]?key|\.pair-session\.json$|e2e-login.*\.json$|\.git([\\/]|$)|tests?([\\/]|$)|.*\.sqlite(?:-shm|-wal)?$|.*\.map$)'
$secretShape = '(?i)(telegram_bot_token|cloudflare_api_token|authorization\s*[:=]\s*bearer|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)'
$results = @()

foreach ($artifact in $artifacts) {
  $listingPath = Join-Path $ReportDir ($artifact.BaseName + '-7z-listing.txt')
  $listing = & $sevenZipPath l -slt -- $artifact.FullName 2>&1 | Out-String
  $listing | Set-Content -LiteralPath $listingPath -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw "7-Zip listing failed for $($artifact.Name)" }

  $paths = @($listing -split "`r?`n" | Where-Object { $_ -like 'Path = *' } | ForEach-Object { $_.Substring(7) })
  $badNames = @($paths | Where-Object { $_ -match $forbiddenName })
  if ($badNames.Count -gt 0) { throw "Sensitive/unexpected packaged path detected in $($artifact.Name); details withheld from log and saved only as a count" }
  if ($listing -match $secretShape) { throw "Secret-shaped text detected in package listing for $($artifact.Name); value withheld" }
  $results += [pscustomobject]@{ artifact = $artifact.Name; entries = $paths.Count; forbidden_name_matches = 0; secret_shape_matches = 0 }
}

$results | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $ReportDir 'package-inspect.json') -Encoding utf8
@(
  '# Package Static Security Inspection',
  '',
  'Conclusion: **PASS**',
  '',
  '| Artifact | Archive entries | Forbidden-name matches | Secret-shape matches |',
  '|---|---:|---:|---:|',
  $($results | ForEach-Object { "| $($_.artifact) | $($_.entries) | $($_.forbidden_name_matches) | $($_.secret_shape_matches) |" })
) | Set-Content (Join-Path $ReportDir 'package-inspect.md') -Encoding utf8

Write-Host "Package static security inspection PASS for $($artifacts.Count) artifact(s)."
