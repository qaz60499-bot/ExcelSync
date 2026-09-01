import { z } from 'zod'
import {
  canCreateResourceAtPath,
  getEffectiveWorkspaceRole,
  isSystemAdmin,
  resolveFileAccess,
  workspaceRoleAtLeast,
  type AuthUser
} from './access'
import type { RequestAuth } from './collaboration'
import { HttpError, json, requestJson } from './http'
import { StorageRouter } from './storage-router'

export type UpgradeRuntimeEnv = Env & {
  TELEGRAM_BOT_TOKEN?: string
  STORAGE_MASTER_KEY?: string
}

const LEASE_TTL_MS = 90_000
const NOTIFICATION_READ_RETENTION_DAYS = 90
const NOTIFICATION_UNREAD_RETENTION_DAYS = 180

const acquireLeaseSchema = z.object({ leaseId: z.string().uuid().optional() })
const heartbeatLeaseSchema = z.object({ leaseId: z.string().uuid() })
const releaseLeaseSchema = z.object({ leaseId: z.string().uuid() })
const commentCreateSchema = z.object({
  body: z.string().trim().min(1).max(8000),
  parentCommentId: z.string().uuid().nullable().optional(),
  fileVersion: z.number().int().positive().nullable().optional()
})
const rewindSchema = z.object({
  workspaceId: z.string().uuid(),
  scopeType: z.enum(['FOLDER', 'WORKSPACE']),
  scopeValue: z.string().max(1000).default(''),
  targetTime: z.string().datetime(),
  idempotencyKey: z.string().min(16).max(160).optional()
})

function nowIso(): string {
  return new Date().toISOString()
}

function expiresIso(ms = LEASE_TTL_MS): string {
  return new Date(Date.now() + ms).toISOString()
}

function safeJson(value: unknown): string | null {
  if (value == null) return null
  return JSON.stringify(value).slice(0, 8000)
}

function normalizeFolder(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/')
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new HttpError(400, 'INVALID_FOLDER')
  return normalized
}

