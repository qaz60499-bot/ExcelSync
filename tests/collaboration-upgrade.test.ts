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

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function bootstrapOwner(env: Env, db: SqliteD1) {
  const nonce = 'collaboration-upgrade-bootstrap-nonce-123456789'
  db.database.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES ('setup_nonce_hash',?,datetime('now'))").run(await sha256Text(nonce))
  const bootstrap = await request(env, '/auth/bootstrap', {
    method: 'POST',
    headers: { 'x-setup-nonce': nonce },
    body: { username: 'owner', displayName: 'Owner User', password: 'owner-password-12345', organizationName: 'Collab Org' }
  })
  expect(bootstrap.status).toBe(201)
}

const deviceA = {
  stableDeviceId: '11111111-1111-4111-8111-111111111111',
  deviceName: 'Owner Laptop',
  osName: 'Windows',
  osVersion: '11',
  clientVersion: '1.4.0'
}
const deviceB = {
  stableDeviceId: '22222222-2222-4222-8222-222222222222',
  deviceName: 'Owner Desktop',
  osName: 'Windows',
  osVersion: '11',
  clientVersion: '1.4.0'
}
const editorDevice = {
  stableDeviceId: '33333333-3333-4333-8333-333333333333',
  deviceName: 'Editor PC',
  osName: 'Windows',
  osVersion: '11',
  clientVersion: '1.4.0'
}

