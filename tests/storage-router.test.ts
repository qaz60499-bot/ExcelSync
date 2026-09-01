import { describe, expect, it } from 'vitest'
import { encryptCredential } from '../worker/src/credential-crypto'
import { StorageRouter } from '../worker/src/storage-router'

class FakeStatement {
  private values: unknown[] = []
  constructor(private readonly db: FakeD1, private readonly sql: string) {}
  bind(...values: unknown[]): FakeStatement { this.values = values; return this }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM storage_connections WHERE id = ?')) {
      const [id] = this.values
      return (this.db.connections.get(String(id)) ?? null) as T | null
    }
    if (this.sql.includes('FROM workspaces WHERE id = ?')) {
      const [workspaceId] = this.values
      return ({ id: this.db.workspaceDefaults.get(String(workspaceId)) ?? null } as unknown) as T
    }
    if (this.sql.includes('FROM file_versions WHERE file_id = ? AND version = ?')) {
      const [fileId, version] = this.values
      return ({ id: this.db.versionStorage.get(`${String(fileId)}:${String(version)}`) ?? null } as unknown) as T
    }
    if (this.sql.includes('FROM storage_profiles WHERE profile = ?')) return null
    throw new Error(`Unhandled first SQL: ${this.sql}`)
  }
  async all<T>(): Promise<{ results: T[] }> { return { results: [] } }
}

class FakeD1 {
  connections = new Map<string, Record<string, unknown>>()
  workspaceDefaults = new Map<string, string>()
  versionStorage = new Map<string, string>()
  prepare(sql: string): FakeStatement { return new FakeStatement(this, sql) }
}

function connection(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    organization_id: 'org-1',
    provider: 'telegram',
    name: `Storage ${id}`,
    telegram_bot_username: 'example_bot',
    telegram_bot_name: 'Example Bot',
    credential_ciphertext: null,
    credential_iv: null,
    credential_source: 'LEGACY_WORKER_SECRET',
    chat_id: '-100123',
    chat_title: 'Vault',
    status: 'ACTIVE',
    ...overrides
  }
}

describe('StorageRouter version routing', () => {
  it('uses the workspace default connection only for new writes', async () => {
    const db = new FakeD1()
    db.connections.set('storage-b', connection('storage-b'))
    db.workspaceDefaults.set('workspace-1', 'storage-b')
    const router = new StorageRouter({ DB: db, TELEGRAM_BOT_TOKEN: 'legacy-token' } as unknown as Env)

    const resolved = await router.resolveWorkspaceDefault('workspace-1')
    expect(resolved.connection.id).toBe('storage-b')
  })

  it('uses the historical version storage connection even after workspace default changes', async () => {
    const db = new FakeD1()
    db.connections.set('storage-a', connection('storage-a'))
    db.connections.set('storage-b', connection('storage-b'))
    db.workspaceDefaults.set('workspace-1', 'storage-b')
    db.versionStorage.set('file-1:1', 'storage-a')
    db.versionStorage.set('file-1:2', 'storage-a')
    db.versionStorage.set('file-1:3', 'storage-b')
    const router = new StorageRouter({ DB: db, TELEGRAM_BOT_TOKEN: 'legacy-token' } as unknown as Env)

    expect((await router.resolveVersion('file-1', 1)).connection.id).toBe('storage-a')
    expect((await router.resolveVersion('file-1', 2)).connection.id).toBe('storage-a')
    expect((await router.resolveVersion('file-1', 3)).connection.id).toBe('storage-b')
    expect((await router.resolveWorkspaceDefault('workspace-1')).connection.id).toBe('storage-b')
  })

  it('decrypts per-connection Telegram credentials and rejects cross-organization credential reads', async () => {
    const db = new FakeD1()
    const master = 'master-key-for-storage-router-tests-123456789'
    const token = 'encrypted-telegram-test-credential-without-token-shape'
    const encrypted = await encryptCredential(master, token)
    db.connections.set('storage-secure', connection('storage-secure', {
      credential_source: 'ENCRYPTED',
      credential_ciphertext: encrypted.ciphertext,
      credential_iv: encrypted.iv
    }))
    const router = new StorageRouter({ DB: db, STORAGE_MASTER_KEY: master } as unknown as Env)

    const credential = await router.resolveConnectionForCredentialCheck('storage-secure', 'org-1')
    expect(credential.token).toBe(token)
    await expect(router.resolveConnectionForCredentialCheck('storage-secure', 'other-org')).rejects.toThrow('STORAGE_CONNECTION_NOT_FOUND')
  })

  it('refuses disabled connections', async () => {
    const db = new FakeD1()
    db.connections.set('disabled', connection('disabled', { status: 'DISABLED' }))
    const router = new StorageRouter({ DB: db, TELEGRAM_BOT_TOKEN: 'legacy-token' } as unknown as Env)
    await expect(router.resolveConnection('disabled')).rejects.toThrow('STORAGE_CONNECTION_DISABLED')
  })
})
