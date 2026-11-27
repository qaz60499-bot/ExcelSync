import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  TelegramUserStorageConfigStore,
  TelegramUserStorageProvider,
  type TelegramUserStorageConfig
} from '../src/main/telegram-user-storage'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

const roots: string[] = []
const providers: TelegramUserStorageProvider[] = []

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.stop()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeProvider(onProgress: (progress: { phase: string; id: string }) => void) {
  const root = await mkdtemp(join(tmpdir(), 'excelsync-user-storage-provider-'))
  roots.push(root)
  const config: TelegramUserStorageConfig = {
    apiId: 1234,
    apiHash: 'a'.repeat(32),
    groupTitle: 'Test group',
    phone: '+15550001234',
    chatId: '-10042',
    chatTitle: 'Test group',
    sessionString: null
  }
  const store = {
    directory: () => root,
    sessionBasePath: () => join(root, 'legacy-session'),
    load: async () => ({ ...config }),
    save: async () => undefined,
    clearAuthorization: async () => undefined
  }
  const bridgePath = resolve('tests/fixtures/fake-telegram-storage-bridge.mjs')
  const provider = new TelegramUserStorageProvider(
    store as unknown as TelegramUserStorageConfigStore,
    bridgePath,
    join(root, 'missing-telegram-storage-bridge.exe'),
    (progress) => onProgress(progress)
  )
  providers.push(provider)
  return { root, provider }
}

async function withBridgeEnvironment<T>(mode: string, action: () => Promise<T>): Promise<T> {
  const oldPython = process.env.EXCELSYNC_PYTHON
  const oldMode = process.env.EXCELSYNC_TEST_TELEGRAM_MODE
  process.env.EXCELSYNC_PYTHON = process.execPath
  process.env.EXCELSYNC_TEST_TELEGRAM_MODE = mode
  try {
    return await action()
  } finally {
    if (oldPython === undefined) delete process.env.EXCELSYNC_PYTHON
    else process.env.EXCELSYNC_PYTHON = oldPython
    if (oldMode === undefined) delete process.env.EXCELSYNC_TEST_TELEGRAM_MODE
    else process.env.EXCELSYNC_TEST_TELEGRAM_MODE = oldMode
  }
}

describe('Telegram User Storage provider reliability', () => {
  it('keeps an unsaved configuration out of memory when disk persistence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-config-save-failure-'))
    roots.push(root)
    const blockedUserDataPath = join(root, 'not-a-directory')
    await writeFile(blockedUserDataPath, 'block config directory creation')
    const store = new TelegramUserStorageConfigStore(blockedUserDataPath)
    const config: TelegramUserStorageConfig = {
      apiId: 1234, apiHash: 'a'.repeat(32), phone: null, chatId: null, chatTitle: null
    }

    await expect(store.save(config)).rejects.toBeDefined()
    await expect(store.load()).resolves.toBeNull()
  })

  it('emits done only after a successful upload receipt check', async () => {
    const progress: Array<{ phase: string; id: string }> = []
    const { provider } = await makeProvider((value) => progress.push(value))
    const filePath = join(roots.at(-1)!, 'book.xlsx')
    const bytes = Buffer.from('known upload snapshot bytes')
    await writeFile(filePath, bytes)

    await withBridgeEnvironment('success', async () => {
      const receipt = await provider.upload(filePath, createHash('sha256').update(bytes).digest('hex'))
      expect(receipt).toMatchObject({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    })

    expect(progress.some((item) => item.phase === 'done')).toBe(true)
    expect(progress.some((item) => item.phase === 'failed')).toBe(false)
    await expect(provider.status()).resolves.toMatchObject({ state: 'CONNECTED', errorCode: null })
  })

  it('emits failed and preserves a receipt mismatch instead of reporting connected', async () => {
    const progress: Array<{ phase: string; id: string }> = []
    const { provider } = await makeProvider((value) => progress.push(value))
    const filePath = join(roots.at(-1)!, 'book.xlsx')
    const bytes = Buffer.from('receipt mismatch')
    await writeFile(filePath, bytes)

    await withBridgeEnvironment('receipt-mismatch', async () => {
      await expect(provider.upload(filePath, createHash('sha256').update(bytes).digest('hex'))).rejects.toThrow('UPLOAD_SIZE_MISMATCH')
      await expect(provider.status()).resolves.toMatchObject({ state: 'ERROR', errorCode: 'UPLOAD_SIZE_MISMATCH' })
    })

    expect(progress.at(-1)?.phase).toBe('failed')
  })

  it('preserves Telegram authorization errors as AUTH_FAILED with terminal failed progress', async () => {
    const progress: Array<{ phase: string; id: string }> = []
    const { provider } = await makeProvider((value) => progress.push(value))
    const filePath = join(roots.at(-1)!, 'book.xlsx')
    const bytes = Buffer.from('authorization failure')
    await writeFile(filePath, bytes)

    await withBridgeEnvironment('auth-failure', async () => {
      await expect(provider.upload(filePath, createHash('sha256').update(bytes).digest('hex'))).rejects.toThrow('TELEGRAM_AUTHORIZATION_LOST')
      await expect(provider.status()).resolves.toMatchObject({ state: 'AUTH_FAILED', errorCode: 'TELEGRAM_AUTHORIZATION_LOST' })
    })

    expect(progress.at(-1)?.phase).toBe('failed')
  })

  it('preserves a deleted-message error and emits terminal failed download progress', async () => {
    const progress: Array<{ phase: string; id: string }> = []
    const { provider } = await makeProvider((value) => progress.push(value))
    const destination = join(roots.at(-1)!, 'download.xlsx')

    await withBridgeEnvironment('missing-message', async () => {
      await expect(provider.download({ chatId: '-10011', messageId: 123 }, destination)).rejects.toThrow('TELEGRAM_MESSAGE_DOCUMENT_NOT_FOUND')
      await expect(provider.status()).resolves.toMatchObject({ state: 'ERROR', errorCode: 'TELEGRAM_MESSAGE_DOCUMENT_NOT_FOUND' })
    })

    expect(progress.at(-1)?.phase).toBe('failed')
  })

  it('preserves bridge network errors after a later healthy status probe', async () => {
    const progress: Array<{ phase: string; id: string }> = []
    const { provider } = await makeProvider((value) => progress.push(value))
    const filePath = join(roots.at(-1)!, 'book.xlsx')
    const bytes = Buffer.from('network failure')
    await writeFile(filePath, bytes)

    await withBridgeEnvironment('network-failure', async () => {
      await expect(provider.upload(filePath, createHash('sha256').update(bytes).digest('hex'))).rejects.toThrow('TELEGRAM_BRIDGE_UNAVAILABLE')
      await expect(provider.status()).resolves.toMatchObject({ state: 'ERROR', errorCode: 'TELEGRAM_BRIDGE_UNAVAILABLE' })
    })

    expect(progress.at(-1)?.phase).toBe('failed')
  })
})