export async function recordDomainEvent(
  env: UpgradeRuntimeEnv,
  input: {
    organizationId: string
    workspaceId?: string | null
    fileId?: string | null
    actorUserId?: string | null
    eventKey: string
    eventType: string
    category?: 'FILE' | 'TASK' | 'SYSTEM' | 'SECURITY' | 'COLLABORATION' | 'RECOVERY'
    targetType: string
    targetId?: string | null
    detail?: unknown
    createdAt?: string
  }
): Promise<string> {
  const id = crypto.randomUUID()
  const createdAt = input.createdAt ?? nowIso()
  await env.DB.prepare(
    `INSERT OR IGNORE INTO domain_events(
       id, organization_id, workspace_id, file_id, actor_user_id, event_key,
       event_type, category, target_type, target_id, detail_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    input.organizationId,
    input.workspaceId ?? null,
    input.fileId ?? null,
    input.actorUserId ?? null,
    input.eventKey.slice(0, 500),
    input.eventType,
    input.category ?? 'FILE',
    input.targetType,
    input.targetId ?? null,
    safeJson(input.detail),
    createdAt
  ).run()
  const existing = await env.DB.prepare('SELECT id FROM domain_events WHERE event_key = ? LIMIT 1')
    .bind(input.eventKey.slice(0, 500)).first<{ id: string }>()
  return existing?.id ?? id
}

export async function createNotification(
  env: UpgradeRuntimeEnv,
  input: {
    organizationId: string
    recipientUserId: string
    eventId: string
    category: 'FILE' | 'TASK' | 'SYSTEM' | 'SECURITY' | 'COLLABORATION' | 'RECOVERY'
    title: string
    body?: string
    resourceType?: string | null
    resourceId?: string | null
    commentId?: string | null
    expiresAt?: string | null
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO notifications(
       id, organization_id, recipient_user_id, event_id, category, title, body,
       resource_type, resource_id, comment_id, created_at, read_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  ).bind(
    crypto.randomUUID(),
    input.organizationId,
    input.recipientUserId,
    input.eventId,
    input.category,
    input.title.slice(0, 240),
    (input.body ?? '').slice(0, 2000),
    input.resourceType ?? null,
    input.resourceId ?? null,
    input.commentId ?? null,
    nowIso(),
    input.expiresAt ?? null
  ).run()
}

export async function recordFileStateSnapshot(
  env: UpgradeRuntimeEnv,
  fileId: string,
  eventType: string,
  actorUserId: string | null,
  sourceEventId?: string | null
): Promise<void> {
  const file = await env.DB.prepare(
    `SELECT id, workspace_id, logical_name, relative_path, status, current_version
       FROM files WHERE id = ? LIMIT 1`
  ).bind(fileId).first<{
    id: string
    workspace_id: string | null
    logical_name: string
    relative_path: string
    status: 'active' | 'trashed' | 'deleted'
    current_version: number
  }>()
  if (!file?.workspace_id) return
  await env.DB.prepare(
    `INSERT INTO file_state_history(
       id, file_id, workspace_id, logical_name, relative_path, status,
       content_version, event_type, actor_user_id, created_at, source_event_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(), file.id, file.workspace_id, file.logical_name, file.relative_path,
    file.status, file.current_version, eventType, actorUserId, nowIso(), sourceEventId ?? null
  ).run()
}

async function pruneExpiredLeases(env: UpgradeRuntimeEnv, fileId?: string): Promise<void> {
  const timestamp = nowIso()
  if (fileId) await env.DB.prepare('DELETE FROM file_edit_leases WHERE file_id = ? AND expires_at <= ?').bind(fileId, timestamp).run()
  else await env.DB.prepare('DELETE FROM file_edit_leases WHERE expires_at <= ?').bind(timestamp).run()
}

export async function assertFileLeaseCompatible(env: UpgradeRuntimeEnv, auth: RequestAuth, fileId: string): Promise<void> {
  await pruneExpiredLeases(env, fileId)
  const lease = await env.DB.prepare(
    'SELECT owner_user_id, owner_device_id, lease_id, heartbeat_at, expires_at FROM file_edit_leases WHERE file_id = ? LIMIT 1'
  ).bind(fileId).first<{ owner_user_id: string; owner_device_id: string; lease_id: string; heartbeat_at: string; expires_at: string }>()
  if (!lease) return
  if (lease.owner_user_id === auth.user.id && auth.deviceId && lease.owner_device_id === auth.deviceId) return
  throw new HttpError(409, 'FILE_LOCKED', 'FILE_LOCKED', {
    leaseId: lease.lease_id,
    ownerUserId: lease.owner_user_id,
    ownerDeviceId: lease.owner_device_id,
    heartbeatAt: lease.heartbeat_at,
    expiresAt: lease.expires_at
  })
}

async function leasePayload(env: UpgradeRuntimeEnv, auth: RequestAuth, fileId: string): Promise<Record<string, unknown>> {
  await pruneExpiredLeases(env, fileId)
  const row = await env.DB.prepare(
    `SELECT l.file_id, l.workspace_id, l.owner_user_id, l.owner_device_id, l.lease_id,
            l.lock_type, l.created_at, l.heartbeat_at, l.expires_at,
            COALESCE(u.display_name, u.username) AS display_name, u.username,
            d.device_name
       FROM file_edit_leases l
       JOIN users u ON u.id = l.owner_user_id
       JOIN devices d ON d.id = l.owner_device_id
      WHERE l.file_id = ? LIMIT 1`
  ).bind(fileId).first<Record<string, unknown>>()
  if (!row) return { fileId, locked: false }
  return {
    fileId,
    locked: true,
    workspaceId: String(row.workspace_id),
    ownerUserId: String(row.owner_user_id),
    ownerDisplayName: String(row.display_name),
    ownerUsername: String(row.username),
    ownerDeviceId: String(row.owner_device_id),
    ownerDeviceName: String(row.device_name),
    leaseId: String(row.lease_id),
    lockType: String(row.lock_type),
    createdAt: String(row.created_at),
    heartbeatAt: String(row.heartbeat_at),
    expiresAt: String(row.expires_at),
    currentUser: String(row.owner_user_id) === auth.user.id,
    currentDevice: String(row.owner_device_id) === auth.deviceId
  }
}

export async function handleFileLeaseGet(env: UpgradeRuntimeEnv, auth: RequestAuth, fileId: string): Promise<Response> {
  if (!(await resolveFileAccess(env, auth.user, fileId, 'VIEWER'))) throw new HttpError(404, 'FILE_NOT_FOUND')
  return json(await leasePayload(env, auth, fileId))
}

export async function handleFileLeaseAcquire(request: Request, env: UpgradeRuntimeEnv, auth: RequestAuth, fileId: string): Promise<Response> {
  if (!auth.deviceId) throw new HttpError(409, 'DEVICE_REGISTRATION_REQUIRED')
  const access = await resolveFileAccess(env, auth.user, fileId, 'EDITOR')
  if (!access) throw new HttpError(404, 'FILE_NOT_FOUND')
  const input = await requestJson(request, acquireLeaseSchema)
  await pruneExpiredLeases(env, fileId)
  const existing = await env.DB.prepare('SELECT owner_user_id, owner_device_id, lease_id FROM file_edit_leases WHERE file_id = ? LIMIT 1')
    .bind(fileId).first<{ owner_user_id: string; owner_device_id: string; lease_id: string }>()
  const timestamp = nowIso()
  const leaseId = existing?.owner_user_id === auth.user.id && existing.owner_device_id === auth.deviceId
    ? existing.lease_id
    : (input.leaseId ?? crypto.randomUUID())

  if (existing && (existing.owner_user_id !== auth.user.id || existing.owner_device_id !== auth.deviceId)) {
    throw new HttpError(409, 'FILE_LOCKED', 'FILE_LOCKED', await leasePayload(env, auth, fileId))
  }

  try {
    await env.DB.prepare(
      `INSERT INTO file_edit_leases(
         file_id, workspace_id, owner_user_id, owner_device_id, owner_session_id,
         lease_id, lock_type, created_at, heartbeat_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'EDIT', ?, ?, ?)
       ON CONFLICT(file_id) DO UPDATE SET
         owner_session_id = excluded.owner_session_id,
         heartbeat_at = excluded.heartbeat_at,
         expires_at = excluded.expires_at
       WHERE file_edit_leases.owner_user_id = excluded.owner_user_id
         AND file_edit_leases.owner_device_id = excluded.owner_device_id`
    ).bind(fileId, access.workspaceId, auth.user.id, auth.deviceId, auth.sessionId, leaseId, timestamp, timestamp, expiresIso()).run()
  } catch {
    throw new HttpError(409, 'FILE_LOCKED', 'FILE_LOCKED', await leasePayload(env, auth, fileId))
  }

  await env.DB.prepare(
    `INSERT INTO file_presence(file_id, user_id, device_id, session_id, state, started_at, last_seen_at)
     VALUES (?, ?, ?, ?, 'EDITING', ?, ?)
     ON CONFLICT(file_id, user_id, device_id) DO UPDATE SET
       session_id = excluded.session_id, state = 'EDITING', last_seen_at = excluded.last_seen_at`
  ).bind(fileId, auth.user.id, auth.deviceId, auth.sessionId, timestamp, timestamp).run()

  const eventId = await recordDomainEvent(env, {
    organizationId: auth.user.organizationId,
    workspaceId: access.workspaceId,
    fileId,
    actorUserId: auth.user.id,
    eventKey: `lease-acquired:${fileId}:${leaseId}`,
    eventType: 'FILE_LOCK_ACQUIRED',
    category: 'COLLABORATION',
    targetType: 'file',
    targetId: fileId,
    detail: { deviceId: auth.deviceId, leaseId }
  })
  void eventId
  return json(await leasePayload(env, auth, fileId), 201)
}

export async function handleFileLeaseHeartbeat(request: Request, env: UpgradeRuntimeEnv, auth: RequestAuth, fileId: string): Promise<Response> {
  if (!auth.deviceId) throw new HttpError(409, 'DEVICE_REGISTRATION_REQUIRED')
  if (!(await resolveFileAccess(env, auth.user, fileId, 'EDITOR'))) throw new HttpError(404, 'FILE_NOT_FOUND')
  const input = await requestJson(request, heartbeatLeaseSchema)
  await pruneExpiredLeases(env, fileId)
  const timestamp = nowIso()
  const result = await env.DB.prepare(
    `UPDATE file_edit_leases SET owner_session_id = ?, heartbeat_at = ?, expires_at = ?
      WHERE file_id = ? AND owner_user_id = ? AND owner_device_id = ? AND lease_id = ?`
  ).bind(auth.sessionId, timestamp, expiresIso(), fileId, auth.user.id, auth.deviceId, input.leaseId).run()
  if ((result.meta.changes ?? 0) !== 1) throw new HttpError(409, 'LEASE_LOST', 'LEASE_LOST', await leasePayload(env, auth, fileId))
  await env.DB.prepare(
    `UPDATE file_presence SET session_id = ?, state = 'EDITING', last_seen_at = ?
      WHERE file_id = ? AND user_id = ? AND device_id = ?`
  ).bind(auth.sessionId, timestamp, fileId, auth.user.id, auth.deviceId).run()
  return json(await leasePayload(env, auth, fileId))
}

export async function handleFileLeaseRelease(request: Request, env: UpgradeRuntimeEnv, auth: RequestAuth, fileId: string): Promise<Response> {
  if (!auth.deviceId) return json({ ok: true })
  const input = await requestJson(request, releaseLeaseSchema)
  const lease = await env.DB.prepare('SELECT workspace_id FROM file_edit_leases WHERE file_id = ? AND owner_user_id = ? AND owner_device_id = ? AND lease_id = ? LIMIT 1')
    .bind(fileId, auth.user.id, auth.deviceId, input.leaseId).first<{ workspace_id: string }>()
  if (!lease) return json({ ok: true })
  await env.DB.batch([
    env.DB.prepare('DELETE FROM file_edit_leases WHERE file_id = ? AND owner_user_id = ? AND owner_device_id = ? AND lease_id = ?')
      .bind(fileId, auth.user.id, auth.deviceId, input.leaseId),
    env.DB.prepare("UPDATE file_presence SET state = 'OPEN', last_seen_at = ? WHERE file_id = ? AND user_id = ? AND device_id = ?")
      .bind(nowIso(), fileId, auth.user.id, auth.deviceId)
  ])
  await recordDomainEvent(env, {
    organizationId: auth.user.organizationId,
    workspaceId: lease.workspace_id,
    fileId,
    actorUserId: auth.user.id,
    eventKey: `lease-released:${fileId}:${input.leaseId}`,
    eventType: 'FILE_LOCK_RELEASED',
    category: 'COLLABORATION',
    targetType: 'file',
    targetId: fileId
  })
  return json({ ok: true })
}

export async function handleFileLeaseTakeoverRequest(env: UpgradeRuntimeEnv, auth: RequestAuth, fileId: string): Promise<Response> {
  const access = await resolveFileAccess(env, auth.user, fileId, 'EDITOR')
  if (!access) throw new HttpError(404, 'FILE_NOT_FOUND')
  await pruneExpiredLeases(env, fileId)
  const lease = await env.DB.prepare('SELECT owner_user_id, lease_id FROM file_edit_leases WHERE file_id = ? LIMIT 1')
    .bind(fileId).first<{ owner_user_id: string; lease_id: string }>()
  if (!lease) return json({ ok: true, requested: false, reason: 'UNLOCKED' })
  if (lease.owner_user_id === auth.user.id) return json({ ok: true, requested: false, reason: 'OWN_LOCK' })
  const eventId = await recordDomainEvent(env, {
    organizationId: auth.user.organizationId,
    workspaceId: access.workspaceId,
    fileId,
    actorUserId: auth.user.id,
    eventKey: `lease-takeover-request:${fileId}:${lease.lease_id}:${auth.user.id}`,
    eventType: 'FILE_LOCK_TAKEOVER_REQUESTED',
    category: 'COLLABORATION',
    targetType: 'file',
    targetId: fileId,
    detail: { requestedBy: auth.user.id }
  })
  await createNotification(env, {
    organizationId: auth.user.organizationId,
    recipientUserId: lease.owner_user_id,
    eventId,
    category: 'COLLABORATION',
    title: '有人请求接管你正在编辑的文件',
    body: `${auth.user.displayName} 请求接管编辑锁。`,
    resourceType: 'file',
    resourceId: fileId
  })
  return json({ ok: true, requested: true })
}

export async function handleFileLeaseForceTakeover(env: UpgradeRuntimeEnv, auth: RequestAuth, fileId: string): Promise<Response> {
  if (!auth.deviceId) throw new HttpError(409, 'DEVICE_REGISTRATION_REQUIRED')
  const access = await resolveFileAccess(env, auth.user, fileId, 'EDITOR')
  if (!access) throw new HttpError(404, 'FILE_NOT_FOUND')
  if (!isSystemAdmin(auth.user) && !workspaceRoleAtLeast(access.workspaceRole, 'MANAGER')) throw new HttpError(403, 'LOCK_TAKEOVER_FORBIDDEN')
  await pruneExpiredLeases(env, fileId)
  const previous = await env.DB.prepare('SELECT owner_user_id, owner_device_id, lease_id FROM file_edit_leases WHERE file_id = ? LIMIT 1')
    .bind(fileId).first<{ owner_user_id: string; owner_device_id: string; lease_id: string }>()
  const leaseId = crypto.randomUUID()
  const timestamp = nowIso()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM file_edit_leases WHERE file_id = ?').bind(fileId),
    env.DB.prepare(
      `INSERT INTO file_edit_leases(
         file_id, workspace_id, owner_user_id, owner_device_id, owner_session_id,
         lease_id, lock_type, created_at, heartbeat_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'EDIT', ?, ?, ?)`
    ).bind(fileId, access.workspaceId, auth.user.id, auth.deviceId, auth.sessionId, leaseId, timestamp, timestamp, expiresIso()),
    env.DB.prepare(
      `INSERT INTO file_presence(file_id, user_id, device_id, session_id, state, started_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'EDITING', ?, ?)
       ON CONFLICT(file_id, user_id, device_id) DO UPDATE SET session_id = excluded.session_id, state = 'EDITING', last_seen_at = excluded.last_seen_at`
    ).bind(fileId, auth.user.id, auth.deviceId, auth.sessionId, timestamp, timestamp)
  ])
  const eventId = await recordDomainEvent(env, {
    organizationId: auth.user.organizationId,
    workspaceId: access.workspaceId,
    fileId,
    actorUserId: auth.user.id,
    eventKey: `lease-force-takeover:${fileId}:${leaseId}`,
    eventType: 'FILE_LOCK_FORCE_TAKEOVER',
    category: 'COLLABORATION',
    targetType: 'file',
    targetId: fileId,
    detail: previous ?? {}
  })
  if (previous && previous.owner_user_id !== auth.user.id) {
    await createNotification(env, {
      organizationId: auth.user.organizationId,
      recipientUserId: previous.owner_user_id,
      eventId,
      category: 'COLLABORATION',
      title: '你的编辑锁已被管理员接管',
      body: `${auth.user.displayName} 已接管该文件编辑锁。`,
      resourceType: 'file',
      resourceId: fileId
    })
  }
  return json(await leasePayload(env, auth, fileId))
}

