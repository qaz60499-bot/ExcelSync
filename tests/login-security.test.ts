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

async function request(env: Env, path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers = new Headers(options.headers)
  let body: string | undefined
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(options.body)
  }
  return appFetch(new Request(`https://excel-sync.test${path}`, { method: options.method ?? 'GET', headers, body }), env as never)
}

describe('login security', () => {
  it('throttles repeated failures by account and tracks source IP separately', async () => {
    const db = new SqliteD1()
    try {
      applyMigrations(db)
      const nonce = 'login-security-bootstrap-nonce-123456789'
      db.database.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES ('setup_nonce_hash',?,datetime('now'))")
        .run(await sha256Text(nonce))
      const env = { DB: db, RETENTION_LIMIT: '20', SESSION_TTL_SECONDS: '2592000' } as unknown as Env
      expect((await request(env, '/auth/bootstrap', {
        method: 'POST',
        headers: { 'x-setup-nonce': nonce },
        body: { username: 'owner', password: 'owner-password-12345' }
      })).status).toBe(201)

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const response = await request(env, '/auth/login', {
          method: 'POST',
          headers: { 'cf-connecting-ip': '203.0.113.55' },
          body: { username: 'owner', password: `wrong-password-${attempt}` }
        })
        expect(response.status, `attempt ${attempt}`).toBe(401)
      }
      const blocked = await request(env, '/auth/login', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.55' },
        body: { username: 'owner', password: 'wrong-password-6' }
      })
      expect(blocked.status).toBe(429)

      const correctWhileBlocked = await request(env, '/auth/login', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.55' },
        body: { username: 'owner', password: 'owner-password-12345' }
      })
      expect(correctWhileBlocked.status).toBe(429)

      const states = db.database.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'login_throttle:%'").all() as Array<{ key: string; value: string }>
      expect(states).toHaveLength(2)
      const userState = states.find((row) => row.key.startsWith('login_throttle:user:'))
      const ipState = states.find((row) => row.key.startsWith('login_throttle:ip:'))
      expect(userState).toBeTruthy()
      expect(ipState).toBeTruthy()
      expect(Boolean(JSON.parse(userState!.value).blockedUntil)).toBe(true)
      expect(JSON.parse(ipState!.value)).toMatchObject({ failures: 6, blockedUntil: null })
    } finally {
      db.close()
    }
  }, 20_000)

  it('uses the same PBKDF2 verification path for unknown usernames', async () => {
    const source = readFileSync(new URL('../worker/src/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('verifyPassword(input.password, row?.password_hash ?? DUMMY_PASSWORD_HASH)')
  })
})
