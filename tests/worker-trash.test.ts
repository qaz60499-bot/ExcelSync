import { describe, expect, it } from 'vitest'
import { handleDelete, handlePermanentDelete, handleRestoreFromTrash, handleTrash, handleTrashList } from '../worker/src/index'

type FileRow = {
  id: string
  logical_name: string
  relative_path: string
  current_version: number
  current_hash: string | null
  owner_user_id: string
  workspace_id: string
  updated_at: string
  updated_by: string
  status: 'active' | 'trashed' | 'deleted'
  trashed_at: string | null
  trashed_by: string | null
}

type Bindings = unknown[]

class FakeStatement {
  private bindings: Bindings = []

  constructor(private readonly db: FakeD1, private readonly sql: string) {}

  bind(...values: unknown[]): FakeStatement {
    this.bindings = values
    return this
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('SELECT f.id, f.workspace_id, f.relative_path, f.home_storage_connection_id')) {
      const [id, organizationId] = this.bindings
      if (this.db.file.id !== id || organizationId !== '00000000-0000-4000-8000-000000000001') return null
      return ({ ...this.db.file, home_storage_connection_id: null, organization_id: organizationId, workspace_status: 'ACTIVE' } as unknown) as T
    }
    if (this.sql.includes('SELECT f.* FROM files f') && this.sql.includes('JOIN workspaces w')) {
      const [organizationId, id] = this.bindings
      if (this.db.file.id !== id || organizationId !== '00000000-0000-4000-8000-000000000001') return null
      return ({ ...this.db.file, home_storage_connection_id: null } as unknown) as T
    }
    if (this.sql.includes('SELECT id FROM files WHERE workspace_id = ?') && this.sql.includes("status = 'active'")) {
      return null
    }
    if (this.sql.includes('SELECT id FROM domain_events WHERE event_key = ?')) {
      return null
    }
    if (this.sql.includes('LEFT JOIN file_versions') && this.sql.includes('WHERE f.id = ?')) {
      const [id, workspaceId] = this.bindings
      if (this.db.file.id !== id || this.db.file.workspace_id !== workspaceId) return null
      return ({ ...this.db.file, size: this.db.size } as unknown) as T
    }
    if (this.sql.includes('SELECT id, workspace_id, logical_name, relative_path, status, current_version') && this.sql.includes('FROM files WHERE id = ?')) {
      const [id] = this.bindings
      if (this.db.file.id !== id) return null
      return ({
        id: this.db.file.id,
        workspace_id: this.db.file.workspace_id,
        logical_name: this.db.file.logical_name,
        relative_path: this.db.file.relative_path,
        status: this.db.file.status,
        current_version: this.db.file.current_version
      } as unknown) as T
    }
    throw new Error(`Unhandled first SQL: ${this.sql}`)
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("WHERE f.status = 'trashed'") && this.sql.includes('JOIN workspaces w')) {
      const organizationId = this.bindings[0]
      if (organizationId !== '00000000-0000-4000-8000-000000000001' || this.db.file.status !== 'trashed') return { results: [] }
      return {
        results: [{
          id: this.db.file.id,
          logical_name: this.db.file.logical_name,
          relative_path: this.db.file.relative_path,
          current_version: this.db.file.current_version,
          current_hash: this.db.file.current_hash,
          status: this.db.file.status,
          trashed_at: this.db.file.trashed_at ?? this.db.file.updated_at,
          updated_at: this.db.file.updated_at,
          size: this.db.size
        } as T]
      }
    }
    throw new Error(`Unhandled all SQL: ${this.sql}`)
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("SET status = 'trashed'")) {
      const [trashedAt, trashedBy, updatedAt, updatedBy, _updatedByUserId, id, workspaceId, version] = this.bindings
      if (this.db.file.id !== id || this.db.file.workspace_id !== workspaceId || this.db.file.current_version !== version || this.db.file.status !== 'active') {
        return { meta: { changes: 0 } }
      }
      this.db.file.status = 'trashed'
      this.db.file.trashed_at = String(trashedAt)
      this.db.file.trashed_by = String(trashedBy)
      this.db.file.updated_at = String(updatedAt)
      this.db.file.updated_by = String(updatedBy)
      return { meta: { changes: 1 } }
    }
    if (this.sql.includes("SET status = 'active', trashed_at = NULL")) {
      const [updatedAt, updatedBy, _updatedByUserId, id, workspaceId] = this.bindings
      if (this.db.file.id !== id || this.db.file.workspace_id !== workspaceId || this.db.file.status !== 'trashed') {
        return { meta: { changes: 0 } }
      }
      this.db.file.status = 'active'
      this.db.file.trashed_at = null
      this.db.file.trashed_by = null
      this.db.file.updated_at = String(updatedAt)
      this.db.file.updated_by = String(updatedBy)
      return { meta: { changes: 1 } }
    }
    if (this.sql.includes("SET status = 'deleted'")) {
      const [updatedAt, updatedBy, _updatedByUserId, id, workspaceId] = this.bindings
      if (this.db.file.id !== id || this.db.file.workspace_id !== workspaceId || this.db.file.status !== 'trashed') return { meta: { changes: 0 } }
      this.db.file.status = 'deleted'
      this.db.file.updated_at = String(updatedAt)
      this.db.file.updated_by = String(updatedBy)
      return { meta: { changes: 1 } }
    }
    if (this.sql.includes('INSERT INTO sync_events')) {
      this.db.events += 1
      return { meta: { changes: 1 } }
    }
    if (this.sql.includes('INSERT OR IGNORE INTO domain_events')) {
      this.db.domainEvents += 1
      return { meta: { changes: 1 } }
    }
    if (this.sql.includes('INSERT INTO file_state_history')) {
      this.db.stateSnapshots += 1
      return { meta: { changes: 1 } }
    }
    throw new Error(`Unhandled run SQL: ${this.sql}`)
  }
}

