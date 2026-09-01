const { execFileSync } = require('node:child_process')
try {
  execFileSync('taskkill.exe', ['/IM', 'ExcelSync.exe', '/F'], { stdio: 'ignore' })
} catch {
  // No running ExcelSync process is fine.
}
console.log('ExcelSync stopped')
