import { z } from 'zod'
import {
  getEffectiveWorkspaceRole,
  isSystemAdmin,
  recordAudit,
  resolveFileAccess,
  workspaceRoleAtLeast,
  type AuthUser,
  type ResourcePermission,
  type ResourceScopeType
} from './access'
import { sha256Text } from './auth'
import { HttpError, json, requestJson } from './http'

export type RuntimeEnv = Env & {
  CLIENT_LATEST_VERSION?: string
  CLIENT_MINIMUM_VERSION?: string
  CLIENT_UPDATE_URL?: string
  CLIENT_ROLLOUT_PERCENT?: string
  API_VERSION?: string
}

export interface RequestAuth {
  user: AuthUser
  sessionId: string
  deviceId: string | null
}

export const deviceInfoSchema = z.object({
  stableDeviceId: z.string().uuid(),
  deviceName: z.string().trim().min(1).max(120),
  osName: z.string().trim().min(1).max(80),
  osVersion: z.string().trim().max(120).default(''),
  clientVersion: z.string().trim().min(1).max(40)
})
export type DeviceInfoInput = z.infer<typeof deviceInfoSchema>

const groupCreateSchema = z.object({ name: z.string().trim().min(1).max(120) })
const groupMembersSchema = z.object({ userIds: z.array(z.string().uuid()).max(1000) })
const scopeSchema = z.object({
  scopeType: z.enum(['WORKSPACE', 'STORAGE', 'FOLDER', 'FILE']),
  scopeValue: z.string().trim().min(1).max(1000)
})
const groupAccessSchema = z.object({
  permission: z.enum(['VIEW', 'EDIT', 'MANAGE']),
  scopes: z.array(scopeSchema).min(1).max(500)
})
const presenceSchema = z.object({ state: z.enum(['OPEN', 'EDITING']) })

function nowIso(): string {
  return new Date().toISOString()
}

function requireAdmin(user: AuthUser): void {
  if (!isSystemAdmin(user)) throw new HttpError(403, 'FORBIDDEN')
}

async function requireWorkspaceManager(env: RuntimeEnv, user: AuthUser, workspaceId: string): Promise<void> {
  const role = await getEffectiveWorkspaceRole(env, user, workspaceId)
  if (!workspaceRoleAtLeast(role, 'MANAGER')) throw new HttpError(403, 'WORKSPACE_FORBIDDEN')
}

async function ensureGroup(env: RuntimeEnv, user: AuthUser, groupId: string): Promise<{ id: string; name: string; status: string }> {
  const row = await env.DB.prepare('SELECT id, name, status FROM groups WHERE id = ? AND organization_id = ? LIMIT 1')
    .bind(groupId, user.organizationId)
    .first<{ id: string; name: string; status: string }>()
  if (!row) throw new HttpError(404, 'GROUP_NOT_FOUND')
  return row
}

export async function upsertLoginDevice(env: RuntimeEnv, user: AuthUser, input?: DeviceInfoInput): Promise<string | null> {
  if (!input) return null
  const existing = await env.DB.prepare('SELECT id FROM devices WHERE user_id = ? AND stable_device_id = ? LIMIT 1')
    .bind(user.id, input.stableDeviceId)
    .first<{ id: string }>()
  const id = existing?.id ?? crypto.randomUUID()
  const timestamp = nowIso()
  await env.DB.prepare(
    `INSERT INTO devices(
       id, organization_id, user_id, stable_device_id, device_name, os_name, os_version,
       client_version, first_seen_at, last_seen_at, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
     ON CONFLICT(user_id, stable_device_id) DO UPDATE SET
       organization_id = excluded.organization_id,
       device_name = excluded.device_name,
       os_name = excluded.os_name,
       os_version = excluded.os_version,
       client_version = excluded.client_version,
       last_seen_at = excluded.last_seen_at,
       status = 'ACTIVE'`
  ).bind(
    id,
    user.organizationId,
    user.id,
    input.stableDeviceId,
    input.deviceName,
    input.osName,
    input.osVersion,
    input.clientVersion,
    timestamp,
    timestamp
  ).run()
  return id
}

