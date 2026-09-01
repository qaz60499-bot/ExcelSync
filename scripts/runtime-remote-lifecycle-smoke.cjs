const WebSocket = require('ws')
const path = require('node:path')
const fs = require('node:fs')
const ExcelJS = require('exceljs')

async function main() {
  const targets = await fetch('http://127.0.0.1:9335/json/list').then((response) => response.json())
  const target = targets.find((item) => item.type === 'page')
  if (!target) throw new Error('NO_PAGE')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })

  let seq = 0
  const pendingCalls = new Map()
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString())
    const waiter = pendingCalls.get(message.id)
    if (!waiter) return
    pendingCalls.delete(message.id)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  })

  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq
      pendingCalls.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  if (process.env.CLEANUP_FILE_ID) {
    const cleanupId = process.env.CLEANUP_FILE_ID
    await evaluate(`window.excelSync.permanentlyDelete(${JSON.stringify(cleanupId)})`)
    console.log(JSON.stringify({ cleanupDeleted: cleanupId }))
    ws.close()
    setTimeout(() => process.exit(0), 50)
    return
  }

  if (process.env.CLEANUP_LOCAL_RELATIVE_PATH) {
    const settings = await evaluate(`window.excelSync.settings()`)
    const localPath = path.resolve(settings.syncDirectory, process.env.CLEANUP_LOCAL_RELATIVE_PATH.replaceAll('/', path.sep))
    fs.rmSync(localPath, { force: true })
    console.log(JSON.stringify({ cleanupLocalDeleted: localPath }))
    ws.close()
    setTimeout(() => process.exit(0), 50)
    return
  }

  let preflight = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    preflight = await evaluate(`(async () => {
      const [auth, tasks, files, settings, dashboard, storage] = await Promise.all([
        window.excelSync.authState(), window.excelSync.pending(), window.excelSync.files(), window.excelSync.settings(), window.excelSync.dashboard(), window.excelSync.storageStatus()
      ]);
      const candidates = files
        .filter(f => f.exists && f.extension === '.xlsx' && f.currentVersion > 0 && f.status === 'SYNCED' && f.cloudStatus === 'active')
        .sort((a,b)=>a.size-b.size);
      return { auth, pendingCount: tasks.length, settings, dashboard, storage, candidate: candidates[0] ?? null, initialIds: files.map(f=>f.id) };
    })()`)
    if (preflight?.auth?.authenticated && preflight?.dashboard?.health?.online && preflight?.dashboard?.health?.worker === 'ok' && preflight?.storage?.reachable) break
    await sleep(1000)
  }

  if (!preflight?.auth?.authenticated) throw new Error('REMOTE_SMOKE_AUTH_REQUIRED')
  if (preflight.pendingCount !== 0) throw new Error(`REMOTE_SMOKE_PENDING_QUEUE_NOT_EMPTY:${preflight.pendingCount}`)
  if (!preflight.settings?.autoSync) throw new Error('REMOTE_SMOKE_AUTOSYNC_PAUSED')
  if (!preflight.dashboard?.health?.online || preflight.dashboard?.health?.worker !== 'ok') throw new Error('REMOTE_SMOKE_WORKER_NOT_READY')
  if (!preflight.storage?.reachable) throw new Error('REMOTE_SMOKE_STORAGE_NOT_REACHABLE')
  if (!preflight.candidate) throw new Error('REMOTE_SMOKE_NO_SYNCED_LOCAL_XLSX_CANDIDATE')

  const source = preflight.candidate
  let copy = null
  let cleaned = false

  try {
    await evaluate(`window.excelSync.copyFile(${JSON.stringify(source.id)})`)

    for (let attempt = 0; attempt < 45; attempt += 1) {
      await evaluate(`window.excelSync.syncNow()`)
      await sleep(500)
      copy = await evaluate(`(async () => { const initial=new Set(${JSON.stringify(preflight.initialIds)}); const files=await window.excelSync.files(); return files.find(f => !initial.has(f.id)) ?? null })()`)
      if (copy?.currentVersion > 0 && copy.status === 'SYNCED') break
    }
    if (!copy) throw new Error('REMOTE_SMOKE_COPY_NOT_CREATED')
    if (copy.currentVersion !== 1 || copy.status !== 'SYNCED') throw new Error(`REMOTE_SMOKE_V1_NOT_SYNCED:${JSON.stringify(copy)}`)

    const localCopyPath = path.resolve(preflight.settings.syncDirectory, copy.relativePath.replaceAll('/', path.sep))
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(localCopyPath)
    const sheet = workbook.worksheets[0] ?? workbook.addWorksheet('Sheet1')
    sheet.getCell('ZZ1').value = `ExcelSync E2E update ${Date.now()}`
    await workbook.xlsx.writeFile(localCopyPath)

    await sleep(900)
    let v2 = null
    for (let attempt = 0; attempt < 55; attempt += 1) {
      await evaluate(`window.excelSync.syncNow()`)
      await sleep(500)
      v2 = await evaluate(`(async () => (await window.excelSync.files()).find(f => f.id === ${JSON.stringify(copy.id)}) ?? null)()`)
      if (v2?.currentVersion >= 2 && v2.status === 'SYNCED') break
    }
    if (!v2 || v2.currentVersion !== 2 || v2.status !== 'SYNCED') throw new Error(`REMOTE_SMOKE_V2_NOT_SYNCED:${JSON.stringify(v2)}`)

    const versionsBeforeRestore = await evaluate(`window.excelSync.versions(${JSON.stringify(copy.id)})`)
    if (versionsBeforeRestore.length < 2 || versionsBeforeRestore[0].version !== 2 || versionsBeforeRestore[1].version !== 1) {
      throw new Error(`REMOTE_SMOKE_VERSION_HISTORY_V2_FAILED:${JSON.stringify(versionsBeforeRestore)}`)
    }

    await evaluate(`window.excelSync.restore(${JSON.stringify(copy.id)}, 1)`)
    const afterRestoreFile = await evaluate(`(async () => (await window.excelSync.files()).find(f => f.id === ${JSON.stringify(copy.id)}) ?? null)()`)
    const versionsAfterRestore = await evaluate(`window.excelSync.versions(${JSON.stringify(copy.id)})`)
    if (!afterRestoreFile || afterRestoreFile.currentVersion !== 3 || versionsAfterRestore[0]?.version !== 3 || versionsAfterRestore[0]?.restored_from_version !== 1) {
      throw new Error(`REMOTE_SMOKE_VERSION_RESTORE_FAILED:${JSON.stringify({ afterRestoreFile, versionsAfterRestore })}`)
    }

    await evaluate(`window.excelSync.trashFile(${JSON.stringify(copy.id)})`)
    const trash = await evaluate(`window.excelSync.trash()`)
    if (!trash.some((item) => item.id === copy.id)) throw new Error('REMOTE_SMOKE_TRASH_FAILED')

    await evaluate(`window.excelSync.restoreTrash(${JSON.stringify(copy.id)})`)
    const restored = await evaluate(`window.excelSync.files()`)
    const restoredFile = restored.find((item) => item.id === copy.id)
    if (!restoredFile || restoredFile.cloudStatus !== 'active' || restoredFile.currentVersion !== 3) throw new Error('REMOTE_SMOKE_TRASH_RESTORE_FAILED')

    await evaluate(`window.excelSync.trashFile(${JSON.stringify(copy.id)})`)
    await evaluate(`window.excelSync.permanentlyDelete(${JSON.stringify(copy.id)})`)
    const finalTrash = await evaluate(`window.excelSync.trash()`)
    if (finalTrash.some((item) => item.id === copy.id)) throw new Error('REMOTE_SMOKE_PERMANENT_DELETE_FAILED')
    fs.rmSync(localCopyPath, { force: true })
    cleaned = true

    console.log(JSON.stringify({
      authenticated: true,
      worker: preflight.dashboard.health.worker,
      storageReachable: preflight.storage.reachable,
      source: { id: source.id, name: source.logicalName, size: source.size, version: source.currentVersion },
      copiedV1: { id: copy.id, name: copy.logicalName, version: 1 },
      editedAndSyncedV2: true,
      versionsBeforeRestore: versionsBeforeRestore.map((item) => item.version),
      restoredVersion: 3,
      restoredFromVersion: versionsAfterRestore[0].restored_from_version,
      versionsAfterRestore: versionsAfterRestore.map((item) => item.version),
      trashVerified: true,
      trashRestoreVerified: true,
      permanentDeleteVerified: true
    }))
  } finally {
    if (copy && !cleaned) {
      try { await evaluate(`window.excelSync.trashFile(${JSON.stringify(copy.id)})`) } catch {}
      try { await evaluate(`window.excelSync.permanentlyDelete(${JSON.stringify(copy.id)})`) } catch {}
    }
    ws.close()
    setTimeout(() => process.exit(0), 50)
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
