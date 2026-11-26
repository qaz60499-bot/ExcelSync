import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appFetch } from '../worker/src/index'
import { sha256Hex, sha256Text } from '../worker/src/auth'
import {
  createBotUploadReceiptSigner,
  signBotUploadReceiptClaims,
  verifyBotUploadReceiptToken,
  type BotUploadReceipt,
  type BotUploadReceiptClaims
} from '../worker/src/bot-upload-receipt'
import { requestFormDataLimited } from '../worker/src/http'

type BoundValue = string | number | bigint | Uint8Array | null
type MetadataWriteFault = 'before' | 'after'

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
    return this.db.run(this.sql, this.values)
  }
}

class SqliteD1 {
  readonly database = new DatabaseSync(':memory:')
  metadataWriteFault: MetadataWriteFault | null = null
  claimWriteFault: MetadataWriteFault | null = null
  batchBarrier: (() => Promise<void>) | null = null
  private batchQueue: Promise<void> = Promise.resolve()

  prepare(sql: string): SqliteStatement { return new SqliteStatement(this, sql) }
  async batch(statements: SqliteStatement[]): Promise<Array<{ success: boolean; meta: { changes: number } }>> {
    if (this.batchBarrier) await this.batchBarrier()
    const previous = this.batchQueue
    let release!: () => void
    this.batchQueue = new Promise<void>((resolve) => { release = resolve })
    await previous
    this.database.exec('BEGIN')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    } finally {
      release()
    }
  }
  run(sql: string, values: BoundValue[]): { success: boolean; meta: { changes: number } } {
    const claimUpdate = /^\s*UPDATE upload_intents\s+SET upload_receipt = \?, updated_at = \?/i.test(sql)
    if (claimUpdate && this.claimWriteFault) {
      const fault = this.claimWriteFault
      this.claimWriteFault = null
      if (fault === 'before') throw new Error('injected D1 claim failure before write')
      const result = this.database.prepare(sql).run(...values)
      throw new Error(`injected D1 claim failure after write (${Number(result.changes)})`)
    }
    const metadataUpdate = /^\s*UPDATE upload_intents\s+SET status = 'uploaded'/i.test(sql)
    if (metadataUpdate && this.metadataWriteFault) {
      const fault = this.metadataWriteFault
      this.metadataWriteFault = null
      if (fault === 'before') throw new Error('injected D1 metadata failure before write')
      const result = this.database.prepare(sql).run(...values)
      throw new Error(`injected D1 metadata failure after write (${Number(result.changes)})`)
    }
    const result = this.database.prepare(sql).run(...values)
    return { success: true, meta: { changes: Number(result.changes) } }
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

type RequestOptions = {
  method?: string
  token?: string
  body?: unknown
  headers?: Record<string, string>
}

async function request(env: Env, path: string, options: RequestOptions = {}): Promise<Response> {
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

const STORAGE_ID = '00000000-0000-4000-8000-000000000003'
const MASTER = 'bot-upload-recovery-master-key-123456789012345'
const BOT_TOKEN = '123456789:bot-upload-recovery-token'
const RECEIPT_SECRETS = { STORAGE_MASTER_KEY: MASTER, TELEGRAM_BOT_TOKEN: BOT_TOKEN }
const XLSX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04])

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function bootstrap(): Promise<{
  db: SqliteD1
  env: Env
  token: string
  userId: string
  workspaceId: string
}> {
  const db = new SqliteD1()
  applyMigrations(db)
  const nonce = 'bot-upload-recovery-bootstrap-nonce-123456789'
  db.database.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES ('setup_nonce_hash',?,datetime('now'))")
    .run(await sha256Text(nonce))
  const env = {
    DB: db,
    RETENTION_LIMIT: '20',
    SESSION_TTL_SECONDS: '2592000',
    STORAGE_MASTER_KEY: MASTER,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN
  } as unknown as Env
  const bootstrapResponse = await appFetch(new Request('https://excel-sync.test/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-setup-nonce': nonce },
    body: JSON.stringify({ username: 'owner', displayName: 'Owner', password: 'owner-password-12345', organizationName: 'Bot Receipt Org' })
  }), env as never)
  expect(bootstrapResponse.status).toBe(201)
  const login = await json<{ token: string; user: { id: string }; defaultWorkspaceId: string }>(await request(env, '/auth/login', {
    method: 'POST', body: { username: 'owner', password: 'owner-password-12345' }
  }))
  db.database.prepare("UPDATE storage_connections SET chat_id='bot-chat', chat_title='Bot Chat', status='ACTIVE' WHERE id=?")
    .run(STORAGE_ID)
  return { db, env, token: login.token, userId: login.user.id, workspaceId: login.defaultWorkspaceId }
}

