async function main() {
  const targets = await fetch('http://127.0.0.1:9335/json/list').then((response) => response.json())
  const target = targets.find((item) => item.type === 'page')
  if (!target) throw new Error('NO_RENDERER_TARGET')

  const socket = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data))
    if (!message.id) return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  }
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id
    pending.set(callId, { resolve, reject })
    socket.send(JSON.stringify({ id: callId, method, params }))
  })

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'RUNTIME_EXCEPTION')
    return result.result.value
  }

  await evaluate(`(() => {
    const fileButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === '▤\\n文件' || button.textContent?.includes('文件'))
    if (fileButton) fileButton.click()
    return true
  })()`)

  await evaluate(`window.resizeTo(760, 640); true`)
  await new Promise((resolve) => setTimeout(resolve, 700))

  for (let depth = 0; depth < 8; depth += 1) {
    const hasRows = await evaluate(`document.querySelectorAll('.file-table tbody tr').length > 0`)
    if (hasRows) break
    const entered = await evaluate(`(() => { const folder = document.querySelector('.folder-card'); if (!folder) return false; folder.click(); return true })()`)
    if (!entered) break
    await new Promise((resolve) => setTimeout(resolve, 220))
  }

  const clickedMore = await evaluate(`(() => { const button = document.querySelector('.file-table tbody tr .file-more-button'); if (!button) return false; button.click(); return true })()`)
  if (clickedMore) await new Promise((resolve) => setTimeout(resolve, 120))

  const layout = await evaluate(`(() => {
    const wrap = document.querySelector('.table-wrap')
    const action = document.querySelector('.actions-cell')
    const table = document.querySelector('.table-panel table')
    const menu = document.querySelector('.file-more-popover')
    const cells = action?.parentElement ? [...action.parentElement.children] : []
    const rect = action?.getBoundingClientRect()
    const wrapRect = wrap?.getBoundingClientRect()
    const menuRect = menu?.getBoundingClientRect()
    const sidebar = document.querySelector('.sidebar')
    const navLabels = [...document.querySelectorAll('.nav-label')]
    return {
      innerWidth: window.innerWidth,
      bodyScrollWidth: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      sidebarWidth: sidebar?.getBoundingClientRect().width ?? null,
      hiddenNavLabels: navLabels.filter((node) => getComputedStyle(node).display === 'none').length,
      hasPhotosNav: [...document.querySelectorAll('nav button')].some((button) => button.textContent?.includes('照片')),
      brandText: document.querySelector('.brand b')?.textContent?.trim() ?? null,
      folderNames: [...document.querySelectorAll('.folder-card b')].map((node) => node.textContent?.trim()),
      tableRows: document.querySelectorAll('.table-panel tbody tr').length,
      openButtons: [...document.querySelectorAll('.actions-cell button')].filter((button) => button.textContent?.trim() === '打开').length,
      moreMenuVisible: Boolean(menu && menuRect && menuRect.width >= 220 && menuRect.left >= 0 && menuRect.right <= window.innerWidth && menuRect.top >= 0 && menuRect.bottom <= window.innerHeight),
      moreMenuWidth: menuRect?.width ?? null,
      moreMenuLabels: menu ? [...menu.querySelectorAll('button')].map((button) => button.textContent?.trim()) : [],
      actionPosition: action ? getComputedStyle(action).position : null,
      actionRight: rect?.right ?? null,
      wrapRight: wrapRect?.right ?? null,
      actionFullyVisible: Boolean(rect && wrapRect && rect.left >= wrapRect.left && rect.right <= wrapRect.right + 1),
      tableScrollWidth: wrap?.scrollWidth ?? null,
      tableClientWidth: wrap?.clientWidth ?? null,
      columnDisplays: cells.map((cell) => getComputedStyle(cell).display),
      tableWidth: table?.getBoundingClientRect().width ?? null
    }
  })()`)

  if (clickedMore && !layout.moreMenuVisible) throw new Error(`MORE_MENU_NOT_VISIBLE:${JSON.stringify(layout)}`)

  await evaluate(`(() => { const taskButton = [...document.querySelectorAll('nav button')].find((button) => button.title === '任务'); if (!taskButton) return false; taskButton.click(); return true })()`)
  await new Promise((resolve) => setTimeout(resolve, 180))
  const taskCenter = await evaluate(`(() => ({
    createButton: [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('创建任务')),
    templateCount: document.querySelectorAll('.task-template-card').length,
    templateLabels: [...document.querySelectorAll('.task-template-card b')].map((node) => node.textContent?.trim()),
    metricCount: document.querySelectorAll('.task-metric-grid > button').length,
    hasSystemQueue: [...document.querySelectorAll('.panel-header h3')].some((node) => node.textContent?.trim() === '系统同步队列'),
    hasRunHistory: [...document.querySelectorAll('.panel-header h3')].some((node) => node.textContent?.trim() === '最近运行记录')
  }))()`)
  if (!taskCenter.createButton || taskCenter.templateCount < 5 || taskCenter.metricCount !== 4 || !taskCenter.hasSystemQueue || !taskCenter.hasRunHistory) throw new Error(`TASK_CENTER_INCOMPLETE:${JSON.stringify(taskCenter)}`)

  const modalOpened = await evaluate(`(() => {
    const create = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('创建任务'))
    if (!create) return false
    create.click()
    return true
  })()`)
  if (!modalOpened) throw new Error('TASK_CREATE_BUTTON_FAILED')
  await new Promise((resolve) => setTimeout(resolve, 100))
  const created = await evaluate(`(() => {
    const custom = [...document.querySelectorAll('.task-create-templates button')].find((button) => button.textContent?.includes('自定义任务'))
    if (!custom) return false
    custom.click()
    return Boolean(document.querySelector('.task-create-fields'))
  })()`)
  if (!created) throw new Error('TASK_CREATE_MODAL_FAILED')
  await new Promise((resolve) => setTimeout(resolve, 80))
  await evaluate(`(() => {
    const input = document.querySelector('.task-create-fields input:not([type="date"])')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, ${JSON.stringify('TASK_SMOKE_MARKER')})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const submit = [...document.querySelectorAll('.task-create-footer button')].find((button) => button.textContent?.trim() === '创建任务')
    submit?.click()
    return true
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 120))
  const taskCreated = await evaluate(`[...document.querySelectorAll('.user-task-row')].some((row) => row.textContent?.includes('TASK_SMOKE_MARKER'))`)
  if (!taskCreated) throw new Error('TASK_CREATE_PERSIST_UI_FAILED')
  await evaluate(`(() => { window.confirm = () => true; const row = [...document.querySelectorAll('.user-task-row')].find((node) => node.textContent?.includes('TASK_SMOKE_MARKER')); row?.querySelector('.user-task-actions .danger')?.click(); return true })()`)

  console.log(JSON.stringify({ ...layout, taskCenter, taskCreated }))
  socket.close()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
