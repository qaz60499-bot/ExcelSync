const fs = require('fs')
const cp = require('child_process')
const path = require('path')

const reportDir = process.argv[2] || path.join('test-artifacts', 'security-validation')
fs.mkdirSync(reportDir, { recursive: true })

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))
const findings = []
const failures = []

function finding(kind, severity, subject, detail, classification = 'EXPECTED / NOT EXPLOITABLE') {
  findings.push({ kind, severity, subject, detail, classification })
}
function fail(kind, severity, subject, detail, classification = 'SECURITY BUG') {
  finding(kind, severity, subject, detail, classification)
  failures.push({ kind, severity, subject })
}

if (lock.lockfileVersion !== 3) fail('lockfile', 'high', 'package-lock.json', `unexpected lockfileVersion=${lock.lockfileVersion}`, 'CI/HARNESS BUG')
if (lock.packages?.['']?.version !== pkg.version) fail('lockfile', 'high', 'root package version', 'package.json and package-lock.json root version differ', 'CI/HARNESS BUG')

const nonRegistry = []
const missingIntegrity = []
const lifecycle = []
for (const [nodePath, meta] of Object.entries(lock.packages || {})) {
  if (!nodePath || !meta || typeof meta !== 'object') continue
  if (meta.resolved && !String(meta.resolved).startsWith('https://registry.npmjs.org/')) nonRegistry.push({ nodePath, resolved: meta.resolved })
  if (meta.resolved && !meta.integrity) missingIntegrity.push(nodePath)
  if (meta.hasInstallScript) lifecycle.push(nodePath.replace(/^node_modules\//, ''))
}
if (nonRegistry.length) fail('supply-chain', 'high', 'non-registry dependencies', `${nonRegistry.length} package(s) resolve outside registry.npmjs.org`, 'SECURITY BUG')
else finding('supply-chain', 'info', 'dependency sources', 'all resolved packages use registry.npmjs.org')
if (missingIntegrity.length) fail('supply-chain', 'high', 'missing integrity', `${missingIntegrity.length} resolved package(s) lack integrity`, 'SECURITY BUG')
else finding('supply-chain', 'info', 'integrity', 'all resolved packages have integrity metadata')

const allowedLifecycle = new Set([
  'electron-winstaller',
  'esbuild',
  'fsevents',
  'vite/node_modules/esbuild',
  'workerd',
  'wrangler/node_modules/esbuild'
])
const unexpectedLifecycle = lifecycle.filter((name) => !allowedLifecycle.has(name))
if (unexpectedLifecycle.length) fail('lifecycle', 'high', 'unexpected install scripts', unexpectedLifecycle.join(', '), 'SECURITY BUG')
else finding('lifecycle', 'info', 'install scripts', `reviewed allowlist: ${lifecycle.join(', ')}`)

let audit
let auditExit = 0
try {
  const result = process.platform === 'win32'
    ? cp.spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm audit --json'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
    : cp.spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
  if (result.error) throw result.error
  auditExit = result.status ?? 1
  if (!result.stdout?.trim()) throw new Error(`npm audit produced no JSON output (exit=${auditExit})`)
  audit = JSON.parse(result.stdout)
  if (!audit.metadata?.vulnerabilities || !audit.vulnerabilities) throw new Error('npm audit JSON is missing vulnerability metadata')
} catch (error) {
  fail('audit', 'high', 'npm audit', `unable to obtain trustworthy npm audit output: ${error instanceof Error ? error.message : String(error)}`, 'CI/HARNESS BUG')
  audit = { vulnerabilities: {}, metadata: { vulnerabilities: {} } }
}

const packages = lock.packages || {}
const runtimeSource = ['src/main/preview.ts', 'src/main/version-diff.ts']
  .filter((file) => fs.existsSync(file))
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n')
const exceljsRuntimeReferenced = /from\s+['\"]exceljs['\"]|require\(['\"]exceljs['\"]\)/.test(runtimeSource)
const excelUuidSources = []
function collectJs(directory) {
  if (!fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) collectJs(full)
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      const text = fs.readFileSync(full, 'utf8')
      if (/require\(['\"]uuid['\"]\)|from\s+['\"]uuid['\"]/.test(text)) excelUuidSources.push(text)
    }
  }
}
collectJs(path.join('node_modules', 'exceljs', 'lib'))
const excelUuidText = excelUuidSources.join('\n')
const exceljsOnlyUsesUuidV4 = excelUuidSources.length > 0 &&
  /(?:uuidv4|\bv4)\s*\(/.test(excelUuidText) &&
  !/(?:uuidv3|uuidv5|uuidv6|\bv3|\bv5|\bv6)\s*\(/.test(excelUuidText)
const uuidAdvisory = audit.vulnerabilities?.uuid
const uuidAdvisorySources = Array.isArray(uuidAdvisory?.via)
  ? uuidAdvisory.via.filter((entry) => entry && typeof entry === 'object').map((entry) => Number(entry.source))
  : []
const exactUuidBufferAdvisoryOnly = uuidAdvisorySources.length === 1 && uuidAdvisorySources[0] === 1119441

for (const [name, vuln] of Object.entries(audit.vulnerabilities || {})) {
  const nodes = Array.isArray(vuln.nodes) ? vuln.nodes : []
  const lockfileDevFlagOnly = nodes.length > 0 && nodes.every((nodePath) => packages[nodePath]?.dev === true)
  const viaNames = Array.isArray(vuln.via) ? vuln.via.map((entry) => typeof entry === 'string' ? entry : entry?.name).filter(Boolean) : []
  const isKnownUnreachableUuidPath = exceljsRuntimeReferenced && exceljsOnlyUsesUuidV4 && exactUuidBufferAdvisoryOnly && (
    name === 'uuid' || (name === 'exceljs' && viaNames.length === 1 && viaNames[0] === 'uuid')
  )

  if (isKnownUnreachableUuidPath) {
    finding(
      'npm-audit',
      vuln.severity || 'unknown',
      name,
      `runtime dependency chain is bundled/referenced, but GHSA-w5hq-g745-h8pq affects uuid v3/v5/v6 with caller-provided buf; inspected ExcelJS code only calls uuid.v4() without a buffer; range=${vuln.range || 'unknown'}`,
      'EXPECTED / NOT EXPLOITABLE (affected API unreachable)'
    )
    continue
  }

  const runtimeReachable = name === 'exceljs' ? exceljsRuntimeReferenced : false
  const devOnly = lockfileDevFlagOnly && !runtimeReachable
  const classification = devOnly ? 'dev-only' : 'potentially production-reachable'
  finding('npm-audit', vuln.severity || 'unknown', name, `${classification}; range=${vuln.range || 'unknown'}`, devOnly ? 'EXPECTED / NOT EXPLOITABLE' : 'SECURITY BUG')
  if (!devOnly && ['moderate', 'high', 'critical'].includes(vuln.severity)) failures.push({ kind: 'npm-audit', severity: vuln.severity, subject: name })
}

const summary = {
  conclusion: failures.length ? 'FAIL' : 'PASS',
  auditExit,
  version: pkg.version,
  lifecycleScripts: lifecycle,
  npmAuditCounts: audit.metadata?.vulnerabilities || {},
  findings,
  failures
}
fs.writeFileSync(path.join(reportDir, 'supply-chain.json'), JSON.stringify(summary, null, 2))
fs.writeFileSync(path.join(reportDir, 'supply-chain.md'), [
  '# Supply-chain Security Validation',
  '',
  `Conclusion: **${summary.conclusion}**`,
  `Version: ${pkg.version}`,
  `Lifecycle script packages: ${lifecycle.join(', ') || 'none'}`,
  '',
  '| Kind | Severity | Subject | Classification | Detail |',
  '|---|---|---|---|---|',
  ...findings.map((item) => `| ${item.kind} | ${item.severity} | ${String(item.subject).replaceAll('|','/')} | ${item.classification} | ${String(item.detail).replaceAll('|','/')} |`)
].join('\n'))

if (failures.length) {
  console.error(`Supply-chain validation FAIL (${failures.length} blocking finding(s)); see artifact report.`)
  process.exit(1)
}
console.log(`Supply-chain validation PASS (${Object.keys(audit.vulnerabilities || {}).length} npm audit finding(s) classified; details in artifact).`)