export async function handleAdminActiveLocks(env: UpgradeRuntimeEnv, user: AuthUser): Promise<Response> {
  if (!isSystemAdmin(user)) throw new HttpError(403, 'FORBIDDEN')
  await pruneExpiredLeases(env)
  const result = await env.DB.prepare(
    `SELECT l.file_id, l.workspace_id, l.owner_user_id, l.owner_device_id, l.lease_id,
            l.created_at, l.heartbeat_at, l.expires_at, f.logical_name, f.relative_path,
            COALESCE(u.display_name, u.username) AS owner_name, d.device_name, w.name AS workspace_name
       FROM file_edit_leases l
       JOIN files f ON f.id = l.file_id
       JOIN workspaces w ON w.id = l.workspace_id AND w.organization_id = ?
       JOIN users u ON u.id = l.owner_user_id
       JOIN devices d ON d.id = l.owner_device_id
      ORDER BY l.heartbeat_at DESC LIMIT 500`
  ).bind(user.organizationId).all()
  return json({ locks: result.results })
}

async function canReadNotificationResource(env: UpgradeRuntimeEnv, user: AuthUser, row: Record<string, unknown>): Promise<boolean> {
  const type = row.resource_type == null ? null : String(row.resource_type)
  const id = row.resource_id == null ? null : String(row.resource_id)
  if (!type || !id) return true
  if (type === 'file') return Boolean(await resolveFileAccess(env, user, id, 'VIEWER'))
  if (type === 'workspace') return Boolean(await getEffectiveWorkspaceRole(env, user, id))
  if (type === 'task') {
    const task = await env.DB.prepare('SELECT workspace_id FROM tasks WHERE id = ? LIMIT 1').bind(id).first<{ workspace_id: string }>()
    return Boolean(task && await getEffectiveWorkspaceRole(env, user, task.workspace_id))
  }
  return true
}

async function pruneNotifications(env: UpgradeRuntimeEnv, userId: string): Promise<void> {
  const readCutoff = new Date(Date.now() - NOTIFICATION_READ_RETENTION_DAYS * 86_400_000).toISOString()
  const unreadCutoff = new Date(Date.now() - NOTIFICATION_UNREAD_RETENTION_DAYS * 86_400_000).toISOString()
  await env.DB.prepare(
    `DELETE FROM notifications
      WHERE recipient_user_id = ? AND (
        (read_at IS NOT NULL AND created_at < ?) OR
        (read_at IS NULL AND created_at < ?) OR
        (expires_at IS NOT NULL AND expires_at < ?)
      )`
  ).bind(userId, readCutoff, unreadCutoff, nowIso()).run()
}

async function ensureTaskDueNotifications(env: UpgradeRuntimeEnv, user: AuthUser): Promise<void> {
  const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const rows = await env.DB.prepare(
    `SELECT t.id, t.workspace_id, t.title, t.due_at
       FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.assignee_user_id = ? AND t.status != 'DONE' AND t.due_at IS NOT NULL
        AND t.due_at > ? AND t.due_at <= ? AND w.organization_id = ?
      ORDER BY t.due_at ASC LIMIT 100`
  ).bind(user.id, nowIso(), until, user.organizationId).all<{ id: string; workspace_id: string; title: string; due_at: string }>()
  for (const task of rows.results) {
    const eventId = await recordDomainEvent(env, {
      organizationId: user.organizationId,
      workspaceId: task.workspace_id,
      actorUserId: null,
      eventKey: `task-due:${task.id}:${task.due_at}`,
      eventType: 'TASK_DUE_SOON',
      category: 'TASK',
      targetType: 'task',
      targetId: task.id,
      detail: { dueAt: task.due_at }
    })
    await createNotification(env, {
      organizationId: user.organizationId,
      recipientUserId: user.id,
      eventId,
      category: 'TASK',
      title: '任务即将到期',
      body: task.title,
      resourceType: 'task',
      resourceId: task.id
    })
  }
}

