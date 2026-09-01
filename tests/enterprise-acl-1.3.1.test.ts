import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appFetch } from '../worker/src/index'
import { sha256Text } from '../worker/src/auth'
import { encryptCredential } from '../worker/src/credential-crypto'

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

async function request(env: Env, path: string, options: { method?: string; token?: string; body?: unknown } = {}): Promise<Response> {
  const headers = new Headers()
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

const ORG = '00000000-0000-4000-8000-000000000001'
const WORKSPACE = '00000000-0000-4000-8000-000000000002'
const STORAGE_A = '00000000-0000-4000-8000-000000000003'
const STORAGE_B = '22222222-2222-4222-8222-222222222222'
const FILE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FILE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TOKEN_A = 'test-telegram-token-a-long-enough'
const TOKEN_B = 'test-telegram-token-b-long-enough'
const MASTER = 'enterprise-acl-master-key-12345678901234567890'

const hashA1 = '1'.repeat(64)
const hashA2 = '2'.repeat(64)
const hashB1 = '3'.repeat(64)

async function bootstrapFixture(): Promise<{
  db: SqliteD1
  env: Env
  owner: { token: string; user: { id: string } }
}> {
  const db = new SqliteD1()
  applyMigrations(db)
  const nonce = 'enterprise-acl-bootstrap-nonce-123456789'
  db.database.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES ('setup_nonce_hash',?,datetime('now'))").run(await sha256Text(nonce))
  const env = {
    DB: db,
    RETENTION_LIMIT: '20',
    SESSION_TTL_SECONDS: '2592000',
    STORAGE_MASTER_KEY: MASTER,
    TELEGRAM_BOT_TOKEN: TOKEN_A
  } as unknown as Env
  expect((await request(env, '/auth/bootstrap', {
    method: 'POST',
    body: { username: 'owner', displayName: 'Owner', password: 'owner-password-12345', organizationName: 'ACL Org' }
  })).status).toBe(403)
  const bootstrap = await appFetch(new Request('https://excel-sync.test/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-setup-nonce': nonce },
    body: JSON.stringify({ username: 'owner', displayName: 'Owner', password: 'owner-password-12345', organizationName: 'ACL Org' })
  }), env as never)
  expect(bootstrap.status).toBe(201)
  const owner = await json<{ token: string; user: { id: string } }>(await request(env, '/auth/login', {
    method: 'POST', body: { username: 'owner', password: 'owner-password-12345' }
  }))

  db.database.prepare("UPDATE storage_connections SET chat_id='chat-a', chat_title='A', status='ACTIVE' WHERE id=?").run(STORAGE_A)
  const encrypted = await encryptCredential(MASTER, TOKEN_B)
  db.database.prepare(
    `INSERT INTO storage_connections(id,organization_id,provider,name,credential_ciphertext,credential_iv,credential_source,chat_id,chat_title,status,created_by_user_id,created_at,updated_at)
     VALUES (?,?, 'telegram','Storage B',?,?, 'ENCRYPTED','chat-b','B','ACTIVE',?,datetime('now'),datetime('now'))`
  ).run(STORAGE_B, ORG, encrypted.ciphertext, encrypted.iv, owner.user.id)

  const now = new Date().toISOString()
  db.database.prepare(
    `INSERT INTO files(id,logical_name,current_version,current_telegram_file_id,current_telegram_message_id,current_hash,owner_user_id,created_at,updated_at,updated_by,status,relative_path,workspace_id,created_by_user_id,updated_by_user_id,home_storage_connection_id)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'active',?,?,?,?,?)`
  ).run(FILE_A, 'A.xlsx', 2, 'remote-a-v2', 202, hashA2, owner.user.id, now, now, owner.user.id,
    '浙江省/宁波市/海曙区/A.xlsx', WORKSPACE, owner.user.id, owner.user.id, STORAGE_A)
  db.database.prepare(
    `INSERT INTO files(id,logical_name,current_version,current_telegram_file_id,current_telegram_message_id,current_hash,owner_user_id,created_at,updated_at,updated_by,status,relative_path,workspace_id,created_by_user_id,updated_by_user_id,home_storage_connection_id)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'active',?,?,?,?,?)`
  ).run(FILE_B, 'B.xlsx', 1, 'remote-b-v1', 301, hashB1, owner.user.id, now, now, owner.user.id,
    '浙江省/杭州市/B.xlsx', WORKSPACE, owner.user.id, owner.user.id, STORAGE_B)

  db.database.prepare(
    `INSERT INTO file_versions(id,file_id,version,telegram_file_id,telegram_message_id,hash,size,base_version,created_at,created_by,status,storage_connection_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run('a1000000-0000-4000-8000-000000000001', FILE_A, 1, 'remote-a-v1', 101, hashA1, 11, 0, now, owner.user.id, 'archived', STORAGE_B)
  db.database.prepare(
    `INSERT INTO file_versions(id,file_id,version,telegram_file_id,telegram_message_id,hash,size,base_version,created_at,created_by,status,storage_connection_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run('a2000000-0000-4000-8000-000000000002', FILE_A, 2, 'remote-a-v2', 202, hashA2, 22, 1, now, owner.user.id, 'active', STORAGE_A)
  db.database.prepare(
    `INSERT INTO file_versions(id,file_id,version,telegram_file_id,telegram_message_id,hash,size,base_version,created_at,created_by,status,storage_connection_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run('b1000000-0000-4000-8000-000000000001', FILE_B, 1, 'remote-b-v1', 301, hashB1, 33, 0, now, owner.user.id, 'active', STORAGE_B)

  return { db, env, owner }
}

async function inviteAndActivate(env: Env, ownerToken: string, username: string, role: 'VIEWER' | 'EDITOR' | 'MANAGER') {
  const inviteResponse = await request(env, '/admin/invites', {
    method: 'POST', token: ownerToken,
    body: { username, displayName: username, workspaceId: WORKSPACE, workspaceRole: role, expiresInHours: 24 }
  })
  expect(inviteResponse.status).toBe(201)
  const invite = await json<{ code: string }>(inviteResponse)
  const activated = await request(env, '/auth/activate', {
    method: 'POST', body: { code: invite.code, password: `${username}-password-12345` }
  })
  expect(activated.status).toBe(200)
  return json<{ token: string; user: { id: string } }>(activated)
}

function installTelegramMock(): Array<{ url: string; fileId?: string }> {
  const calls: Array<{ url: string; fileId?: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/getFile')) {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { file_id?: string }
      calls.push({ url, fileId: parsed.file_id })
      return new Response(JSON.stringify({ ok: true, result: { file_id: parsed.file_id, file_path: `files/${parsed.file_id}.bin` } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    }
    if (url.includes('/file/bot')) {
      calls.push({ url })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    }
    if (url.includes('/sendDocument')) {
      calls.push({ url })
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: 999, document: { file_id: 'restored-object', file_unique_id: 'restored-unique', file_size: 11 } }
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: false, error_code: 404 }), { status: 404, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ExcelSync 1.3.1 ACL and version routing', () => {
  it('gives OWNER and ADMIN organization-wide file capabilities even with VIEWER membership', async () => {
    const { db, env, owner } = await bootstrapFixture()
    const calls = installTelegramMock()
    try {
      db.database.prepare("UPDATE workspace_members SET role='VIEWER' WHERE workspace_id=? AND user_id=?").run(WORKSPACE, owner.user.id)

      const ownerList = await json<{ files: Array<{ id: string }> }>(await request(env, '/files/list', { token: owner.token }))
      expect(ownerList.files.map((row) => row.id)).toEqual(expect.arrayContaining([FILE_A, FILE_B]))
      expect((await request(env, `/files/${FILE_A}/download`, { token: owner.token })).status).toBe(200)
      expect(calls.some((call) => call.fileId === 'remote-a-v2' && call.url.includes(`bot${TOKEN_A}`))).toBe(true)

      const versions = await json<{ versions: Array<{ version: number }> }>(await request(env, `/versions/${FILE_A}`, { token: owner.token }))
      expect(versions.versions.map((row) => row.version)).toEqual([2, 1])
      expect((await request(env, `/files/${FILE_A}/versions/1/download`, { token: owner.token })).status).toBe(200)
      expect(calls.some((call) => call.fileId === 'remote-a-v1' && call.url.includes(`bot${TOKEN_B}`))).toBe(true)

      expect((await request(env, `/files/${FILE_A}/rename`, {
        method: 'POST', token: owner.token,
        body: { logicalName: 'A.xlsx', relativePath: '浙江省/宁波市/鄞州区/A.xlsx', baseVersion: 2 }
      })).status).toBe(200)
      expect((await request(env, `/files/${FILE_A}/trash`, { method: 'POST', token: owner.token, body: { baseVersion: 2 } })).status).toBe(200)
      expect((await request(env, `/files/${FILE_A}/restore-from-trash`, { method: 'POST', token: owner.token })).status).toBe(200)
      expect((await request(env, `/versions/${FILE_A}/restore`, {
        method: 'POST', token: owner.token, body: { version: 1, baseVersion: 2 }
      })).status).toBe(200)
      const ownerCurrent = db.database.prepare('SELECT current_version FROM files WHERE id=?').get(FILE_A) as { current_version: number }
      expect(ownerCurrent.current_version).toBe(3)
      expect((db.database.prepare('SELECT storage_connection_id,restored_from_version FROM file_versions WHERE file_id=? AND version=3').get(FILE_A) as { storage_connection_id: string; restored_from_version: number })).toEqual({
        storage_connection_id: STORAGE_A,
        restored_from_version: 1
      })
      expect((await request(env, '/sync/preflight', {
        method: 'POST', token: owner.token,
        body: { workspaceId: WORKSPACE, fileId: FILE_A, logicalName: 'A.xlsx', relativePath: '浙江省/宁波市/鄞州区/A.xlsx', hash: '4'.repeat(64), size: 44, baseVersion: 3, idempotencyKey: 'owner-acl-upload-0001' }
      })).status).toBe(201)

      const admin = await inviteAndActivate(env, owner.token, 'admin1', 'VIEWER')
      expect((await request(env, `/workspaces/${WORKSPACE}/resource-access/${admin.user.id}`, {
        method: 'PUT', token: owner.token,
        body: { workspaceRole: 'VIEWER', scopes: [{ scopeType: 'FILE', scopeValue: FILE_B }] }
      })).status).toBe(200)
      expect((await request(env, `/admin/users/${admin.user.id}/role`, {
        method: 'PATCH', token: owner.token, body: { systemRole: 'ADMIN' }
      })).status).toBe(200)
      db.database.prepare("UPDATE workspace_members SET role='VIEWER' WHERE workspace_id=? AND user_id=?").run(WORKSPACE, admin.user.id)

      const adminList = await json<{ files: Array<{ id: string }> }>(await request(env, '/files/list', { token: admin.token }))
      expect(adminList.files.map((row) => row.id)).toEqual(expect.arrayContaining([FILE_A, FILE_B]))
      expect((await request(env, `/versions/${FILE_A}`, { token: admin.token })).status).toBe(200)
      expect((await request(env, `/files/${FILE_A}/versions/1/download`, { token: admin.token })).status).toBe(200)
      expect((await request(env, `/files/${FILE_A}/rename`, {
        method: 'POST', token: admin.token,
        body: { logicalName: 'A.xlsx', relativePath: '浙江省/杭州市/A.xlsx', baseVersion: 3 }
      })).status).toBe(200)
      expect((await request(env, `/files/${FILE_A}/trash`, { method: 'POST', token: admin.token, body: { baseVersion: 3 } })).status).toBe(200)
      expect((await request(env, `/files/${FILE_A}/restore-from-trash`, { method: 'POST', token: admin.token })).status).toBe(200)
      expect((await request(env, `/versions/${FILE_A}/restore`, {
        method: 'POST', token: admin.token, body: { version: 1, baseVersion: 3 }
      })).status).toBe(200)
      expect((await request(env, '/sync/preflight', {
        method: 'POST', token: admin.token,
        body: { workspaceId: WORKSPACE, fileId: FILE_A, logicalName: 'A.xlsx', relativePath: '浙江省/杭州市/A.xlsx', hash: '5'.repeat(64), size: 55, baseVersion: 4, idempotencyKey: 'admin-acl-upload-0001' }
      })).status).toBe(201)

      expect((await request(env, `/admin/users/${owner.user.id}/role`, {
        method: 'PATCH', token: admin.token, body: { systemRole: 'MEMBER' }
      })).status).toBe(403)
    } finally {
      db.close()
    }
  })

  it('enforces WORKSPACE, FILE, FOLDER and STORAGE scopes at Worker endpoints and task links', async () => {
    const { db, env, owner } = await bootstrapFixture()
    installTelegramMock()
    try {
      const member = await inviteAndActivate(env, owner.token, 'member1', 'VIEWER')

      const workspaceFiles = await json<{ files: Array<{ id: string }> }>(await request(env, '/files/list', { token: member.token }))
      expect(workspaceFiles.files.map((row) => row.id)).toEqual(expect.arrayContaining([FILE_A, FILE_B]))
      expect((await request(env, `/files/${FILE_A}/rename`, {
        method: 'POST', token: member.token,
        body: { logicalName: 'A.xlsx', relativePath: '浙江省/宁波市/海曙区/A2.xlsx', baseVersion: 2 }
      })).status).toBe(404)

      expect((await request(env, `/workspaces/${WORKSPACE}/resource-access/${member.user.id}`, {
        method: 'PUT', token: owner.token,
        body: { workspaceRole: 'VIEWER', scopes: [{ scopeType: 'FILE', scopeValue: FILE_A }] }
      })).status).toBe(200)
      const fileScoped = await json<{ files: Array<{ id: string }> }>(await request(env, '/files/list', { token: member.token }))
      expect(fileScoped.files.map((row) => row.id)).toEqual([FILE_A])
      expect((await request(env, `/files/${FILE_B}/download`, { token: member.token })).status).toBe(404)
      expect((await request(env, `/versions/${FILE_B}`, { token: member.token })).status).toBe(404)
      expect((await request(env, `/files/${FILE_B}/versions/1/download`, { token: member.token })).status).toBe(404)

      const selfTask = await request(env, '/tasks', {
        method: 'POST', token: member.token,
        body: { workspaceId: WORKSPACE, title: 'Self task', description: '', priority: 'MEDIUM', assigneeUserId: member.user.id, fileIds: [FILE_A] }
      })
      expect(selfTask.status).toBe(201)
      expect((await request(env, '/tasks', {
        method: 'POST', token: member.token,
        body: { workspaceId: WORKSPACE, title: 'Forbidden link', description: '', priority: 'MEDIUM', assigneeUserId: member.user.id, fileIds: [FILE_B] }
      })).status).toBe(400)

      expect((await request(env, `/workspaces/${WORKSPACE}/resource-access/${member.user.id}`, {
        method: 'PUT', token: owner.token,
        body: { workspaceRole: 'EDITOR', scopes: [{ scopeType: 'FOLDER', scopeValue: '浙江省/宁波市' }] }
      })).status).toBe(200)
      expect((await request(env, `/files/${FILE_A}/rename`, {
        method: 'POST', token: member.token,
        body: { logicalName: 'A.xlsx', relativePath: '浙江省/宁波市/鄞州区/A.xlsx', baseVersion: 2 }
      })).status).toBe(200)
      expect((await request(env, `/files/${FILE_A}/rename`, {
        method: 'POST', token: member.token,
        body: { logicalName: 'A.xlsx', relativePath: '浙江省/宁波市2/A.xlsx', baseVersion: 2 }
      })).status).toBe(403)
      expect((await request(env, `/files/${FILE_A}/rename`, {
        method: 'POST', token: member.token,
        body: { logicalName: 'A.xlsx', relativePath: '浙江省/杭州市/A.xlsx', baseVersion: 2 }
      })).status).toBe(403)

      expect((await request(env, `/workspaces/${WORKSPACE}/resource-access/${member.user.id}`, {
        method: 'PUT', token: owner.token,
        body: { workspaceRole: 'VIEWER', scopes: [{ scopeType: 'STORAGE', scopeValue: STORAGE_A }] }
      })).status).toBe(200)
      const storageA = await json<{ files: Array<{ id: string }> }>(await request(env, '/files/list', { token: member.token }))
      expect(storageA.files.map((row) => row.id)).toEqual([FILE_A])
      expect((await request(env, `/files/${FILE_A}/versions/1/download`, { token: member.token })).status).toBe(200)

      expect((await request(env, `/workspaces/${WORKSPACE}/resource-access/${member.user.id}`, {
        method: 'PUT', token: owner.token,
        body: { workspaceRole: 'VIEWER', scopes: [{ scopeType: 'STORAGE', scopeValue: STORAGE_B }] }
      })).status).toBe(200)
      const storageB = await json<{ files: Array<{ id: string }> }>(await request(env, '/files/list', { token: member.token }))
      expect(storageB.files.map((row) => row.id)).toEqual([FILE_B])

      expect((await request(env, `/workspaces/${WORKSPACE}/resource-access/${member.user.id}`, {
        method: 'PUT', token: owner.token,
        body: { workspaceRole: 'EDITOR', scopes: [{ scopeType: 'WORKSPACE', scopeValue: WORKSPACE }] }
      })).status).toBe(200)
      expect((await request(env, '/sync/preflight', {
        method: 'POST', token: member.token,
        body: { workspaceId: WORKSPACE, logicalName: 'new.xlsx', relativePath: '浙江省/嘉兴市/new.xlsx', hash: '6'.repeat(64), size: 66, baseVersion: 0, idempotencyKey: 'member-workspace-create-0001' }
      })).status).toBe(201)
    } finally {
      db.close()
    }
  })
})
