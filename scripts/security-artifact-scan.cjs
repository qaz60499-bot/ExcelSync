const fs = require('fs')
const path = require('path')

const roots = process.argv.slice(2)
const reportDir = path.join('test-artifacts', 'security-validation')
fs.mkdirSync(reportDir, { recursive: true })

const forbiddenNames = [
  /^\.env(?:\.|$)/i,
  /^\.dev\.vars(?:\.|$)/i,
  /(?:^|[\\/])secrets?\.json$/i,
  /(?:^|[\\/])credentials?/i,
  /(?:^|[\\/])\.pair-session\.json$/i,
  /(?:^|[\\/])e2e-login.*\.json$/i,
  /\.(?:pfx|p12|pem|key)$/i,
  /\.sqlite(?:-shm|-wal)?$/i,
  /\.map$/i
]
const secretPatterns = [
  /TELEGRAM_BOT_TOKEN\s*[=:]\s*['\"](?!test|dummy|fake|example)[A-Za-z0-9_-]{20,}:[A-Za-z0-9_-]{20,}['\"]/i,
  /CLOUDFLARE_API_TOKEN\s*[=:]\s*['\"](?!test|dummy|fake|example)[A-Za-z0-9_-]{30,}['\"]/i,
  /Authorization\s*[:=]\s*Bearer\s+[A-Za-z0-9._~-]{24,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
]
const textExt = new Set(['.js','.cjs','.mjs','.ts','.tsx','.json','.html','.css','.py','.txt','.md','.yml','.yaml','.xml','.ini','.cfg'])
const scanned = []
const badNames = []
const secretFiles = []

function walk(root) {
  if (!fs.existsSync(root)) return
  const stat = fs.lstatSync(root)
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(root)) walk(path.join(root, name))
    return
  }
  if (!stat.isFile()) return
  const normalized = root.replaceAll('\\','/')
  const base = path.basename(root)
  if (forbiddenNames.some((re) => re.test(base) || re.test(normalized))) badNames.push(normalized)
  if (stat.size > 5 * 1024 * 1024 || !textExt.has(path.extname(root).toLowerCase())) return
  scanned.push(normalized)
  const text = fs.readFileSync(root, 'utf8')
  if (secretPatterns.some((re) => re.test(text))) secretFiles.push(normalized)
}

for (const root of roots) walk(root)
const report = {
  conclusion: badNames.length || secretFiles.length ? 'FAIL' : 'PASS',
  roots,
  scannedTextFiles: scanned.length,
  forbiddenNameMatches: badNames.length,
  secretShapeFileMatches: secretFiles.length
}
fs.writeFileSync(path.join(reportDir, 'artifact-scan.json'), JSON.stringify(report, null, 2))
fs.writeFileSync(path.join(reportDir, 'artifact-scan.md'), [
  '# Build / Package Sensitive Data Scan', '',
  `Conclusion: **${report.conclusion}**`,
  `Scanned text files: ${report.scannedTextFiles}`,
  `Forbidden filename matches: ${report.forbiddenNameMatches}`,
  `Secret-shape file matches: ${report.secretShapeFileMatches}`
].join('\n'))
if (report.conclusion !== 'PASS') {
  console.error(`Artifact sensitive-data scan FAIL (forbidden-name=${badNames.length}, secret-shaped-file=${secretFiles.length}); matched values and paths are not printed.`)
  process.exit(1)
}
console.log(`Artifact sensitive-data scan PASS (${scanned.length} text files scanned; no sensitive filename or secret-shape matches).`)