export async function handleNotifications(request: Request, env: UpgradeRuntimeEnv, user: AuthUser): Promise<Response> {
  await pruneNotifications(env, user.id)
  await ensureTaskDueNotifications(env, user)
  const url = new URL(request.url)
  const filter = url.searchParams.get('filter') ?? 'all'
  const cursor = url.searchParams.get('cursor')
  const rows = await env.DB.prepare(
    `SELECT id, event_id, category, title, body, resource_type, resource_id, comment_id, created_at, read_at, expires_at
       FROM notifications
      WHERE recipient_user_id = ? AND (? IS NULL OR created_at < ?)
      ORDER BY created_at DESC LIMIT 200`
  ).bind(user.id, cursor, cursor).all<Record<string, unknown>>()
  const visible: Record<string, unknown>[] = []
  for (const row of rows.results) {
    if (filter === 'unread' && row.read_at != null) continue
    if (filter === 'file' && row.category !== 'FILE' && row.category !== 'COLLABORATION') continue
    if (filter === 'task' && row.category !== 'TASK') continue
    if (filter === 'system' && !['SYSTEM', 'SECURITY', 'RECOVERY'].includes(String(row.category))) continue
    if (!(await canReadNotificationResource(env, user, row))) continue
    visible.push(row)
    if (visible.length >= 100) break
  }
  const unread = await env.DB.prepare('SELECT COUNT(*) AS count FROM notifications WHERE recipient_user_id = ? AND read_at IS NULL')
    .bind(user.id).first<{ count: number }>()
  return json({ notifications: visible, unreadCount: Number(unread?.count ?? 0), nextCursor: visible.at(-1)?.created_at ?? null })
}

export async function handleNotificationRead(env: UpgradeRuntimeEnv, user: AuthUser, notificationId: string): Promise<Response> {
  const result = await env.DB.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND recipient_user_id = ?')
    .bind(nowIso(), notificationId, user.id).run()
  if ((result.meta.changes ?? 0) !== 1) throw new HttpError(404, 'NOTIFICATION_NOT_FOUND')
  return json({ ok: true })
}

export async function handleNotificationReadAll(env: UpgradeRuntimeEnv, user: AuthUser): Promise<Response> {
  const result = await env.DB.prepare('UPDATE notifications SET read_at = ? WHERE recipient_user_id = ? AND read_at IS NULL')
    .bind(nowIso(), user.id).run()
  return json({ ok: true, changed: Number(result.meta.changes ?? 0) })
}

async function parseMentionUsers(env: UpgradeRuntimeEnv, user: AuthUser, fileId: string, body: string): Promise<Array<{ id: string; display_name: string }>> {
  const names = [...new Set([...body.matchAll(/(?:^|\s)@([A-Za-z0-9_.-]{3,64})\b/g)].map((match) => match[1]!.toLowerCase()))]
  const users: Array<{ id: string; display_name: string }> = []
  for (const name of names.slice(0, 50)) {
    const row = await env.DB.prepare(
      `SELECT id, username, COALESCE(display_name, username) AS display_name, organization_id,
              system_role, lifecycle_status, account_type, access_expires_at
         FROM users
        WHERE organization_id = ? AND lower(username) = ? AND lifecycle_status = 'ACTIVE' LIMIT 1`
    ).bind(user.organizationId, name).first<{
      id: string
      username: string
      display_name: string
      organization_id: string
      system_role: AuthUser['systemRole']
      lifecycle_status: AuthUser['status']
      account_type: AuthUser['accountType']
      access_expires_at: string | null
    }>()
    if (!row || row.id === user.id) continue
    const mentionedUser: AuthUser = {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      organizationId: row.organization_id,
      systemRole: row.system_role,
      status: row.lifecycle_status,
      accountType: row.account_type,
      accessExpiresAt: row.access_expires_at
    }
    if (await resolveFileAccess(env, mentionedUser, fileId, 'VIEWER')) users.push({ id: row.id, display_name: row.display_name })
  }
  return users
}

async function commentPayload(env: UpgradeRuntimeEnv, fileId: string): Promise<Record<string, unknown>[]> {
  const result = await env.DB.prepare(
    `SELECT c.id, c.file_id, c.workspace_id, c.parent_comment_id, c.file_version, c.body,
            c.created_by_user_id, c.created_at, c.updated_at, c.resolved_at, c.resolved_by_user_id,
            COALESCE(u.display_name, u.username) AS created_by_name, u.username AS created_by_username,
            (SELECT json_group_array(cm.user_id) FROM comment_mentions cm WHERE cm.comment_id = c.id) AS mention_user_ids
       FROM file_comments c JOIN users u ON u.id = c.created_by_user_id
      WHERE c.file_id = ? ORDER BY c.created_at ASC LIMIT 1000`
  ).bind(fileId).all<Record<string, unknown>>()
  return result.results.map((row) => ({
    ...row,
    mention_user_ids: (() => {
      try { return JSON.parse(String(row.mention_user_ids ?? '[]')) as string[] } catch { return [] }
    })()
  }))
}

export async function handleCommentsList(env: UpgradeRuntimeEnv, user: AuthUser, fileId: string): Promise<Response> {
  if (!(await resolveFileAccess(env, user, fileId, 'VIEWER'))) throw new HttpError(404, 'FILE_NOT_FOUND')
  return json({ comments: await commentPayload(env, fileId) })
}

