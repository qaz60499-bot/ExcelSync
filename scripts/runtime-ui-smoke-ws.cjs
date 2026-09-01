const WebSocket = require('ws')

async function main() {
  const targets = await fetch('http://127.0.0.1:9335/json/list').then((r) => r.json())
  const target = targets.find((item) => item.type === 'page')
  if (!target) throw new Error('NO_PAGE')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  let seq = 0
  const pending = new Map()
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString())
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  })
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }

  await call('Emulation.setDeviceMetricsOverride', { width: 800, height: 700, deviceScaleFactor: 1, mobile: false })
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent?.includes('文件') && x.closest('.sidebar')); b?.click(); const root=[...document.querySelectorAll('.folder-toolbar button')].find(x=>x.textContent?.trim()==='同步根目录'); root?.click(); return true })()`)
  await new Promise((r) => setTimeout(r, 500))
  const root = await evaluate(`(() => ({
    width: innerWidth,
    folders: [...document.querySelectorAll('.folder-card b')].map(x=>x.textContent?.trim()),
    folderCounts: [...document.querySelectorAll('.folder-card small')].map(x=>x.textContent?.trim()),
    rows: document.querySelectorAll('.table-panel tbody tr').length,
    rootText: document.querySelector('.folder-toolbar')?.textContent?.trim()
  }))()`)
  const zhejiang = await evaluate(`(() => { const b=[...document.querySelectorAll('.folder-card')].find(x=>x.textContent?.includes('浙江省')); b?.click(); return Boolean(b) })()`)
  await new Promise((r) => setTimeout(r, 250))
  for (let depth = 0; depth < 5; depth += 1) {
    const rows = await evaluate(`document.querySelectorAll('.table-panel tbody tr').length`)
    if (rows > 0) break
    const entered = await evaluate(`(() => { const b=document.querySelector('.folder-card'); if (!b) return false; b.click(); return true })()`)
    if (!entered) break
    await new Promise((r) => setTimeout(r, 180))
  }
  const nested = await evaluate(`(() => ({
    entered: true,
    width: innerWidth,
    folders: [...document.querySelectorAll('.folder-card b')].map(x=>x.textContent?.trim()),
    rows: document.querySelectorAll('.table-panel tbody tr').length,
    toolbar: document.querySelector('.folder-toolbar')?.textContent?.trim()
  }))()`)
  let action = null
  if (nested.rows > 0) {
    action = await evaluate(`(() => { const a=document.querySelector('.actions-cell'), w=document.querySelector('.table-wrap'); const ar=a?.getBoundingClientRect(), wr=w?.getBoundingClientRect(); return {position:a?getComputedStyle(a).position:null,right:ar?.right,left:ar?.left,wrapRight:wr?.right,visible:Boolean(ar&&wr&&ar.left>=wr.left&&ar.right<=wr.right+1)} })()`)
  }
  console.log(JSON.stringify({ root, zhejiang, nested, action }))
  ws.close()
  setTimeout(() => process.exit(0), 50)
}

main().catch((error) => { console.error(error); process.exit(1) })
