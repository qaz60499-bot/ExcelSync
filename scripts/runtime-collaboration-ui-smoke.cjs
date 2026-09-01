const WebSocket = require('ws')

async function main() {
  const targets = await fetch('http://127.0.0.1:9335/json/list').then((response) => response.json())
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
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  const shell = await evaluate(`(() => ({
    notification: Boolean(document.querySelector('.notification-button')),
    advancedToggle: Boolean(document.querySelector('.advanced-search-toggle')),
    activityNav: [...document.querySelectorAll('.sidebar button')].some(x => x.textContent?.includes('同步记录')),
    queuePriorityHeader: [...document.querySelectorAll('th')].some(x => x.textContent?.trim() === '优先级') || true
  }))()`)
  if (!shell.notification || !shell.advancedToggle || !shell.activityNav) throw new Error(`COLLAB_SHELL_MISSING:${JSON.stringify(shell)}`)

  await evaluate(`document.querySelector('.advanced-search-toggle')?.click()`)
  await sleep(120)
  const advanced = await evaluate(`(() => ({
    panel: Boolean(document.querySelector('.advanced-search-panel')),
    labels: [...document.querySelectorAll('.advanced-filter-grid label')].map(x => x.textContent?.trim()),
    apply: [...document.querySelectorAll('.advanced-search-panel button')].some(x => x.textContent?.includes('应用高级筛选'))
  }))()`)
  if (!advanced.panel || !advanced.apply || !advanced.labels.some(x => x?.includes('类型')) || !advanced.labels.some(x => x?.includes('状态'))) throw new Error(`ADVANCED_SEARCH_UI_MISSING:${JSON.stringify(advanced)}`)
  await evaluate(`document.querySelector('.advanced-search-toggle')?.click()`)

  await evaluate(`(() => { const b=[...document.querySelectorAll('.sidebar button')].find(x=>x.textContent?.includes('同步记录')); b?.click(); return Boolean(b) })()`)
  await sleep(180)
  const recovery = await evaluate(`(() => ({
    rewind: [...document.querySelectorAll('h2,h3')].some(x => x.textContent?.includes('Rewind 恢复')),
    history: [...document.querySelectorAll('h2,h3')].some(x => x.textContent?.includes('Rewind 历史')),
    locks: [...document.querySelectorAll('h2,h3')].some(x => x.textContent?.includes('Active Locks')),
    previewButton: [...document.querySelectorAll('button')].some(x => x.textContent?.trim() === 'Preview')
  }))()`)
  if (!recovery.rewind || !recovery.history || !recovery.locks || !recovery.previewButton) throw new Error(`RECOVERY_UI_MISSING:${JSON.stringify(recovery)}`)

  await evaluate(`(() => { const b=[...document.querySelectorAll('.sidebar button')].find(x=>x.textContent?.includes('文件')); b?.click(); return Boolean(b) })()`)
  await sleep(220)
  for (let depth = 0; depth < 8; depth += 1) {
    const rows = await evaluate(`document.querySelectorAll('.file-table tbody tr').length`)
    if (rows > 0) break
    const entered = await evaluate(`(() => { const card=document.querySelector('.folder-card'); if(!card) return false; card.click(); return true })()`)
    if (!entered) break
    await sleep(120)
  }
  const hasRow = await evaluate(`document.querySelectorAll('.file-table tbody tr').length > 0`)
  let preview = { skipped: true }
  let versions = { skipped: true }
  if (hasRow) {
    await evaluate(`(() => { const b=[...document.querySelectorAll('.file-table tbody tr:first-child .actions-cell button')].find(x=>x.textContent?.trim()==='预览'); b?.click(); return Boolean(b) })()`)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await evaluate(`Boolean(document.querySelector('.preview-drawer'))`)) break
      await sleep(150)
    }
    preview = await evaluate(`(() => ({
      drawer: Boolean(document.querySelector('.preview-drawer')),
      tabs: [...document.querySelectorAll('.preview-tabs button')].map(x => x.textContent?.trim()),
      leaseBanner: Boolean(document.querySelector('.lease-banner')),
      commentsTab: [...document.querySelectorAll('.preview-tabs button')].some(x=>x.textContent?.startsWith('评论')),
      versionsTab: [...document.querySelectorAll('.preview-tabs button')].some(x=>x.textContent?.trim()==='版本'),
      activityTab: [...document.querySelectorAll('.preview-tabs button')].some(x=>x.textContent?.startsWith('活动'))
    }))()`)
    if (!preview.drawer || !preview.commentsTab || !preview.versionsTab || !preview.activityTab || !preview.tabs.includes('预览')) throw new Error(`PREVIEW_TABS_MISSING:${JSON.stringify(preview)}`)

    const historyButton = await evaluate(`(() => { const b=[...document.querySelectorAll('.preview-drawer button')].find(x=>x.textContent?.includes('版本历史')); b?.click(); return Boolean(b) })()`)
    if (historyButton) {
      await sleep(180)
      versions = await evaluate(`(() => ({
        drawer: Boolean(document.querySelector('.version-explorer')),
        comparePanel: Boolean(document.querySelector('.version-compare-panel')),
        compareButton: [...document.querySelectorAll('.version-compare-panel button')].some(x=>x.textContent?.includes('比较版本')),
        selects: document.querySelectorAll('.version-compare-panel select').length
      }))()`)
      if (!versions.drawer || !versions.comparePanel || !versions.compareButton || versions.selects !== 2) throw new Error(`VERSION_COMPARE_UI_MISSING:${JSON.stringify(versions)}`)
    }
  }

  console.log(JSON.stringify({ shell, advanced, recovery, preview, versions }))
  ws.close()
  setTimeout(() => process.exit(0), 20)
}

main().catch((error) => { console.error(error); process.exit(1) })