export async function handleCommentCreate(request: Request, env: UpgradeRuntimeEnv, user: AuthUser, fileId: string): Promise<Response> {
  const access = await resolveFileAccess(env, user, fileId, 'VIEWER')
  if (!access) throw new HttpError(404, 'FILE_NOT_FOUND')
  const input = await requestJson(request, commentCreateSchema)
  if (input.parentCommentId) {
    const parent = await env.DB.prepare('SELECT file_id, resolved_at FROM file_comments WHERE id = ? LIMIT 1')
      .bind(input.parentCommentId).first<{ file_id: string; resolved_at: string | null }>()
    if (!parent || parent.file_id !== fileId) throw new HttpError(400, 'COMMENT_PARENT_INVALID')
    if (parent.resolved_at) throw new HttpError(409, 'COMMENT_THREAD_RESOLVED')
  }
  if (input.fileVersion) {
    const version = await env.DB.prepare('SELECT 1 AS ok FROM file_versions WHERE file_id = ? AND version = ? LIMIT 1')
      .bind(fileId, input.fileVersion).first<{ ok: number }>()
    if (!version) throw new HttpError(400, 'COMMENT_VERSION_INVALID')
  }
  const id = crypto.randomUUID()
  const timestamp = nowIso()
  await env.DB.prepare(
    `INSERT INTO file_comments(
       id, file_id, workspace_id, parent_comment_id, file_version, body,
       created_by_user_id, created_at, updated_at, resolved_at, resolved_by_user_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
  ).bind(id, fileId, access.workspaceId, input.parentCommentId ?? null, input.fileVersion ?? null, input.body, user.id, timestamp, timestamp).run()
  const mentions = await parseMentionUsers(env, user, fileId, input.body)
  const eventId = await recordDomainEvent(env, {
    organizationId: user.organizationId,
    workspaceId: access.workspaceId,
    fileId,
    actorUserId: user.id,
    eventKey: `comment-created:${id}`,
    eventType: input.parentCommentId ? 'FILE_COMMENT_REPLIED' : 'FILE_COMMENT_CREATED',
    category: 'COLLABORATION',
    targetType: 'comment',
    targetId: id,
    detail: { fileVersion: input.fileVersion ?? null, parentCommentId: input.parentCommentId ?? null }
  })
  for (const mention of mentions) {
    await env.DB.prepare('INSERT OR IGNORE INTO comment_mentions(comment_id, user_id, created_at) VALUES (?, ?, ?)')
      .bind(id, mention.id, timestamp).run()
    await createNotification(env, {
      organizationId: user.organizationId,
      recipientUserId: mention.id,
      eventId,
      category: 'COLLABORATION',
      title: '你在文件评论中被提及',
      body: `${user.displayName}: ${input.body.slice(0, 300)}`,
      resourceType: 'file',
      resourceId: fileId,
      commentId: id
    })
  }
  return json({ comments: await commentPayload(env, fileId) }, 201)
}

export async function handleCommentResolve(env: UpgradeRuntimeEnv, user: AuthUser, commentId: string, reopen: boolean): Promise<Response> {
  const row = await env.DB.prepare('SELECT id, file_id, workspace_id, created_by_user_id, resolved_at FROM file_comments WHERE id = ? LIMIT 1')
    .bind(commentId).first<{ id: string; file_id: string; workspace_id: string; created_by_user_id: string; resolved_at: string | null }>()
  if (!row || !(await resolveFileAccess(env, user, row.file_id, 'VIEWER'))) throw new HttpError(404, 'COMMENT_NOT_FOUND')
  const editor = Boolean(await resolveFileAccess(env, user, row.file_id, 'EDITOR'))
  if (row.created_by_user_id !== user.id && !editor) throw new HttpError(403, 'COMMENT_RESOLVE_FORBIDDEN')
  const timestamp = nowIso()
  if (reopen) {
    await env.DB.prepare('UPDATE file_comments SET resolved_at = NULL, resolved_by_user_id = NULL, updated_at = ? WHERE id = ?')
      .bind(timestamp, commentId).run()
  } else {
    await env.DB.prepare('UPDATE file_comments SET resolved_at = ?, resolved_by_user_id = ?, updated_at = ? WHERE id = ?')
      .bind(timestamp, user.id, timestamp, commentId).run()
  }
  await recordDomainEvent(env, {
    organizationId: user.organizationId,
    workspaceId: row.workspace_id,
    fileId: row.file_id,
    actorUserId: user.id,
    eventKey: `comment-${reopen ? 'reopened' : 'resolved'}:${commentId}:${timestamp}`,
    eventType: reopen ? 'FILE_COMMENT_REOPENED' : 'FILE_COMMENT_RESOLVED',
    category: 'COLLABORATION',
    targetType: 'comment',
    targetId: commentId
  })
  return json({ ok: true })
}

function typeExtensions(type: string): string[] {
  const normalized = type.toLowerCase()
  if (normalized === 'excel') return ['.xlsx', '.xlsm', '.xls']
  if (normalized === 'word') return ['.docx', '.doc']
  if (normalized === 'pdf') return ['.pdf']
  if (normalized === 'csv') return ['.csv']
  if (normalized === 'zip') return ['.zip']
  if (normalized === 'ppt') return ['.pptx', '.ppt']
  if (normalized === 'image') return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']
  if (normalized === 'exe') return ['.exe']
  return []
}

export async function handleAdvancedSearch(request: Request, env: UpgradeRuntimeEnv, user: AuthUser): Promise<Response> {
  await pruneExpiredLeases(env)
  const url = new URL(request.url)
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const type = (url.searchParams.get('type') ?? '').trim()
  const workspaceId = (url.searchParams.get('workspaceId') ?? '').trim()
  const path = (url.searchParams.get('path') ?? '').trim().replaceAll('\\', '/')
  const modifiedBy = (url.searchParams.get('modifiedBy') ?? '').trim()
  const createdBy = (url.searchParams.get('createdBy') ?? '').trim()
  const modifiedFrom = (url.searchParams.get('modifiedFrom') ?? '').trim()
  const modifiedTo = (url.searchParams.get('modifiedTo') ?? '').trim()
  const state = (url.searchParams.get('state') ?? '').trim().toLowerCase()
  const extensions = typeExtensions(type)
  const clauses = ["f.status != 'deleted'", 'w.organization_id = ?']
  const binds: unknown[] = [user.organizationId]
  if (q) { clauses.push('(lower(f.logical_name) LIKE ? OR lower(f.relative_path) LIKE ?)'); binds.push(`%${q}%`, `%${q}%`) }
  if (workspaceId) { clauses.push('f.workspace_id = ?'); binds.push(workspaceId) }
  if (path) { clauses.push('(f.relative_path = ? OR f.relative_path LIKE ?)'); binds.push(path, `${path}/%`) }
  if (modifiedBy) { clauses.push('(f.updated_by_user_id = ? OR lower(COALESCE(uu.username, \'\')) = lower(?))'); binds.push(modifiedBy, modifiedBy) }
  if (createdBy) { clauses.push('(f.created_by_user_id = ? OR lower(COALESCE(cu.username, \'\')) = lower(?))'); binds.push(createdBy, createdBy) }
  if (modifiedFrom) { clauses.push('f.updated_at >= ?'); binds.push(modifiedFrom) }
  if (modifiedTo) { clauses.push('f.updated_at <= ?'); binds.push(modifiedTo) }
  if (extensions.length > 0) {
    clauses.push(`(${extensions.map(() => 'lower(f.logical_name) LIKE ?').join(' OR ')})`)
    binds.push(...extensions.map((ext) => `%${ext}`))
  } else if (type.toLowerCase() === 'other') {
    const known = ['.xlsx','.xlsm','.xls','.docx','.doc','.pdf','.csv','.zip','.pptx','.ppt','.png','.jpg','.jpeg','.gif','.webp','.bmp','.exe']
    clauses.push(`NOT (${known.map(() => 'lower(f.logical_name) LIKE ?').join(' OR ')})`)
    binds.push(...known.map((ext) => `%${ext}`))
  }
  if (state === 'locked') clauses.push('l.file_id IS NOT NULL')
  if (state === 'editing') clauses.push("EXISTS (SELECT 1 FROM file_presence p WHERE p.file_id = f.id AND p.state = 'EDITING' AND p.last_seen_at > ?)")
  if (state === 'editing') binds.push(new Date(Date.now() - 120_000).toISOString())
  if (state === 'trashed') clauses.push("f.status = 'trashed'")

  if (!isSystemAdmin(user)) {
    clauses.push(`EXISTS (
      SELECT 1 FROM workspace_members wm
       WHERE wm.workspace_id = f.workspace_id AND wm.user_id = ?
    )`)
    binds.push(user.id)
    clauses.push(`EXISTS (
      SELECT 1 FROM resource_access_rules r
       WHERE r.organization_id = ? AND r.workspace_id = f.workspace_id
         AND (
           (r.principal_type = 'USER' AND r.principal_id = ?)
           OR (r.principal_type = 'GROUP' AND r.principal_id IN (
             SELECT gm.group_id FROM group_members gm JOIN groups g ON g.id = gm.group_id AND g.status = 'ACTIVE'
              WHERE gm.user_id = ? AND g.organization_id = ?
           ))
         )
         AND r.permission IN ('VIEW','EDIT','MANAGE')
         AND (
           (r.scope_type = 'WORKSPACE' AND r.scope_value = f.workspace_id)
           OR (r.scope_type = 'STORAGE' AND r.scope_value = COALESCE(f.home_storage_connection_id, ''))
           OR (r.scope_type = 'FILE' AND r.scope_value = f.id)
           OR (r.scope_type = 'FOLDER' AND (f.relative_path = r.scope_value OR f.relative_path LIKE r.scope_value || '/%'))
         )
    )`)
    binds.push(user.organizationId, user.id, user.id, user.organizationId)
  }

  const result = await env.DB.prepare(
    `SELECT f.id, f.workspace_id, w.name AS workspace_name, f.logical_name, f.relative_path,
            f.current_version, f.current_hash, f.status, f.created_at, f.updated_at,
            f.created_by_user_id, f.updated_by_user_id,
            COALESCE(cu.display_name, cu.username) AS created_by_name,
            COALESCE(uu.display_name, uu.username) AS updated_by_name,
            l.lease_id, l.owner_user_id AS lock_owner_user_id, l.heartbeat_at AS lock_heartbeat_at, l.expires_at AS lock_expires_at,
            COALESCE(lu.display_name, lu.username) AS lock_owner_name,
            (SELECT COUNT(DISTINCT p.user_id) FROM file_presence p WHERE p.file_id = f.id AND p.last_seen_at > ?) AS active_user_count,
            (SELECT COUNT(DISTINCT p.user_id) FROM file_presence p WHERE p.file_id = f.id AND p.state = 'EDITING' AND p.last_seen_at > ?) AS editing_user_count
       FROM files f
       JOIN workspaces w ON w.id = f.workspace_id
       LEFT JOIN users cu ON cu.id = f.created_by_user_id
       LEFT JOIN users uu ON uu.id = f.updated_by_user_id
       LEFT JOIN file_edit_leases l ON l.file_id = f.id AND l.expires_at > ?
       LEFT JOIN users lu ON lu.id = l.owner_user_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY f.updated_at DESC LIMIT 500`
  ).bind(
    new Date(Date.now() - 120_000).toISOString(),
    new Date(Date.now() - 120_000).toISOString(),
    nowIso(),
    ...binds
  ).all<Record<string, unknown>>()
  return json({ files: result.results })
}

export async function handleUnifiedActivity(env: UpgradeRuntimeEnv, user: AuthUser): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT e.id, e.workspace_id, e.file_id, e.actor_user_id, e.event_type, e.category,
            e.target_type, e.target_id, e.detail_json, e.created_at,
            COALESCE(u.display_name, u.username) AS actor_name
       FROM domain_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.organization_id = ? ORDER BY e.created_at DESC LIMIT 500`
  ).bind(user.organizationId).all<Record<string, unknown>>()
  const visible: Record<string, unknown>[] = []
  for (const row of rows.results) {
    const fileId = row.file_id == null ? null : String(row.file_id)
    const workspaceId = row.workspace_id == null ? null : String(row.workspace_id)
    if (fileId && !(await resolveFileAccess(env, user, fileId, 'VIEWER'))) continue
    if (!fileId && workspaceId && !(await getEffectiveWorkspaceRole(env, user, workspaceId))) continue
    visible.push({
      id: row.id,
      file_id: row.file_id,
      event_type: row.event_type,
      detail: row.detail_json,
      created_at: row.created_at,
      category: row.category,
      actor_name: row.actor_name,
      target_type: row.target_type,
      target_id: row.target_id
    })
    if (visible.length >= 200) break
  }
  return json({ events: visible })
}

