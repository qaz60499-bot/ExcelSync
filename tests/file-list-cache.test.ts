import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { handleFilesList } from '../worker/src/index'
import { WorkerApi } from '../src/main/api'

const org = '00000000-0000-4000-8000-000000000001'
const workspace = '00000000-0000-4000-8000-000000000002'
const user = { id: 'test-user', organizationId: org, systemRole: 'OWNER' } as any

function fixture(count = 1) {
  const sqlite = new DatabaseSync(':memory:')
  for (const name of readdirSync(new URL('../migrations', import.meta.url)).sort()) {
    if (name.endsWith('.sql') && name !== '0008_client_resilience_accounts_presence.sql') {
      sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))
    }
  }
  sqlite.prepare('INSERT INTO users(id,username,password_hash,created_at,organization_id) VALUES (?,?,?,?,?)')
    .run(user.id, 'fixture', 'unused', '2026-01-01', org)
  const insert = sqlite.prepare(`INSERT INTO files(id,workspace_id,logical_name,relative_path,owner_user_id,created_at,updated_at,updated_by)
    VALUES (?,?,?,?,?,?,?,?)`)
  for (let i = 0; i < count; i++) {
    const id = `file-${String(i).padStart(5, '0')}`
    insert.run(id, workspace, `${id}.csv`, `${id}.csv`, user.id, '2026-01-01', '2026-01-01', user.id)
  }
  const queries: string[] = []
  const db = {
    prepare(sql: string) {
      queries.push(sql)
      let values: any[] = []
      return {
        bind(...args: any[]) { values = args; return this },
        async first() { return sqlite.prepare(sql).get(...values) ?? null },
        async all() { return { results: sqlite.prepare(sql).all(...values) } }
      }
    }
  }
  const list = (suffix = '', etag?: string, actor = user) => handleFilesList(
    new Request(`https://example.test/files/list?include=all&paged=1${suffix}`, { headers: etag ? { 'if-none-match': etag } : {} }),
    { DB: db } as any, actor)
  return { sqlite, queries, list }
}