async function deviceRows(env: RuntimeEnv, userId: string, currentDeviceId: string | null): Promise<Array<Record<string, unknown>>> {
  const result = await env.DB.prepare(
    `SELECT d.id, d.device_name, d.os_name, d.os_version, d.client_version,
            d.first_seen_at, d.last_seen_at, d.status,
            (SELECT COUNT(*) FROM sessions s
              WHERE s.device_id = d.id AND s.user_id = d.user_id
                AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
       FROM devices d
      WHERE d.user_id = ?
      ORDER BY CASE WHEN d.id = ? THEN 0 ELSE 1 END, d.last_seen_at DESC`
  ).bind(nowIso(), userId, currentDeviceId).all<Record<string, unknown>>()
  return result.results.map((row) => ({
    id: String(row.id),
    deviceName: String(row.device_name),
    osName: String(row.os_name),
    osVersion: String(row.os_version ?? ''),
    clientVersion: String(row.client_version ?? ''),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    status: String(row.status),
    current: String(row.id) === currentDeviceId,
    activeSessions: Number(row.active_sessions ?? 0)
  }))
}

export async function handleMyDevices(env: RuntimeEnv, auth: RequestAuth): Promise<Response> {
  return json({ devices: await deviceRows(env, auth.user.id, auth.deviceId) })
}

export async function handleAdminUserDevices(env: RuntimeEnv, user: AuthUser, targetUserId: string): Promise<Response> {
  requireAdmin(user)
  const target = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND organization_id = ? LIMIT 1')
    .bind(targetUserId, user.organizationId).first<{ id: string }>()
  if (!target) throw new HttpError(404, 'USER_NOT_FOUND')
  return json({ devices: await deviceRows(env, targetUserId, null) })
}

async function revokeDeviceSessions(env: RuntimeEnv, user: AuthUser, deviceIds: string[], reason: string): Promise<number> {
  if (deviceIds.length === 0) return 0
  const placeholders = deviceIds.map(() => '?').join(',')
  const timestamp = nowIso()
  const result = await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ?, revoked_reason = ?
      WHERE user_id = ? AND device_id IN (${placeholders}) AND revoked_at IS NULL`
  ).bind(timestamp, reason, user.id, ...deviceIds).run()
  await env.DB.prepare(
    `UPDATE devices SET status = 'REVOKED', last_seen_at = ? WHERE user_id = ? AND id IN (${placeholders})`
  ).bind(timestamp, user.id, ...deviceIds).run()
  await env.DB.prepare(`DELETE FROM file_presence WHERE user_id = ? AND device_id IN (${placeholders})`)
    .bind(user.id, ...deviceIds).run()
  return Number(result.meta.changes ?? 0)
}

export async function handleLogoutDevice(env: RuntimeEnv, auth: RequestAuth, deviceId: string): Promise<Response> {
  const device = await env.DB.prepare('SELECT id FROM devices WHERE id = ? AND user_id = ? LIMIT 1')
    .bind(deviceId, auth.user.id).first<{ id: string }>()
  if (!device) throw new HttpError(404, 'DEVICE_NOT_FOUND')
  const invalidated = await revokeDeviceSessions(env, auth.user, [deviceId], 'USER_DEVICE_LOGOUT')
  await recordAudit(env, auth.user, 'DEVICE_LOGGED_OUT', 'device', deviceId, { invalidated })
  return json({ ok: true, invalidated, current: auth.deviceId === deviceId })
}

export async function handleLogoutOtherDevices(env: RuntimeEnv, auth: RequestAuth): Promise<Response> {
  const devices = await env.DB.prepare('SELECT id FROM devices WHERE user_id = ? AND (? IS NULL OR id != ?)')
    .bind(auth.user.id, auth.deviceId, auth.deviceId).all<{ id: string }>()
  const deviceInvalidated = await revokeDeviceSessions(env, auth.user, devices.results.map((row) => row.id), 'USER_LOGOUT_OTHER_DEVICES')
  let legacyInvalidated = 0
  if (auth.deviceId) {
    const timestamp = nowIso()
    const legacy = await env.DB.prepare(
      `UPDATE sessions SET revoked_at = ?, revoked_reason = 'USER_LOGOUT_OTHER_DEVICES'
        WHERE user_id = ? AND device_id IS NULL AND revoked_at IS NULL`
    ).bind(timestamp, auth.user.id).run()
    legacyInvalidated = Number(legacy.meta.changes ?? 0)
  }
  const invalidated = deviceInvalidated + legacyInvalidated
  await recordAudit(env, auth.user, 'OTHER_DEVICES_LOGGED_OUT', 'user', auth.user.id, { invalidated })
  return json({ ok: true, invalidated })
}

export async function handleLogoutAllDevices(env: RuntimeEnv, auth: RequestAuth): Promise<Response> {
  const devices = await env.DB.prepare('SELECT id FROM devices WHERE user_id = ?').bind(auth.user.id).all<{ id: string }>()
  const invalidated = await revokeDeviceSessions(env, auth.user, devices.results.map((row) => row.id), 'USER_LOGOUT_ALL_DEVICES')
  const timestamp = nowIso()
  const legacy = await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ?, revoked_reason = 'USER_LOGOUT_ALL_DEVICES'
      WHERE user_id = ? AND device_id IS NULL AND revoked_at IS NULL`
  ).bind(timestamp, auth.user.id).run()
  await env.DB.prepare('DELETE FROM file_presence WHERE user_id = ?').bind(auth.user.id).run()
  const total = invalidated + Number(legacy.meta.changes ?? 0)
  await recordAudit(env, auth.user, 'ALL_DEVICES_LOGGED_OUT', 'user', auth.user.id, { invalidated: total })
  return json({ ok: true, invalidated: total })
}