type RewindTarget = {
  file_id: string
  logical_name: string
  relative_path: string
  status: 'active' | 'trashed' | 'deleted'
  content_version: number
  created_at: string
}

type RewindCurrent = {
  id: string
  logical_name: string
  relative_path: string
  status: 'active' | 'trashed' | 'deleted'
  current_version: number
  created_at: string
}

type RewindAction = {
  fileId: string
  logicalName: string
  action: 'RESTORE_VERSION' | 'RESTORE_PATH' | 'RESTORE_STATUS' | 'TRASH_NEW' | 'NOOP'
  targetVersion?: number
  targetLogicalName?: string
  targetRelativePath?: string
  targetStatus?: 'active' | 'trashed' | 'deleted'
  reason?: string
}

async function requireRewindPermission(env: UpgradeRuntimeEnv, user: AuthUser, input: z.infer<typeof rewindSchema>): Promise<string> {
  const role = await getEffectiveWorkspaceRole(env, user, input.workspaceId)
  if (!role) throw new HttpError(403, 'WORKSPACE_FORBIDDEN')
  if (input.scopeType === 'WORKSPACE') {
    if (!workspaceRoleAtLeast(role, 'MANAGER')) throw new HttpError(403, 'REWIND_FORBIDDEN')
    return ''
  }
  if (!workspaceRoleAtLeast(role, 'EDITOR')) throw new HttpError(403, 'REWIND_FORBIDDEN')
  const folder = normalizeFolder(input.scopeValue)
  if (!isSystemAdmin(user) && !(await canCreateResourceAtPath(env, user, input.workspaceId, `${folder}/.rewind-scope`, null, 'EDITOR'))) {
    throw new HttpError(403, 'REWIND_FORBIDDEN')
  }
  return folder
}

async function candidateFiles(env: UpgradeRuntimeEnv, workspaceId: string, scopeType: 'FOLDER' | 'WORKSPACE', scopeValue: string): Promise<RewindCurrent[]> {
  if (scopeType === 'WORKSPACE') {
    const result = await env.DB.prepare(
      `SELECT id, logical_name, relative_path, status, current_version, created_at
         FROM files WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 5000`
    ).bind(workspaceId).all<RewindCurrent>()
    return result.results
  }
  const result = await env.DB.prepare(
    `SELECT DISTINCT f.id, f.logical_name, f.relative_path, f.status, f.current_version, f.created_at
       FROM files f
      WHERE f.workspace_id = ? AND (
        f.relative_path = ? OR f.relative_path LIKE ? OR EXISTS (
          SELECT 1 FROM file_state_history h
           WHERE h.file_id = f.id AND h.workspace_id = ?
             AND (h.relative_path = ? OR h.relative_path LIKE ?)
        )
      )
      ORDER BY f.created_at ASC LIMIT 5000`
  ).bind(workspaceId, scopeValue, `${scopeValue}/%`, workspaceId, scopeValue, `${scopeValue}/%`).all<RewindCurrent>()
  return result.results
}

async function planRewind(env: UpgradeRuntimeEnv, workspaceId: string, scopeType: 'FOLDER' | 'WORKSPACE', scopeValue: string, targetTime: string): Promise<{
  actions: RewindAction[]
  unsupported: Array<{ fileId: string; logicalName: string; reason: string }>
}> {
  const files = await candidateFiles(env, workspaceId, scopeType, scopeValue)
  const actions: RewindAction[] = []
  const unsupported: Array<{ fileId: string; logicalName: string; reason: string }> = []
  for (const file of files) {
    const target = await env.DB.prepare(
      `SELECT file_id, logical_name, relative_path, status, content_version, created_at
         FROM file_state_history WHERE file_id = ? AND created_at <= ?
        ORDER BY created_at DESC LIMIT 1`
    ).bind(file.id, targetTime).first<RewindTarget>()
    if (!target) {
      if (file.created_at > targetTime && file.status !== 'deleted') {
        actions.push({ fileId: file.id, logicalName: file.logical_name, action: 'TRASH_NEW', targetStatus: 'trashed', reason: 'CREATED_AFTER_TARGET' })
      } else {
        unsupported.push({ fileId: file.id, logicalName: file.logical_name, reason: 'NO_STATE_HISTORY_BEFORE_TARGET' })
      }
      continue
    }
    let changed = false
    if (target.content_version > 0 && target.content_version !== file.current_version) {
      actions.push({ fileId: file.id, logicalName: file.logical_name, action: 'RESTORE_VERSION', targetVersion: target.content_version })
      changed = true
    }
    if (target.relative_path !== file.relative_path || target.logical_name !== file.logical_name) {
      actions.push({
        fileId: file.id,
        logicalName: file.logical_name,
        action: 'RESTORE_PATH',
        targetRelativePath: target.relative_path,
        targetLogicalName: target.logical_name
      })
      changed = true
    }
    if (target.status !== file.status) {
      actions.push({ fileId: file.id, logicalName: file.logical_name, action: 'RESTORE_STATUS', targetStatus: target.status })
      changed = true
    }
    if (!changed) actions.push({ fileId: file.id, logicalName: file.logical_name, action: 'NOOP' })
  }
  return { actions, unsupported }
}

function rewindSummary(actions: RewindAction[], unsupported: Array<{ fileId: string }>): Record<string, number> {
  const counts = {
    restoreVersions: 0,
    restorePaths: 0,
    restoreStatuses: 0,
    newFilesAfterTarget: 0,
    unaffected: 0,
    unsupported: unsupported.length
  }
  for (const action of actions) {
    if (action.action === 'RESTORE_VERSION') counts.restoreVersions += 1
    else if (action.action === 'RESTORE_PATH') counts.restorePaths += 1
    else if (action.action === 'RESTORE_STATUS') counts.restoreStatuses += 1
    else if (action.action === 'TRASH_NEW') counts.newFilesAfterTarget += 1
    else counts.unaffected += 1
  }
  return counts
}