describe('ExcelSync collaboration/recovery upgrade', () => {
  it('enforces a single edit lease across devices and supports manager force takeover', async () => {
    const db = new SqliteD1()
    try {
      applyMigrations(db)
      const env = {
        DB: db,
        RETENTION_LIMIT: '20',
        SESSION_TTL_SECONDS: '2592000',
        STORAGE_MASTER_KEY: 'collaboration-storage-master-key-1234567890'
      } as unknown as Env
      await bootstrapOwner(env, db)

      const loginA = await request(env, '/auth/login', { method: 'POST', body: { username: 'owner', password: 'owner-password-12345', device: deviceA } })
      const ownerA = await json<{ token: string; defaultWorkspaceId: string }>(loginA)
      const loginB = await request(env, '/auth/login', { method: 'POST', body: { username: 'owner', password: 'owner-password-12345', device: deviceB } })
      const ownerB = await json<{ token: string }>(loginB)

      const preflight = await request(env, '/sync/preflight', {
        method: 'POST', token: ownerA.token,
        body: { workspaceId: ownerA.defaultWorkspaceId, logicalName: 'locked.xlsx', relativePath: 'locked.xlsx', hash: 'a'.repeat(64), size: 100, baseVersion: 0, idempotencyKey: 'collab-lock-file-create-001' }
      })
      expect(preflight.status).toBe(201)
      const file = await json<{ fileId: string }>(preflight)

      const acquired = await request(env, `/files/${file.fileId}/lease`, { method: 'POST', token: ownerA.token, body: {} })
      expect(acquired.status).toBe(201)
      const leaseA = await json<{ locked: boolean; ownerDeviceName: string; leaseId: string }>(acquired)
      expect(leaseA).toMatchObject({ locked: true, ownerDeviceName: 'Owner Laptop' })

      const blocked = await request(env, `/files/${file.fileId}/lease`, { method: 'POST', token: ownerB.token, body: {} })
      expect(blocked.status).toBe(409)
      expect(await json<{ error: { code: string } }>(blocked)).toMatchObject({ error: { code: 'FILE_LOCKED' } })

      const takeover = await request(env, `/files/${file.fileId}/lease/force-takeover`, { method: 'POST', token: ownerB.token })
      expect(takeover.status).toBe(200)
      const leaseB = await json<{ ownerDeviceName: string; currentDevice: boolean; leaseId: string }>(takeover)
      expect(leaseB.ownerDeviceName).toBe('Owner Desktop')
      expect(leaseB.currentDevice).toBe(true)
      expect(leaseB.leaseId).not.toBe(leaseA.leaseId)

      const staleHeartbeat = await request(env, `/files/${file.fileId}/lease`, { method: 'PUT', token: ownerA.token, body: { leaseId: leaseA.leaseId } })
      expect(staleHeartbeat.status).toBe(409)
      expect(await json<{ error: { code: string } }>(staleHeartbeat)).toMatchObject({ error: { code: 'LEASE_LOST' } })
    } finally {
      db.close()
    }
  })

  it('creates comments, takeover notifications, and permission-aware advanced-search results', async () => {
    const db = new SqliteD1()
    try {
      applyMigrations(db)
      const env = {
        DB: db,
        RETENTION_LIMIT: '20',
        SESSION_TTL_SECONDS: '2592000',
        STORAGE_MASTER_KEY: 'collaboration-storage-master-key-1234567890'
      } as unknown as Env
      await bootstrapOwner(env, db)

      const ownerLogin = await request(env, '/auth/login', { method: 'POST', body: { username: 'owner', password: 'owner-password-12345', device: deviceA } })
      const owner = await json<{ token: string; user: { id: string }; defaultWorkspaceId: string }>(ownerLogin)
      const preflight = await request(env, '/sync/preflight', {
        method: 'POST', token: owner.token,
        body: { workspaceId: owner.defaultWorkspaceId, logicalName: 'finance.xlsx', relativePath: 'Finance/finance.xlsx', hash: 'b'.repeat(64), size: 120, baseVersion: 0, idempotencyKey: 'collab-search-file-create-001' }
      })
      const file = await json<{ fileId: string }>(preflight)
      expect(preflight.status).toBe(201)

      const inviteResponse = await request(env, '/admin/invites', {
        method: 'POST', token: owner.token,
        body: { username: 'editor1', displayName: 'Editor One', workspaceId: owner.defaultWorkspaceId, workspaceRole: 'EDITOR', expiresInHours: 24 }
      })
      expect(inviteResponse.status).toBe(201)
      const invite = await json<{ code: string }>(inviteResponse)
      const editorActivate = await request(env, '/auth/activate', {
        method: 'POST',
        body: { code: invite.code, password: 'editor-password-12345', device: editorDevice }
      })
      expect(editorActivate.status).toBe(200)
      const editor = await json<{ token: string; user: { id: string } }>(editorActivate)

      const accessResponse = await request(env, `/workspaces/${owner.defaultWorkspaceId}/resource-access/${editor.user.id}`, {
        method: 'PUT', token: owner.token,
        body: { workspaceRole: 'EDITOR', scopes: [{ scopeType: 'WORKSPACE', scopeValue: owner.defaultWorkspaceId }] }
      })
      expect(accessResponse.status).toBe(200)

      const commentResponse = await request(env, `/files/${file.fileId}/comments`, {
        method: 'POST', token: owner.token, body: { body: '请检查这个文件 @editor1' }
      })
      expect(commentResponse.status).toBe(201)
      const comments = await json<{ comments: Array<{ body: string; mention_user_ids: string[] }> }>(commentResponse)
      expect(comments.comments).toHaveLength(1)
      expect(comments.comments[0]?.body).toContain('@editor1')
      expect(comments.comments[0]?.mention_user_ids).toContain(editor.user.id)

      const editorNotifications = await request(env, '/notifications?filter=unread', { token: editor.token })
      expect(editorNotifications.status).toBe(200)
      const editorNoticePayload = await json<{ unreadCount: number; notifications: Array<{ title: string; resource_id: string }> }>(editorNotifications)
      expect(editorNoticePayload.unreadCount).toBeGreaterThanOrEqual(1)
      expect(editorNoticePayload.notifications.some((row) => row.title.includes('提及') && row.resource_id === file.fileId)).toBe(true)

      const ownerLease = await request(env, `/files/${file.fileId}/lease`, { method: 'POST', token: owner.token, body: {} })
      expect(ownerLease.status).toBe(201)
      const takeoverRequest = await request(env, `/files/${file.fileId}/lease/request-takeover`, { method: 'POST', token: editor.token })
      expect(takeoverRequest.status).toBe(200)
      const ownerNotifications = await request(env, '/notifications?filter=unread', { token: owner.token })
      const ownerNoticePayload = await json<{ notifications: Array<{ title: string }> }>(ownerNotifications)
      expect(ownerNoticePayload.notifications.some((row) => row.title.includes('接管'))).toBe(true)

      const search = await request(env, `/search/files?q=finance&type=Excel&state=locked&workspaceId=${encodeURIComponent(owner.defaultWorkspaceId)}&path=Finance`, { token: editor.token })
      expect(search.status).toBe(200)
      const searchPayload = await json<{ files: Array<{ id: string; logical_name: string; lock_owner_name: string | null }> }>(search)
      expect(searchPayload.files).toHaveLength(1)
      expect(searchPayload.files[0]).toMatchObject({ id: file.fileId, logical_name: 'finance.xlsx', lock_owner_name: 'Owner User' })

      const firstNotification = editorNoticePayload.notifications[0]
      const read = await request(env, `/notifications/${(firstNotification as { id?: string }).id ?? ''}/read`, { method: 'POST', token: editor.token })
      if ((firstNotification as { id?: string }).id) expect(read.status).toBe(200)
    } finally {
      db.close()
    }
  })
})
