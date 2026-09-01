import { app, net, session } from 'electron'

const target = process.argv[2] || 'https://excel-sync-worker.qaz60499.workers.dev/health'

app.whenReady().then(async () => {
  try {
    await session.defaultSession.setProxy({ mode: 'system' })
    await session.defaultSession.forceReloadProxyConfig()
    console.log(`RESOLVED_PROXY=${await session.defaultSession.resolveProxy(target)}`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    const response = await net.fetch(target, { method: 'GET', signal: controller.signal })
    clearTimeout(timer)
    const body = await response.text()
    console.log(JSON.stringify({ ok: response.ok, status: response.status, body }))
    process.exitCode = response.ok ? 0 : 2
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 3
  } finally {
    app.quit()
  }
})
