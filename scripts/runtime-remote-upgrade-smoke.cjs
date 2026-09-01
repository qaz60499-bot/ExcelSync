const WebSocket = require('ws')

const debugPort = Number(process.env.EXCELSYNC_RUNTIME_DEBUG_PORT || 9335)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  let page
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      if (response.ok) {
        const list = await response.json()
        page = list.find((item) => item.type === 'page')
        if (page) break
      }
    } catch {}
    await sleep(100)
  }
  if (!page) throw new Error('REMOTE_SMOKE_RENDERER_NOT_READY')

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

  const evaluate = (expression) => new Promise((resolve, reject) => {
    const id = ++nextId
    waiters.set(id, {
      resolve: (result) => {
        if (result.exceptionDetails) reject(new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'RUNTIME_EXCEPTION'))
        else resolve(result.result.value)
      },
      reject
    })
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })

  try {
    const result = await evaluate(`(async () => {
      const auth = await window.excelSync.authState()
      if (!auth.authenticated) throw new Error('REMOTE_SMOKE_AUTH_REQUIRED')
      const workspaceId = auth.defaultWorkspaceId || auth.memberships?.find((item) => item.status === 'ACTIVE')?.workspaceId
      if (!workspaceId) throw new Error('REMOTE_SMOKE_WORKSPACE_REQUIRED')
      const [version, dashboard, notifications, search, rewind, locks, storage] = await Promise.all([
        window.excelSync.clientVersion(),
        window.excelSync.dashboard(),
        window.excelSync.notifications('all'),
        window.excelSync.advancedSearch({ workspaceId }),
        window.excelSync.rewindHistory(workspaceId),
        window.excelSync.activeLocks(),
        window.excelSync.storageStatus()
      ])
      return {
        user: auth.username,
        workspaceId,
        version,
        dashboard: {
          online: dashboard.health?.online,
          worker: dashboard.health?.worker,
          pending: dashboard.pending,
          conflicts: dashboard.conflicts
        },
        notifications: { count: notifications.notifications.length, unread: notifications.unreadCount },
        searchCount: search.length,
        rewindCount: rewind.length,
        activeLocks: locks.length,
        storage: { reachable: storage.reachable, status: storage.status, message: storage.message }
      }
    })()`)

    if (result.version?.latest !== '1.4.1') throw new Error(`REMOTE_VERSION_MISMATCH:${JSON.stringify(result.version)}`)
    if (result.version?.apiVersion !== '2026-08-31') throw new Error(`REMOTE_API_VERSION_MISMATCH:${JSON.stringify(result.version)}`)
    if (result.dashboard?.worker !== 'ok' || result.dashboard?.online !== true) throw new Error(`REMOTE_DASHBOARD_UNHEALTHY:${JSON.stringify(result.dashboard)}`)
    if (result.storage?.reachable !== true) throw new Error(`REMOTE_STORAGE_UNHEALTHY:${JSON.stringify(result.storage)}`)
    console.log(JSON.stringify(result))
  } finally {
    socket.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
