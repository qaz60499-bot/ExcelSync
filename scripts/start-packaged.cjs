const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { resolve } = require('node:path')

const exe = resolve(__dirname, '..', 'dist', 'win-unpacked', 'ExcelSync.exe')
if (!existsSync(exe)) throw new Error(`PACKAGED_EXE_NOT_FOUND:${exe}`)
const child = spawn(exe, ['--remote-debugging-port=9335'], {
  detached: true,
  stdio: 'ignore',
  windowsHide: false
})
child.unref()
console.log(exe)
