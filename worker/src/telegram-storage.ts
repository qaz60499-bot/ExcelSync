import type { StorageProvider, StorageStatus, StoredObject } from './storage'
import { createStreamingMultipart } from './multipart'
import { TELEGRAM_OFFICIAL_BOT_CAPABILITIES } from '../../src/shared/storage-capabilities'

const TELEGRAM_API = 'https://api.telegram.org'
const TELEGRAM_TIMEOUT_MS = 15_000

interface TelegramEnvelope<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

const DEFINITE_TELEGRAM_UPLOAD_REJECTIONS = new Set([400, 401, 403, 404, 413, 429])

export class TelegramUploadRejectedError extends Error {
  constructor(readonly telegramErrorCode: number) {
    super(`TELEGRAM_SENDDOCUMENT_FAILED_${telegramErrorCode}`)
    this.name = 'TelegramUploadRejectedError'
  }
}

function isTelegramEnvelope<T>(value: unknown): value is TelegramEnvelope<T> {
  return value !== null && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean'
}

interface TelegramUser {
  id: number
  is_bot: boolean
  username?: string
  first_name?: string
}

interface TelegramDocument {
  file_id: string
  file_unique_id?: string
  file_size?: number
  file_name?: string
  mime_type?: string
  thumbnail?: {
    file_id: string
    file_unique_id?: string
    file_size?: number
    width?: number
    height?: number
  }
}

interface TelegramMessage {
  message_id: number
  document?: TelegramDocument
}

interface TelegramFile {
  file_id: string
  file_unique_id?: string
  file_size?: number
  file_path?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    date?: number
    text?: string
    caption?: string
    document?: TelegramDocument
    chat: {
      id: number
      type: string
      username?: string
      title?: string
      first_name?: string
      last_name?: string
    }
  }
}

export class TelegramStorage implements StorageProvider {
  readonly name = 'telegram'
  readonly capabilities = TELEGRAM_OFFICIAL_BOT_CAPABILITIES

  constructor(
    private readonly token: string,
    private readonly chatId: string
  ) {
    if (!token) throw new Error('TELEGRAM_NOT_CONFIGURED')
    if (!chatId) throw new Error('TELEGRAM_CHAT_NOT_CONFIGURED')
  }

  private endpoint(method: string): string {
    return `${TELEGRAM_API}/bot${this.token}/${method}`
  }

