const WebSocket = require('ws')

const debugPort = Number(process.env.EXCELSYNC_RUNTIME_DEBUG_PORT || 9335)
const args = process.argv.slice(2)
const batchMode = args.includes('--batch')
const fileIds = args.filter((arg) => arg !== '--batch')
if (!batchMode && fileIds.length === 0) throw new Error('AT_LEAST_ONE_FILE_ID_REQUIRED')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function target() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      if (response.ok) {
        const list = await response.json()
        const page = list.find((item) => item.type === 'page')
        if (page) return page
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('PRODUCTION_RENDERER_NOT_READY')
}

async function attach() {
  const page = await target()
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  let nextId = 0
  const waiters = new Map()
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    const waiter = waiters.get(message.id)
    if (!waiter) return
    waiters.delete(message.id)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    waiters.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'RUNTIME_EXCEPTION')
    return result.result.value
  }
  return { socket, evaluate }
}

async function main() {
  const connection = await attach()
  try {
    const auth = await connection.evaluate('window.excelSync.authState()')
    if (!auth?.authenticated || !['OWNER', 'ADMIN'].includes(auth.user?.systemRole)) throw new Error('ADMIN_SESSION_REQUIRED')
    const results = []
    if (batchMode) {
      const result = await connection.evaluate('window.excelSync.repairVersionIntegrity()')
      results.push({ batch: true, repaired: result.repaired, skipped: result.skipped })
    } else {
      for (const fileId of fileIds) {
        const result = await connection.evaluate(`window.excelSync.repairVersionIntegrity(${JSON.stringify(fileId)})`)
        results.push({ fileId, repaired: result.repaired, skipped: result.skipped })
      }
    }
    const audit = await connection.evaluate('window.excelSync.versionIntegrity()')
    console.log(JSON.stringify({ results, summary: audit.summary, remainingRepairable: audit.findings.filter((item) => item.current_reference_repairable).length }))
  } finally {
    connection.socket.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