export async function handleRewindPreview(request: Request, env: UpgradeRuntimeEnv, user: AuthUser): Promise<Response> {
  const input = await requestJson(request, rewindSchema)
  if (new Date(input.targetTime).getTime() > Date.now()) throw new HttpError(400, 'REWIND_TIME_IN_FUTURE')
  const scopeValue = await requireRewindPermission(env, user, input)
  const plan = await planRewind(env, input.workspaceId, input.scopeType, scopeValue, input.targetTime)
  return json({
    workspaceId: input.workspaceId,
    scopeType: input.scopeType,
    scopeValue,
    targetTime: input.targetTime,
    summary: rewindSummary(plan.actions, plan.unsupported),
    actions: plan.actions.filter((item) => item.action !== 'NOOP'),
    unsupported: plan.unsupported
  })
}

async function assertRewindFileIdle(env: UpgradeRuntimeEnv, fileId: string, userId: string): Promise<void> {
  await pruneExpiredLeases(env, fileId)
  const lease = await env.DB.prepare('SELECT owner_user_id FROM file_edit_leases WHERE file_id = ? LIMIT 1')
    .bind(fileId).first<{ owner_user_id: string }>()
  if (lease && lease.owner_user_id !== userId) throw new Error('FILE_LOCKED')
  const intent = await env.DB.prepare("SELECT id FROM upload_intents WHERE file_id = ? AND status IN ('reserved','uploaded') LIMIT 1")
    .bind(fileId).first<{ id: string }>()
  if (intent) throw new Error('UPLOAD_IN_PROGRESS')
}

async function completeSimpleRewindItem(
  env: UpgradeRuntimeEnv,
  user: AuthUser,
  operationId: string,
  item: Record<string, unknown>,
  file: RewindCurrent
): Promise<void> {
  const itemId = String(item.id)
  const action = String(item.action)
  const timestamp = nowIso()
  let nextName = file.logical_name
  let nextPath = file.relative_path
  let nextStatus = file.status
  if (action === 'RESTORE_PATH') {
    nextName = String(item.target_logical_name)
    nextPath = String(item.target_relative_path)
    const conflict = await env.DB.prepare("SELECT id FROM files WHERE workspace_id = ? AND relative_path = ? COLLATE NOCASE AND status = 'active' AND id != ? LIMIT 1")
      .bind(String(item.workspace_id ?? ''), nextPath, file.id).first<{ id: string }>()
    if (conflict) throw new Error('REWIND_PATH_CONFLICT')
  } else if (action === 'RESTORE_STATUS' || action === 'TRASH_NEW') {
    nextStatus = String(item.target_status) as RewindCurrent['status']
    if (nextStatus === 'active') {
      const conflict = await env.DB.prepare("SELECT id FROM files WHERE workspace_id = ? AND relative_path = ? COLLATE NOCASE AND status = 'active' AND id != ? LIMIT 1")
        .bind(String(item.workspace_id ?? ''), nextPath, file.id).first<{ id: string }>()
      if (conflict) throw new Error('REWIND_PATH_CONFLICT')
    }
  }
  const eventId = crypto.randomUUID()
  const eventKey = `rewind-item:${operationId}:${itemId}`
  const historyId = crypto.randomUUID()
  await env.DB.batch([
    env.DB.prepare('UPDATE files SET logical_name = ?, relative_path = ?, status = ?, updated_at = ?, updated_by = ?, updated_by_user_id = ? WHERE id = ?')
      .bind(nextName, nextPath, nextStatus, timestamp, user.id, user.id, file.id),
    env.DB.prepare("UPDATE rewind_items SET status = 'DONE', error_text = NULL, updated_at = ? WHERE id = ?")
      .bind(timestamp, itemId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO domain_events(id, organization_id, workspace_id, file_id, actor_user_id, event_key, event_type, category, target_type, target_id, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'REWIND_ITEM_APPLIED', 'RECOVERY', 'file', ?, ?, ?)`
    ).bind(eventId, user.organizationId, String(item.workspace_id), file.id, user.id, eventKey, file.id, safeJson({ operationId, action }), timestamp),
    env.DB.prepare(
      `INSERT INTO file_state_history(id, file_id, workspace_id, logical_name, relative_path, status, content_version, event_type, actor_user_id, created_at, source_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'REWIND', ?, ?, ?)`
    ).bind(historyId, file.id, String(item.workspace_id), nextName, nextPath, nextStatus, file.current_version, user.id, timestamp, eventId)
  ])
}

async function completeVersionRewindItem(
  env: UpgradeRuntimeEnv,
  user: AuthUser,
  operationId: string,
  item: Record<string, unknown>,
  file: RewindCurrent
): Promise<void> {
  const itemId = String(item.id)
  const sourceVersion = Number(item.target_version)
  const source = await env.DB.prepare(
    `SELECT id, file_id, version, telegram_file_id, hash, size, storage_connection_id, status
       FROM file_versions WHERE file_id = ? AND version = ? LIMIT 1`
  ).bind(file.id, sourceVersion).first<{
    id: string
    file_id: string
    version: number
    telegram_file_id: string
    hash: string
    size: number
    storage_connection_id: string | null
    status: string
  }>()
  if (!source || source.status === 'expired' || !source.storage_connection_id) throw new Error('REWIND_SOURCE_VERSION_UNAVAILABLE')
  const resolved = await new StorageRouter(env).resolveVersion(file.id, sourceVersion)
  const nextVersion = file.current_version + 1
  const stored = await resolved.provider.clone({ fileId: source.telegram_file_id, caption: `ExcelSync rewind ${file.id} V${nextVersion} from V${sourceVersion}` })
  const timestamp = nowIso()
  const versionId = crypto.randomUUID()
  const eventId = crypto.randomUUID()
  const historyId = crypto.randomUUID()
  const eventKey = `rewind-item:${operationId}:${itemId}`
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO file_versions(
         id, file_id, version, telegram_file_id, telegram_message_id, telegram_file_unique_id,
         hash, size, base_version, restored_from_version, created_at, created_by, storage_connection_id, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
    ).bind(versionId, file.id, nextVersion, stored.fileId, stored.messageId, stored.fileUniqueId ?? null,
      source.hash, source.size, file.current_version, sourceVersion, timestamp, user.id, source.storage_connection_id),
    env.DB.prepare(
      `UPDATE files SET current_version = ?, current_telegram_file_id = ?, current_telegram_message_id = ?, current_hash = ?,
              updated_at = ?, updated_by = ?, updated_by_user_id = ? WHERE id = ? AND current_version = ?`
    ).bind(nextVersion, stored.fileId, stored.messageId, source.hash, timestamp, user.id, user.id, file.id, file.current_version),
    env.DB.prepare("UPDATE file_versions SET status = 'archived' WHERE file_id = ? AND version < ? AND status = 'active'")
      .bind(file.id, nextVersion),
    env.DB.prepare("UPDATE rewind_items SET status = 'DONE', error_text = NULL, updated_at = ? WHERE id = ?")
      .bind(timestamp, itemId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO domain_events(id, organization_id, workspace_id, file_id, actor_user_id, event_key, event_type, category, target_type, target_id, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'REWIND_VERSION_RESTORED', 'RECOVERY', 'file', ?, ?, ?)`
    ).bind(eventId, user.organizationId, String(item.workspace_id), file.id, user.id, eventKey, file.id, safeJson({ operationId, restoredFromVersion: sourceVersion, newVersion: nextVersion }), timestamp),
    env.DB.prepare(
      `INSERT INTO file_state_history(id, file_id, workspace_id, logical_name, relative_path, status, content_version, event_type, actor_user_id, created_at, source_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'REWIND_VERSION_RESTORE', ?, ?, ?)`
    ).bind(historyId, file.id, String(item.workspace_id), file.logical_name, file.relative_path, file.status, nextVersion, user.id, timestamp, eventId)
  ])
}

