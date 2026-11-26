// Reproduce a stalled cloud probe against the real Electron main/preload bridge.
// Uses a fresh profile and a network stub; never contacts production.
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const artifacts = path.join(root, 'test-artifacts', 'local-health-responsiveness')
const output = path.join(artifacts, 'report.json')

if (!process.versions.electron) {
  fs.mkdirSync(artifacts, { recursive: true })
  const profile = fs.mkdtempSync(path.join(artifacts, 'profile-'))
  const child = require('node:child_process').spawnSync(require('electron'), [__filename], {
    cwd: root, windowsHide: true, timeout: 30_000, encoding: 'utf8',
    env: { ...process.env, EXCELSYNC_USER_DATA_DIR: profile }, maxBuffer: 1024 * 1024
  })
  const report = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null
  console.log(JSON.stringify({ exitCode: child.status, report }))
  if (child.status !== 0 || !report?.ok) process.exitCode = 1
} else {
  const { app, net } = require('electron')
  const requests = []
  net.fetch = async (input, init = {}) => {
    requests.push(new URL(String(input)).pathname)
    return new Promise((resolve, reject) => {
      const cancel = () => reject(new DOMException('Cancelled by test shutdown', 'AbortError'))
      if (init.signal?.aborted) cancel()
      else init.signal?.addEventListener('abort', cancel, { once: true })
    })
  }
  let finished = false
  const finish = (result) => {
    if (finished) return
    finished = true
    fs.writeFileSync(output, JSON.stringify({ ...result, requests, network: 'stalled headers; no production traffic' }, null, 2))
    app.quit()
  }
  app.on('browser-window-created', (_event, window) => {
    const db = new (require('node:sqlite').DatabaseSync)(path.join(process.env.EXCELSYNC_USER_DATA_DIR, 'state', 'excel-sync.sqlite'))
    db.prepare('INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run('workerUrl', JSON.stringify('https://cloud-unavailable.invalid'), new Date().toISOString())
    db.close()
    window.webContents.once('did-finish-load', async () => {
      try {
        const result = await Promise.race([
          window.webContents.executeJavaScript(`(async () => { const start=performance.now(); const dashboard=await window.excelSync.dashboard(); const files=await window.excelSync.files(); return {elapsedMs:performance.now()-start,files:files.length,pending:dashboard.pending,worker:dashboard.health.worker}; })()`),
          new Promise((_, reject) => setTimeout(() => reject(new Error('LOCAL_REFRESH_BLOCKED_BY_CLOUD')), 2000))
        ])
        finish({ ok: result.elapsedMs < 500 && result.files === 0 && result.pending === 0 && requests.includes('/health'), ...result })
      } catch (error) { finish({ ok: false, error: error.message }) }
    })
  })
  const server = require('node:http').createServer((request, response) => {
    const rendererRoot = path.join(root, 'out', 'renderer')
    const url = new URL(request.url, 'http://localhost')
    const target = path.resolve(rendererRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
    if (!target.startsWith(rendererRoot + path.sep)) { response.writeHead(403).end(); return }
    const mime = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(target)] || 'application/octet-stream'
    fs.readFile(target, (error, bytes) => { if (error) response.writeHead(404).end(); else response.writeHead(200, { 'content-type': mime }).end(bytes) })
  })
  server.listen(0, '127.0.0.1', () => {
    process.env.ELECTRON_RENDERER_URL = `http://127.0.0.1:${server.address().port}`
    import(require('node:url').pathToFileURL(path.join(root, 'out', 'main', 'index.js')).href).catch(error => finish({ ok: false, error: error.message }))
  })
  app.on('quit', () => server.close())
  setTimeout(() => { if (!finished) finish({ ok: false, error: 'INITIALIZATION_TIMEOUT' }) }, 15_000).unref()
}
