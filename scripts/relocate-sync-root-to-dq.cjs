const { createHash } = require('node:crypto')
const { execFileSync, spawn } = require('node:child_process')
const {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync
} = require('node:fs')
const { join, relative, resolve, sep } = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const source = resolve(String.raw`D:\wendangcodex\pyzhengli\浙江省`)
const targetParent = resolve(String.raw`D:\dq`)
const target = join(targetParent, '浙江省')
const appData = process.env.APPDATA
if (!appData) throw new Error('APPDATA_NOT_FOUND')
const dbPath = join(appData, 'ExcelSync', 'state', 'excel-sync.sqlite')
const exePath = resolve(__dirname, '..', 'dist', 'win-unpacked', 'ExcelSync.exe')
const dryRun = process.argv.includes('--dry-run')
const noRestart = process.argv.includes('--no-restart')

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function stopExcelSync() {
  try {
    execFileSync('taskkill.exe', ['/IM', 'ExcelSync.exe', '/F'], { stdio: 'ignore' })
  } catch {
    // No running ExcelSync process is fine.
  }
  sleep(800)
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function isTransientOfficeLock(relativePath) {
  const name = relativePath.split('/').pop() || ''
  return name.startsWith('~$') && /\.(xlsx|xlsm)$/i.test(name)
}

function inventory(root) {
  const rows = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`SYMLINK_REJECTED:${relative(root, absolute)}`)
      if (entry.isDirectory()) {
        walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const relativePath = relative(root, absolute).split(sep).join('/')
      if (isTransientOfficeLock(relativePath)) continue
      const info = lstatSync(absolute)
      rows.push({ relativePath, size: info.size, hash: hashFile(absolute) })
    }
  }
  walk(root)
  rows.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return rows
}

function removeTransientOfficeLocks(root) {
  if (!existsSync(root)) return
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
        continue
      }
      if (entry.isFile() && entry.name.startsWith('~$') && /\.(xlsx|xlsm)$/i.test(entry.name)) {
        rmSync(absolute, { force: true })
      }
    }
  }
  walk(root)
}

function sameInventory(a, b) {
  if (a.length !== b.length) return false
  return a.every((row, index) => {
    const other = b[index]
    return row.relativePath === other.relativePath && row.size === other.size && row.hash === other.hash
  })
}

function updateLocalDatabase() {
  if (!existsSync(dbPath)) throw new Error(`LOCAL_DB_NOT_FOUND:${dbPath}`)
  const db = new DatabaseSync(dbPath)
  const now = new Date().toISOString()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`
      INSERT INTO settings(key, value_json, updated_at)
      VALUES ('syncDirectory', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(target), now)

    const rows = db.prepare('SELECT id, local_path FROM pending_sync').all()
    const oldPrefix = source.toLowerCase() + sep
    const update = db.prepare('UPDATE pending_sync SET local_path = ?, updated_at = ? WHERE id = ?')
    for (const row of rows) {
      const localPath = String(row.local_path || '')
      if (localPath.toLowerCase() === source.toLowerCase()) {
        update.run(target, now, row.id)
      } else if (localPath.toLowerCase().startsWith(oldPrefix)) {
        update.run(join(target, relative(source, localPath)), now, row.id)
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

function startExcelSync() {
  if (!existsSync(exePath)) return false
  const child = spawn(exePath, ['--remote-debugging-port=9335'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
  return true
}

if (!existsSync(targetParent)) throw new Error(`TARGET_PARENT_NOT_FOUND:${targetParent}`)
if (!existsSync(source) && !existsSync(target)) throw new Error('SOURCE_AND_TARGET_MISSING')

if (dryRun) {
  const sourceInventory = existsSync(source) ? inventory(source) : []
  const targetInventory = existsSync(target) ? inventory(target) : []
  let unmanagedExcel = []
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const managed = new Set(db.prepare('SELECT relative_path FROM files').all().map((row) => String(row.relative_path).toLowerCase()))
    unmanagedExcel = sourceInventory
      .filter((row) => /\.(xlsx|xlsm)$/i.test(row.relativePath) && !managed.has(row.relativePath.toLowerCase()))
      .map((row) => row.relativePath)
    db.close()
  }
  console.log(JSON.stringify({
    dryRun: true,
    source,
    sourceExists: existsSync(source),
    sourceFiles: sourceInventory.length,
    sourceExcelCount: sourceInventory.filter((row) => /\.(xlsx|xlsm)$/i.test(row.relativePath)).length,
    unmanagedExcel,
    target,
    targetExists: existsSync(target),
    targetFiles: targetInventory.length,
    targetMatchesSource: sourceInventory.length > 0 && sameInventory(sourceInventory, targetInventory),
    database: dbPath
  }))
  process.exit(0)
}

stopExcelSync()

let sourceInventory = null
let targetInventory = null
let copied = false
let sourceRemoved = !existsSync(source)

if (existsSync(source)) {
  sourceInventory = inventory(source)
  if (existsSync(target)) {
    targetInventory = inventory(target)
    if (targetInventory.length === 0) {
      rmSync(target, { recursive: true, force: true })
      targetInventory = null
    } else if (!sameInventory(sourceInventory, targetInventory)) {
      throw new Error('TARGET_EXISTS_WITH_DIFFERENT_CONTENT')
    }
  }

  if (!existsSync(target)) {
    mkdirSync(targetParent, { recursive: true })
    cpSync(source, target, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true })
    removeTransientOfficeLocks(target)
    copied = true
    targetInventory = inventory(target)
    if (!sameInventory(sourceInventory, targetInventory)) {
      throw new Error('COPY_VERIFY_FAILED')
    }
  }

  try {
    rmSync(source, { recursive: true, force: false })
    sourceRemoved = true
  } catch {
    sourceRemoved = false
  }
} else {
  targetInventory = inventory(target)
}

updateLocalDatabase()
const started = noRestart ? false : startExcelSync()
const finalInventory = targetInventory || inventory(target)
const excelCount = finalInventory.filter((row) => /\.(xlsx|xlsm)$/i.test(row.relativePath)).length

console.log(JSON.stringify({
  source,
  target,
  copied,
  verifiedFiles: finalInventory.length,
  excelCount,
  sourceRemoved,
  databaseUpdated: true,
  appRestarted: started
}))
