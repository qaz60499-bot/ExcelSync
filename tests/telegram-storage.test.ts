import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelegramStorage, telegramGetMe, telegramGetUpdates } from '../worker/src/telegram-storage'

function telegramJson(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: status >= 200 && status < 300, result }), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Telegram Bot storage adapter', () => {
  it('checks bot identity and health through getMe', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/getMe')) return telegramJson({ id: 42, is_bot: true, username: 'excel_sync_test_bot', first_name: 'ExcelSync Test Bot' })
      if (url.includes('/getChat')) {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({ chat_id: '-10042' })
        return telegramJson({ id: -10042, type: 'supergroup', title: 'ExcelSync Test Storage' })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(telegramGetMe('test-token-not-a-real-secret-value')).resolves.toEqual({
      id: 42,
      username: 'excel_sync_test_bot',
      name: 'ExcelSync Test Bot'
    })
    const storage = new TelegramStorage('test-token-not-a-real-secret-value', '-10042')
    await expect(storage.status()).resolves.toMatchObject({ provider: 'telegram', reachable: true, detail: 'ExcelSync Test Storage' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('uploads a document and returns the Telegram locator metadata', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/sendDocument')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeInstanceOf(FormData)
      const form = init?.body as FormData
      expect(form.get('chat_id')).toBe('-10042')
      expect(form.get('caption')).toBe('test upload')
      const document = form.get('document')
      expect(document).toBeInstanceOf(File)
      expect((document as File).name).toBe('sample.exe')
      return telegramJson({
        message_id: 321,
        document: {
          file_id: 'telegram-file-id',
          file_unique_id: 'telegram-unique-id',
          file_size: 4,
          thumbnail: { file_id: 'thumb-id' }
        }
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const storage = new TelegramStorage('test-token-not-a-real-secret-value', '-10042')

    await expect(storage.upload({
      bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]),
      fileName: 'sample.exe',
      mimeType: 'application/vnd.microsoft.portable-executable',
      caption: 'test upload'
    })).resolves.toEqual({
      fileId: 'telegram-file-id',
      fileUniqueId: 'telegram-unique-id',
      previewFileId: 'thumb-id',
      messageId: 321,
      size: 4
    })
  })

  it('clones an existing Telegram file without re-uploading bytes', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData
      expect(form.get('chat_id')).toBe('-10042')
      expect(form.get('document')).toBe('existing-file-id')
      return telegramJson({ message_id: 777, document: { file_id: 'cloned-file-id', file_size: 123 } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const storage = new TelegramStorage('test-token-not-a-real-secret-value', '-10042')
    await expect(storage.clone({ fileId: 'existing-file-id', caption: 'restore V2' })).resolves.toMatchObject({
      fileId: 'cloned-file-id', messageId: 777, size: 123
    })
  })

  it('downloads through getFile followed by the Telegram file endpoint', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/getFile')) {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({ file_id: 'download-file-id' })
        return telegramJson({ file_id: 'download-file-id', file_path: 'documents/file_42.exe' })
      }
      if (url.includes('/file/bot')) {
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const storage = new TelegramStorage('test-token-not-a-real-secret-value', '-10042')
    const response = await storage.download('download-file-id')
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3, 4])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces Telegram API failures instead of silently marking an upload successful', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests' }), {
      status: 429,
      headers: { 'content-type': 'application/json' }
    })))
    const storage = new TelegramStorage('test-token-not-a-real-secret-value', '-10042')
    await expect(storage.upload({ bytes: new Uint8Array([1]), fileName: 'x.exe', mimeType: 'application/octet-stream' }))
      .rejects.toThrow('TELEGRAM_SENDDOCUMENT_FAILED_429')
    await expect(storage.status()).resolves.toMatchObject({ reachable: false })
  })

  it('reads pairing updates and preserves the /start payload needed by storage pairing', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toMatchObject({ limit: 100, timeout: 0 })
      return telegramJson([{ update_id: 9, message: { message_id: 1, text: '/start PAIR-TEST', chat: { id: -10042, type: 'supergroup' } } }])
    })
    vi.stubGlobal('fetch', fetchMock)
    const updates = await telegramGetUpdates('test-token-not-a-real-secret-value')
    expect(updates[0]?.message?.text).toBe('/start PAIR-TEST')
    expect(updates[0]?.message?.chat.id).toBe(-10042)
  })
})
