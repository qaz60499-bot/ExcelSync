const WebSocket = require('ws')

const debugPort = Number(process.argv[2] || 9340)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  let page
  for (let attempt = 0; attempt < 120; attempt += 1) {
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
  if (!page) throw new Error('BINARY_RENDERER_NOT_READY')
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
        if (result.exceptionDetails) reject(new Error(result.exceptionDetails.text || 'RUNTIME_EXCEPTION'))
        else resolve(result.result.value)
      },
      reject
    })
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  try {
    const state = await evaluate(`(async () => ({
      title: document.title,
      bridge: typeof window.excelSync?.authState,
      auth: await window.excelSync.authState(),
      bodyHasChinese: document.body.innerText.includes('ExcelSync') || document.body.innerText.includes('登录') || document.body.innerText.includes('文件')
    }))()`)
    if (state.bridge !== 'function' || !state.bodyHasChinese) throw new Error(`BINARY_SHELL_INVALID:${JSON.stringify(state)}`)
    console.log(JSON.stringify(state))
  } finally {
    socket.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
