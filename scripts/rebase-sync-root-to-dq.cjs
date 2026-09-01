const { randomUUID } = require('node:crypto')
const { execFileSync, spawn } = require('node:child_process')
const { existsSync, readdirSync, statSync } = require('node:fs')
const { basename, join, resolve, sep } = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const newRoot = resolve(String.raw`D:\dq`)
const folderName = '浙江省'
const physicalFolder = join(newRoot, folderName)
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
    // No running process is fine.
  }
  sleep(800)
}

function startExcelSync() {
  if (!existsSync(exePath)) return false
  const child = spawn(exePath, ['--remote-debugging-port=9335'], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return true
}

function listRoot() {
  return readdirSync(newRoot, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    directory: entry.isDirectory()
  }))
}

function scanExcel(root) {
  let count = 0
  let oversized = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(absolute)
        continue
      }
      if (!entry.isFile() || entry.name.startsWith('~$') || !/\.(xlsx|xlsm)$/i.test(entry.name)) continue
      count += 1
      if (statSync(absolute).size > 20 * 1024 * 1024) oversized += 1
    }
  }
  walk(root)
  return { count, oversized }
}

if (!existsSync(newRoot) || !statSync(newRoot).isDirectory()) throw new Error('DQ_ROOT_NOT_FOUND')
if (!existsSync(physicalFolder) || !statSync(physicalFolder).isDirectory()) throw new Error('ZHEJIANG_FOLDER_NOT_FOUND')
if (!existsSync(dbPath)) throw new Error('LOCAL_DB_NOT_FOUND')

const db = new DatabaseSync(dbPath, { readOnly: dryRun })
const settingsRow = db.prepare("SELECT value_json FROM settings WHERE key='syncDirectory'").get()
const currentRoot = settingsRow ? JSON.parse(String(settingsRow.value_json)) : ''
const files = db.prepare('SELECT id, relative_path, logical_name, current_version, current_hash, status FROM files ORDER BY relative_path').all()
const pendingCount = Number(db.prepare('SELECT COUNT(*) AS c FROM pending_sync').get().c)
const alreadyRebased = files.every((file) => String(file.relative_path).replaceAll('\\', '/').startsWith(`${folderName}/`))
const physicalMissing = files.filter((file) => {
  const rel = String(file.relative_path).replaceAll('\\', '/')
  const rebasedRel = rel.startsWith(`${folderName}/`) ? rel : `${folderName}/${rel}`
  return !existsSync(join(newRoot, ...rebasedRel.split('/')))
}).map((file) => file.relative_path)

if (dryRun) {
  const rootExcel = scanExcel(newRoot)
  console.log(JSON.stringify({
    dryRun: true,
    currentRoot,
    newRoot,
    folderName,
    files: files.length,
    pendingCount,
    alreadyRebased,
    physicalMissing,
    rootEntries: listRoot(),
    rootExcelCount: rootExcel.count,
    oversizedExcelCount: rootExcel.oversized
  }))
  db.close()
  process.exit(0)
}

db.close()
if (physicalMissing.length > 0) throw new Error(`PHYSICAL_FILES_MISSING:${physicalMissing.length}`)
if (pendingCount > 0 && !alreadyRebased) throw new Error(`PENDING_QUEUE_NOT_EMPTY:${pendingCount}`)

stopExcelSync()
const writeDb = new DatabaseSync(dbPath)
const now = new Date().toISOString()
writeDb.exec('BEGIN IMMEDIATE')
try {
  writeDb.prepare(`
    INSERT INTO settings(key, value_json, updated_at)
    VALUES ('syncDirectory', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(JSON.stringify(newRoot), now)

  if (!alreadyRebased) {
    const updateFile = writeDb.prepare("UPDATE files SET relative_path = ?, status = 'PENDING', updated_at = ? WHERE id = ?")
    const insertRename = writeDb.prepare(`
      INSERT INTO pending_sync(
        id, file_id, operation, local_path, hash, size, base_version, idempotency_key,
        status, attempt_count, next_retry_at, error_code, error_message, created_at, updated_at
      ) VALUES (?, ?, 'RENAME', ?, NULL, NULL, ?, ?, 'PENDING', 0, NULL, NULL, NULL, ?, ?)
    `)

    for (const file of files) {
      const oldRel = String(file.relative_path).replaceAll('\\', '/')
      const newRel = `${folderName}/${oldRel}`
      const localPath = join(newRoot, ...newRel.split('/'))
      updateFile.run(newRel, now, file.id)
      insertRename.run(
        randomUUID(),
        file.id,
        localPath,
        Number(file.current_version),
        `${file.id}:${file.current_version}:RENAME:${newRel}`,
        now,
        now
      )
    }
  }

  writeDb.exec('COMMIT')
} catch (error) {
  writeDb.exec('ROLLBACK')
  writeDb.close()
  throw error
}
writeDb.close()

const started = noRestart ? false : startExcelSync()
console.log(JSON.stringify({
  currentRoot,
  newRoot,
  files: files.length,
  queuedRenames: alreadyRebased ? 0 : files.length,
  appRestarted: started
}))
