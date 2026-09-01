const WebSocket = require('ws')

async function main() {
  const targets = await fetch('http://127.0.0.1:9335/json/list').then((response) => response.json())
  const target = targets.find((item) => item.type === 'page')
  if (!target) throw new Error('NO_PAGE')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  let nextId = 0
  const waiters = new Map()
  ws.on('message', (raw) => {
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
    ws.send(JSON.stringify({ id, method, params }))
  })
  const result = await call('Runtime.evaluate', {
    expression: `window.excelSync.authState().then((auth) => ({ auth, bodyHasLogout: document.body.innerText.includes('退出登录') }))`,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  console.log(JSON.stringify(result.result.value))
  ws.close()
  setTimeout(() => process.exit(0), 50)
}

main().catch((error) => { console.error(error); process.exit(1) })
