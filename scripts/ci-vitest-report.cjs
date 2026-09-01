const fs = require('fs')
const path = require('path')

function arg(name, fallback) {
  const prefix = `--${name}=`
  const value = process.argv.find((item) => item.startsWith(prefix))
  return value ? value.slice(prefix.length) : fallback
}

const input = arg('input', 'test-artifacts/vitest.json')
const suite = arg('suite', 'Vitest')
const outputDir = arg('output-dir', path.dirname(input))
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
fs.mkdirSync(outputDir, { recursive: true })

let source = null
let parseError = null
try {
  source = JSON.parse(fs.readFileSync(input, 'utf8'))
} catch (error) {
  parseError = error instanceof Error ? error.message : String(error)
}

const total = source?.numTotalTests ?? 0
const passed = source?.numPassedTests ?? 0
const failed = source?.numFailedTests ?? (source ? Math.max(0, total - passed) : 1)
const pending = (source?.numPendingTests ?? 0) + (source?.numTodoTests ?? 0)
const started = source?.startTime ? new Date(source.startTime).toISOString() : null
const ended = new Date().toISOString()
const report = {
  environment: {
    commit_sha: process.env.GITHUB_SHA || null,
    excelsync_version: packageJson.version,
    runner_os: process.env.RUNNER_OS || process.platform,
    runner_image: process.env.ImageOS || process.env.ImageVersion || null,
    runner_name: process.env.RUNNER_NAME || null,
    node: process.version,
    start_time: started,
    end_time: ended
  },
  suite,
  tests: { total, passed, failed, pending },
  parse_error: parseError,
  conclusion: source?.success === true && failed === 0 && !parseError ? 'PASS' : 'FAIL'
}

fs.writeFileSync(path.join(outputDir, 'test-report.json'), `${JSON.stringify(report, null, 2)}\n`)
fs.writeFileSync(path.join(outputDir, 'test-report.md'), [
  `# ${suite}`,
  '',
  `- Commit SHA: ${report.environment.commit_sha || 'local'}`,
  `- ExcelSync version: ${report.environment.excelsync_version}`,
  `- Runner OS: ${report.environment.runner_os}`,
  `- Runner image: ${report.environment.runner_image || 'local'}`,
  `- Start: ${report.environment.start_time || 'unknown'}`,
  `- End: ${report.environment.end_time}`,
  '',
  `Tests: ${passed}/${total} passed; failed=${failed}; pending=${pending}`,
  '',
  `Conclusion: **${report.conclusion}**`,
  ...(parseError ? ['', `Report parse error: ${parseError}`] : [])
].join('\n'))

console.log(JSON.stringify(report, null, 2))
if (report.conclusion !== 'PASS') process.exitCode = 1
