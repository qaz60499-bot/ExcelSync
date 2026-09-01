const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const pkg = require('../package.json')

if (process.platform !== 'win32') {
  throw new Error('WINDOWS_SIGNATURE_VERIFICATION_REQUIRES_WINDOWS')
}

const root = resolve(__dirname, '..')
const output = join(root, 'installer-dist')
const files = [
  join(output, `ExcelSync-Setup-${pkg.version}-x64.exe`),
  join(output, `ExcelSync-Portable-${pkg.version}-x64.exe`),
  join(output, 'win-unpacked', 'ExcelSync.exe'),
  join(output, 'win-unpacked', 'resources', 'telegram-storage-bridge.exe')
]

const command = [
  '& { param([string]$Path)',
  '$sig = Get-AuthenticodeSignature -LiteralPath $Path',
  '[PSCustomObject]@{ Status = $sig.Status.ToString(); Subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { $null } } | ConvertTo-Json -Compress',
  '}'
].join('; ')

const failures = []
for (const file of files) {
  if (!existsSync(file)) {
    failures.push(`${file}: MISSING`)
    continue
  }
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command, file], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0) {
    failures.push(`${file}: SIGNATURE_CHECK_FAILED ${String(result.stderr || '').trim()}`)
    continue
  }
  let parsed
  try {
    parsed = JSON.parse(String(result.stdout || '').trim())
  } catch {
    failures.push(`${file}: SIGNATURE_CHECK_INVALID_OUTPUT`)
    continue
  }
  if (parsed.Status !== 'Valid' || !parsed.Subject) failures.push(`${file}: ${parsed.Status || 'UNKNOWN'}`)
  else console.log(`VALID ${file} ${parsed.Subject}`)
}

if (failures.length > 0) {
  console.error('Windows release signature verification failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(2)
}