async function reserveIntent(
  env: Env,
  token: string,
  workspaceId: string,
  fileName: string,
  key: string,
  options: { fileId?: string; baseVersion?: number; bytes?: Uint8Array } = {}
) {
  const bytes = options.bytes ?? XLSX_BYTES
  const hash = await sha256Hex(bytes)
  const response = await request(env, '/sync/preflight', {
    method: 'POST', token,
    body: {
      ...(options.fileId ? { fileId: options.fileId } : {}),
      workspaceId,
      logicalName: fileName,
      relativePath: `Bot Uploads/${fileName}`,
      hash,
      size: bytes.byteLength,
      baseVersion: options.baseVersion ?? 0,
      idempotencyKey: key,
      storageBackend: 'telegram_bot'
    }
  })
  expect(response.status).toBe(201)
  return { ...(await json<{ fileId: string; intentId: string }>(response)), hash }
}

async function upload(env: Env, token: string, intentId: string, bytes = XLSX_BYTES): Promise<Response> {
  const form = new FormData()
  form.set('intentId', intentId)
  form.set('file', new File([bytes], 'upload.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }))
  return appFetch(new Request('https://excel-sync.test/sync/upload', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form
  }), env as never)
}

function installTelegramSuccessMock() {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/sendDocument')) {
      const sequence = calls.filter((call) => call.includes('/sendDocument')).length
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: 7000 + sequence, document: { file_id: `bot-file-${sequence}`, file_unique_id: `bot-unique-${sequence}`, file_size: XLSX_BYTES.length } }
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: false, error_code: 404 }), { status: 404, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

async function finishWithReceipt(env: Env, token: string, intentId: string, receipt: BotUploadReceipt) {
  const receiptResponse = await request(env, '/sync/upload-receipt', {
    method: 'POST', token,
    body: { intentId, receipt }
  })
  const receiptBody = await json<{ error?: { code: string }; status?: string }>(receiptResponse)
  expect(receiptResponse.status, JSON.stringify(receiptBody)).toBe(200)
  const commitResponse = await request(env, '/sync/commit', { method: 'POST', token, body: { intentId } })
  expect(commitResponse.status).toBe(200)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Worker Bot upload recovery', () => {
  it.each(['before', 'after'] as const)('recovers a Telegram success when the D1 metadata write fails %s the write', async (fault) => {
    const { db, env, token, workspaceId } = await bootstrap()
    const calls = installTelegramSuccessMock()
    try {
      const intent = await reserveIntent(env, token, workspaceId, `metadata-${fault}.xlsx`, `bot-metadata-${fault}-key-0001`)
      db.metadataWriteFault = fault
      const uploadResponse = await upload(env, token, intent.intentId)
      const payload = await json<{ status: string; receipt: BotUploadReceipt; metadataPersisted: boolean }>(uploadResponse)
      expect(uploadResponse.status).toBe(200)
      expect(payload.status).toBe('receipt_pending')
      expect(payload.metadataPersisted).toBe(false)
      expect(payload.receipt).toMatchObject({ backend: 'telegram_bot', intentId: intent.intentId, sha256: intent.hash, size: XLSX_BYTES.length })

      await finishWithReceipt(env, token, intent.intentId, payload.receipt)
      expect(calls.filter((url) => url.includes('/sendDocument'))).toHaveLength(1)
      expect((db.database.prepare('SELECT current_version FROM files WHERE id=?').get(intent.fileId) as { current_version: number }).current_version).toBe(1)
      expect((db.database.prepare('SELECT COUNT(*) AS count FROM file_versions WHERE file_id=?').get(intent.fileId) as { count: number }).count).toBe(1)
    } finally {
      db.close()
    }
  })

  it('serializes concurrent uploads for one intent and performs one Telegram send', async () => {
    const { db, env, token, workspaceId } = await bootstrap()
    const providerResponse = deferred<Response>()
    const sendStarted = deferred<void>()
    let sends = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes('/sendDocument')) return new Response('{}', { status: 404 })
      sends += 1
      sendStarted.resolve()
      return providerResponse.promise
    }))
    try {
      const intent = await reserveIntent(env, token, workspaceId, 'parallel.xlsx', 'bot-parallel-key-0000001')
      const firstUpload = upload(env, token, intent.intentId)
      await sendStarted.promise
      const secondResponse = await upload(env, token, intent.intentId)
      expect(secondResponse.status).toBe(422)
      expect((await json<{ error: { code: string } }>(secondResponse)).error.code).toBe('UPLOAD_OUTCOME_UNCERTAIN')
      expect(sends).toBe(1)

      providerResponse.resolve(new Response(JSON.stringify({
        ok: true,
        result: { message_id: 7001, document: { file_id: 'bot-file-7001', file_unique_id: 'bot-unique-7001', file_size: XLSX_BYTES.length } }
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      const firstResponse = await firstUpload
      expect(firstResponse.status).toBe(200)
      const payload = await json<{ receipt: BotUploadReceipt; status: string }>(firstResponse)
      expect(payload.status).toBe('uploaded')
      await finishWithReceipt(env, token, intent.intentId, payload.receipt)
      expect(sends).toBe(1)
      expect((db.database.prepare('SELECT current_version FROM files WHERE id=?').get(intent.fileId) as { current_version: number }).current_version).toBe(1)
    } finally {
      db.close()
    }
  })

  it.each([
    ['connection loss after upstream acceptance', 'network'],
    ['an upstream 5xx with a contradictory 400 code', 'five-hundred'],
    ['an ok:false envelope without an explicit Telegram code', 'missing-code']
  ] as const)('locks an intent after %s and does not resend automatically', async (_label, failureMode) => {
    const { db, env, token, workspaceId } = await bootstrap()
    let sends = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/sendDocument')) {
        sends += 1
        if (failureMode === 'network') throw new Error('simulated connection loss after upstream acceptance')
        if (failureMode === 'five-hundred') {
          return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'contradictory upstream response' }), {
            status: 500, headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({ ok: false, description: 'missing explicit code' }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      return new Response('{}', { status: 404 })
    }))
    try {
      const intent = await reserveIntent(env, token, workspaceId, 'lost-response.xlsx', 'bot-lost-response-key-001')
      const first = await upload(env, token, intent.intentId)
      expect(first.status).toBe(422)
      expect((await json<{ error: { code: string } }>(first)).error.code).toBe('UPLOAD_OUTCOME_UNCERTAIN')
      const retry = await upload(env, token, intent.intentId)
      expect(retry.status).toBe(422)
      expect((await json<{ error: { code: string } }>(retry)).error.code).toBe('UPLOAD_OUTCOME_UNCERTAIN')
      expect(sends).toBe(1)
      const state = db.database.prepare('SELECT status,upload_receipt FROM upload_intents WHERE id=?').get(intent.intentId) as { status: string; upload_receipt: string }
      expect(state.status).toBe('reserved')
      expect(JSON.parse(state.upload_receipt).kind).toBe('telegram_bot_upload_claim')
    } finally {
      db.close()
    }
  })

  it('does not mint an unusable receipt from malformed successful Telegram metadata', async () => {
    const { db, env, token, workspaceId } = await bootstrap()
    let sends = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/sendDocument')) {
        sends += 1
        return new Response(JSON.stringify({
          ok: true,
          result: { message_id: 7001, document: { file_id: 'x'.repeat(257), file_unique_id: 'bot-unique-7001', file_size: XLSX_BYTES.length } }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }))
    try {
      const intent = await reserveIntent(env, token, workspaceId, 'malformed-result.xlsx', 'bot-malformed-result-key-01')
      const response = await upload(env, token, intent.intentId)
      expect(response.status).toBe(422)
      expect((await json<{ error: { code: string } }>(response)).error.code).toBe('UPLOAD_OUTCOME_UNCERTAIN')
      expect((await upload(env, token, intent.intentId)).status).toBe(422)
      expect(sends).toBe(1)
      const state = db.database.prepare('SELECT status,upload_receipt FROM upload_intents WHERE id=?').get(intent.intentId) as { status: string; upload_receipt: string }
      expect(state.status).toBe('reserved')
      expect(JSON.parse(state.upload_receipt).kind).toBe('telegram_bot_upload_claim')
    } finally {
      db.close()
    }
  })

  it('never sends when the D1 claim write has an ambiguous result', async () => {
    const { db, env, token, workspaceId } = await bootstrap()
    const calls = installTelegramSuccessMock()
    try {
      const intent = await reserveIntent(env, token, workspaceId, 'claim-write.xlsx', 'bot-claim-write-key-0001')
      db.claimWriteFault = 'after'
      const first = await upload(env, token, intent.intentId)
      expect(first.status).toBe(422)
      expect((await json<{ error: { code: string } }>(first)).error.code).toBe('UPLOAD_OUTCOME_UNCERTAIN')
      const retry = await upload(env, token, intent.intentId)
      expect(retry.status).toBe(422)
      expect(calls.filter((url) => url.includes('/sendDocument'))).toHaveLength(0)
      const state = db.database.prepare('SELECT status,upload_receipt FROM upload_intents WHERE id=?').get(intent.intentId) as { status: string; upload_receipt: string }
      expect(state.status).toBe('reserved')
      expect(JSON.parse(state.upload_receipt).kind).toBe('telegram_bot_upload_claim')
    } finally {
      db.close()
    }
  })

  it('releases a claim only after an explicit Telegram rejection', async () => {
    const { db, env, token, workspaceId } = await bootstrap()
    let sends = 0
    let reject = true
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/sendDocument')) {
        sends += 1
        if (reject) return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request' }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
        return new Response(JSON.stringify({
          ok: true,
          result: { message_id: 7001, document: { file_id: 'bot-file-7001', file_unique_id: 'bot-unique-7001', file_size: XLSX_BYTES.length } }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }))
    try {
      const intent = await reserveIntent(env, token, workspaceId, 'rejected.xlsx', 'bot-rejected-key-0000001')
      const rejected = await upload(env, token, intent.intentId)
      expect(rejected.status).toBe(502)
      expect((await json<{ error: { code: string } }>(rejected)).error.code).toBe('TELEGRAM_UPLOAD_REJECTED')
      const afterReject = db.database.prepare('SELECT status,upload_receipt FROM upload_intents WHERE id=?').get(intent.intentId) as { status: string; upload_receipt: string | null }
      expect(afterReject).toEqual({ status: 'reserved', upload_receipt: null })

      reject = false
      const accepted = await upload(env, token, intent.intentId)
      expect(accepted.status).toBe(200)
      const payload = await json<{ receipt: BotUploadReceipt }>(accepted)
      await finishWithReceipt(env, token, intent.intentId, payload.receipt)
      expect(sends).toBe(2)
      expect((db.database.prepare('SELECT current_version FROM files WHERE id=?').get(intent.fileId) as { current_version: number }).current_version).toBe(1)
    } finally {
      db.close()
    }
  })

  it('rejects forged, wrong-owner, wrong-origin and wrong-route receipts without changing metadata', async () => {
    const { db, env, token, workspaceId } = await bootstrap()
    const calls = installTelegramSuccessMock()
    try {
      const intent = await reserveIntent(env, token, workspaceId, 'receipt-validation.xlsx', 'bot-receipt-validation-key-01')
      const uploadResponse = await upload(env, token, intent.intentId)
      const { receipt } = await json<{ receipt: BotUploadReceipt }>(uploadResponse)

      const forged = { ...receipt, recoveryToken: `${receipt.recoveryToken}x` }
      const forgedResponse = await request(env, '/sync/upload-receipt', { method: 'POST', token, body: { intentId: intent.intentId, receipt: forged } })
      expect(forgedResponse.status).toBe(403)

      const inviteResponse = await request(env, '/admin/invites', {
        method: 'POST', token,
        body: { username: 'other', displayName: 'Other', workspaceId, workspaceRole: 'EDITOR', expiresInHours: 24 }
      })
      expect(inviteResponse.status).toBe(201)
      const invite = await json<{ code: string }>(inviteResponse)
      const activation = await request(env, '/auth/activate', { method: 'POST', body: { code: invite.code, password: 'other-password-12345' } })
      expect(activation.status).toBe(200)
      const other = await json<{ token: string }>(activation)
      const wrongOwner = await request(env, '/sync/upload-receipt', {
        method: 'POST', token: other.token, body: { intentId: intent.intentId, receipt }
      })
      expect(wrongOwner.status).toBe(404)

      const claims = await verifyBotUploadReceiptToken(receipt.recoveryToken, RECEIPT_SECRETS, 'https://excel-sync.test')
      expect(claims).not.toBeNull()
      const signer = await createBotUploadReceiptSigner(RECEIPT_SECRETS)
      const wrongAudienceClaims = { ...claims!, audience: 'https://other-worker.test' } as BotUploadReceiptClaims
      const wrongAudience = { ...receipt, recoveryToken: await signBotUploadReceiptClaims(signer, wrongAudienceClaims) }
      const wrongAudienceResponse = await request(env, '/sync/upload-receipt', {
        method: 'POST', token, body: { intentId: intent.intentId, receipt: wrongAudience }
      })
      expect(wrongAudienceResponse.status).toBe(403)

      const otherStorageId = '99999999-9999-4999-8999-999999999999'
      db.database.prepare(
        `INSERT INTO storage_connections(id,organization_id,provider,name,credential_source,chat_id,status,created_by_user_id,created_at,updated_at)
         VALUES (?,(SELECT organization_id FROM users WHERE id=?),'telegram','Other Route','LEGACY_WORKER_SECRET','other-chat','ACTIVE',?,datetime('now'),datetime('now'))`
      ).run(otherStorageId, (db.database.prepare('SELECT owner_user_id AS id FROM upload_intents WHERE id=?').get(intent.intentId) as { id: string }).id,
        (db.database.prepare('SELECT owner_user_id AS id FROM upload_intents WHERE id=?').get(intent.intentId) as { id: string }).id)
      db.database.prepare('UPDATE upload_intents SET storage_connection_id=? WHERE id=?').run(otherStorageId, intent.intentId)
      const wrongRoute = await request(env, '/sync/upload-receipt', {
        method: 'POST', token, body: { intentId: intent.intentId, receipt }
      })
      expect(wrongRoute.status).toBe(403)
      expect((db.database.prepare('SELECT current_version FROM files WHERE id=?').get(intent.fileId) as { current_version: number }).current_version).toBe(0)
      expect((db.database.prepare('SELECT COUNT(*) AS count FROM file_versions WHERE file_id=?').get(intent.fileId) as { count: number }).count).toBe(0)
      expect(calls.filter((url) => url.includes('/sendDocument'))).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('rejects signed receipt changes to hash, size, base version, or claim attempt', async () => {
    const { db, env, token, workspaceId } = await bootstrap()
    const calls = installTelegramSuccessMock()
    try {
      const intent = await reserveIntent(env, token, workspaceId, 'claim-binding.xlsx', 'bot-claim-binding-key-0001')
      db.metadataWriteFault = 'before'
      const uploadResponse = await upload(env, token, intent.intentId)
      const { receipt } = await json<{ receipt: BotUploadReceipt }>(uploadResponse)
      const originalClaims = await verifyBotUploadReceiptToken(receipt.recoveryToken, RECEIPT_SECRETS, 'https://excel-sync.test')
      expect(originalClaims).not.toBeNull()
      const signer = await createBotUploadReceiptSigner(RECEIPT_SECRETS)

      const tamperedVariants: Array<{
        name: string
        claims: Partial<BotUploadReceiptClaims>
        receipt: Partial<BotUploadReceipt>
      }> = [
        { name: 'hash', claims: { sha256: 'a'.repeat(64) }, receipt: { sha256: 'a'.repeat(64) } },
        { name: 'size', claims: { size: receipt.size + 1 }, receipt: { size: receipt.size + 1 } },
        { name: 'base version', claims: { baseVersion: originalClaims!.baseVersion + 1 }, receipt: {} },
        { name: 'claim attempt', claims: { attemptId: crypto.randomUUID() }, receipt: {} }
      ]
      for (const variant of tamperedVariants) {
        const signedClaims = { ...originalClaims!, ...variant.claims } as BotUploadReceiptClaims
        const alteredReceipt = {
          ...receipt,
          ...variant.receipt,
          recoveryToken: await signBotUploadReceiptClaims(signer, signedClaims)
        }
        const response = await request(env, '/sync/upload-receipt', {
          method: 'POST', token, body: { intentId: intent.intentId, receipt: alteredReceipt }
        })
        expect(response.status, variant.name).toBe(403)
        expect((await json<{ error: { code: string } }>(response)).error.code).toBe('INVALID_UPLOAD_RECEIPT')
      }

      const state = db.database.prepare('SELECT status,upload_receipt FROM upload_intents WHERE id=?').get(intent.intentId) as { status: string; upload_receipt: string }
      expect(state.status).toBe('reserved')
      expect(JSON.parse(state.upload_receipt).kind).toBe('telegram_bot_upload_claim')
      await finishWithReceipt(env, token, intent.intentId, receipt)
      expect(calls.filter((url) => url.includes('/sendDocument'))).toHaveLength(1)
      expect((db.database.prepare('SELECT current_version FROM files WHERE id=?').get(intent.fileId) as { current_version: number }).current_version).toBe(1)
    } finally {
      db.close()
    }
  })

  it('rejects a chunked multipart body as soon as the configured ceiling is crossed', async () => {
    let chunk = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunk >= 3) {
          controller.close()
          return
        }
        controller.enqueue(new Uint8Array(8).fill(65 + chunk))
        chunk += 1
      }
    })
    const request = new Request('https://excel-sync.test/sync/upload', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=test-boundary' },
      body,
      duplex: 'half'
    } as RequestInit & { duplex: 'half' })
    await expect(requestFormDataLimited(request, 10)).rejects.toMatchObject({ status: 413, code: 'FILE_TOO_LARGE' })
  })

  it('accepts same-Bot token rotation and preserves a receipt when the Bot or chat route changes', async () => {
    const { db, env, token, workspaceId } = await bootstrap()
    const calls = installTelegramSuccessMock()
    const setBotToken = (value: string) => {
      ;(env as unknown as { TELEGRAM_BOT_TOKEN: string }).TELEGRAM_BOT_TOKEN = value
    }
    try {
      const intent = await reserveIntent(env, token, workspaceId, 'route-identity.xlsx', 'bot-route-identity-key-001')
      const uploadResponse = await upload(env, token, intent.intentId)
      const { receipt } = await json<{ receipt: BotUploadReceipt }>(uploadResponse)

      setBotToken('987654321:different-bot-token')
      const changedBot = await request(env, '/sync/upload-receipt', {
        method: 'POST', token, body: { intentId: intent.intentId, receipt }
      })
      expect(changedBot.status).toBe(422)
      expect((await json<{ error: { code: string } }>(changedBot)).error.code).toBe('STORAGE_ROUTE_CHANGED')
      expect((db.database.prepare('SELECT status FROM upload_intents WHERE id=?').get(intent.intentId) as { status: string }).status).toBe('uploaded')

      setBotToken('123456789:rotated-bot-token')
      db.database.prepare("UPDATE storage_connections SET chat_id='changed-chat' WHERE id=?").run(STORAGE_ID)
      const changedChat = await request(env, '/sync/upload-receipt', {
        method: 'POST', token, body: { intentId: intent.intentId, receipt }
      })
      expect(changedChat.status).toBe(422)
      expect((await json<{ error: { code: string } }>(changedChat)).error.code).toBe('STORAGE_ROUTE_CHANGED')

      db.database.prepare("UPDATE storage_connections SET chat_id='bot-chat' WHERE id=?").run(STORAGE_ID)
      const recovered = await request(env, '/sync/upload-receipt', {
        method: 'POST', token, body: { intentId: intent.intentId, receipt }
      })
      expect(recovered.status).toBe(200)
      const commit = await request(env, '/sync/commit', { method: 'POST', token, body: { intentId: intent.intentId } })
      expect(commit.status).toBe(200)
      expect(calls.filter((url) => url.includes('/sendDocument'))).toHaveLength(1)
      expect((db.database.prepare('SELECT current_version FROM files WHERE id=?').get(intent.fileId) as { current_version: number }).current_version).toBe(1)
    } finally {
      db.close()
    }
  })

  it('acknowledges a concurrent same-intent commit and replays its original version after later updates', async () => {
    const { db, env, token, workspaceId } = await bootstrap()
    installTelegramSuccessMock()
    try {
      const firstIntent = await reserveIntent(env, token, workspaceId, 'commit-race-replay.xlsx', 'bot-commit-first-key-00001')
      const firstUpload = await upload(env, token, firstIntent.intentId)
      const firstReceipt = await json<{ receipt: BotUploadReceipt }>(firstUpload)
      const firstReceiptSaved = await request(env, '/sync/upload-receipt', {
        method: 'POST', token, body: { intentId: firstIntent.intentId, receipt: firstReceipt.receipt }
      })
      expect(firstReceiptSaved.status).toBe(200)

      const bothAtCommit = deferred<void>()
      let commitArrivals = 0
      db.batchBarrier = async () => {
        commitArrivals += 1
        if (commitArrivals === 2) bothAtCommit.resolve()
        await bothAtCommit.promise
      }
      const concurrentCommits = await Promise.all([
        request(env, '/sync/commit', { method: 'POST', token, body: { intentId: firstIntent.intentId } }),
        request(env, '/sync/commit', { method: 'POST', token, body: { intentId: firstIntent.intentId } })
      ])
      expect(concurrentCommits.map((response) => response.status)).toEqual([200, 200])
      const firstResults = await Promise.all(concurrentCommits.map((response) => json<{ fileId: string; version: number; hash: string }>(response)))
      expect(firstResults.map(({ fileId, version, hash }) => ({ fileId, version, hash }))).toEqual([
        { fileId: firstIntent.fileId, version: 1, hash: firstIntent.hash },
        { fileId: firstIntent.fileId, version: 1, hash: firstIntent.hash }
      ])
      expect((db.database.prepare('SELECT COUNT(*) AS count FROM file_versions WHERE file_id=?').get(firstIntent.fileId) as { count: number }).count).toBe(1)

      db.batchBarrier = null
      const nextBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01])
      const secondIntent = await reserveIntent(env, token, workspaceId, 'commit-race-replay.xlsx', 'bot-commit-second-key-00001', {
        fileId: firstIntent.fileId,
        baseVersion: 1,
        bytes: nextBytes
      })
      const secondUpload = await upload(env, token, secondIntent.intentId, nextBytes)
      const secondReceipt = await json<{ receipt: BotUploadReceipt }>(secondUpload)
      const secondReceiptSaved = await request(env, '/sync/upload-receipt', {
        method: 'POST', token, body: { intentId: secondIntent.intentId, receipt: secondReceipt.receipt }
      })
      expect(secondReceiptSaved.status).toBe(200)
      const secondCommit = await request(env, '/sync/commit', {
        method: 'POST', token, body: { intentId: secondIntent.intentId }
      })
      expect(secondCommit.status).toBe(200)
      expect((await json<{ version: number; hash: string }>(secondCommit)).version).toBe(2)

      const replay = await request(env, '/sync/commit', {
        method: 'POST', token, body: { intentId: firstIntent.intentId }
      })
      expect(replay.status).toBe(200)
      const replayResult = await json<{ fileId: string; version: number; hash: string }>(replay)
      expect(replayResult).toMatchObject({
        fileId: firstIntent.fileId,
        version: 1,
        hash: firstIntent.hash
      })
      expect((db.database.prepare('SELECT current_version FROM files WHERE id=?').get(firstIntent.fileId) as { current_version: number }).current_version).toBe(2)
      expect((db.database.prepare('SELECT COUNT(*) AS count FROM file_versions WHERE file_id=?').get(firstIntent.fileId) as { count: number }).count).toBe(2)
    } finally {
      db.close()
    }
  })
})
