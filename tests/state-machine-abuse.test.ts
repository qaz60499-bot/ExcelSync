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
    return (this.db.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null
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
    '0001_init.sql', '0002_relative_paths.sql', '0003_trash_state.sql',
    '0004_personal_cloud_photos.sql', '0005_photo_legacy_metadata.sql',
    '0006_enterprise_workspaces.sql', '0007_version_acl_scopes.sql',
    '0008_resilience_accounts_presence.sql', '0009_collaboration_recovery_search.sql',
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

async function bootstrap(): Promise<{ db: SqliteD1; env: Env; token: string; workspaceId: string }> {
  const db = new SqliteD1()
  applyMigrations(db)
  const nonce = 'state-machine-bootstrap-nonce-123456789'
  db.database.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES ('setup_nonce_hash',?,datetime('now'))").run(await sha256Text(nonce))
  const env = { DB: db, RETENTION_LIMIT: '20', SESSION_TTL_SECONDS: '2592000' } as unknown as Env
  expect((await request(env, '/auth/bootstrap', {
    method: 'POST', headers: { 'x-setup-nonce': nonce }, body: { username: 'owner', password: 'owner-password-12345' }
  })).status).toBe(201)
  const login = await request(env, '/auth/login', { method: 'POST', body: { username: 'owner', password: 'owner-password-12345' } })
  expect(login.status).toBe(200)
  const result = await login.json() as { token: string; defaultWorkspaceId: string }
  return { db, env, token: result.token, workspaceId: result.defaultWorkspaceId }
}

describe('upload state-machine abuse resistance', () => {
  it('does not create a ghost file when an idempotency key is replayed with a different path', async () => {
    const { db, env, token, workspaceId } = await bootstrap()
    try {
      const key = 'state-machine-replay-key-0001'
      const first = await request(env, '/sync/preflight', {
        method: 'POST', token,
        body: {
          workspaceId, logicalName: 'first.xlsx', relativePath: 'Safe/first.xlsx', hash: 'a'.repeat(64),
          size: 1024, baseVersion: 0, idempotencyKey: key, storageBackend: 'telegram_user_group'
        }
      })
      expect(first.status).toBe(201)
      const before = (db.database.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number }).count

      const replay = await request(env, '/sync/preflight', {
        method: 'POST', token,
        body: {
          workspaceId, logicalName: 'second.xlsx', relativePath: 'Safe/second.xlsx', hash: 'a'.repeat(64),
          size: 1024, baseVersion: 0, idempotencyKey: key, storageBackend: 'telegram_user_group'
        }
      })
      expect(replay.status).toBe(409)
      const payload = await replay.json() as { error?: { code?: string } }
      expect(payload.error?.code).toBe('IDEMPOTENCY_KEY_REUSED')

      const after = (db.database.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number }).count
      expect(after).toBe(before)
      const ghost = db.database.prepare("SELECT id FROM files WHERE relative_path = 'Safe/second.xlsx'").get()
      expect(ghost).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('rejects altered idempotent replays without growing file or intent state', async () => {
    const { db, env, token, workspaceId } = await bootstrap()
    try {
      const key = 'state-machine-mutation-key-0002'
      const baseBody = {
        workspaceId, logicalName: 'stable.xlsx', relativePath: 'Stable/stable.xlsx', hash: 'b'.repeat(64),
        size: 2048, baseVersion: 0, idempotencyKey: key, storageBackend: 'telegram_user_group'
      }
      expect((await request(env, '/sync/preflight', { method: 'POST', token, body: baseBody })).status).toBe(201)
      const beforeFiles = (db.database.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number }).count
      const beforeIntents = (db.database.prepare('SELECT COUNT(*) AS count FROM upload_intents').get() as { count: number }).count

      const mutations = [
        { ...baseBody, size: 2049 },
        { ...baseBody, hash: 'c'.repeat(64) },
        { ...baseBody, storageBackend: 'telegram_bot' as const },
        { ...baseBody, relativePath: 'Stable/renamed.xlsx', logicalName: 'renamed.xlsx' }
      ]
      for (const mutation of mutations) {
        const response = await request(env, '/sync/preflight', { method: 'POST', token, body: mutation })
        expect(response.status).toBe(409)
        const payload = await response.json() as { error?: { code?: string } }
        expect(payload.error?.code).toBe('IDEMPOTENCY_KEY_REUSED')
      }

      expect((db.database.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number }).count).toBe(beforeFiles)
      expect((db.database.prepare('SELECT COUNT(*) AS count FROM upload_intents').get() as { count: number }).count).toBe(beforeIntents)
    } finally {
      db.close()
    }
  })

  it('keeps repeated receipt and commit bursts idempotent', async () => {
    const { db, env, token, workspaceId } = await bootstrap()
    try {
      const hash = 'd'.repeat(64)
      const preflight = await request(env, '/sync/preflight', {
        method: 'POST', token,
        body: {
          workspaceId, logicalName: 'burst.xlsx', relativePath: 'Burst/burst.xlsx', hash,
          size: 4096, baseVersion: 0, idempotencyKey: 'state-machine-burst-key-0003', storageBackend: 'telegram_user_group'
        }
      })
      expect(preflight.status).toBe(201)
      const created = await preflight.json() as { intentId: string; fileId: string }
      const receipt = {
        intentId: created.intentId,
        receipt: {
          backend: 'telegram_user_group', chatId: '-1001234567890', messageId: 998877,
          fileName: 'burst.xlsx', size: 4096, sha256: hash,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          createdAt: new Date().toISOString()
        }
      }

      for (let index = 0; index < 25; index += 1) {
        expect((await request(env, '/sync/upload-receipt', { method: 'POST', token, body: receipt })).status).toBe(200)
      }
      for (let index = 0; index < 100; index += 1) {
        const response = await request(env, '/sync/commit', { method: 'POST', token, body: { intentId: created.intentId } })
        expect(response.status).toBe(200)
      }

      const file = db.database.prepare('SELECT current_version,current_hash FROM files WHERE id=?').get(created.fileId) as { current_version: number; current_hash: string }
      expect(file).toEqual({ current_version: 1, current_hash: hash })
      expect((db.database.prepare('SELECT COUNT(*) AS count FROM file_versions WHERE file_id=?').get(created.fileId) as { count: number }).count).toBe(1)
      expect((db.database.prepare("SELECT COUNT(*) AS count FROM sync_events WHERE file_id=? AND event_type='SYNC_COMMIT'").get(created.fileId) as { count: number }).count).toBe(1)
    } finally {
      db.close()
    }
  })
})