async function executeRewindOperation(env: UpgradeRuntimeEnv, user: AuthUser, operationId: string): Promise<Record<string, unknown>> {
  const operation = await env.DB.prepare(
    `SELECT id, workspace_id, status FROM rewind_operations
      WHERE id = ? AND organization_id = ? LIMIT 1`
  ).bind(operationId, user.organizationId).first<{ id: string; workspace_id: string; status: string }>()
  if (!operation) throw new HttpError(404, 'REWIND_NOT_FOUND')
  if (operation.status === 'COMPLETED') return { id: operationId, status: 'COMPLETED' }
  await env.DB.prepare("UPDATE rewind_operations SET status = 'RUNNING', started_at = COALESCE(started_at, ?), error_text = NULL WHERE id = ?")
    .bind(nowIso(), operationId).run()
  const items = await env.DB.prepare(
    `SELECT i.*, o.workspace_id FROM rewind_items i JOIN rewind_operations o ON o.id = i.operation_id
      WHERE i.operation_id = ? AND i.status != 'DONE' ORDER BY i.created_at ASC, i.action ASC LIMIT 5000`
  ).bind(operationId).all<Record<string, unknown>>()
  let failed = 0
  let done = 0
  for (const item of items.results) {
    if (String(item.action) === 'NOOP') {
      await env.DB.prepare("UPDATE rewind_items SET status = 'DONE', updated_at = ? WHERE id = ?").bind(nowIso(), String(item.id)).run()
      done += 1
      continue
    }
    const fileId = String(item.file_id)
    try {
      await assertRewindFileIdle(env, fileId, user.id)
      const file = await env.DB.prepare('SELECT id, logical_name, relative_path, status, current_version, created_at FROM files WHERE id = ? LIMIT 1')
        .bind(fileId).first<RewindCurrent>()
      if (!file) throw new Error('FILE_NOT_FOUND')
      await env.DB.prepare("UPDATE rewind_items SET status = 'RUNNING', attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .bind(nowIso(), String(item.id)).run()
      if (String(item.action) === 'RESTORE_VERSION') await completeVersionRewindItem(env, user, operationId, item, file)
      else await completeSimpleRewindItem(env, user, operationId, item, file)
      done += 1
    } catch (error) {
      failed += 1
      await env.DB.prepare("UPDATE rewind_items SET status = 'FAILED', error_text = ?, updated_at = ? WHERE id = ?")
        .bind((error instanceof Error ? error.message : String(error)).slice(0, 1000), nowIso(), String(item.id)).run()
    }
  }
  const pending = await env.DB.prepare("SELECT COUNT(*) AS count FROM rewind_items WHERE operation_id = ? AND status NOT IN ('DONE','SKIPPED')")
    .bind(operationId).first<{ count: number }>()
  const status = Number(pending?.count ?? 0) === 0 ? 'COMPLETED' : (done > 0 ? 'PARTIAL' : 'FAILED')
  const completedAt = status === 'COMPLETED' ? nowIso() : null
  await env.DB.prepare('UPDATE rewind_operations SET status = ?, completed_at = ?, error_text = ? WHERE id = ?')
    .bind(status, completedAt, failed > 0 ? `${failed} item(s) failed` : null, operationId).run()
  const eventId = await recordDomainEvent(env, {
    organizationId: user.organizationId,
    workspaceId: operation.workspace_id,
    actorUserId: user.id,
    eventKey: `rewind-operation-status:${operationId}:${status}`,
    eventType: status === 'COMPLETED' ? 'REWIND_COMPLETED' : 'REWIND_PARTIAL',
    category: 'RECOVERY',
    targetType: 'rewind',
    targetId: operationId,
    detail: { done, failed, status }
  })
  await createNotification(env, {
    organizationId: user.organizationId,
    recipientUserId: user.id,
    eventId,
    category: 'RECOVERY',
    title: status === 'COMPLETED' ? '回退已完成' : '回退需要继续处理',
    body: `已完成 ${done} 项，失败 ${failed} 项。`,
    resourceType: 'workspace',
    resourceId: operation.workspace_id
  })
  return { id: operationId, status, done, failed }
}

export async function handleRewindExecute(request: Request, env: UpgradeRuntimeEnv, user: AuthUser): Promise<Response> {
  const input = await requestJson(request, rewindSchema.extend({ idempotencyKey: z.string().min(16).max(160) }))
  if (new Date(input.targetTime).getTime() > Date.now()) throw new HttpError(400, 'REWIND_TIME_IN_FUTURE')
  const scopeValue = await requireRewindPermission(env, user, input)
  const existing = await env.DB.prepare('SELECT id FROM rewind_operations WHERE organization_id = ? AND idempotency_key = ? LIMIT 1')
    .bind(user.organizationId, input.idempotencyKey).first<{ id: string }>()
  if (existing) return json(await executeRewindOperation(env, user, existing.id))
  const plan = await planRewind(env, input.workspaceId, input.scopeType, scopeValue, input.targetTime)
  if (plan.unsupported.length > 0) throw new HttpError(409, 'REWIND_HISTORY_INCOMPLETE', 'REWIND_HISTORY_INCOMPLETE', { unsupported: plan.unsupported })
  const operationId = crypto.randomUUID()
  const timestamp = nowIso()
  const summary = rewindSummary(plan.actions, [])
  const statements = [env.DB.prepare(
    `INSERT INTO rewind_operations(
       id, organization_id, workspace_id, scope_type, scope_value, target_time, status,
       idempotency_key, created_by_user_id, created_at, summary_json
     ) VALUES (?, ?, ?, ?, ?, ?, 'PLANNED', ?, ?, ?, ?)`
  ).bind(operationId, user.organizationId, input.workspaceId, input.scopeType, scopeValue, input.targetTime,
    input.idempotencyKey, user.id, timestamp, safeJson(summary))]
  for (const action of plan.actions) {
    statements.push(env.DB.prepare(
      `INSERT INTO rewind_items(
         id, operation_id, file_id, action, target_version, target_logical_name,
         target_relative_path, target_status, status, attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`
    ).bind(crypto.randomUUID(), operationId, action.fileId, action.action, action.targetVersion ?? null,
      action.targetLogicalName ?? null, action.targetRelativePath ?? null, action.targetStatus ?? null, timestamp, timestamp))
  }
  await env.DB.batch(statements)
  return json(await executeRewindOperation(env, user, operationId), 201)
}

export async function handleRewindRetry(env: UpgradeRuntimeEnv, user: AuthUser, operationId: string): Promise<Response> {
  const operation = await env.DB.prepare('SELECT workspace_id FROM rewind_operations WHERE id = ? AND organization_id = ? LIMIT 1')
    .bind(operationId, user.organizationId).first<{ workspace_id: string }>()
  if (!operation) throw new HttpError(404, 'REWIND_NOT_FOUND')
  const role = await getEffectiveWorkspaceRole(env, user, operation.workspace_id)
  if (!workspaceRoleAtLeast(role, 'MANAGER') && !isSystemAdmin(user)) throw new HttpError(403, 'REWIND_FORBIDDEN')
  await env.DB.prepare("UPDATE rewind_items SET status = 'PENDING', error_text = NULL, updated_at = ? WHERE operation_id = ? AND status = 'FAILED'")
    .bind(nowIso(), operationId).run()
  return json(await executeRewindOperation(env, user, operationId))
}

export async function handleRewindHistory(env: UpgradeRuntimeEnv, user: AuthUser, workspaceId: string): Promise<Response> {
  const role = await getEffectiveWorkspaceRole(env, user, workspaceId)
  if (!role) throw new HttpError(403, 'WORKSPACE_FORBIDDEN')
  const rows = await env.DB.prepare(
    `SELECT id, scope_type, scope_value, target_time, status, created_by_user_id, created_at,
            started_at, completed_at, summary_json, error_text
       FROM rewind_operations WHERE workspace_id = ? AND organization_id = ?
      ORDER BY created_at DESC LIMIT 200`
  ).bind(workspaceId, user.organizationId).all()
  return json({ operations: rows.results })
}
