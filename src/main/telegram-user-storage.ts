import { safeStorage } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { TelegramUserStorageReceipt, TelegramUserStorageStatusView, TransferProgressView } from '../shared/contracts'

export interface TelegramUserStorageConfig {
  apiId: number
  apiHash: string
  phone: string | null
  chatId: string | null
  chatTitle: string | null
  proxyUrl?: string | null
  sessionString?: string | null
}

export interface TelegramUserImportCandidate {
  chatId: string
  messageId: number
  fileName: string
  size: number
  mimeType: string
  createdAt: string
}

interface BridgeEnvelope<T> {
  ok: boolean
  result?: T
  error?: { code?: string; message?: string }
}

interface BridgeTransferProgress {
  id: string
  direction: 'upload' | 'download'
  fileName: string
  phase: 'verifying' | 'transferring' | 'finalizing' | 'done'
  transferredBytes: number
  totalBytes: number
  bytesPerSecond: number
  updatedAt: number
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null
  const digits = phone.replace(/\s+/g, '')
  if (digits.length <= 5) return '*'.repeat(Math.max(1, digits.length - 2)) + digits.slice(-2)
  return `${digits.slice(0, 3)}${'*'.repeat(Math.max(4, digits.length - 6))}${digits.slice(-3)}`
}

export class TelegramUserStorageConfigStore {
  private readonly root: string
  private readonly configPath: string
  private memory: TelegramUserStorageConfig | null = null

  constructor(userDataPath: string) {
    this.root = join(userDataPath, 'TelegramStorage')
    this.configPath = join(this.root, 'config.bin')
  }

  directory(): string {
    return this.root
  }

  sessionBasePath(): string {
    return join(this.root, 'excel-sync-user')
  }

  async load(): Promise<TelegramUserStorageConfig | null> {
    if (this.memory) return this.memory
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      const encrypted = await readFile(this.configPath)
      const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as TelegramUserStorageConfig
      if (!Number.isInteger(parsed.apiId) || parsed.apiId <= 0 || !parsed.apiHash) return null
      this.memory = parsed
      return parsed
    } catch {
      return null
    }
  }

  async save(config: TelegramUserStorageConfig): Promise<void> {
    this.memory = config
    if (!safeStorage.isEncryptionAvailable()) throw new Error('WINDOWS_SECURE_STORAGE_UNAVAILABLE')
    await mkdir(this.root, { recursive: true })
    await writeFile(this.configPath, safeStorage.encryptString(JSON.stringify(config)), { mode: 0o600 })
  }

  async clearAuthorization(): Promise<void> {
    const current = await this.load()
    if (current) await this.save({ ...current, phone: null, chatId: null, chatTitle: null, sessionString: null })
    await Promise.all([
      rm(`${this.sessionBasePath()}.session`, { force: true }).catch(() => undefined),
      rm(`${this.sessionBasePath()}.session-journal`, { force: true }).catch(() => undefined)
    ])
  }
}

export class TelegramUserStorageProvider {
  private child: ChildProcessWithoutNullStreams | null = null
  private port: number | null = null
  private secret: string | null = null
  private starting: Promise<void> | null = null
  private lastError: { code: string; message: string } | null = null
  private lastSyncAt: string | null = null
  private state: TelegramUserStorageStatusView['state'] = 'UNCONFIGURED'
  private legacySessionActive = false
  private legacySessionMigrated = false

  constructor(
    private readonly store: TelegramUserStorageConfigStore,
    private readonly devScriptPath: string,
    private readonly packagedExePath: string,
    private readonly onTransferProgress?: (progress: TransferProgressView) => void
  ) {}

  private async resolveLaunch(): Promise<{ command: string; args: string[] }> {
    try {
      await access(this.packagedExePath)
      return { command: this.packagedExePath, args: [] }
    } catch {
      await access(this.devScriptPath)
      return { command: process.env.EXCELSYNC_PYTHON || 'python', args: [this.devScriptPath] }
    }
  }

