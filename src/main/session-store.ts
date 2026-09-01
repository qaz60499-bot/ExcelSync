import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AuthUserView, WorkspaceMembershipView } from '../shared/contracts'

export interface SessionPayload {
  token: string
  expiresAt: string
  username: string
  deviceId?: string | null
  auth?: {
    user: AuthUserView
    memberships: WorkspaceMembershipView[]
    defaultWorkspaceId: string | null
  }
}

export class SessionStore {
  private memorySession: SessionPayload | null = null
  private readonly sessionPath: string
  private readonly bootstrapPath: string
  private readonly bootstrapPendingPath: string
  private readonly stableDevicePath: string
  private readonly stableDevicePlainPath: string
  private memoryStableDeviceId: string | null = null

  constructor(userDataPath: string) {
    this.sessionPath = join(userDataPath, 'secure', 'session.bin')
    this.bootstrapPath = join(userDataPath, 'secure', 'bootstrap-nonce.bin')
    this.bootstrapPendingPath = join(userDataPath, 'secure', 'bootstrap-nonce.pending')
    this.stableDevicePath = join(userDataPath, 'secure', 'device-id.bin')
    this.stableDevicePlainPath = join(userDataPath, 'secure', 'device-id.txt')
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(dirname(this.sessionPath), { recursive: true })
  }

  async save(session: SessionPayload): Promise<void> {
    this.memorySession = session
    if (!safeStorage.isEncryptionAvailable()) return
    await this.ensureDirectory()
    const encrypted = safeStorage.encryptString(JSON.stringify(session))
    await writeFile(this.sessionPath, encrypted)
  }

  async load(): Promise<SessionPayload | null> {
    if (this.memorySession && new Date(this.memorySession.expiresAt).getTime() > Date.now()) return this.memorySession
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      const encrypted = await readFile(this.sessionPath)
      const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as SessionPayload
      if (!parsed.token || !parsed.username || new Date(parsed.expiresAt).getTime() <= Date.now()) {
        await this.clear()
        return null
      }
      this.memorySession = parsed
      return parsed
    } catch {
      return null
    }
  }

  async clear(): Promise<void> {
    this.memorySession = null
    await rm(this.sessionPath, { force: true }).catch(() => undefined)
  }

  async stableDeviceId(): Promise<string> {
    if (this.memoryStableDeviceId) return this.memoryStableDeviceId
    const encryptedAvailable = safeStorage.isEncryptionAvailable()
    if (encryptedAvailable) {
      try {
        const encrypted = await readFile(this.stableDevicePath)
        const value = safeStorage.decryptString(encrypted).trim()
        if (/^[0-9a-f-]{36}$/i.test(value)) {
          this.memoryStableDeviceId = value
          return value
        }
      } catch {
        // Try the non-secret plaintext fallback below.
      }
    }

    try {
      const plain = (await readFile(this.stableDevicePlainPath, 'utf8')).trim()
      if (/^[0-9a-f-]{36}$/i.test(plain)) {
        this.memoryStableDeviceId = plain
        if (encryptedAvailable) {
          await this.ensureDirectory()
          await writeFile(this.stableDevicePath, safeStorage.encryptString(plain))
          await rm(this.stableDevicePlainPath, { force: true }).catch(() => undefined)
        }
        return plain
      }
    } catch {
      // Create a new install-scoped identifier below.
    }

    const value = randomUUID()
    this.memoryStableDeviceId = value
    await this.ensureDirectory()
    if (encryptedAvailable) {
      await writeFile(this.stableDevicePath, safeStorage.encryptString(value))
    } else {
      await writeFile(this.stableDevicePlainPath, value, { encoding: 'utf8', mode: 0o600 })
    }
    return value
  }

  async readBootstrapNonce(): Promise<string | null> {
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      const encrypted = await readFile(this.bootstrapPath)
      return safeStorage.decryptString(encrypted)
    } catch {
      try {
        const pending = (await readFile(this.bootstrapPendingPath, 'utf8')).trim()
        if (!pending) return null
        await this.ensureDirectory()
        await writeFile(this.bootstrapPath, safeStorage.encryptString(pending))
        await rm(this.bootstrapPendingPath, { force: true })
        return pending
      } catch {
        return null
      }
    }
  }

  async deleteBootstrapNonce(): Promise<void> {
    await Promise.all([
      rm(this.bootstrapPath, { force: true }).catch(() => undefined),
      rm(this.bootstrapPendingPath, { force: true }).catch(() => undefined)
    ])
  }

  static bootstrapNoncePath(userDataPath: string): string {
    return join(userDataPath, 'secure', 'bootstrap-nonce.bin')
  }
}
