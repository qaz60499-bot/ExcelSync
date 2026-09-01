const { spawn, execFileSync } = require('node:child_process')
const { resolve } = require('node:path')
const WebSocket = require('ws')

const root = resolve(__dirname, '..')
const exe = resolve(root, 'dist', 'win-unpacked', 'ExcelSync.exe')
const debugPort = Number(process.env.EXCELSYNC_RUNTIME_DEBUG_PORT || 9336)
const workerUrl = process.env.EXCELSYNC_RUNTIME_WORKER_URL || 'http://127.0.0.1:8788'
const userDataDir = process.env.EXCELSYNC_RUNTIME_USER_DATA || 'D:\\Temp\\ExcelSync130Runtime\\UserData'
const bootstrapNonce = process.env.EXCELSYNC_RUNTIME_BOOTSTRAP_NONCE
if (!bootstrapNonce) throw new Error('EXCELSYNC_RUNTIME_BOOTSTRAP_NONCE_REQUIRED')

const child = spawn(exe, [`--remote-debugging-port=${debugPort}`], {
  cwd: root,
  env: { ...process.env, EXCELSYNC_USER_DATA_DIR: userDataDir },
  stdio: 'ignore',
  windowsHide: false
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function targets() {
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
  throw new Error('ISOLATED_RENDERER_NOT_READY')
}

async function attach() {
  const target = await targets()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, reject) => { socket.once('open', resolveOpen); socket.once('error', reject) })
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
  const call = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++nextId
    waiters.set(id, { resolve: resolveCall, reject })
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
  let connection
  try {
    connection = await attach()
    const { evaluate } = connection
    const initial = await evaluate(`window.excelSync.authState()`)
    if (initial.authenticated) throw new Error(`ISOLATED_PROFILE_NOT_CLEAN:${JSON.stringify(initial)}`)

    const legacyTask = {
      id: 'runtime-legacy-task-130',
      title: 'Runtime legacy task migration',
      description: 'created only inside isolated runtime smoke',
      templateId: 'custom',
      status: 'todo',
      priority: 'medium',
      dueDate: '',
      assignee: 'Owner Runtime',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    await evaluate(`localStorage.setItem('excel-sync-user-tasks-v2', ${JSON.stringify(JSON.stringify([legacyTask]))}); true`)
    await evaluate(`window.excelSync.updateSettings({ workerUrl: ${JSON.stringify(workerUrl)} })`)
    await evaluate(`window.excelSync.bootstrap('owner130', 'runtime-owner-password-12345', ${JSON.stringify(bootstrapNonce)})`)
    await evaluate(`location.reload(); true`)
    await sleep(1400)

    connection.socket.close()
    connection = await attach()
    const { evaluate: eval2 } = connection
    const auth = await eval2(`window.excelSync.authState()`)
    if (!auth.authenticated || auth.user?.systemRole !== 'OWNER') throw new Error(`OWNER_AUTH_MISSING:${JSON.stringify(auth)}`)
    if (auth.memberships?.[0]?.role !== 'MANAGER') throw new Error(`OWNER_WORKSPACE_ROLE_MISSING:${JSON.stringify(auth)}`)

    const workspaceState = await eval2(`window.excelSync.workspaces()`)
    const workspaceId = workspaceState.defaultWorkspaceId || workspaceState.workspaces?.[0]?.id
    if (!workspaceId) throw new Error('DEFAULT_WORKSPACE_MISSING')

    const invite = await eval2(`window.excelSync.createInvite({ username:'runtimeviewer', displayName:'Runtime Viewer', workspaceId:${JSON.stringify(workspaceId)}, workspaceRole:'VIEWER', accountType:'INTERNAL', expiresInHours:24 })`)
    if (!invite.code?.startsWith('XS-')) throw new Error(`INVITE_CODE_MISSING:${JSON.stringify(invite)}`)

    const taskRows = await eval2(`window.excelSync.tasks('mine', ${JSON.stringify(workspaceId)})`)
    if (!taskRows.some((task) => task.title === 'Runtime legacy task migration')) throw new Error(`LEGACY_TASK_NOT_MIGRATED:${JSON.stringify(taskRows)}`)
    const legacyStillPresent = await eval2(`Boolean(localStorage.getItem('excel-sync-user-tasks-v2') || localStorage.getItem('excel-sync-user-tasks-v1'))`)
    if (legacyStillPresent) throw new Error('LEGACY_TASK_LOCALSTORAGE_NOT_CLEARED')

    const ui = await eval2(`(() => {
      const adminButton = [...document.querySelectorAll('nav button')].find((button) => button.title === '管理中心')
      const roleSwitch = document.querySelector('.role-view-label select')
      const manualRoleText = document.body.innerText.includes('工作台视图')
      if (adminButton) adminButton.click()
      return {
        adminNav: Boolean(adminButton),
        roleSwitch: Boolean(roleSwitch),
        manualRoleText,
        accountText: document.querySelector('.account-summary')?.innerText || '',
        rolePill: document.querySelector('.workspace-role-pill')?.innerText || ''
      }
    })()`)
    if (!ui.adminNav || ui.roleSwitch || ui.manualRoleText) throw new Error(`ROLE_UI_INVALID:${JSON.stringify(ui)}`)
    await sleep(650)

    const adminUi = await eval2(`(() => ({
      heading: [...document.querySelectorAll('h2')].some((node) => node.textContent?.trim() === '管理中心'),
      tabs: [...document.querySelectorAll('.admin-tabs button')].map((node) => node.textContent?.trim()),
      inviteForm: Boolean(document.querySelector('.admin-form-grid')),
      tokenInputs: document.querySelectorAll('input[type="password"]').length,
      bridge: {
        adminUsers: typeof window.excelSync.adminUsers,
        storageConnections: typeof window.excelSync.storageConnections,
        systemStatus: typeof window.excelSync.systemStatus,
        createStorageConnection: typeof window.excelSync.createStorageConnection
      }
    }))()`)
    const expectedTabs = ['用户', '工作空间', '存储连接', '审计日志', '系统状态']
    if (!adminUi.heading || expectedTabs.some((tab) => !adminUi.tabs.includes(tab))) throw new Error(`ADMIN_CENTER_INCOMPLETE:${JSON.stringify(adminUi)}`)
    if (Object.values(adminUi.bridge).some((value) => value !== 'function')) throw new Error(`ENTERPRISE_BRIDGE_INCOMPLETE:${JSON.stringify(adminUi.bridge)}`)

    const storageTab = await eval2(`(() => { const button = [...document.querySelectorAll('.admin-tabs button')].find((node) => node.textContent?.trim() === '存储连接'); button?.click(); return Boolean(button) })()`)
    if (!storageTab) throw new Error('STORAGE_TAB_MISSING')
    await sleep(300)
    const storageUi = await eval2(`(() => ({
      title: [...document.querySelectorAll('h3')].some((node) => node.textContent?.trim() === '添加 Telegram 存储'),
      passwordField: Boolean(document.querySelector('.storage-form input[type="password"]')),
      visibleTokenValue: [...document.querySelectorAll('input')].some((input) => input.type !== 'password' && /bot token/i.test(input.value || ''))
    }))()`)
    if (!storageUi.title || !storageUi.passwordField || storageUi.visibleTokenValue) throw new Error(`STORAGE_UI_INVALID:${JSON.stringify(storageUi)}`)

    console.log(JSON.stringify({ auth, workspaceId, inviteCodeShape: invite.code.replace(/[A-Z0-9]/g, '*'), ui, adminUi, storageUi, taskCount: taskRows.length }))
  } finally {
    try { connection?.socket.close() } catch {}
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