  async start(): Promise<void> {
    if (this.child && this.port && this.secret) return
    if (this.starting) return this.starting
    this.starting = this.startInternal().finally(() => { this.starting = null })
    return this.starting
  }

  private async startInternal(): Promise<void> {
    const config = await this.store.load()
    if (!config) {
      this.state = 'UNCONFIGURED'
      throw new Error('TELEGRAM_USER_STORAGE_NOT_CONFIGURED')
    }
    await mkdir(this.store.directory(), { recursive: true })
    const launch = await this.resolveLaunch()
    const secret = randomBytes(32).toString('hex')
    const legacySessionBase = this.store.sessionBasePath()
    let legacySession = ''
    if (!config.sessionString) {
      try {
        await access(`${legacySessionBase}.session`)
        legacySession = legacySessionBase
      } catch {
        legacySession = ''
      }
    }
    this.legacySessionActive = Boolean(legacySession)
    this.legacySessionMigrated = false
    const child = spawn(launch.command, launch.args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        EXCELSYNC_BRIDGE_SECRET: secret,
        EXCELSYNC_TELEGRAM_API_ID: String(config.apiId),
        EXCELSYNC_TELEGRAM_API_HASH: config.apiHash,
        EXCELSYNC_TELEGRAM_SESSION_STRING: config.sessionString ?? '',
        EXCELSYNC_TELEGRAM_LEGACY_SESSION: legacySession,
        EXCELSYNC_TELEGRAM_CHAT_ID: config.chatId ?? '',
        EXCELSYNC_TELEGRAM_CHAT_TITLE: config.chatTitle ?? 'ai',
        EXCELSYNC_TELEGRAM_PROXY_URL: config.proxyUrl?.trim() || process.env.EXCELSYNC_TELEGRAM_PROXY_URL?.trim() || ''
      }
    }) as unknown as ChildProcessWithoutNullStreams

    this.child = child
    this.secret = secret
    this.port = null
    this.lastError = null

    await new Promise<void>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => reject(new Error('TELEGRAM_BRIDGE_START_TIMEOUT')), 12_000)
      const cleanup = (): void => clearTimeout(timeout)
      const fail = (error: Error): void => {
        cleanup()
        reject(error)
      }
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
        const lines = stdout.split(/\r?\n/)
        stdout = lines.pop() ?? ''
        for (const line of lines) {
          const match = /^READY\s+(\d+)$/.exec(line.trim())
          if (match) {
            this.port = Number(match[1])
            cleanup()
            resolve()
            return
          }
        }
      })
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4000) })
      child.once('error', (error) => fail(error))
      child.once('exit', (code) => {
        if (!this.port) fail(new Error(stderr.trim() || `TELEGRAM_BRIDGE_EXIT_${code ?? 'UNKNOWN'}`))
      })
    }).catch((error) => {
      this.lastError = { code: 'TELEGRAM_BRIDGE_START_FAILED', message: error instanceof Error ? error.message : String(error) }
      this.state = 'ERROR'
      child.kill()
      this.child = null
      this.port = null
      this.secret = null
      throw error
    })

    child.once('exit', () => {
      if (this.child === child) {
        this.child = null
        this.port = null
        this.secret = null
        if (this.legacySessionMigrated) void this.removeLegacySessionFiles()
        this.legacySessionActive = false
        if (this.state !== 'UNCONFIGURED') this.state = 'ERROR'
      }
    })

    try {
      const health = await this.call<{ authorized: boolean; chatId: string | null; chatTitle: string | null }>('/health')
      if (health.authorized) {
        if (this.legacySessionActive) {
          await this.persistSession()
          this.legacySessionMigrated = true
        }
        this.state = health.chatId ? 'CONNECTED' : 'RESOLVING_GROUP'
      } else if (config.phone) {
        this.state = 'AUTH_FAILED'
        this.lastError = { code: 'TELEGRAM_AUTHORIZATION_LOST', message: 'Telegram 授权已失效，请重新验证。' }
      } else {
        this.state = 'UNAUTHORIZED'
      }
    } catch (error) {
      this.state = 'ERROR'
      throw error
    }
  }

  private async persistSession(): Promise<void> {
    const exported = await this.call<{ session: string }>('/session/export', undefined, false)
    const current = await this.store.load()
    if (!current || !exported.session || current.sessionString === exported.session) return
    await this.store.save({ ...current, sessionString: exported.session })
  }

  private async removeLegacySessionFiles(): Promise<void> {
    await Promise.all([
      rm(`${this.store.sessionBasePath()}.session`, { force: true }).catch(() => undefined),
      rm(`${this.store.sessionBasePath()}.session-journal`, { force: true }).catch(() => undefined)
    ])
    this.legacySessionMigrated = false
  }

  private async call<T>(path: string, body?: unknown, affectLastError = true): Promise<T> {
    if (!this.port || !this.secret) throw new Error('TELEGRAM_BRIDGE_NOT_RUNNING')
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-excelsync-bridge-secret': this.secret,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const payload = await response.json() as BridgeEnvelope<T>
    if (!response.ok || !payload.ok || payload.result === undefined) {
      const code = payload.error?.code ?? `TELEGRAM_BRIDGE_HTTP_${response.status}`
      const message = payload.error?.message ?? code
      if (affectLastError) this.lastError = { code, message }
      throw new Error(code === message ? code : `${code}: ${message}`)
    }
    if (affectLastError) this.lastError = null
    return payload.result
  }

  private async callTransfer<T>(
    path: '/upload' | '/download',
    body: Record<string, unknown>,
    meta: { direction: 'upload' | 'download'; fileName: string; totalBytes: number }
  ): Promise<T> {
    const id = randomUUID()
    let finished = false
    const request = this.call<T>(path, { ...body, operationId: id })
    const polling = (async (): Promise<void> => {
      while (!finished) {
        try {
          const progress = await this.call<BridgeTransferProgress>(`/progress?id=${encodeURIComponent(id)}`, undefined, false)
          this.onTransferProgress?.({ ...progress, updatedAt: Date.now() })
        } catch {
          // The transfer request may start a few milliseconds before the progress record exists.
        }
        if (!finished) await delay(300)
      }
    })()
    try {
      const result = await request
      this.onTransferProgress?.({
        id,
        direction: meta.direction,
        fileName: meta.fileName,
        phase: 'done',
        transferredBytes: meta.totalBytes,
        totalBytes: meta.totalBytes,
        bytesPerSecond: 0,
        updatedAt: Date.now()
      })
      return result
    } finally {
      finished = true
      await polling.catch(() => undefined)
    }
  }

  async configure(apiId: number, apiHash: string): Promise<void> {
    if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash.trim()) throw new Error('TELEGRAM_API_CREDENTIALS_INVALID')
    const existing = await this.store.load()
    await this.stop()
    await this.store.save({ apiId, apiHash: apiHash.trim(), phone: existing?.phone ?? null, chatId: existing?.chatId ?? null, chatTitle: existing?.chatTitle ?? null, proxyUrl: existing?.proxyUrl ?? null, sessionString: existing?.sessionString ?? null })
    this.state = 'UNAUTHORIZED'
  }

  async configureProxy(proxyUrl: string | null): Promise<void> {
    const existing = await this.store.load()
    if (!existing) throw new Error('TELEGRAM_USER_STORAGE_NOT_CONFIGURED')
    const normalized = proxyUrl?.trim() || null
    if (normalized) {
      let parsed: URL
      try {
        parsed = new URL(normalized)
      } catch {
        throw new Error('TELEGRAM_PROXY_URL_INVALID')
      }
      if (!['socks5:', 'socks4:', 'http:'].includes(parsed.protocol) || !parsed.hostname || !parsed.port) {
        throw new Error('TELEGRAM_PROXY_URL_INVALID')
      }
    }
    await this.stop()
    await this.store.save({ ...existing, proxyUrl: normalized })
  }

  async beginAuthorization(phone: string): Promise<TelegramUserStorageStatusView> {
    const config = await this.store.load()
    if (!config) throw new Error('TELEGRAM_USER_STORAGE_NOT_CONFIGURED')
    await this.store.save({ ...config, phone: phone.trim(), chatId: null, chatTitle: null })
    await this.stop()
    try {
      await this.start()
      await this.call('/auth/start', { phone: phone.trim() })
      this.state = 'WAITING_CODE'
      return this.status()
    } catch (error) {
      this.state = 'AUTH_FAILED'
      throw error
    }
  }

  async restartAuthorization(): Promise<TelegramUserStorageStatusView> {
    const config = await this.store.load()
    if (!config) throw new Error('TELEGRAM_USER_STORAGE_NOT_CONFIGURED')
    const phone = config.phone?.trim()
    if (!phone) throw new Error('TELEGRAM_PHONE_REQUIRED')
    await this.stop()
    await this.store.clearAuthorization()
    await this.store.save({ ...config, phone, chatId: null, chatTitle: null, sessionString: null })
    return this.beginAuthorization(phone)
  }

  async submitCode(code: string): Promise<TelegramUserStorageStatusView> {
    await this.start()
    try {
      const result = await this.call<{ state: 'authorized' | 'password_required' }>('/auth/code', { code: code.trim() })
      this.state = result.state === 'password_required' ? 'WAITING_2FA' : 'RESOLVING_GROUP'
      if (result.state === 'authorized') {
        await this.persistSession()
        await this.resolveGroup('ai')
      }
      return this.status()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.state = message.includes('TELEGRAM_CODE_INVALID') ? 'WAITING_CODE' : 'AUTH_FAILED'
      throw error
    }
  }

  async submitPassword(password: string): Promise<TelegramUserStorageStatusView> {
    await this.start()
    try {
      await this.call('/auth/password', { password })
      await this.persistSession()
      this.state = 'RESOLVING_GROUP'
      await this.resolveGroup('ai')
      return this.status()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.state = message.includes('TELEGRAM_2FA_INVALID') ? 'WAITING_2FA' : 'AUTH_FAILED'
      throw error
    }
  }

  async resolveGroup(title = 'ai'): Promise<TelegramUserStorageStatusView> {
    await this.start()
    this.state = 'RESOLVING_GROUP'
    const resolved = await this.call<{ chatId: string; chatTitle: string }>('/group/resolve', { title })
    const config = await this.store.load()
    if (!config) throw new Error('TELEGRAM_USER_STORAGE_NOT_CONFIGURED')
    await this.store.save({ ...config, chatId: resolved.chatId, chatTitle: resolved.chatTitle })
    this.state = 'CONNECTED'
    return this.status()
  }

  async status(): Promise<TelegramUserStorageStatusView> {
    const config = await this.store.load()
    if (!config) {
      return {
        state: 'UNCONFIGURED', authorized: false, bridgeReachable: false, phoneMasked: null,
        chatId: null, chatTitle: null, lastSyncAt: this.lastSyncAt, errorCode: this.lastError?.code ?? null, errorMessage: this.lastError?.message ?? null
      }
    }
    let authorized = false
    let bridgeReachable = false
    try {
      await this.start()
      const health = await this.call<{ authorized: boolean; chatId: string | null; chatTitle: string | null }>('/health')
      authorized = health.authorized
      bridgeReachable = true
      if (authorized && config.chatId && this.state !== 'SYNCING') {
        this.state = 'CONNECTED'
      } else if (!authorized && !['WAITING_CODE', 'WAITING_2FA'].includes(this.state)) {
        if (config.sessionString) {
          await this.store.save({ ...config, sessionString: null, chatId: null, chatTitle: null })
          config.sessionString = null
          config.chatId = null
          config.chatTitle = null
        }
        if (config.phone) {
          this.state = 'AUTH_FAILED'
          this.lastError = { code: 'TELEGRAM_AUTHORIZATION_LOST', message: 'Telegram 授权已失效，请重新验证。' }
        } else {
          this.state = 'UNAUTHORIZED'
        }
      }
    } catch (error) {
      this.lastError = { code: 'TELEGRAM_BRIDGE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) }
      this.state = 'ERROR'
    }
    return {
      state: this.state,
      authorized,
      bridgeReachable,
      phoneMasked: maskPhone(config.phone),
      chatId: config.chatId,
      chatTitle: config.chatTitle,
      lastSyncAt: this.lastSyncAt,
      errorCode: this.lastError?.code ?? null,
      errorMessage: this.lastError?.message ?? null
    }
  }

  async upload(localPath: string, expectedSha256: string): Promise<TelegramUserStorageReceipt> {
    const config = await this.store.load()
    if (!config?.chatId) throw new Error('TELEGRAM_USER_GROUP_NOT_BOUND')
    await this.start()
    this.state = 'SYNCING'
    try {
      const info = await stat(localPath)
      const result = await this.callTransfer<TelegramUserStorageReceipt>('/upload', {
        path: localPath,
        chatId: config.chatId,
        expectedSha256: expectedSha256.toLowerCase()
      }, { direction: 'upload', fileName: basename(localPath), totalBytes: info.size })
      if (result.size !== info.size) throw new Error('UPLOAD_SIZE_MISMATCH')
      if (result.sha256.toLowerCase() !== expectedSha256.toLowerCase()) throw new Error('UPLOAD_HASH_MISMATCH')
      this.lastSyncAt = new Date().toISOString()
      return result
    } finally {
      this.state = 'CONNECTED'
    }
  }

  async download(
    locator: { chatId: string; messageId: number },
    destination: string,
    expected?: { size?: number | null; sha256?: string | null; fileName?: string | null }
  ): Promise<void> {
    await this.start()
    this.state = 'SYNCING'
    try {
      const result = await this.callTransfer<{ path: string; size: number; sha256: string }>('/download', {
        chatId: locator.chatId,
        messageId: locator.messageId,
        destination
      }, {
        direction: 'download',
        fileName: expected?.fileName || basename(destination),
        totalBytes: Number(expected?.size ?? 0)
      })
      const info = await stat(destination)
      if (result.size !== info.size || (expected?.size != null && Number(expected.size) !== info.size)) {
        await rm(destination, { force: true }).catch(() => undefined)
        throw new Error('DOWNLOAD_SIZE_MISMATCH')
      }
      if (expected?.sha256 && result.sha256.toLowerCase() !== expected.sha256.toLowerCase()) {
        await rm(destination, { force: true }).catch(() => undefined)
        throw new Error('DOWNLOAD_HASH_MISMATCH')
      }
      this.lastSyncAt = new Date().toISOString()
    } finally {
      this.state = 'CONNECTED'
    }
  }

  async catchUp(afterMessageId: number): Promise<TelegramUserImportCandidate[]> {
    const config = await this.store.load()
    if (!config?.chatId) return []
    await this.start()
    const result = await this.call<{ messages: TelegramUserImportCandidate[] }>('/imports', { chatId: config.chatId, afterMessageId })
    this.lastSyncAt = new Date().toISOString()
    return result.messages
  }

  async reauthorize(): Promise<void> {
    await this.stop()
    await this.store.clearAuthorization()
    this.state = 'UNAUTHORIZED'
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    try {
      await this.call('/shutdown', {})
    } catch {
      // The child is still terminated below, scoped to the process created by this instance.
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve()
      const timeout = setTimeout(() => {
        child.kill()
        resolve()
      }, 2500)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
    })
    if (this.child === child) {
      this.child = null
      this.port = null
      this.secret = null
    }
    if (this.legacySessionMigrated) await this.removeLegacySessionFiles()
    this.legacySessionActive = false
  }
}