export async function handleGroups(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  requireAdmin(user)
  const result = await env.DB.prepare(
    `SELECT g.id, g.name, g.status, g.created_at, g.updated_at,
            (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count
       FROM groups g WHERE g.organization_id = ?
      ORDER BY CASE g.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, g.name COLLATE NOCASE`
  ).bind(user.organizationId).all<Record<string, unknown>>()
  return json({ groups: result.results.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    status: String(row.status),
    memberCount: Number(row.member_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  })) })
}

export async function handleGroupCreate(request: Request, env: RuntimeEnv, user: AuthUser): Promise<Response> {
  requireAdmin(user)
  const input = await requestJson(request, groupCreateSchema)
  const id = crypto.randomUUID()
  const timestamp = nowIso()
  try {
    await env.DB.prepare(
      `INSERT INTO groups(id, organization_id, name, status, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)`
    ).bind(id, user.organizationId, input.name, user.id, timestamp, timestamp).run()
  } catch (error) {
    if (String(error).toLowerCase().includes('unique')) throw new HttpError(409, 'GROUP_NAME_EXISTS')
    throw error
  }
  await recordAudit(env, user, 'GROUP_CREATED', 'group', id, { name: input.name })
  return json({ id, name: input.name, status: 'ACTIVE', memberCount: 0, createdAt: timestamp, updatedAt: timestamp }, 201)
}

export async function handleGroupArchive(env: RuntimeEnv, user: AuthUser, groupId: string): Promise<Response> {
  requireAdmin(user)
  await ensureGroup(env, user, groupId)
  const timestamp = nowIso()
  await env.DB.prepare("UPDATE groups SET status = 'ARCHIVED', updated_at = ? WHERE id = ? AND organization_id = ?")
    .bind(timestamp, groupId, user.organizationId).run()
  await recordAudit(env, user, 'GROUP_ARCHIVED', 'group', groupId)
  return json({ ok: true })
}

export async function handleGroupMembers(env: RuntimeEnv, user: AuthUser, groupId: string): Promise<Response> {
  requireAdmin(user)
  await ensureGroup(env, user, groupId)
  const result = await env.DB.prepare(
    `SELECT u.id, u.username, COALESCE(u.display_name, u.username) AS display_name,
            u.account_type, u.lifecycle_status, gm.added_at
       FROM group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ? AND u.organization_id = ? ORDER BY u.display_name COLLATE NOCASE`
  ).bind(groupId, user.organizationId).all<Record<string, unknown>>()
  return json({ members: result.results.map((row) => ({
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    accountType: String(row.account_type),
    status: String(row.lifecycle_status),
    addedAt: String(row.added_at)
  })) })
}

