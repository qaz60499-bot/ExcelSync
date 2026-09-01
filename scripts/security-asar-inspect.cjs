const fs = require('fs')
const path = require('path')
const asar = require('@electron/asar')

const asarPath = process.argv[2]
const reportDir = process.argv[3] || path.join('test-artifacts', 'security-validation', 'asar-inspect')
if (!asarPath || !fs.existsSync(asarPath)) throw new Error(`ASAR_NOT_FOUND: ${asarPath || '<missing>'}`)
fs.mkdirSync(reportDir, { recursive: true })

const sensitiveForbidden = [
  /(^|[\\/])\.env(?:\.|$)/i,
  /(^|[\\/])\.dev\.vars(?:\.|$)/i,
  /(^|[\\/])secrets?\.json$/i,
  /(^|[\\/])credentials?/i,
  /(^|[\\/])e2e-login.*\.json$/i,
  /(^|[\\/])\.pair-session\.json$/i,
  /\.(?:pfx|p12|pem|key)$/i,
  /\.sqlite(?:-shm|-wal)?$/i
]
const ownSourceForbidden = [
  /\.map$/i,
  /(^|[\\/])tests?([\\/]|$)/i,
  /(^|[\\/])\.git([\\/]|$)/i
]
const secretPatterns = [
  /TELEGRAM_BOT_TOKEN\s*[=:]\s*['\"](?!test|dummy|fake|example)[A-Za-z0-9_-]{20,}:[A-Za-z0-9_-]{20,}['\"]/i,
  /CLOUDFLARE_API_TOKEN\s*[=:]\s*['\"](?!test|dummy|fake|example)[A-Za-z0-9_-]{30,}['\"]/i,
  /Authorization\s*[:=]\s*Bearer\s+[A-Za-z0-9._~-]{24,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
]
const textExt = new Set(['.js','.cjs','.mjs','.json','.html','.css','.txt','.md','.xml','.ini','.cfg'])

const entries = asar.listPackage(asarPath).map((entry) => entry.replace(/^[/\\]+/, ''))
const badNames = entries.filter((entry) => {
  if (sensitiveForbidden.some((re) => re.test(entry))) return true
  if (entry.replaceAll('\\', '/').startsWith('node_modules/')) return false
  return ownSourceForbidden.some((re) => re.test(entry))
})
const thirdPartyTestEntries = entries.filter((entry) => {
  const normalized = entry.replaceAll('\\', '/')
  return normalized.startsWith('node_modules/') && /(^|\/)tests?(\/|$)/i.test(normalized)
}).length
const thirdPartySourceMaps = entries.filter((entry) => entry.replaceAll('\\', '/').startsWith('node_modules/') && /\.map$/i.test(entry)).length
let scanned = 0
let secretMatches = 0
for (const entry of entries) {
  if (!textExt.has(path.extname(entry).toLowerCase())) continue
  let stat
  try { stat = asar.statFile(asarPath, entry) } catch { continue }
  if (!stat || stat.size > 5 * 1024 * 1024) continue
  let data
  try { data = asar.extractFile(asarPath, entry) } catch { continue }
  scanned += 1
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8')
  if (secretPatterns.some((re) => re.test(text))) secretMatches += 1
}

const report = {
  conclusion: badNames.length || secretMatches ? 'FAIL' : 'PASS',
  entries: entries.length,
  scannedTextEntries: scanned,
  forbiddenNameMatches: badNames.length,
  secretShapeEntryMatches: secretMatches,
  thirdPartyTestEntries,
  thirdPartySourceMaps
}
fs.writeFileSync(path.join(reportDir, 'asar-inspect.json'), JSON.stringify(report, null, 2))
fs.writeFileSync(path.join(reportDir, 'asar-inspect.md'), [
  '# ASAR Security Inspection', '',
  `Conclusion: **${report.conclusion}**`,
  `ASAR entries: ${report.entries}`,
  `Scanned text entries: ${report.scannedTextEntries}`,
  `Forbidden filename matches: ${report.forbiddenNameMatches}`,
  `Secret-shape entry matches: ${report.secretShapeEntryMatches}`,
  `Third-party test entries (reported, non-blocking): ${report.thirdPartyTestEntries}`,
  `Third-party source maps (reported, non-blocking): ${report.thirdPartySourceMaps}`
].join('\n'))

if (report.conclusion !== 'PASS') {
  console.error(`ASAR security inspection FAIL (forbidden-name=${badNames.length}, secret-shaped-entry=${secretMatches}); matched values and paths are withheld.`)
  process.exit(1)
}
console.log(`ASAR security inspection PASS (${entries.length} entries; ${scanned} text entries scanned).`)
