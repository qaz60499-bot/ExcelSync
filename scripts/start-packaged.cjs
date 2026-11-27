const { spawn } = require('node:child_process')
const { existsSync, realpathSync } = require('node:fs')
const { resolve, relative, isAbsolute, basename } = require('node:path')

const root = realpathSync(resolve(__dirname, '..'))
const requested = process.argv[2]
if (!requested || process.argv.length !== 3) throw new Error('Usage: npm run start:packaged -- <verified path to ExcelSync.exe>')
const exe = realpathSync(resolve(root, requested))
const scoped = relative(root, exe)
if (!scoped || scoped.startsWith('..') || isAbsolute(scoped) || basename(exe) !== 'ExcelSync.exe') {
  throw new Error('PACKAGED_EXE_OUTSIDE_PROJECT')
}
if (!existsSync(exe)) throw new Error(`PACKAGED_EXE_NOT_FOUND:${exe}`)
const child = spawn(exe, [], {
  detached: true,
  stdio: 'ignore',
  windowsHide: false
})
child.unref()
console.log(exe)
