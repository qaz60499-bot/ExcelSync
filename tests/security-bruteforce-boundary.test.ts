import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { appFetch } from '../worker/src/index'
import { sha256Text } from '../worker/src/auth'
import { activateInvite } from '../worker/src/enterprise'

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

async function request(
  env: Env,
  path: string,
  options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string } = {}
): Promise<Response> {
  const headers = new Headers(options.headers)
  if (options.token) headers.set('authorization', `Bearer ${options.token}`)
  let body: string | undefined = options.rawBody
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(options.body)
  }
  return appFetch(new Request(`https://excel-sync.test${path}`, { method: options.method ?? 'GET', headers, body }), env as never)
}

async function bootstrapOwner(): Promise<{ db: SqliteD1; env: Env; ownerToken: string; workspaceId: string }> {
  const db = new SqliteD1()
  applyMigrations(db)
  const nonce = 'security-bruteforce-bootstrap-nonce-123456789'
  db.database.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES ('setup_nonce_hash',?,datetime('now'))")
    .run(await sha256Text(nonce))
  const env = { DB: db, RETENTION_LIMIT: '20', SESSION_TTL_SECONDS: '2592000' } as unknown as Env
  expect((await request(env, '/auth/bootstrap', {
    method: 'POST',
    headers: { 'x-setup-nonce': nonce },
    body: { username: 'owner', password: 'owner-password-12345' }
  })).status).toBe(201)
  const login = await request(env, '/auth/login', {
    method: 'POST',
    headers: { 'cf-connecting-ip': '198.51.100.1' },
    body: { username: 'owner', password: 'owner-password-12345' }
  })
  expect(login.status).toBe(200)
  const payload = await login.json() as { token: string; defaultWorkspaceId: string }
  return { db, env, ownerToken: payload.token, workspaceId: payload.defaultWorkspaceId }
}