export async function handleGroupMembersReplace(request: Request, env: RuntimeEnv, user: AuthUser, groupId: string): Promise<Response> {
  requireAdmin(user)
  const group = await ensureGroup(env, user, groupId)
  if (group.status !== 'ACTIVE') throw new HttpError(409, 'GROUP_ARCHIVED')
  const input = await requestJson(request, groupMembersSchema)
  const userIds = [...new Set(input.userIds)]
  if (userIds.length > 0) {
    const placeholders = userIds.map(() => '?').join(',')
    const found = await env.DB.prepare(
      `SELECT id FROM users WHERE organization_id = ? AND lifecycle_status != 'DEACTIVATED' AND id IN (${placeholders})`
    ).bind(user.organizationId, ...userIds).all<{ id: string }>()
    if (found.results.length !== userIds.length) throw new HttpError(400, 'GROUP_MEMBER_INVALID')
  }
  const timestamp = nowIso()
  const statements = [env.DB.prepare('DELETE FROM group_members WHERE group_id = ?').bind(groupId)]
  for (const userId of userIds) {
    statements.push(env.DB.prepare(
      'INSERT INTO group_members(group_id, user_id, added_by_user_id, added_at) VALUES (?, ?, ?, ?)'
    ).bind(groupId, userId, user.id, timestamp))
  }
  statements.push(env.DB.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').bind(timestamp, groupId))
  await env.DB.batch(statements)
  await recordAudit(env, user, 'GROUP_MEMBERS_REPLACED', 'group', groupId, { userIds })
  return json({ ok: true, count: userIds.length })
}

async function accessCatalog(env: RuntimeEnv, user: AuthUser, workspaceId: string): Promise<{
  files: unknown[]
  folders: string[]
  storages: unknown[]
}> {
  const files = await env.DB.prepare(
    `SELECT id, logical_name, relative_path, home_storage_connection_id, current_version, status
       FROM files WHERE workspace_id = ? AND status != 'deleted' ORDER BY relative_path COLLATE NOCASE LIMIT 2000`
  ).bind(workspaceId).all<Record<string, unknown>>()
  const folders = new Set<string>()
  for (const row of files.results) {
    const parts = String(row.relative_path).split('/')
    for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join('/'))
  }
  const storages = await env.DB.prepare(
    `SELECT id, name, status FROM storage_connections WHERE organization_id = ? ORDER BY name COLLATE NOCASE`
  ).bind(user.organizationId).all<Record<string, unknown>>()
  return { files: files.results, folders: [...folders].sort((a, b) => a.localeCompare(b, 'zh-CN')), storages: storages.results }
}

export async function handleGroupResourceAccessGet(
  env: RuntimeEnv,
  user: AuthUser,
  workspaceId: string,
  groupId: string
): Promise<Response> {
  await requireWorkspaceManager(env, user, workspaceId)
  const group = await ensureGroup(env, user, groupId)
  const rules = await env.DB.prepare(
    `SELECT id, scope_type, scope_value, permission, created_at, updated_at
       FROM resource_access_rules
      WHERE organization_id = ? AND workspace_id = ? AND principal_type = 'GROUP' AND principal_id = ?
      ORDER BY scope_type, scope_value COLLATE NOCASE`
  ).bind(user.organizationId, workspaceId, groupId).all()
  const catalog = await accessCatalog(env, user, workspaceId)
  return json({ group: { id: group.id, name: group.name }, rules: rules.results, ...catalog })
}

function normalizeFolder(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/')
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new HttpError(400, 'INVALID_RESOURCE_SCOPE')
  return normalized
}

