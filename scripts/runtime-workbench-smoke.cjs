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

  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await evaluate(`(() => { const b=[...document.querySelectorAll('.sidebar button')].find(x=>x.textContent?.includes('文件')); b?.click(); return Boolean(b) })()`)
  await sleep(300)
  await evaluate(`(() => { const root=[...document.querySelectorAll('.folder-toolbar button')].find(x=>x.textContent?.trim()==='同步根目录'); root?.click(); return Boolean(root) })()`)
  await sleep(200)

  for (let depth = 0; depth < 8; depth += 1) {
    const rows = await evaluate(`document.querySelectorAll('.file-table tbody tr').length`)
    if (rows > 0) break
    const entered = await evaluate(`(() => { const preferred=[...document.querySelectorAll('.folder-card')].find(x=>x.textContent?.includes('浙江省')) || document.querySelector('.folder-card'); if(!preferred) return false; preferred.click(); return true })()`)
    if (!entered) break
    await sleep(180)
  }

  const initial = await evaluate(`(() => ({
    rows: document.querySelectorAll('.file-table tbody tr').length,
    searchPlaceholder: document.querySelector('.file-search-row input')?.getAttribute('placeholder'),
    headers: [...document.querySelectorAll('.file-table thead th')].map(x=>x.textContent?.trim()),
    buttons: [...document.querySelectorAll('.file-table tbody tr:first-child .actions-cell button')].map(x=>x.textContent?.trim())
  }))()`)
  if (!initial.rows) throw new Error('NO_FILE_ROW')
  if (!initial.buttons.includes('预览') || !initial.buttons.includes('打开')) throw new Error('OPEN_PREVIEW_ACTIONS_MISSING')

  const fileName = await evaluate(`document.querySelector('.file-table tbody tr:first-child .file-name b')?.textContent?.trim()`)
  const searchResult = await evaluate(`(() => { const input=document.querySelector('.file-search-row input'); if(!input) return null; const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input, ${JSON.stringify('xlsx')}); input.dispatchEvent(new Event('input',{bubbles:true})); return input.value })()`)
  await sleep(350)
  const searchedRows = await evaluate(`document.querySelectorAll('.file-table tbody tr').length`)
  await evaluate(`(() => { const input=document.querySelector('.file-search-row input'); if(!input) return false; const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,''); input.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
  await sleep(250)

  await evaluate(`(() => { const b=[...document.querySelectorAll('.file-table tbody tr:first-child .actions-cell button')].find(x=>x.textContent?.trim()==='预览'); b?.click(); return Boolean(b) })()`)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ready = await evaluate(`Boolean(document.querySelector('.preview-table-wrap table, .text-preview, .image-preview img, .pdf-preview iframe, .zip-preview, .preview-empty:not(:only-child)'))`)
    if (ready) break
    await sleep(400)
  }
  const preview = await evaluate(`(() => ({
    exists: Boolean(document.querySelector('.preview-drawer')),
    title: document.querySelector('.preview-drawer h3')?.textContent?.trim(),
    hasExcelOpen: [...document.querySelectorAll('.preview-drawer button')].some(x=>x.textContent?.includes('使用 Excel 打开')),
    hasTable: Boolean(document.querySelector('.preview-table-wrap table')),
    hasText: Boolean(document.querySelector('.text-preview')),
    hasImage: Boolean(document.querySelector('.image-preview img')),
    hasPdf: Boolean(document.querySelector('.pdf-preview iframe')),
    hasZip: Boolean(document.querySelector('.zip-preview')),
    error: document.querySelector('.preview-empty')?.textContent?.trim()
  }))()`)
  if (!preview.exists) throw new Error('PREVIEW_DRAWER_MISSING')
  if (!preview.hasTable && !preview.hasText && !preview.hasImage && !preview.hasPdf && !preview.hasZip) throw new Error(`PREVIEW_NOT_READY:${preview.error ?? ''}`)

  await evaluate(`(() => { const close=document.querySelector('.preview-drawer .icon-close'); close?.click(); return true })()`)
  await sleep(100)
  const contextMenu = await evaluate(`(() => { const row=document.querySelector('.file-table tbody tr:first-child'); if(!row) return null; row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:440,clientY:360})); return true })()`)
  await sleep(120)
  const contextItems = await evaluate(`[...document.querySelectorAll('.file-context-menu button')].map(x=>x.textContent?.trim())`)
  if (!contextMenu || !contextItems.includes('打开') || !contextItems.includes('预览') || !contextItems.some((text)=>text?.includes('收藏'))) throw new Error('CONTEXT_MENU_MISSING')

  await evaluate(`(() => { document.body.click(); const favorite=[...document.querySelectorAll('.sidebar button')].find(x=>x.textContent?.includes('收藏')); return Boolean(favorite) })()`)
  const favoriteNav = await evaluate(`[...document.querySelectorAll('.sidebar button')].some(x=>x.textContent?.includes('收藏'))`)
  if (!favoriteNav) throw new Error('FAVORITES_NAV_MISSING')

  const opened = await evaluate(`(() => { const b=[...document.querySelectorAll('.file-table tbody tr:first-child .actions-cell button')].find(x=>x.textContent?.trim()==='打开'); b?.click(); return Boolean(b) })()`)
  if (!opened) throw new Error('OPEN_ACTION_MISSING')
  await sleep(900)
  await evaluate(`(() => { const dashboard=[...document.querySelectorAll('.sidebar button')].find(x=>x.textContent?.includes('个人云概览')); dashboard?.click(); return Boolean(dashboard) })()`)
  await sleep(350)
  const recentOpened = await evaluate(`(() => ({ heading:[...document.querySelectorAll('.panel h3')].some(x=>x.textContent?.trim()==='最近打开'), contains:[...document.querySelectorAll('.recent-file-row b')].some(x=>x.textContent?.trim()===${JSON.stringify(fileName)}) }))()`)
  if (!recentOpened.heading || !recentOpened.contains) throw new Error('RECENT_OPENED_NOT_RECORDED')

  await evaluate(`(() => { const task=[...document.querySelectorAll('.sidebar button')].find(x=>x.textContent?.includes('任务')); task?.click(); return Boolean(task) })()`)
  await sleep(250)
  const tasks = await evaluate(`(() => ({ heading: document.querySelector('.content h2')?.textContent?.trim(), body: document.querySelector('.content')?.textContent?.includes('任务中心') }))()`)
  if (!tasks.body) throw new Error('TASKS_PAGE_MISSING')

  console.log(JSON.stringify({ initial, fileName, searchResult, searchedRows, preview, contextItems, favoriteNav, recentOpened, tasks }))
  ws.close()
  setTimeout(() => process.exit(0), 50)
}

main().catch((error) => { console.error(error); process.exit(1) })
