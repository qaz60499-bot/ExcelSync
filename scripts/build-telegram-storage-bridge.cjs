const { existsSync, mkdirSync, rmSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')

const root = resolve(__dirname, '..')
const python = process.env.EXCELSYNC_PYTHON || 'python'
const venv = join(tmpdir(), 'ExcelSync-TelegramStorage-Bridge-Build')
const venvPython = process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
const requirements = join(root, 'scripts', 'telegram-storage-requirements.txt')
const bridgeScript = join(root, 'scripts', 'telegram-storage-bridge.py')
const distDir = join(root, 'bridge-dist')
const workDir = join(tmpdir(), 'ExcelSync-TelegramStorage-Bridge-PyInstaller')
const expectedExe = join(distDir, process.platform === 'win32' ? 'telegram-storage-bridge.exe' : 'telegram-storage-bridge')

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`)
}

if (!existsSync(venvPython)) {
  run(python, ['-m', 'venv', venv], 'python venv creation')
}
run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements], 'bridge dependency install')

mkdirSync(distDir, { recursive: true })
rmSync(expectedExe, { force: true })
rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })

run(venvPython, [
  '-m', 'PyInstaller',
  '--noconfirm',
  '--clean',
  '--onefile',
  '--name', 'telegram-storage-bridge',
  '--distpath', distDir,
  '--workpath', join(workDir, 'work'),
  '--specpath', join(workDir, 'spec'),
  '--hidden-import', 'telethon',
  '--hidden-import', 'telethon.crypto',
  bridgeScript
], 'telegram bridge build')

if (!existsSync(expectedExe)) throw new Error(`bridge artifact missing: ${expectedExe}`)
console.log(`Telegram storage bridge ready: ${expectedExe}`)
