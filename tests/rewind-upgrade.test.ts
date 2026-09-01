import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { appFetch } from '../worker/src/index'
import { sha256Text } from '../worker/src/auth'

type BoundValue = string | number | bigint | Uint8Array | null

class SqliteStatement {
  private values: BoundValue[] = []
  constructor(private readonly db: SqliteD1, readonly sql: string) {}
  bind(...values: unknown[]): SqliteStatement {
    this.values = values.map((value) => value === undefined ? null : value as BoundValue)
    return this
  }
  async first<T>(): Promise<T | null> {
    const row = this.db.database.prepare(this.sql).get(...this.values) as T | undefined
    return row ?? null
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.database.prepare(this.sql).all(...this.values) as T[] }
  }
  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    const result = this.db.database.prepare(this.sql).run(...this.values)
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

class SqliteD1 {
  readonly database = new DatabaseSync(':memory:')
  prepare(sql: string): SqliteStatement { return new SqliteStatement(this, sql) }
  async batch(statements: SqliteStatement[]): Promise<Array<{ success: boolean; meta: { changes: number } }>> {
    this.database.exec('BEGIN')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
  exec(sql: string): void { this.database.exec(sql) }
  close(): void { this.database.close() }
}

function applyMigrations(db: SqliteD1): void {
  for (const file of [
    '0001_init.sql',
    '0002_relative_paths.sql',
    '0003_trash_state.sql',
    '0004_personal_cloud_photos.sql',
    '0005_photo_legacy_metadata.sql',
    '0006_enterprise_workspaces.sql',
    '0007_version_acl_scopes.sql',
    '0008_resilience_accounts_presence.sql',
    '0009_collaboration_recovery_search.sql',
    '0010_dual_telegram_storage.sql'
  ]) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))
}

async function request(env: Env, path: string, options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers = new Headers(options.headers)
  if (options.token) headers.set('authorization', `Bearer ${options.token}`)
  let body: string | undefined
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(options.body)
  }
  return appFetch(new Request(`https://excel-sync.test${path}`, { method: options.method ?? 'GET', headers, body }), env as never)
}

async function json<T>(response: Response): Promise<T> { return await response.json() as T }

async function bootstrapOwner(env: Env, db: SqliteD1) {
  const nonce = 'rewind-upgrade-bootstrap-nonce-123456789'
  db.database.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES ('setup_nonce_hash',?,datetime('now'))").run(await sha256Text(nonce))
  expect((await request(env, '/auth/bootstrap', {
    method: 'POST',
    headers: { 'x-setup-nonce': nonce },
    body: { username: 'owner', displayName: 'Owner', password: 'owner-password-12345', organizationName: 'Rewind Org' }
  })).status).toBe(201)
}

const device = {
  stableDeviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  deviceName: 'Owner PC', osName: 'Windows', osVersion: '11', clientVersion: '1.4.0'
}