describe('conditional file lists with transactional invalidation', () => {
  it('avoids the file query when unchanged and invalidates equal-timestamp edits and rollbacks correctly', async () => {
    const f = fixture()
    try {
      const first = await f.list()
      const etag = first.headers.get('etag')!
      f.queries.length = 0
      expect((await f.list('', etag)).status).toBe(304)
      expect(f.queries).toHaveLength(1)
      expect(f.queries[0]).not.toMatch(/FROM files/)
      f.sqlite.exec("BEGIN; UPDATE files SET logical_name='rolled-back.csv'; ROLLBACK;")
      expect((await f.list('', etag)).status).toBe(304)
      f.sqlite.exec("UPDATE files SET logical_name='renamed.csv'")
      const changed = await f.list('', etag)
      expect(changed.status).toBe(200)
      expect((await changed.json() as any).files[0].logical_name).toBe('renamed.csv')
    } finally { f.sqlite.close() }
  })

  it('pages beyond 1000 rows without gaps when timestamps are identical', async () => {
    const f = fixture(1003)
    try {
      const first = await (await f.list()).json() as any
      const second = await (await f.list(`&cursor=${encodeURIComponent(first.nextCursor)}`)).json() as any
      expect(first.files).toHaveLength(1000)
      expect(second.files).toHaveLength(3)
      expect(new Set([...first.files, ...second.files].map(x => x.id)).size).toBe(1003)
      expect(second.nextCursor).toBeNull()
    } finally { f.sqlite.close() }
  })

  it('invalidates workspace and direct/group ACL changes and isolates users', async () => {
    const f = fixture()
    try {
      let etag = (await f.list()).headers.get('etag')!
      expect((await f.list('', etag, { ...user, id: 'other-user' })).status).toBe(200)
      for (const sql of [
        `INSERT INTO workspace_members(workspace_id,user_id,role,joined_at) VALUES ('${workspace}','test-user','VIEWER','2026-01-01')`,
        `UPDATE workspace_members SET role='EDITOR'`,
        `DELETE FROM workspace_members`,
        `UPDATE workspaces SET status='ARCHIVED' WHERE id='${workspace}'`
      ]) {
        f.sqlite.exec(sql)
        const result = await f.list('', etag)
        expect(result.status).toBe(200)
        expect(result.headers.get('etag')).not.toBe(etag)
        etag = result.headers.get('etag')!
      }
      f.sqlite.exec(`INSERT INTO workspace_members(workspace_id,user_id,role,joined_at) VALUES ('${workspace}','test-user','VIEWER','2026-01-01');
        INSERT INTO groups(id,organization_id,name,created_at,updated_at) VALUES ('test-group','${org}','Test','2026-01-01','2026-01-01');
        INSERT INTO group_members(group_id,user_id,added_at) VALUES ('test-group','test-user','2026-01-01');
        INSERT INTO resource_access_rules(id,organization_id,workspace_id,principal_type,principal_id,scope_type,scope_value,permission,created_at,updated_at)
        VALUES ('grant','${org}','${workspace}','GROUP','test-group','WORKSPACE','${workspace}','VIEW','2026-01-01','2026-01-01');`)
      const member = { ...user, systemRole: 'MEMBER' }
      let visible = await f.list('', undefined, member)
      etag = visible.headers.get('etag')!
      expect((await visible.json() as any).files).toHaveLength(1)
      for (const [revoke, restore] of [
        ["UPDATE groups SET status='ARCHIVED'", "UPDATE groups SET status='ACTIVE'"],
        ["DELETE FROM group_members", "INSERT INTO group_members(group_id,user_id,added_at) VALUES ('test-group','test-user','2026-01-01')"],
        ["UPDATE resource_access_rules SET scope_type='FILE',scope_value='not-visible'", `UPDATE resource_access_rules SET scope_type='WORKSPACE',scope_value='${workspace}'`]
      ]) {
        f.sqlite.exec(revoke!)
        const denied = await f.list('', etag, member)
        expect(denied.status).toBe(200)
        expect((await denied.json() as any).files).toHaveLength(0)
        f.sqlite.exec(restore!)
        visible = await f.list('', denied.headers.get('etag')!, member)
        etag = visible.headers.get('etag')!
        expect((await visible.json() as any).files).toHaveLength(1)
      }
    } finally { f.sqlite.close() }
  })

  it('keeps the old full-list behavior before the migration is applied', async () => {
    const f = fixture()
    try {
      f.sqlite.exec("DELETE FROM app_settings WHERE key='file_list_revision'")
      const response = await f.list('', '"stale"')
      expect(response.status).toBe(200)
      expect(response.headers.get('etag')).toBeNull()
    } finally { f.sqlite.close() }
  })
})

describe('desktop conditional file list', () => {
  it('coalesces calls, returns the cached list for reconciliation and isolates sessions', async () => {
    let token = 'session-one'
    const headers: Headers[] = []
    const api = new WorkerApi({ load: async () => ({ token }) } as any, () => 'https://example.test', async (_url, init) => {
      headers.push(new Headers(init?.headers))
      if (headers.length === 2) return new Response(null, { status: 304 })
      return new Response(JSON.stringify({ files: [{ id: token }], nextCursor: null }), { headers: { 'content-type': 'application/json', etag: '"rev-1"' } })
    })
    const [a,b] = await Promise.all([api.filesList(), api.filesList()])
    expect(headers).toHaveLength(1)
    expect(a).toBe(b)
    expect(await api.filesList()).toBe(a)
    expect(headers[1]!.get('if-none-match')).toBe('"rev-1"')
    token = 'session-two'
    expect((await api.filesList())[0]!.id).toBe(token)
    expect(headers[2]!.has('if-none-match')).toBe(false)
  })

  it('rejects a list that changes between pages instead of caching a partial result', async () => {
    let calls = 0
    const api = new WorkerApi({ load: async () => ({ token: 'session' }) } as any, () => 'https://example.test', async () => {
      calls++
      return new Response(JSON.stringify({ files: [{ id: String(calls) }], nextCursor: calls === 1 ? 'next' : null }),
        { headers: { 'content-type': 'application/json', etag: `"rev-${calls}"` } })
    })
    await expect(api.filesList()).rejects.toMatchObject({ code: 'FILE_LIST_CHANGED' })
    expect((api as any).fileListCache).toBeNull()
  })
})
