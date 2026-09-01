import { readFile, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TOKEN_PATTERN = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const output: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) output.push(...(await filesUnder(path)))
    else output.push(path)
  }
  return output
}

describe('security boundaries', () => {
  it('contains no bot-token-shaped secret in source/config/tests', async () => {
    const roots = ['src', 'worker', 'migrations', 'tests', 'scripts']
    const rootFiles = ['package.json', 'wrangler.jsonc']
    const files = [
      ...(await Promise.all(roots.map(filesUnder))).flat()
        .filter((path) => ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.json', '.jsonc', '.sql', '.html', '.css', '.md'].includes(extname(path))),
      ...rootFiles
    ]
    for (const path of files) {
      const text = await readFile(path, 'utf8')
      expect(text.match(TOKEN_PATTERN), path).toBeNull()
    }
  })

  it('renderer does not contain Telegram Bot API or D1 direct access', async () => {
    const files = await filesUnder('src/renderer')
    const text = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n')
    expect(text).not.toContain('api.telegram.org')
    expect(text).not.toContain('TELEGRAM_BOT_TOKEN')
    expect(text).not.toMatch(/\bD1Database\b/)
  })

  it('main process enables isolation and disables renderer Node integration', async () => {
    const text = await readFile('src/main/index.ts', 'utf8')
    expect(text).toContain('contextIsolation: true')
    expect(text).toContain('nodeIntegration: false')
    expect(text).toContain('sandbox: true')
  })

  it('does not block login/bootstrap completion on a full sync batch', async () => {
    const mainText = await readFile('src/main/index.ts', 'utf8')
    const rendererText = await readFile('src/renderer/src/App.tsx', 'utf8')
    expect(mainText).not.toContain('await sync.syncNow()')
    expect(mainText).toContain('void sync.syncNow().catch')
    expect(rendererText).not.toContain('setAuth(state)\n    await refreshAll()')
  })

  it('persists login across ordinary close/reopen and flushes pending work on real exit', async () => {
    const [mainText, sessionText] = await Promise.all([
      readFile('src/main/index.ts', 'utf8'),
      readFile('src/main/session-store.ts', 'utf8')
    ])
    expect(sessionText).toContain("this.sessionPath = join(userDataPath, 'secure', 'session.bin')")
    expect(sessionText).toContain('safeStorage.encryptString')
    expect(mainText).toContain("window.on('close'")
    expect(mainText).toContain('window.hide()')
    expect(mainText).toContain('syncEngine?.syncNow().catch')
    expect(mainText).toContain('await syncEngine.flushBeforeExit()')
    expect(mainText).toContain("app.on('before-quit'")
  })

  it('uses a CommonJS preload compatible with the sandboxed renderer', async () => {
    const [main, vite] = await Promise.all([
      readFile('src/main/index.ts', 'utf8'),
      readFile('electron.vite.config.ts', 'utf8')
    ])
    expect(main).toContain("../preload/index.cjs")
    expect(vite).toContain("format: 'cjs'")
    expect(vite).toContain("entryFileNames: 'index.cjs'")
  })

  it('retires destructive legacy pairing scripts and excludes plaintext pair sessions from source control', async () => {
    const [start, confirm, confirmAdmin, gitignore] = await Promise.all([
      readFile('scripts/pair-start.mjs', 'utf8'),
      readFile('scripts/pair-confirm.mjs', 'utf8'),
      readFile('scripts/pair-confirm-admin.mjs', 'utf8'),
      readFile('.gitignore', 'utf8')
    ])
    for (const text of [start, confirm, confirmAdmin]) expect(text).toContain('LEGACY_PAIR_SCRIPT_DISABLED')
    expect(gitignore.split(/\r?\n/)).toContain('.pair-session.json')
  })

  it('requires exact Telegram pairing codes and throttles password login', async () => {
    const worker = await readFile('worker/src/index.ts', 'utf8')
    expect(worker).toContain('DUMMY_PASSWORD_HASH')
    expect(worker).toContain('TOO_MANY_LOGIN_ATTEMPTS')
    expect(worker).toContain('LOGIN_IP_FAILURE_LIMIT')
    expect(worker).not.toContain('candidates.size === 1')
    expect(worker).not.toContain('const cutoff = Date.now() - 15 * 60 * 1000')
  })

  it('pins packaged clients to the production Worker and disables workers.dev', async () => {
    const [config, main, wrangler] = await Promise.all([
      readFile('src/main/config.ts', 'utf8'),
      readFile('src/main/index.ts', 'utf8'),
      readFile('wrangler.jsonc', 'utf8')
    ])
    expect(config).toContain('if (packaged) return false')
    expect(main).toContain('WORKER_URL_NOT_ALLOWED')
    expect(wrangler).toContain('"workers_dev": false')
  })

  it('uses encrypted StringSession persistence and release hardening', async () => {
    const [telegram, bridge, packageJson] = await Promise.all([
      readFile('src/main/telegram-user-storage.ts', 'utf8'),
      readFile('scripts/telegram-storage-bridge.py', 'utf8'),
      readFile('package.json', 'utf8')
    ])
    expect(telegram).toContain('sessionString')
    expect(telegram).toContain('safeStorage.encryptString')
    expect(telegram).toContain('EXCELSYNC_TELEGRAM_LEGACY_SESSION')
    expect(bridge).toContain('StringSession.save(client.session)')
    expect(packageJson).not.toContain('forceCodeSigning=true')
    expect(packageJson).toContain('"package:verify-signatures": "node scripts/verify-windows-signatures.cjs"')
    expect(packageJson).not.toContain('--prepackaged dist/win-unpacked')
    expect(packageJson).toContain('"signExts"')
    expect(packageJson).toContain('"enableEmbeddedAsarIntegrityValidation": true')
    expect(packageJson).toContain('"onlyLoadAppFromAsar": true')
  })
})
