import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
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
  ]) {
    db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))
  }
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

describe('ExcelSync 1.3 multi-user Worker E2E', () => {
  it('enforces invite lifecycle, workspace roles, tasks and session invalidation end to end', async () => {
    const db = new SqliteD1()
    try {
      applyMigrations(db)
      const nonce = 'enterprise-e2e-bootstrap-nonce-123456789'
      const nonceHash = await sha256Text(nonce)
      db.database.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES ('setup_nonce_hash',?,datetime('now'))").run(nonceHash)
      const env = {
        DB: db,
        RETENTION_LIMIT: '20',
        SESSION_TTL_SECONDS: '2592000',
        STORAGE_MASTER_KEY: 'enterprise-e2e-storage-master-key-123456789012345'
      } as unknown as Env

      const bootstrap = await request(env, '/auth/bootstrap', {
        method: 'POST',
        headers: { 'x-setup-nonce': nonce },
        body: { username: 'owner', displayName: 'Owner User', password: 'owner-password-12345', organizationName: 'E2E Org' }
      })
      expect(bootstrap.status).toBe(201)

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const invalid = await request(env, '/auth/login', { method: 'POST', body: { username: 'ghost-user', password: 'not-the-password' } })
        expect(invalid.status).toBe(401)
      }
      const throttled = await request(env, '/auth/login', { method: 'POST', body: { username: 'ghost-user', password: 'not-the-password' } })
      expect(throttled.status).toBe(429)
      expect((await request(env, '/auth/login', { method: 'POST', body: { username: 'ghost-user', password: 'not-the-password' } })).status).toBe(429)

      const login = await request(env, '/auth/login', { method: 'POST', body: { username: 'owner', password: 'owner-password-12345' } })
      expect(login.status).toBe(200)
      const ownerLogin = await json<{ token: string; user: { id: string; systemRole: string }; defaultWorkspaceId: string }>(login)
      expect(ownerLogin.user.systemRole).toBe('OWNER')
      expect(ownerLogin.defaultWorkspaceId).toMatch(/[0-9a-f-]{36}/i)
      const workspaceId = ownerLogin.defaultWorkspaceId

      db.database.prepare("UPDATE workspace_members SET role = 'VIEWER' WHERE workspace_id = ? AND user_id = ?").run(workspaceId, ownerLogin.user.id)
      const ownerPreflight = await request(env, '/sync/preflight', {
        method: 'POST', token: ownerLogin.token,
        body: { workspaceId, logicalName: 'owner-admin.xlsx', relativePath: 'owner-admin.xlsx', hash: 'c'.repeat(64), size: 100, baseVersion: 0, idempotencyKey: 'owner-admin-preflight-001' }
      })
      expect(ownerPreflight.status).toBe(201)

      const previousStorage = db.database.prepare('SELECT default_storage_connection_id AS id FROM workspaces WHERE id = ?').get(workspaceId) as { id: string | null }
      db.database.prepare('UPDATE workspaces SET default_storage_connection_id = NULL WHERE id = ?').run(workspaceId)
      const userGroupHash = 'e'.repeat(64)
      const userGroupPreflightResponse = await request(env, '/sync/preflight', {
        method: 'POST', token: ownerLogin.token,
        body: {
          workspaceId,
          logicalName: 'user-group-large.xlsx',
          relativePath: 'user-group-large.xlsx',
          hash: userGroupHash,
          size: 25 * 1024 * 1024,
          baseVersion: 0,
          idempotencyKey: 'user-group-large-preflight-001',
          storageBackend: 'telegram_user_group'
        }
      })
      expect(userGroupPreflightResponse.status).toBe(201)
      const userGroupPreflight = await json<{ fileId: string; intentId: string; action: string }>(userGroupPreflightResponse)
      expect(userGroupPreflight.action).toBe('upload_required')
      const receiptResponse = await request(env, '/sync/upload-receipt', {
        method: 'POST', token: ownerLogin.token,
        body: {
          intentId: userGroupPreflight.intentId,
          receipt: {
            backend: 'telegram_user_group',
            chatId: '-1001234567890',
            messageId: 4242,
            fileName: 'user-group-large.xlsx',
            size: 25 * 1024 * 1024,
            sha256: userGroupHash,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            createdAt: new Date().toISOString()
          }
        }
      })
      expect(receiptResponse.status).toBe(200)
      const userGroupCommit = await request(env, '/sync/commit', {
        method: 'POST', token: ownerLogin.token, body: { intentId: userGroupPreflight.intentId }
      })
      expect(userGroupCommit.status).toBe(200)
      const userGroupDownload = await request(env, `/files/${userGroupPreflight.fileId}/download`, { token: ownerLogin.token })
      expect(userGroupDownload.status).toBe(409)
      expect((await json<{ error: { code: string } }>(userGroupDownload)).error.code).toBe('DESKTOP_STORAGE_REQUIRED')
      const userGroupVersions = await json<{ versions: Array<{ version: number; storage_backend?: string; storage_locator?: string }> }>(
        await request(env, `/versions/${userGroupPreflight.fileId}`, { token: ownerLogin.token })
      )
      expect(userGroupVersions.versions[0]?.storage_backend).toBe('telegram_user_group')
      expect(userGroupVersions.versions[0]?.storage_locator).toContain('4242')
      db.database.prepare('UPDATE workspaces SET default_storage_connection_id = ? WHERE id = ?').run(previousStorage.id, workspaceId)

      const botOverLimit = await request(env, '/sync/preflight', {
        method: 'POST', token: ownerLogin.token,
        body: {
          workspaceId,
          logicalName: 'bot-over-limit.exe',
          relativePath: 'bot-over-limit.exe',
          hash: 'f'.repeat(64),
          size: 20 * 1024 * 1024 + 1,
          baseVersion: 0,
          idempotencyKey: 'bot-over-limit-preflight-001',
          storageBackend: 'telegram_bot'
        }
      })
      expect(botOverLimit.status).toBe(413)
      const botOverLimitError = await json<{ error: { code: string; detail?: { capabilities?: { maxReliableFileBytes?: number } } } }>(botOverLimit)
      expect(botOverLimitError.error.code).toBe('FILE_TOO_LARGE')
      expect(botOverLimitError.error.detail?.capabilities?.maxReliableFileBytes).toBe(20 * 1024 * 1024)

      const userGroupAtLimit = await request(env, '/sync/preflight', {
        method: 'POST', token: ownerLogin.token,
        body: {
          workspaceId,
          logicalName: 'user-group-at-limit.exe',
          relativePath: 'user-group-at-limit.exe',
          hash: '1'.repeat(64),
          size: 2 * 1024 * 1024 * 1024,
          baseVersion: 0,
          idempotencyKey: 'user-group-at-limit-preflight-001',
          storageBackend: 'telegram_user_group'
        }
      })
      expect(userGroupAtLimit.status).toBe(201)

      const userGroupOverLimit = await request(env, '/sync/preflight', {
        method: 'POST', token: ownerLogin.token,
        body: {
          workspaceId,
          logicalName: 'user-group-over-limit.exe',
          relativePath: 'user-group-over-limit.exe',
          hash: '2'.repeat(64),
          size: 2 * 1024 * 1024 * 1024 + 1,
          baseVersion: 0,
          idempotencyKey: 'user-group-over-limit-preflight-001',
          storageBackend: 'telegram_user_group'
        }
      })
      expect(userGroupOverLimit.status).toBe(413)
      expect((await json<{ error: { code: string } }>(userGroupOverLimit)).error.code).toBe('FILE_TOO_LARGE')

      const viewerInviteResponse = await request(env, '/admin/invites', {
        method: 'POST', token: ownerLogin.token,
        body: { username: 'viewer1', displayName: 'Viewer One', workspaceId, workspaceRole: 'VIEWER', expiresInHours: 24 }
      })
      expect(viewerInviteResponse.status).toBe(201)
      const viewerInvite = await json<{ id: string; code: string }>(viewerInviteResponse)
      expect(viewerInvite.code).toMatch(/^XS-/)

      const viewerActivateResponse = await request(env, '/auth/activate', { method: 'POST', body: { code: viewerInvite.code, password: 'viewer-password-12345' } })
      expect(viewerActivateResponse.status).toBe(200)
      const viewer = await json<{ token: string; user: { id: string }; memberships: Array<{ role: string }> }>(viewerActivateResponse)
      expect(viewer.memberships[0]?.role).toBe('VIEWER')

      const reusedInvite = await request(env, '/auth/activate', { method: 'POST', body: { code: viewerInvite.code, password: 'another-password-12345' } })
      expect(reusedInvite.status).toBe(400)

      const viewerAdmin = await request(env, '/admin/users', { token: viewer.token })
      expect(viewerAdmin.status).toBe(403)

      const viewerPreflight = await request(env, '/sync/preflight', {
        method: 'POST', token: viewer.token,
        body: { workspaceId, logicalName: 'viewer.xlsx', relativePath: 'viewer.xlsx', hash: 'a'.repeat(64), size: 100, baseVersion: 0, idempotencyKey: 'viewer-preflight-key-0001' }
      })
      expect(viewerPreflight.status).toBe(403)

      const editorInviteResponse = await request(env, '/admin/invites', {
        method: 'POST', token: ownerLogin.token,
        body: { username: 'editor1', displayName: 'Editor One', workspaceId, workspaceRole: 'EDITOR', expiresInHours: 24 }
      })
      const editorInvite = await json<{ code: string }>(editorInviteResponse)
      const editorActivateResponse = await request(env, '/auth/activate', { method: 'POST', body: { code: editorInvite.code, password: 'editor-password-12345' } })
      const editor = await json<{ token: string; user: { id: string } }>(editorActivateResponse)

      const editorPreflight = await request(env, '/sync/preflight', {
        method: 'POST', token: editor.token,
        body: { workspaceId, logicalName: 'editor.xlsx', relativePath: 'editor.xlsx', hash: 'b'.repeat(64), size: 100, baseVersion: 0, idempotencyKey: 'editor-preflight-key-001' }
      })
      expect(editorPreflight.status).toBe(201)
      const preflight = await json<{ fileId: string; action: string }>(editorPreflight)
      expect(preflight.action).toBe('upload_required')

      const editorPreflightSecond = await request(env, '/sync/preflight', {
        method: 'POST', token: editor.token,
        body: { workspaceId, logicalName: 'editor-second.xlsx', relativePath: 'private/editor-second.xlsx', hash: 'd'.repeat(64), size: 100, baseVersion: 0, idempotencyKey: 'editor-preflight-key-002' }
      })
      expect(editorPreflightSecond.status).toBe(201)
      const secondFile = await json<{ fileId: string }>(editorPreflightSecond)

      const narrowViewer = await request(env, `/workspaces/${workspaceId}/resource-access/${viewer.user.id}`, {
        method: 'PUT', token: ownerLogin.token,
        body: { workspaceRole: 'VIEWER', scopes: [{ scopeType: 'FILE', scopeValue: preflight.fileId }] }
      })
      expect(narrowViewer.status).toBe(200)
      const viewerFiles = await json<{ files: Array<{ id: string }> }>(await request(env, '/files/list', { token: viewer.token }))
      expect(viewerFiles.files.map((file) => file.id)).toContain(preflight.fileId)
      expect(viewerFiles.files.map((file) => file.id)).not.toContain(secondFile.fileId)

      const taskCreate = await request(env, '/tasks', {
        method: 'POST', token: editor.token,
        body: { workspaceId, title: 'Review editor file', description: 'E2E task', priority: 'HIGH', assigneeUserId: editor.user.id, fileIds: [preflight.fileId] }
      })
      expect(taskCreate.status).toBe(201)

      const migrationPayload = {
        tasks: [{ legacyClientId: 'legacy-task-1', workspaceId, title: 'Legacy migrated', description: '', status: 'TODO', priority: 'MEDIUM', assigneeUserId: editor.user.id, fileIds: [] }]
      }
      const migrationFirst = await json<{ imported: string[]; existing: string[] }>(await request(env, '/tasks/migrate-local', { method: 'POST', token: editor.token, body: migrationPayload }))
      const migrationSecond = await json<{ imported: string[]; existing: string[] }>(await request(env, '/tasks/migrate-local', { method: 'POST', token: editor.token, body: migrationPayload }))
      expect(migrationFirst.imported).toHaveLength(1)
      expect(migrationSecond.imported).toHaveLength(0)
      expect(migrationSecond.existing).toHaveLength(1)

      const promoteManager = await request(env, `/workspaces/${workspaceId}/members`, { method: 'PUT', token: ownerLogin.token, body: { userId: editor.user.id, role: 'MANAGER' } })
      expect(promoteManager.status).toBe(200)
      const membersAsManager = await request(env, `/workspaces/${workspaceId}/members`, { token: editor.token })
      expect(membersAsManager.status).toBe(200)

      const suspend = await request(env, `/admin/users/${viewer.user.id}/status`, { method: 'PATCH', token: ownerLogin.token, body: { status: 'SUSPENDED' } })
      expect(suspend.status).toBe(200)
      const suspendedSession = await request(env, '/auth/me', { token: viewer.token })
      expect(suspendedSession.status).toBe(401)
      const suspendedLogin = await request(env, '/auth/login', { method: 'POST', body: { username: 'viewer1', password: 'viewer-password-12345' } })
      expect(suspendedLogin.status).toBe(401)

      const restoreViewer = await request(env, `/admin/users/${viewer.user.id}/status`, { method: 'PATCH', token: ownerLogin.token, body: { status: 'ACTIVE' } })
      expect(restoreViewer.status).toBe(200)
      const viewerRelogin = await json<{ token: string }>(await request(env, '/auth/login', { method: 'POST', body: { username: 'viewer1', password: 'viewer-password-12345' } }))
      const forceLogout = await request(env, `/admin/users/${viewer.user.id}/force-logout`, { method: 'POST', token: ownerLogin.token })
      expect(forceLogout.status).toBe(200)
      expect((await request(env, '/auth/me', { token: viewerRelogin.token })).status).toBe(401)

      const invalidStorage = await request(env, '/admin/storage-connections', {
        method: 'POST', token: ownerLogin.token,
        body: { name: 'Invalid Telegram', botToken: 'invalid-telegram-token-value-long-enough' }
      })
      expect(invalidStorage.status).toBe(400)

      const audit = await json<{ logs: Array<{ action: string }> }>(await request(env, '/admin/audit-logs', { token: ownerLogin.token }))
      expect(audit.logs.some((row) => row.action === 'INVITE_CREATED')).toBe(true)
      expect(audit.logs.some((row) => row.action === 'USER_SUSPENDED')).toBe(true)
    } finally {
      db.close()
    }
  })

  it('adds, pairs, rotates, health-checks and binds a Telegram Bot storage connection without retaining the plaintext token', async () => {
    const db = new SqliteD1()
    const firstToken = 'test-token-one-not-a-real-telegram-secret'
    const rotatedToken = 'test-token-two-not-a-real-telegram-secret'
    let pairCode = ''
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/getMe')) {
        const rotated = url.includes(rotatedToken)
        return new Response(JSON.stringify({
          ok: true,
          result: {
            id: rotated ? 987654321 : 123456789,
            is_bot: true,
            first_name: rotated ? 'ExcelSync Bot Rotated' : 'ExcelSync Bot',
            username: rotated ? 'excelsync_rotated_bot' : 'excelsync_test_bot'
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/getChat')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { id: -1001234567890, type: 'supergroup', title: 'ExcelSync Storage Test' }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/getUpdates')) {
        return new Response(JSON.stringify({
          ok: true,
          result: pairCode ? [{
            update_id: 1001,
            message: {
              message_id: 55,
              text: `/start ${pairCode}`,
              chat: { id: -1001234567890, type: 'supergroup', title: 'ExcelSync Storage Test' }
            }
          }] : []
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected Telegram request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      applyMigrations(db)
      const nonce = 'enterprise-storage-bootstrap-nonce-123456789'
      db.database.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES ('setup_nonce_hash',?,datetime('now'))").run(await sha256Text(nonce))
      const env = {
        DB: db,
        RETENTION_LIMIT: '20',
        SESSION_TTL_SECONDS: '2592000',
        STORAGE_MASTER_KEY: 'enterprise-storage-master-key-123456789012345',
        CLIENT_LATEST_VERSION: '1.4.1',
        CLIENT_MINIMUM_VERSION: '1.3.1',
        CLIENT_ROLLOUT_PERCENT: '100',
        API_VERSION: '2026-08-31'
      } as unknown as Env

      expect((await request(env, '/auth/bootstrap', {
        method: 'POST', headers: { 'x-setup-nonce': nonce },
        body: { username: 'storage-owner', displayName: 'Storage Owner', password: 'storage-owner-password-12345', organizationName: 'Storage Org' }
      })).status).toBe(201)
      const login = await json<{ token: string; defaultWorkspaceId: string }>(await request(env, '/auth/login', {
        method: 'POST', body: { username: 'storage-owner', password: 'storage-owner-password-12345' }
      }))

      const createResponse = await request(env, '/admin/storage-connections', {
        method: 'POST', token: login.token, body: { name: 'Primary Telegram Bot', botToken: firstToken }
      })
      expect(createResponse.status).toBe(201)
      const created = await json<{ id: string; botUsername: string | null; botName: string | null; status: string }>(createResponse)
      expect(created.botUsername).toBe('excelsync_test_bot')
      expect(created.botName).toBe('ExcelSync Bot')
      expect(created.status).toBe('DEGRADED')

      const credential = db.database.prepare('SELECT credential_ciphertext, credential_iv, credential_source, chat_id, status FROM storage_connections WHERE id = ?').get(created.id) as {
        credential_ciphertext: string; credential_iv: string; credential_source: string; chat_id: string | null; status: string
      }
      expect(credential.credential_ciphertext).not.toContain(firstToken)
      expect(credential.credential_iv.length).toBeGreaterThan(8)
      expect(credential.credential_source).toBe('ENCRYPTED')
      expect(credential.chat_id).toBeNull()
      expect(credential.status).toBe('DEGRADED')

      const pairStart = await json<{ code: string; deepLink: string }>(await request(env, `/admin/storage-connections/${created.id}/pair/start`, {
        method: 'POST', token: login.token
      }))
      pairCode = pairStart.code
      expect(pairCode).toMatch(/^PAIR-/)
      expect(pairStart.deepLink).toContain('excelsync_test_bot')

      const pairConfirm = await request(env, `/admin/storage-connections/${created.id}/pair/confirm`, { method: 'POST', token: login.token })
      expect(pairConfirm.status).toBe(200)
      expect(await json<{ chatId: string; chatTitle: string }>(pairConfirm)).toMatchObject({
        chatId: '-1001234567890', chatTitle: 'ExcelSync Storage Test'
      })

      expect((await request(env, `/workspaces/${login.defaultWorkspaceId}/default-storage`, {
        method: 'PUT', token: login.token, body: { storageConnectionId: created.id }
      })).status).toBe(200)
      const workspace = db.database.prepare('SELECT default_storage_connection_id AS id FROM workspaces WHERE id = ?').get(login.defaultWorkspaceId) as { id: string | null }
      expect(workspace.id).toBe(created.id)

      const rotateResponse = await request(env, `/admin/storage-connections/${created.id}/token`, {
        method: 'PUT', token: login.token, body: { botToken: rotatedToken }
      })
      expect(rotateResponse.status).toBe(200)
      expect(await json<{ botUsername: string | null }>(rotateResponse)).toMatchObject({ botUsername: 'excelsync_rotated_bot' })
      const rotatedCredential = db.database.prepare('SELECT credential_ciphertext, telegram_bot_id, telegram_bot_username, status FROM storage_connections WHERE id = ?').get(created.id) as {
        credential_ciphertext: string; telegram_bot_id: string; telegram_bot_username: string; status: string
      }
      expect(rotatedCredential.credential_ciphertext).not.toContain(rotatedToken)
      expect(rotatedCredential.telegram_bot_id).toBe('987654321')
      expect(rotatedCredential.telegram_bot_username).toBe('excelsync_rotated_bot')
      expect(rotatedCredential.status).toBe('ACTIVE')

      const health = await json<{ connections: Array<{ id: string; status: string; reachable: boolean }> }>(await request(env, '/admin/storage-health', {
        method: 'POST', token: login.token
      }))
      expect(health.connections.find((row) => row.id === created.id)).toMatchObject({ status: 'ACTIVE', reachable: true })

      const disableWhileInUse = await request(env, `/admin/storage-connections/${created.id}/disable`, { method: 'POST', token: login.token })
      expect(disableWhileInUse.status).toBe(409)

      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/getMe'))).toBe(true)
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/getUpdates'))).toBe(true)
    } finally {
      vi.unstubAllGlobals()
      db.close()
    }
  })

  it('rejects an unrelated private /start during legacy Telegram pairing and accepts only the exact code', async () => {
    const db = new SqliteD1()
    const botToken = 'legacy-pair-test-token-not-a-real-secret'
    let payload = 'UNRELATED-CODE'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/getMe')) {
        return new Response(JSON.stringify({ ok: true, result: { id: 12345, is_bot: true, first_name: 'Legacy Pair Bot', username: 'legacy_pair_test_bot' } }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      if (url.includes('/getUpdates')) {
        return new Response(JSON.stringify({
          ok: true,
          result: [{
            update_id: 77,
            message: { message_id: 8, text: `/start ${payload}`, chat: { id: 424242, type: 'private', first_name: 'Pair User' } }
          }]
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected Telegram request: ${url}`)
    }))
    try {
      applyMigrations(db)
      const nonce = 'legacy-pair-bootstrap-nonce-123456789'
      db.database.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES ('setup_nonce_hash',?,datetime('now'))").run(await sha256Text(nonce))
      const env = {
        DB: db,
        RETENTION_LIMIT: '20',
        SESSION_TTL_SECONDS: '2592000',
        STORAGE_MASTER_KEY: 'legacy-pair-master-key-123456789012345678',
        TELEGRAM_BOT_TOKEN: botToken
      } as unknown as Env
      expect((await request(env, '/auth/bootstrap', {
        method: 'POST', headers: { 'x-setup-nonce': nonce },
        body: { username: 'legacy-owner', displayName: 'Legacy Owner', password: 'legacy-owner-password-12345', organizationName: 'Legacy Pair Org' }
      })).status).toBe(201)
      const login = await json<{ token: string }>(await request(env, '/auth/login', {
        method: 'POST', body: { username: 'legacy-owner', password: 'legacy-owner-password-12345' }
      }))
      const start = await json<{ code: string }>(await request(env, '/storage/pair/start', { method: 'POST', token: login.token }))
      expect(start.code.length).toBeGreaterThan(8)

      const unrelated = await request(env, '/storage/pair/confirm', { method: 'POST', token: login.token })
      expect(unrelated.status).toBe(404)
      const before = db.database.prepare("SELECT chat_id FROM storage_config WHERE provider='telegram'").get() as { chat_id: string | null }
      expect(before.chat_id).toBeNull()

      payload = start.code
      const exact = await request(env, '/storage/pair/confirm', { method: 'POST', token: login.token })
      expect(exact.status).toBe(200)
      const after = db.database.prepare("SELECT chat_id FROM storage_config WHERE provider='telegram'").get() as { chat_id: string | null }
      expect(after.chat_id).toBe('424242')
    } finally {
      vi.unstubAllGlobals()
      db.close()
    }
  })

  it('covers device sessions, external accounts, group ACL, presence and self force-logout', async () => {
    const db = new SqliteD1()
    try {
      applyMigrations(db)
      const nonce = 'enterprise-14-bootstrap-nonce-123456789'
      db.database.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES ('setup_nonce_hash',?,datetime('now'))").run(await sha256Text(nonce))
      const env = {
        DB: db,
        RETENTION_LIMIT: '20',
        SESSION_TTL_SECONDS: '2592000',
        STORAGE_MASTER_KEY: 'enterprise-14-storage-master-key-123456789012345',
        CLIENT_LATEST_VERSION: '1.4.0',
        CLIENT_MINIMUM_VERSION: '1.3.1',
        CLIENT_ROLLOUT_PERCENT: '100',
        API_VERSION: '2026-08-31'
      } as unknown as Env

      expect((await request(env, '/auth/bootstrap', {
        method: 'POST',
        headers: { 'x-setup-nonce': nonce },
        body: { username: 'owner14', displayName: 'Owner 14', password: 'owner14-password-12345' }
      })).status).toBe(201)

      const ownerDevice = {
        stableDeviceId: '11111111-1111-4111-8111-111111111111',
        deviceName: 'Owner-PC',
        osName: 'Windows',
        osVersion: '11',
        clientVersion: '1.4.0'
      }
      const owner = await json<{ token: string; deviceId: string; user: { id: string }; defaultWorkspaceId: string }>(await request(env, '/auth/login', {
        method: 'POST', body: { username: 'owner14', password: 'owner14-password-12345', device: ownerDevice }
      }))
      expect(owner.deviceId).toMatch(/[0-9a-f-]{36}/i)
      const ownerDevices = await json<{ devices: Array<{ id: string; current: boolean; activeSessions: number }> }>(await request(env, '/auth/devices', { token: owner.token }))
      expect(ownerDevices.devices).toHaveLength(1)
      expect(ownerDevices.devices[0]?.current).toBe(true)
      expect(ownerDevices.devices[0]?.activeSessions).toBe(1)

      const versionInfo = await json<{ latest: string; minimum: string; updateAvailable: boolean; updateRequired: boolean }>(await request(
        env,
        `/client/version?current=1.3.1&device=${ownerDevice.stableDeviceId}`
      ))
      expect(versionInfo).toMatchObject({ latest: '1.4.0', minimum: '1.3.1', updateAvailable: true, updateRequired: false })

      const workspaceId = owner.defaultWorkspaceId
      const fileOneResponse = await request(env, '/sync/preflight', {
        method: 'POST', token: owner.token,
        body: { workspaceId, logicalName: 'group-one.xlsx', relativePath: 'Shared/group-one.xlsx', hash: '1'.repeat(64), size: 128, baseVersion: 0, idempotencyKey: 'group-one-preflight-0001' }
      })
      const fileTwoResponse = await request(env, '/sync/preflight', {
        method: 'POST', token: owner.token,
        body: { workspaceId, logicalName: 'group-two.xlsx', relativePath: 'Private/group-two.xlsx', hash: '2'.repeat(64), size: 128, baseVersion: 0, idempotencyKey: 'group-two-preflight-0002' }
      })
      expect(fileOneResponse.status).toBe(201)
      expect(fileTwoResponse.status).toBe(201)
      const fileOne = await json<{ fileId: string }>(fileOneResponse)
      const fileTwo = await json<{ fileId: string }>(fileTwoResponse)

      const forbiddenExternalManager = await request(env, '/admin/invites', {
        method: 'POST', token: owner.token,
        body: {
          username: 'external-manager', displayName: 'External Manager', workspaceId, workspaceRole: 'MANAGER',
          accountType: 'EXTERNAL', expiresInHours: 24
        }
      })
      expect(forbiddenExternalManager.status).toBe(400)

      const userExpiresAt = new Date(Date.now() + 24 * 3600_000).toISOString()
      const inviteResponse = await request(env, '/admin/invites', {
        method: 'POST', token: owner.token,
        body: {
          username: 'external-viewer', displayName: 'External Viewer', workspaceId, workspaceRole: 'VIEWER',
          accountType: 'EXTERNAL', userExpiresAt, expiresInHours: 24
        }
      })
      expect(inviteResponse.status).toBe(201)
      const invite = await json<{ code: string }>(inviteResponse)
      const externalDevice = {
        stableDeviceId: '22222222-2222-4222-8222-222222222222',
        deviceName: 'Audit-Laptop',
        osName: 'Windows',
        osVersion: '11',
        clientVersion: '1.4.0'
      }
      const external = await json<{ token: string; deviceId: string; user: { id: string; accountType: string; accessExpiresAt: string | null } }>(await request(env, '/auth/activate', {
        method: 'POST', body: { code: invite.code, password: 'external-password-12345', device: externalDevice }
      }))
      expect(external.user.accountType).toBe('EXTERNAL')
      expect(external.user.accessExpiresAt).toBe(userExpiresAt)

      db.database.prepare("DELETE FROM resource_access_rules WHERE principal_type = 'USER' AND principal_id = ?").run(external.user.id)
      const groupResponse = await request(env, '/admin/groups', { method: 'POST', token: owner.token, body: { name: 'External Audit' } })
      expect(groupResponse.status).toBe(201)
      const group = await json<{ id: string }>(groupResponse)
      expect((await request(env, `/admin/groups/${group.id}/members`, {
        method: 'PUT', token: owner.token, body: { userIds: [external.user.id] }
      })).status).toBe(200)
      expect((await request(env, `/workspaces/${workspaceId}/group-access/${group.id}`, {
        method: 'PUT', token: owner.token,
        body: { permission: 'VIEW', scopes: [{ scopeType: 'FILE', scopeValue: fileOne.fileId }] }
      })).status).toBe(200)

      const externalFiles = await json<{ files: Array<{ id: string }> }>(await request(env, '/files/list', { token: external.token }))
      expect(externalFiles.files.map((row) => row.id)).toContain(fileOne.fileId)
      expect(externalFiles.files.map((row) => row.id)).not.toContain(fileTwo.fileId)
      const access = await json<{ rules: unknown[]; inheritedRules: Array<{ group_name: string; scope_value: string }> }>(await request(
        env,
        `/workspaces/${workspaceId}/resource-access/${external.user.id}`,
        { token: owner.token }
      ))
      expect(access.rules).toHaveLength(0)
      expect(access.inheritedRules.some((rule) => rule.group_name === 'External Audit' && rule.scope_value === fileOne.fileId)).toBe(true)

      expect((await request(env, `/files/${fileOne.fileId}/presence`, {
        method: 'PUT', token: external.token, body: { state: 'OPEN' }
      })).status).toBe(200)
      expect((await request(env, `/files/${fileOne.fileId}/presence`, {
        method: 'PUT', token: owner.token, body: { state: 'EDITING' }
      })).status).toBe(200)
      const presence = await json<{ activeUserCount: number; editingUserCount: number; entries: Array<{ displayName: string; state: string }> }>(await request(
        env,
        `/files/${fileOne.fileId}/presence`,
        { token: owner.token }
      ))
      expect(presence.activeUserCount).toBe(2)
      expect(presence.editingUserCount).toBe(1)
      expect(presence.entries.some((entry) => entry.displayName === 'External Viewer' && entry.state === 'OPEN')).toBe(true)
      expect(presence.entries.some((entry) => entry.displayName === 'Owner 14' && entry.state === 'EDITING')).toBe(true)
      expect((await request(env, `/files/${fileOne.fileId}/presence`, {
        method: 'PUT', token: external.token, body: { state: 'EDITING' }
      })).status).toBe(404)

      expect((await request(env, `/workspaces/${workspaceId}/members`, {
        method: 'PUT', token: owner.token, body: { userId: external.user.id, role: 'EDITOR' }
      })).status).toBe(200)
      expect((await request(env, `/workspaces/${workspaceId}/group-access/${group.id}`, {
        method: 'PUT', token: owner.token,
        body: { permission: 'EDIT', scopes: [{ scopeType: 'FOLDER', scopeValue: 'Shared' }] }
      })).status).toBe(200)
      expect((await request(env, '/sync/preflight', {
        method: 'POST', token: external.token,
        body: { workspaceId, logicalName: 'external-ok.xlsx', relativePath: 'Shared/external-ok.xlsx', hash: '3'.repeat(64), size: 128, baseVersion: 0, idempotencyKey: 'external-group-edit-0001' }
      })).status).toBe(201)
      expect((await request(env, '/sync/preflight', {
        method: 'POST', token: external.token,
        body: { workspaceId, logicalName: 'external-denied.xlsx', relativePath: 'Private/external-denied.xlsx', hash: '4'.repeat(64), size: 128, baseVersion: 0, idempotencyKey: 'external-group-edit-0002' }
      })).status).toBe(403)

      const selfLogout = await request(env, `/admin/users/${owner.user.id}/force-logout`, { method: 'POST', token: owner.token })
      expect(selfLogout.status).toBe(200)
      expect((await request(env, '/auth/me', { token: owner.token })).status).toBe(401)

      const ownerRelogin = await json<{ token: string }>(await request(env, '/auth/login', {
        method: 'POST', body: { username: 'owner14', password: 'owner14-password-12345', device: ownerDevice }
      }))
      const externalDevices = await json<{ devices: Array<{ deviceName: string }> }>(await request(env, `/admin/users/${external.user.id}/devices`, { token: ownerRelogin.token }))
      expect(externalDevices.devices.map((device) => device.deviceName)).toContain('Audit-Laptop')
      expect((await request(env, `/admin/users/${owner.user.id}/account-policy`, {
        method: 'PATCH', token: ownerRelogin.token, body: { accountType: 'EXTERNAL', accessExpiresAt: null }
      })).status).toBe(400)
      const extendedExpiry = new Date(Date.now() + 48 * 3600_000).toISOString()
      expect((await request(env, `/admin/users/${external.user.id}/account-policy`, {
        method: 'PATCH', token: ownerRelogin.token, body: { accountType: 'EXTERNAL', accessExpiresAt: extendedExpiry }
      })).status).toBe(200)
      const usersAfterPolicy = await json<{ users: Array<{ id: string; account_type: string; access_expires_at: string | null }> }>(await request(env, '/admin/users', { token: ownerRelogin.token }))
      expect(usersAfterPolicy.users.find((row) => row.id === external.user.id)).toMatchObject({ account_type: 'EXTERNAL', access_expires_at: extendedExpiry })

      db.database.prepare("UPDATE users SET access_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), external.user.id)
      expect((await request(env, '/auth/me', { token: external.token })).status).toBe(401)
      const expired = db.database.prepare('SELECT lifecycle_status, status FROM users WHERE id = ?').get(external.user.id) as { lifecycle_status: string; status: string }
      expect(expired).toMatchObject({ lifecycle_status: 'SUSPENDED', status: 'disabled' })

      const secondaryDevice = {
        stableDeviceId: '33333333-3333-4333-8333-333333333333',
        deviceName: 'Owner-Laptop',
        osName: 'Windows',
        osVersion: '11',
        clientVersion: '1.4.0'
      }
      const secondaryLogin = await json<{ token: string }>(await request(env, '/auth/login', {
        method: 'POST', body: { username: 'owner14', password: 'owner14-password-12345', device: secondaryDevice }
      }))
      expect((await request(env, '/auth/me', { token: ownerRelogin.token })).status).toBe(200)
      expect((await request(env, '/auth/me', { token: secondaryLogin.token })).status).toBe(200)

      const logoutOther = await request(env, '/auth/logout-other-devices', { method: 'POST', token: ownerRelogin.token })
      expect(logoutOther.status).toBe(200)
      expect((await request(env, '/auth/me', { token: ownerRelogin.token })).status).toBe(200)
      expect((await request(env, '/auth/me', { token: secondaryLogin.token })).status).toBe(401)

      const secondaryRelogin = await json<{ token: string }>(await request(env, '/auth/login', {
        method: 'POST', body: { username: 'owner14', password: 'owner14-password-12345', device: secondaryDevice }
      }))
      const logoutAll = await request(env, '/auth/logout-all-devices', { method: 'POST', token: ownerRelogin.token })
      expect(logoutAll.status).toBe(200)
      expect((await request(env, '/auth/me', { token: ownerRelogin.token })).status).toBe(401)
      expect((await request(env, '/auth/me', { token: secondaryRelogin.token })).status).toBe(401)
    } finally {
      db.close()
    }
  })
})