describe('Rewind upgrade', () => {
  it('previews and idempotently rewinds files created after the target time', async () => {
    const db = new SqliteD1()
    try {
      applyMigrations(db)
      const env = {
        DB: db,
        RETENTION_LIMIT: '20',
        SESSION_TTL_SECONDS: '2592000',
        STORAGE_MASTER_KEY: 'rewind-storage-master-key-123456789012345'
      } as unknown as Env
      await bootstrapOwner(env, db)
      const login = await request(env, '/auth/login', { method: 'POST', body: { username: 'owner', password: 'owner-password-12345', device } })
      const owner = await json<{ token: string; defaultWorkspaceId: string }>(login)

      const created = await request(env, '/sync/preflight', {
        method: 'POST', token: owner.token,
        body: { workspaceId: owner.defaultWorkspaceId, logicalName: 'after.xlsx', relativePath: 'after.xlsx', hash: 'a'.repeat(64), size: 100, baseVersion: 0, idempotencyKey: 'rewind-create-after-file-001' }
      })
      expect(created.status).toBe(201)
      const file = await json<{ fileId: string }>(created)
      db.database.prepare('DELETE FROM upload_intents WHERE file_id = ?').run(file.fileId)
      const fileCreatedAt = db.database.prepare('SELECT created_at FROM files WHERE id = ?').get(file.fileId) as { created_at: string }
      const targetTime = new Date(new Date(fileCreatedAt.created_at).getTime() - 1000).toISOString()

      const preview = await request(env, '/rewind/preview', {
        method: 'POST', token: owner.token,
        body: { workspaceId: owner.defaultWorkspaceId, scopeType: 'WORKSPACE', scopeValue: owner.defaultWorkspaceId, targetTime }
      })
      expect(preview.status).toBe(200)
      const previewPayload = await json<{ summary: Record<string, number>; actions: Array<{ fileId: string; action: string }> }>(preview)
      expect(previewPayload.summary.newFilesAfterTarget).toBe(1)
      expect(previewPayload.actions).toContainEqual(expect.objectContaining({ fileId: file.fileId, action: 'TRASH_NEW' }))

      const executeBody = {
        workspaceId: owner.defaultWorkspaceId,
        scopeType: 'WORKSPACE',
        scopeValue: owner.defaultWorkspaceId,
        targetTime,
        idempotencyKey: 'rewind-idempotent-operation-001'
      }
      const executed = await request(env, '/rewind/execute', { method: 'POST', token: owner.token, body: executeBody })
      expect(executed.status).toBe(201)
      const first = await json<{ id: string; status: string; done: number; failed: number }>(executed)
      expect(first).toMatchObject({ status: 'COMPLETED', done: 1, failed: 0 })
      expect((db.database.prepare('SELECT status FROM files WHERE id = ?').get(file.fileId) as { status: string }).status).toBe('trashed')

      const repeated = await request(env, '/rewind/execute', { method: 'POST', token: owner.token, body: executeBody })
      expect(repeated.status).toBe(200)
      const second = await json<{ id: string; status: string; done: number; failed: number }>(repeated)
      expect(second).toMatchObject({ id: first.id, status: 'COMPLETED' })
      expect((db.database.prepare('SELECT COUNT(*) AS count FROM rewind_operations').get() as { count: number }).count).toBe(1)
      expect((db.database.prepare('SELECT attempts FROM rewind_items WHERE operation_id = ?').get(first.id) as { attempts: number }).attempts).toBe(1)
    } finally { db.close() }
  })

  it('refuses a rewind while a file has an unfinished upload intent, then succeeds on retry after the blocker is removed', async () => {
    const db = new SqliteD1()
    try {
      applyMigrations(db)
      const env = {
        DB: db,
        RETENTION_LIMIT: '20',
        SESSION_TTL_SECONDS: '2592000',
        STORAGE_MASTER_KEY: 'rewind-storage-master-key-123456789012345'
      } as unknown as Env
      await bootstrapOwner(env, db)
      const login = await request(env, '/auth/login', { method: 'POST', body: { username: 'owner', password: 'owner-password-12345', device } })
      const owner = await json<{ token: string; defaultWorkspaceId: string }>(login)
      const created = await request(env, '/sync/preflight', {
        method: 'POST', token: owner.token,
        body: { workspaceId: owner.defaultWorkspaceId, logicalName: 'busy.xlsx', relativePath: 'busy.xlsx', hash: 'b'.repeat(64), size: 100, baseVersion: 0, idempotencyKey: 'rewind-create-busy-file-001' }
      })
      const file = await json<{ fileId: string }>(created)
      const fileCreatedAt = db.database.prepare('SELECT created_at FROM files WHERE id = ?').get(file.fileId) as { created_at: string }
      const targetTime = new Date(new Date(fileCreatedAt.created_at).getTime() - 1000).toISOString()
      const executeBody = {
        workspaceId: owner.defaultWorkspaceId,
        scopeType: 'WORKSPACE',
        scopeValue: owner.defaultWorkspaceId,
        targetTime,
        idempotencyKey: 'rewind-partial-operation-001'
      }

      const executed = await request(env, '/rewind/execute', { method: 'POST', token: owner.token, body: executeBody })
      expect(executed.status).toBe(201)
      const first = await json<{ id: string; status: string; done: number; failed: number }>(executed)
      expect(first).toMatchObject({ status: 'FAILED', done: 0, failed: 1 })
      expect((db.database.prepare('SELECT status FROM files WHERE id = ?').get(file.fileId) as { status: string }).status).toBe('active')

      db.database.prepare('DELETE FROM upload_intents WHERE file_id = ?').run(file.fileId)
      const retry = await request(env, `/rewind/${first.id}/retry`, { method: 'POST', token: owner.token })
      expect(retry.status).toBe(200)
      const second = await json<{ id: string; status: string; done: number; failed: number }>(retry)
      expect(second).toMatchObject({ id: first.id, status: 'COMPLETED', done: 1, failed: 0 })
      expect((db.database.prepare('SELECT status FROM files WHERE id = ?').get(file.fileId) as { status: string }).status).toBe('trashed')
    } finally { db.close() }
  })
})