describe('security brute-force and boundary probes', () => {
  it('blocks account password spraying even when the attacker rotates source IPs', async () => {
    const { db, env } = await bootstrapOwner()
    try {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const response = await request(env, '/auth/login', {
          method: 'POST',
          headers: { 'cf-connecting-ip': `203.0.113.${attempt}` },
          body: { username: 'owner', password: `wrong-password-${attempt}` }
        })
        expect(response.status, `attempt ${attempt}`).toBe(401)
      }
      const sixth = await request(env, '/auth/login', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.6' },
        body: { username: 'owner', password: 'wrong-password-6' }
      })
      expect(sixth.status).toBe(429)
      const correctFromFreshIp = await request(env, '/auth/login', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.200' },
        body: { username: 'owner', password: 'owner-password-12345' }
      })
      expect(correctFromFreshIp.status).toBe(429)
    } finally {
      db.close()
    }
  }, 20_000)

  it('still blocks an account after a concurrent burst of wrong passwords', async () => {
    const { db, env } = await bootstrapOwner()
    try {
      const burst = await Promise.all(Array.from({ length: 12 }, (_, index) => request(env, '/auth/login', {
        method: 'POST',
        headers: { 'cf-connecting-ip': `203.0.113.${100 + index}` },
        body: { username: 'owner', password: `parallel-wrong-${index}` }
      })))
      expect(burst.every((response) => response.status === 401 || response.status === 429)).toBe(true)
      const correctAfterBurst = await request(env, '/auth/login', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.250' },
        body: { username: 'owner', password: 'owner-password-12345' }
      })
      expect(correctAfterBurst.status).toBe(429)
    } finally {
      db.close()
    }
  }, 20_000)

  it('blocks source-IP username spraying after the IP threshold', async () => {
    const { db, env } = await bootstrapOwner()
    try {
      for (let attempt = 1; attempt <= 29; attempt += 1) {
        const response = await request(env, '/auth/login', {
          method: 'POST',
          headers: { 'cf-connecting-ip': '192.0.2.77' },
          body: { username: `ghost${attempt}`, password: 'definitely-wrong' }
        })
        expect(response.status, `attempt ${attempt}`).toBe(401)
      }
      const thirtieth = await request(env, '/auth/login', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '192.0.2.77' },
        body: { username: 'ghost30', password: 'definitely-wrong' }
      })
      expect(thirtieth.status).toBe(429)
      const validFromBlockedIp = await request(env, '/auth/login', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '192.0.2.77' },
        body: { username: 'owner', password: 'owner-password-12345' }
      })
      expect(validFromBlockedIp.status).toBe(429)
    } finally {
      db.close()
    }
  }, 30_000)

  it('activates a valid invite through the enterprise handler', async () => {
    const { db, env, ownerToken } = await bootstrapOwner()
    try {
      const inviteResponse = await request(env, '/admin/invites', {
        method: 'POST',
        token: ownerToken,
        body: {
          username: 'directinvite',
          displayName: 'Direct Invite',
          workspaceId: '00000000-0000-4000-8000-000000000002',
          workspaceRole: 'VIEWER',
          expiresInHours: 24
        }
      })
      expect(inviteResponse.status).toBe(201)
      const invite = await inviteResponse.json() as { code: string }
      const directRequest = new Request('https://excel-sync.test/auth/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.70' },
        body: JSON.stringify({ code: invite.code, password: 'direct-invite-password-12345' })
      })
      const activated = await activateInvite(directRequest, env as never)
      expect(activated.user.username).toBe('directinvite')
    } finally {
      db.close()
    }
  }, 20_000)

  it('rate-limits online invite-code guessing by source IP', async () => {
    const { db, env, ownerToken } = await bootstrapOwner()
    try {
      const inviteResponse = await request(env, '/admin/invites', {
        method: 'POST',
        token: ownerToken,
        body: {
          username: 'invitee1',
          displayName: 'Invitee 1',
          workspaceId: '00000000-0000-4000-8000-000000000002',
          workspaceRole: 'VIEWER',
          expiresInHours: 24
        }
      })
      expect(inviteResponse.status).toBe(201)
      const invite = await inviteResponse.json() as { code: string }

      for (let attempt = 1; attempt <= 11; attempt += 1) {
        const response = await request(env, '/auth/activate', {
          method: 'POST',
          headers: { 'cf-connecting-ip': '198.51.100.88' },
          body: { code: `XS-AAAA-${String(attempt).padStart(4, '0')}`, password: 'invitee-password-12345' }
        })
        expect(response.status, `attempt ${attempt}`).toBe(400)
      }
      const blocked = await request(env, '/auth/activate', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '198.51.100.88' },
        body: { code: 'XS-BBBB-0012', password: 'invitee-password-12345' }
      })
      expect(blocked.status).toBe(429)

      const validButBlocked = await request(env, '/auth/activate', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '198.51.100.88' },
        body: { code: invite.code, password: 'invitee-password-12345' }
      })
      expect(validButBlocked.status).toBe(429)

      const validFromFreshIp = await request(env, '/auth/activate', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '198.51.100.89' },
        body: { code: invite.code, password: 'invitee-password-12345' }
      })
      expect(validFromFreshIp.status).toBe(200)
    } finally {
      db.close()
    }
  }, 20_000)

  it('blocks ordinary members from Owner/Admin storage and control-plane endpoints', async () => {
    const { db, env, ownerToken } = await bootstrapOwner()
    try {
      const inviteResponse = await request(env, '/admin/invites', {
        method: 'POST', token: ownerToken,
        body: {
          username: 'boundarymember', displayName: 'Boundary Member',
          workspaceId: '00000000-0000-4000-8000-000000000002', workspaceRole: 'VIEWER', expiresInHours: 24
        }
      })
      expect(inviteResponse.status).toBe(201)
      const invite = await inviteResponse.json() as { code: string }
      const activated = await request(env, '/auth/activate', {
        method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.91' },
        body: { code: invite.code, password: 'boundary-member-password-12345' }
      })
      expect(activated.status).toBe(200)
      const member = await activated.json() as { token: string }

      const probes: Array<Promise<Response>> = [
        request(env, '/admin/users', { token: member.token }),
        request(env, '/admin/invites', { token: member.token }),
        request(env, '/admin/storage-connections', { token: member.token }),
        request(env, '/admin/system-status', { token: member.token }),
        request(env, '/admin/version-integrity', { token: member.token }),
        request(env, '/admin/active-locks', { token: member.token }),
        request(env, '/storage/pair/start', { method: 'POST', token: member.token }),
        request(env, '/storage/pair/confirm', { method: 'POST', token: member.token }),
        request(env, '/admin/storage-connections', {
          method: 'POST', token: member.token,
          body: { name: 'Should Not Create', botToken: 'not-a-real-telegram-token-value' }
        })
      ]
      const responses = await Promise.all(probes)
      for (const response of responses) expect(response.status).toBe(403)
      expect((db.database.prepare("SELECT COUNT(*) AS count FROM storage_connections WHERE name='Should Not Create'").get() as { count: number }).count).toBe(0)
    } finally {
      db.close()
    }
  }, 20_000)

  it('rejects a forged-session token flood without creating or mutating sessions', async () => {
    const { db, env } = await bootstrapOwner()
    try {
      const before = (db.database.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count
      for (let index = 0; index < 256; index += 1) {
        const forged = `${index.toString(16).padStart(8, '0')}${'f'.repeat(56)}`
        const response = await request(env, '/files/list', { token: forged })
        expect(response.status, `forged token ${index}`).toBe(401)
      }
      const after = (db.database.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count
      expect(after).toBe(before)
    } finally {
      db.close()
    }
  }, 20_000)

  it('returns controlled 4xx responses for malformed activation payloads', async () => {
    const invalidJson = await request({} as Env, '/auth/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: '{'
    })
    expect(invalidJson.status).toBe(400)

    const wrongContentType = await request({} as Env, '/auth/activate', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      rawBody: JSON.stringify({ code: 'XS-AAAA-BBBB', password: 'invitee-password-12345' })
    })
    expect(wrongContentType.status).toBe(415)
  })

  it('replays a create preflight with the same idempotency key instead of conflicting with its own reserved file', async () => {
    const { db, env, ownerToken, workspaceId } = await bootstrapOwner()
    try {
      const body = {
        workspaceId,
        logicalName: 'idempotent-retry.xlsx',
        relativePath: 'Retries/idempotent-retry.xlsx',
        hash: '7'.repeat(64),
        size: 2048,
        baseVersion: 0,
        idempotencyKey: 'security-idempotent-create-retry-0001',
        storageBackend: 'telegram_user_group' as const
      }
      const first = await request(env, '/sync/preflight', { method: 'POST', token: ownerToken, body })
      expect(first.status).toBe(201)
      const firstPayload = await first.json() as { fileId: string; intentId: string; action: string }
      expect(firstPayload.action).toBe('upload_required')

      const replay = await request(env, '/sync/preflight', { method: 'POST', token: ownerToken, body })
      expect(replay.status).toBe(200)
      const replayPayload = await replay.json() as { fileId: string; intentId: string; action: string }
      expect(replayPayload).toMatchObject({
        action: 'upload_required',
        fileId: firstPayload.fileId,
        intentId: firstPayload.intentId
      })
      expect((db.database.prepare('SELECT COUNT(*) AS count FROM files WHERE relative_path = ?').get(body.relativePath) as { count: number }).count).toBe(1)
      expect((db.database.prepare('SELECT COUNT(*) AS count FROM upload_intents WHERE owner_user_id = (SELECT id FROM users WHERE username = ?) AND idempotency_key = ?').get('owner', body.idempotencyKey) as { count: number }).count).toBe(1)
    } finally {
      db.close()
    }
  })

  it('keeps upload receipt and commit state transitions idempotent and rejects out-of-order transitions', async () => {
    const { db, env, ownerToken, workspaceId } = await bootstrapOwner()
    try {
      const hash = '8'.repeat(64)
      const preflight = await request(env, '/sync/preflight', {
        method: 'POST', token: ownerToken,
        body: {
          workspaceId,
          logicalName: 'state-machine.xlsx',
          relativePath: 'State/state-machine.xlsx',
          hash,
          size: 4096,
          baseVersion: 0,
          idempotencyKey: 'security-state-machine-0001',
          storageBackend: 'telegram_user_group'
        }
      })
      expect(preflight.status).toBe(201)
      const reserved = await preflight.json() as { fileId: string; intentId: string }

      const prematureCommit = await request(env, '/sync/commit', {
        method: 'POST', token: ownerToken, body: { intentId: reserved.intentId }
      })
      expect(prematureCommit.status).toBe(409)

      const wrongReceipt = await request(env, '/sync/upload-receipt', {
        method: 'POST', token: ownerToken,
        body: {
          intentId: reserved.intentId,
          receipt: {
            backend: 'telegram_user_group',
            chatId: '-100777',
            messageId: 7001,
            fileName: 'state-machine.xlsx',
            size: 4097,
            sha256: hash,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            createdAt: new Date().toISOString()
          }
        }
      })
      expect(wrongReceipt.status).toBe(409)
      expect((db.database.prepare('SELECT status FROM upload_intents WHERE id=?').get(reserved.intentId) as { status: string }).status).toBe('reserved')

      const receiptBody = {
        intentId: reserved.intentId,
        receipt: {
          backend: 'telegram_user_group' as const,
          chatId: '-100777',
          messageId: 7001,
          fileName: 'state-machine.xlsx',
          size: 4096,
          sha256: hash,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          createdAt: new Date().toISOString()
        }
      }
      expect((await request(env, '/sync/upload-receipt', { method: 'POST', token: ownerToken, body: receiptBody })).status).toBe(200)
      expect((await request(env, '/sync/upload-receipt', { method: 'POST', token: ownerToken, body: receiptBody })).status).toBe(200)

      const firstCommit = await request(env, '/sync/commit', {
        method: 'POST', token: ownerToken, body: { intentId: reserved.intentId }
      })
      expect(firstCommit.status).toBe(200)
      const secondCommit = await request(env, '/sync/commit', {
        method: 'POST', token: ownerToken, body: { intentId: reserved.intentId }
      })
      expect(secondCommit.status).toBe(200)

      expect((db.database.prepare('SELECT current_version FROM files WHERE id=?').get(reserved.fileId) as { current_version: number }).current_version).toBe(1)
      expect((db.database.prepare('SELECT COUNT(*) AS count FROM file_versions WHERE file_id=?').get(reserved.fileId) as { count: number }).count).toBe(1)
      expect((db.database.prepare('SELECT status FROM upload_intents WHERE id=?').get(reserved.intentId) as { status: string }).status).toBe('committed')
    } finally {
      db.close()
    }
  })

  it('never creates duplicate versions during a concurrent commit burst', async () => {
    const { db, env, ownerToken, workspaceId } = await bootstrapOwner()
    try {
      const hash = '9'.repeat(64)
      const preflight = await request(env, '/sync/preflight', {
        method: 'POST', token: ownerToken,
        body: {
          workspaceId,
          logicalName: 'concurrent-commit.xlsx',
          relativePath: 'State/concurrent-commit.xlsx',
          hash,
          size: 8192,
          baseVersion: 0,
          idempotencyKey: 'security-concurrent-commit-0001',
          storageBackend: 'telegram_user_group'
        }
      })
      expect(preflight.status).toBe(201)
      const reserved = await preflight.json() as { fileId: string; intentId: string }
      expect((await request(env, '/sync/upload-receipt', {
        method: 'POST', token: ownerToken,
        body: {
          intentId: reserved.intentId,
          receipt: {
            backend: 'telegram_user_group', chatId: '-100888', messageId: 8001,
            fileName: 'concurrent-commit.xlsx', size: 8192, sha256: hash,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            createdAt: new Date().toISOString()
          }
        }
      })).status).toBe(200)

      const burst = await Promise.all(Array.from({ length: 12 }, () => request(env, '/sync/commit', {
        method: 'POST', token: ownerToken, body: { intentId: reserved.intentId }
      })))
      expect(burst.some((response) => response.status === 200)).toBe(true)
      expect(burst.every((response) => response.status === 200 || response.status === 409)).toBe(true)
      expect((db.database.prepare('SELECT current_version FROM files WHERE id=?').get(reserved.fileId) as { current_version: number }).current_version).toBe(1)
      expect((db.database.prepare('SELECT COUNT(*) AS count FROM file_versions WHERE file_id=?').get(reserved.fileId) as { count: number }).count).toBe(1)
    } finally {
      db.close()
    }
  }, 20_000)

  it('keeps concurrent duplicate preflight requests controlled and converges on one file and intent', async () => {
    const { db, env, ownerToken, workspaceId } = await bootstrapOwner()
    try {
      const body = {
        workspaceId,
        logicalName: 'concurrent-preflight.xlsx',
        relativePath: 'State/concurrent-preflight.xlsx',
        hash: 'a'.repeat(64),
        size: 16384,
        baseVersion: 0,
        idempotencyKey: 'security-concurrent-preflight-0001',
        storageBackend: 'telegram_user_group' as const
      }
      const burst = await Promise.all(Array.from({ length: 12 }, () => request(env, '/sync/preflight', {
        method: 'POST', token: ownerToken, body
      })))
      expect(burst.some((response) => response.status === 201 || response.status === 200)).toBe(true)
      expect(burst.every((response) => response.status >= 200 && response.status < 500)).toBe(true)
      expect((db.database.prepare('SELECT COUNT(*) AS count FROM files WHERE relative_path=?').get(body.relativePath) as { count: number }).count).toBe(1)
      expect((db.database.prepare('SELECT COUNT(*) AS count FROM upload_intents WHERE idempotency_key=?').get(body.idempotencyKey) as { count: number }).count).toBe(1)

      const retry = await request(env, '/sync/preflight', { method: 'POST', token: ownerToken, body })
      expect(retry.status).toBe(200)
    } finally {
      db.close()
    }
  }, 20_000)

  it('rejects Windows-dangerous Worker relative paths before any file record is created', async () => {
    const { db, env, ownerToken, workspaceId } = await bootstrapOwner()
    try {
      const before = (db.database.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number }).count
      const dangerousPaths = [
        'C:/outside/escape.xlsx',
        'Shared/report.xlsx:hidden',
        'Shared/CON.xlsx',
        'Shared/NUL.xlsx',
        'Shared/trailing-dot.xlsx.',
        'Shared/trailing-space.xlsx '
      ]
      for (const [index, relativePath] of dangerousPaths.entries()) {
        const response = await request(env, '/sync/preflight', {
          method: 'POST',
          token: ownerToken,
          body: {
            workspaceId,
            logicalName: 'escape.xlsx',
            relativePath,
            hash: 'a'.repeat(64),
            size: 1024,
            baseVersion: 0,
            idempotencyKey: `windows-path-boundary-${String(index).padStart(4, '0')}`,
            storageBackend: 'telegram_user_group'
          }
        })
        expect(response.status, relativePath).toBe(400)
      }
      const after = (db.database.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number }).count
      expect(after).toBe(before)
    } finally {
      db.close()
    }
  })
})