class FakeD1 {
  events = 0
  domainEvents = 0
  stateSnapshots = 0
  size = 321
  file: FileRow = {
    id: '11111111-1111-4111-8111-111111111111',
    logical_name: 'book.xlsx',
    relative_path: 'book.xlsx',
    current_version: 7,
    current_hash: 'a'.repeat(64),
    owner_user_id: 'user-1',
    workspace_id: '00000000-0000-4000-8000-000000000002',
    updated_at: new Date(0).toISOString(),
    updated_by: 'user-1',
    status: 'active',
    trashed_at: null,
    trashed_by: null
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql)
  }
}

function env(db: FakeD1) {
  return { DB: db } as unknown as Env
}

const user = {
  id: 'user-1',
  username: 'owner',
  displayName: 'Owner',
  organizationId: '00000000-0000-4000-8000-000000000001',
  systemRole: 'OWNER' as const,
  status: 'ACTIVE' as const
}
const fileId = '11111111-1111-4111-8111-111111111111'

function versionRequest(path: string): Request {
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseVersion: 7 })
  })
}

describe('Worker SaaS trash semantics', () => {
  it('keeps the legacy local-delete endpoint as a no-op so old clients cannot delete cloud data', async () => {
    const db = new FakeD1()
    const response = await handleDelete(versionRequest(`/files/${fileId}/delete`), env(db), user, fileId)
    expect(response.status).toBe(200)
    expect(db.file.status).toBe('active')
    expect((await response.json()) as object).toMatchObject({ ok: true, retained: true })
  })

  it('moves an active file to D1 trash without requiring any Telegram binding', async () => {
    const db = new FakeD1()
    const response = await handleTrash(versionRequest(`/files/${fileId}/trash`), env(db), user, fileId)
    expect(response.status).toBe(200)
    expect(db.file.status).toBe('trashed')
    expect(db.file.trashed_at).toBeTruthy()
    expect(db.file.trashed_by).toBe(user.id)
    expect(db.events).toBe(1)
  })

  it('lists trashed files with the current version size', async () => {
    const db = new FakeD1()
    db.file.status = 'trashed'
    db.file.trashed_at = new Date().toISOString()
    const response = await handleTrashList(env(db), user)
    const payload = await response.json() as { files: Array<{ id: string; size: number; status: string }> }
    expect(payload.files).toHaveLength(1)
    expect(payload.files[0]).toMatchObject({ id: fileId, size: 321, status: 'trashed' })
  })

  it('permanently deletes a trashed SaaS record and hides it from the recoverable trash list', async () => {
    const db = new FakeD1()
    db.file.status = 'trashed'
    db.file.trashed_at = new Date().toISOString()
    const response = await handlePermanentDelete(env(db), user, fileId)
    expect(response.status).toBe(200)
    expect(db.file.status).toBe('deleted')
    const list = await handleTrashList(env(db), user)
    expect(((await list.json()) as { files: unknown[] }).files).toHaveLength(0)
    await expect(handleRestoreFromTrash(env(db), user, fileId)).rejects.toThrow('FILE_NOT_TRASHED')
  })

  it('restores a trashed file to active without downloading or creating a new version', async () => {
    const db = new FakeD1()
    db.file.status = 'trashed'
    db.file.trashed_at = new Date().toISOString()
    db.file.trashed_by = user.id
    const beforeVersion = db.file.current_version
    const response = await handleRestoreFromTrash(env(db), user, fileId)
    expect(response.status).toBe(200)
    expect(db.file.status).toBe('active')
    expect(db.file.current_version).toBe(beforeVersion)
    expect(db.file.trashed_at).toBeNull()
    expect(db.events).toBe(1)
  })
})