  private async call<T>(method: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.endpoint(method), {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
    })
    let payload: TelegramEnvelope<T>
    try {
      payload = (await response.json()) as TelegramEnvelope<T>
    } catch {
      throw new Error(`TELEGRAM_${method.toUpperCase()}_INVALID_RESPONSE`)
    }
    if (!response.ok || !payload.ok || payload.result === undefined) {
      const code = payload.error_code ?? response.status
      throw new Error(`TELEGRAM_${method.toUpperCase()}_FAILED_${code}`)
    }
    return payload.result
  }

  async status(): Promise<StorageStatus> {
    try {
      const me = await this.call<TelegramUser>('getMe')
      if (!me.is_bot) return { provider: this.name, reachable: false, detail: 'TELEGRAM_ACCOUNT_IS_NOT_BOT' }
      const chat = await this.call<{ id: number; title?: string; username?: string }>('getChat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId })
      })
      return { provider: this.name, reachable: Boolean(chat.id), detail: chat.title ?? chat.username ?? me.username }
    } catch (error) {
      return {
        provider: this.name,
        reachable: false,
        detail: error instanceof Error ? error.message : 'TELEGRAM_STATUS_FAILED'
      }
    }
  }

  async upload(input: {
    bytes: Uint8Array
    fileName: string
    mimeType: string
    caption?: string
  }): Promise<StoredObject> {
    const copy = new Uint8Array(input.bytes.byteLength)
    copy.set(input.bytes)
    const form = new FormData()
    form.set('chat_id', this.chatId)
    if (input.caption) form.set('caption', input.caption.slice(0, 1024))
    form.set('document', new File([copy.buffer], input.fileName, { type: input.mimeType }))

    const response = await fetch(this.endpoint('sendDocument'), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
    })
    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      throw new Error('TELEGRAM_SENDDOCUMENT_INVALID_RESPONSE')
    }
    if (!isTelegramEnvelope<TelegramMessage>(raw)) throw new Error('TELEGRAM_SENDDOCUMENT_INVALID_RESPONSE')
    const payload = raw
    const document = payload.result?.document
    if (!response.ok || !payload.ok || !document) {
      const explicitCode = typeof payload.error_code === 'number' && Number.isInteger(payload.error_code)
        ? payload.error_code
        : null
      const code = explicitCode ?? response.status
      if (response.status < 500 && !payload.ok && explicitCode !== null && DEFINITE_TELEGRAM_UPLOAD_REJECTIONS.has(explicitCode)) {
        throw new TelegramUploadRejectedError(explicitCode)
      }
      throw new Error(`TELEGRAM_SENDDOCUMENT_FAILED_${code}`)
    }
    const message = payload.result!
    return {
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id,
      previewFileId: document.thumbnail?.file_id,
      messageId: message.message_id,
      size: document.file_size
    }
  }

  async uploadStream(input: {
    body: ReadableStream<Uint8Array>
    sizeBytes: number
    fileName: string
    mimeType: string
    caption?: string
  }): Promise<StoredObject> {
    const multipart = createStreamingMultipart({
      fields: {
        chat_id: this.chatId,
        ...(input.caption ? { caption: input.caption.slice(0, 1024) } : {})
      },
      fileField: 'document',
      fileName: input.fileName,
      mimeType: input.mimeType,
      body: input.body
    })
    const response = await fetch(this.endpoint('sendDocument'), {
      method: 'POST',
      headers: { 'content-type': multipart.contentType },
      body: multipart.body,
      signal: AbortSignal.timeout(Math.max(TELEGRAM_TIMEOUT_MS, 180_000))
    })
    let payload: TelegramEnvelope<TelegramMessage>
    try {
      payload = (await response.json()) as TelegramEnvelope<TelegramMessage>
    } catch {
      throw new Error('TELEGRAM_SENDDOCUMENT_INVALID_RESPONSE')
    }
    if (!response.ok || !payload.ok || !payload.result?.document) {
      const code = payload.error_code ?? response.status
      const retryAfter = response.headers.get('retry-after')
      throw new Error(`TELEGRAM_SENDDOCUMENT_FAILED_${code}${retryAfter ? `_RETRY_AFTER_${retryAfter}` : ''}`)
    }
    return {
      fileId: payload.result.document.file_id,
      fileUniqueId: payload.result.document.file_unique_id,
      previewFileId: payload.result.document.thumbnail?.file_id,
      messageId: payload.result.message_id,
      size: payload.result.document.file_size ?? input.sizeBytes
    }
  }

  async clone(input: { fileId: string; caption?: string }): Promise<StoredObject> {
    const form = new FormData()
    form.set('chat_id', this.chatId)
    form.set('document', input.fileId)
    if (input.caption) form.set('caption', input.caption.slice(0, 1024))

    const message = await this.call<TelegramMessage>('sendDocument', {
      method: 'POST',
      body: form
    })
    if (!message.document) throw new Error('TELEGRAM_DOCUMENT_MISSING')
    return {
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id,
      previewFileId: message.document.thumbnail?.file_id,
      messageId: message.message_id,
      size: message.document.file_size
    }
  }

  async download(fileId: string): Promise<Response> {
    const started = performance.now()
    const file = await this.call<TelegramFile>('getFile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: fileId })
    })
    if (!file.file_path) throw new Error('TELEGRAM_FILE_PATH_MISSING')
    const resolvedAt = performance.now()
    const response = await fetch(`${TELEGRAM_API}/file/bot${this.token}/${file.file_path}`, {
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
    })
    if (!response.ok || !response.body) throw new Error(`TELEGRAM_DOWNLOAD_FAILED_${response.status}`)
    const headers = new Headers(response.headers)
    headers.set('server-timing', `telegram_resolve;dur=${(resolvedAt - started).toFixed(1)}, telegram_headers;dur=${(performance.now() - resolvedAt).toFixed(1)}`)
    return new Response(response.body, { status: response.status, headers })
  }
}

export async function telegramGetMe(token: string): Promise<{ id: number; username?: string; name?: string }> {
  if (!token) throw new Error('TELEGRAM_NOT_CONFIGURED')
  const response = await fetch(`${TELEGRAM_API}/bot${token}/getMe`, {
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
  })
  const payload = (await response.json()) as TelegramEnvelope<TelegramUser>
  if (!response.ok || !payload.ok || !payload.result) {
    throw new Error(`TELEGRAM_GETME_FAILED_${payload.error_code ?? response.status}`)
  }
  return { id: payload.result.id, username: payload.result.username, name: payload.result.first_name }
}

export async function telegramGetUpdates(token: string, offset?: number): Promise<TelegramUpdate[]> {
  if (!token) throw new Error('TELEGRAM_NOT_CONFIGURED')
  const response = await fetch(`${TELEGRAM_API}/bot${token}/getUpdates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 100, timeout: 0, allowed_updates: ['message'], ...(offset ? { offset } : {}) }),
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
  })
  const payload = (await response.json()) as TelegramEnvelope<TelegramUpdate[]>
  if (!response.ok || !payload.ok || !payload.result) {
    throw new Error(`TELEGRAM_GETUPDATES_FAILED_${payload.error_code ?? response.status}`)
  }
  return payload.result
}
