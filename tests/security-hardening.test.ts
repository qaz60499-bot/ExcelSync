import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKER_URL, isAllowedWorkerUrl, normalizeWorkerUrl } from '../src/main/config'
import { resolveWithinRoot, safeRelativePath } from '../src/main/path-security'

describe('security hardening regressions', () => {
  it('rejects absolute, drive-qualified, UNC and traversal paths', () => {
    for (const value of [
      'C:/outside/file.xlsx',
      'C:\\outside\\file.xlsx',
      '/outside/file.xlsx',
      '\\\\server\\share\\file.xlsx',
      '../outside/file.xlsx',
      'safe/../outside.xlsx',
      'safe//file.xlsx'
    ]) {
      expect(() => safeRelativePath(value), value).toThrow('PATH_REJECTED')
    }
    expect(safeRelativePath('team/reports/file.xlsx')).toBe('team/reports/file.xlsx')
    expect(resolveWithinRoot('C:\\ExcelSyncRoot', 'team/reports/file.xlsx').toLowerCase())
      .toContain('excelsyncroot')
  })

  it('pins packaged clients to the production Worker origin', () => {
    expect(normalizeWorkerUrl(`${DEFAULT_WORKER_URL}/`)).toBe(DEFAULT_WORKER_URL)
    expect(isAllowedWorkerUrl(DEFAULT_WORKER_URL, true)).toBe(true)
    expect(isAllowedWorkerUrl('https://attacker.example', true)).toBe(false)
    expect(isAllowedWorkerUrl('http://127.0.0.1:8787', true)).toBe(false)
    expect(isAllowedWorkerUrl('http://127.0.0.1:8787', false)).toBe(true)
  })

  it('keeps the legacy pairing scripts disabled and free of session persistence', async () => {
    for (const file of ['pair-start.mjs', 'pair-confirm.mjs', 'pair-confirm-admin.mjs']) {
      const text = await readFile(new URL(`../scripts/${file}`, import.meta.url), 'utf8')
      expect(text).toContain('LEGACY_PAIR_SCRIPT_DISABLED_USE_EXCELSYNC_ADMIN_STORAGE_UI')
      expect(text).not.toContain('DELETE FROM users')
      expect(text).not.toContain('.pair-session.json')
      expect(text).not.toContain('Bearer ')
    }
    const gitignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8')
    expect(gitignore.split(/\r?\n/)).toContain('.pair-session.json')
  })

  it('requires exact legacy Telegram pairing codes and limits anonymous health detail', async () => {
    const worker = await readFile(new URL('../worker/src/index.ts', import.meta.url), 'utf8')
    expect(worker).not.toContain('candidates.size === 1')
    expect(worker).not.toContain('PAIR_AMBIGUOUS')
    expect(worker).toContain("if (!matchedChatId) throw new HttpError(404, 'PAIR_MESSAGE_NOT_FOUND')")
    expect(worker).toContain('DUMMY_PASSWORD_HASH')
    expect(worker).toContain('TOO_MANY_LOGIN_ATTEMPTS')
    expect(worker).not.toContain('telegramDetail')
  })

  it('stores Telegram user authorization as an encrypted StringSession payload', async () => {
    const main = await readFile(new URL('../src/main/telegram-user-storage.ts', import.meta.url), 'utf8')
    const bridge = await readFile(new URL('../scripts/telegram-storage-bridge.py', import.meta.url), 'utf8')
    expect(main).toContain('sessionString?: string | null')
    expect(main).toContain('EXCELSYNC_TELEGRAM_SESSION_STRING')
    expect(main).toContain('safeStorage.encryptString')
    expect(bridge).toContain('SQLiteSession, StringSession')
    expect(bridge).toContain('StringSession(SESSION_STRING)')
    expect(bridge).toContain('StringSession.save(client.session)')
    expect(main).toContain('EXCELSYNC_TELEGRAM_LEGACY_SESSION')
    expect(bridge).not.toContain('EXCELSYNC_TELEGRAM_SESSION",')
  })

  it('disables workers.dev and keeps signing verification optional for GitHub packaging', async () => {
    const wrangler = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
      build: { electronFuses?: Record<string, boolean>; win?: { signExts?: string[] } }
    }
    const verifier = await readFile(new URL('../scripts/verify-windows-signatures.cjs', import.meta.url), 'utf8')
    expect(wrangler).toContain('"workers_dev": false')
    expect(pkg.scripts['package:win']).not.toContain('forceCodeSigning=true')
    expect(pkg.scripts['package:win']).not.toContain('--prepackaged')
    expect(pkg.scripts['package:win']).not.toContain('verify-windows-signatures.cjs')
    expect(pkg.scripts['package:verify-signatures']).toContain('verify-windows-signatures.cjs')
    expect(pkg.build.win?.signExts).toContain('.exe')
    expect(verifier).toContain('Get-AuthenticodeSignature')
    expect(verifier).toContain("parsed.Status !== 'Valid'")
    expect(pkg.build.electronFuses).toMatchObject({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true
    })
  })
})