async function normalizeGroupScope(
  env: RuntimeEnv,
  user: AuthUser,
  workspaceId: string,
  scope: { scopeType: ResourceScopeType; scopeValue: string }
): Promise<{ scopeType: ResourceScopeType; scopeValue: string }> {
  if (scope.scopeType === 'WORKSPACE') return { scopeType: 'WORKSPACE', scopeValue: workspaceId }
  if (scope.scopeType === 'FOLDER') return { scopeType: 'FOLDER', scopeValue: normalizeFolder(scope.scopeValue) }
  if (scope.scopeType === 'FILE') {
    const row = await env.DB.prepare('SELECT id FROM files WHERE id = ? AND workspace_id = ? LIMIT 1')
      .bind(scope.scopeValue, workspaceId).first<{ id: string }>()
    if (!row) throw new HttpError(400, 'RESOURCE_FILE_INVALID')
    return scope
  }
  const storage = await env.DB.prepare('SELECT id FROM storage_connections WHERE id = ? AND organization_id = ? LIMIT 1')
    .bind(scope.scopeValue, user.organizationId).first<{ id: string }>()
  if (!storage) throw new HttpError(400, 'RESOURCE_STORAGE_INVALID')
  return scope
}

export async function handleGroupResourceAccessReplace(
  request: Request,
  env: RuntimeEnv,
  user: AuthUser,
  workspaceId: string,
  groupId: string
): Promise<Response> {
  await requireWorkspaceManager(env, user, workspaceId)
  const group = await ensureGroup(env, user, groupId)
  if (group.status !== 'ACTIVE') throw new HttpError(409, 'GROUP_ARCHIVED')
  const input = await requestJson(request, groupAccessSchema)
  const normalized: Array<{ scopeType: ResourceScopeType; scopeValue: string }> = []
  for (const scope of input.scopes) normalized.push(await normalizeGroupScope(env, user, workspaceId, scope))
  const unique = [...new Map(normalized.map((scope) => [`${scope.scopeType}:${scope.scopeValue}`, scope])).values()]
  const timestamp = nowIso()
  const statements = [
    env.DB.prepare("DELETE FROM resource_access_rules WHERE workspace_id = ? AND principal_type = 'GROUP' AND principal_id = ?")
      .bind(workspaceId, groupId)
  ]
  for (const scope of unique) {
    statements.push(env.DB.prepare(
      `INSERT INTO resource_access_rules(
         id, organization_id, workspace_id, principal_type, principal_id,
         scope_type, scope_value, permission, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, 'GROUP', ?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), user.organizationId, workspaceId, groupId, scope.scopeType, scope.scopeValue,
      input.permission, user.id, timestamp, timestamp))
  }
  await env.DB.batch(statements)
  await recordAudit(env, user, 'GROUP_RESOURCE_ACCESS_REPLACED', 'group', groupId, {
    workspaceId,
    permission: input.permission,
    scopes: unique
  })
  return json({ ok: true, permission: input.permission, scopes: unique })
}

const PRESENCE_TTL_MS = 120_000

async function prunePresence(env: RuntimeEnv, fileId?: string): Promise<void> {
  const cutoff = new Date(Date.now() - PRESENCE_TTL_MS).toISOString()
  if (fileId) {
    await env.DB.prepare(
      `DELETE FROM file_presence
        WHERE file_id = ? AND (
          last_seen_at <= ? OR session_id IS NULL OR session_id NOT IN (
            SELECT id FROM sessions WHERE revoked_at IS NULL AND expires_at > ?
          )
        )`
    ).bind(fileId, cutoff, nowIso()).run()
  } else {
    await env.DB.prepare(
      `DELETE FROM file_presence
        WHERE last_seen_at <= ? OR session_id IS NULL OR session_id NOT IN (
          SELECT id FROM sessions WHERE revoked_at IS NULL AND expires_at > ?
        )`
    ).bind(cutoff, nowIso()).run()
  }
}

async function presencePayload(env: RuntimeEnv, auth: RequestAuth, fileId: string): Promise<Response> {
  await prunePresence(env, fileId)
  const rows = await env.DB.prepare(
    `SELECT p.user_id, COALESCE(u.display_name, u.username) AS display_name, u.username,
            p.device_id, d.device_name, p.state, p.started_at, p.last_seen_at
       FROM file_presence p
       JOIN users u ON u.id = p.user_id
       JOIN devices d ON d.id = p.device_id
      WHERE p.file_id = ?
      ORDER BY p.last_seen_at DESC`
  ).bind(fileId).all<Record<string, unknown>>()
  const entries = rows.results.map((row) => ({
    userId: String(row.user_id),
    displayName: String(row.display_name),
    username: String(row.username),
    deviceId: String(row.device_id),
    deviceName: String(row.device_name),
    state: String(row.state),
    startedAt: String(row.started_at),
    lastSeenAt: String(row.last_seen_at),
    currentUser: String(row.user_id) === auth.user.id,
    currentDevice: String(row.device_id) === auth.deviceId
  }))
  return json({
    fileId,
    activeUserCount: new Set(entries.map((row) => row.userId)).size,
    editingUserCount: new Set(entries.filter((row) => row.state === 'EDITING').map((row) => row.userId)).size,
    entries
  })
}

export async function handlePresenceGet(env: RuntimeEnv, auth: RequestAuth, fileId: string): Promise<Response> {
  if (!(await resolveFileAccess(env, auth.user, fileId, 'VIEWER'))) throw new HttpError(404, 'FILE_NOT_FOUND')
  return presencePayload(env, auth, fileId)
}

export async function handlePresenceUpsert(request: Request, env: RuntimeEnv, auth: RequestAuth, fileId: string): Promise<Response> {
  if (!auth.deviceId) throw new HttpError(409, 'DEVICE_REGISTRATION_REQUIRED')
  const input = await requestJson(request, presenceSchema)
  const required = input.state === 'EDITING' ? 'EDITOR' : 'VIEWER'
  if (!(await resolveFileAccess(env, auth.user, fileId, required))) throw new HttpError(404, 'FILE_NOT_FOUND')
  const timestamp = nowIso()
  await env.DB.prepare(
    `INSERT INTO file_presence(file_id, user_id, device_id, session_id, state, started_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_id, user_id, device_id) DO UPDATE SET
       session_id = excluded.session_id,
       state = excluded.state,
       last_seen_at = excluded.last_seen_at`
  ).bind(fileId, auth.user.id, auth.deviceId, auth.sessionId, input.state, timestamp, timestamp).run()
  await env.DB.prepare('UPDATE devices SET last_seen_at = ?, status = \'ACTIVE\' WHERE id = ? AND user_id = ?')
    .bind(timestamp, auth.deviceId, auth.user.id).run()
  return presencePayload(env, auth, fileId)
}

export async function handlePresenceClear(env: RuntimeEnv, auth: RequestAuth, fileId: string): Promise<Response> {
  if (auth.deviceId) {
    await env.DB.prepare('DELETE FROM file_presence WHERE file_id = ? AND user_id = ? AND device_id = ?')
      .bind(fileId, auth.user.id, auth.deviceId).run()
  }
  return json({ ok: true })
}

function parseVersion(value: string): [number, number, number] {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0]
}

function versionLessThan(a: string, b: string): boolean {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! < right[index]!
  }
  return false
}

export async function handleClientVersion(request: Request, env: RuntimeEnv): Promise<Response> {
  const url = new URL(request.url)
  const current = url.searchParams.get('current')?.trim() || '0.0.0'
  const stableDeviceId = url.searchParams.get('device')?.trim() || ''
  const latest = env.CLIENT_LATEST_VERSION?.trim() || '1.4.1'
  const minimum = env.CLIENT_MINIMUM_VERSION?.trim() || '1.3.1'
  const rolloutRaw = Number(env.CLIENT_ROLLOUT_PERCENT ?? 100)
  const rollout = Number.isFinite(rolloutRaw) ? Math.max(0, Math.min(100, Math.floor(rolloutRaw))) : 100
  const updateRequired = versionLessThan(current, minimum)
  let inRollout = rollout >= 100
  if (!inRollout && stableDeviceId) {
    const digest = await sha256Text(stableDeviceId)
    inRollout = Number.parseInt(digest.slice(0, 8), 16) % 100 < rollout
  }
  return json({
    latest,
    minimum,
    mandatory: updateRequired,
    rollout,
    apiVersion: env.API_VERSION?.trim() || '2026-08-31',
    updateUrl: env.CLIENT_UPDATE_URL?.trim() || null,
    updateAvailable: versionLessThan(current, latest) && (updateRequired || inRollout),
    updateRequired
  })
}
