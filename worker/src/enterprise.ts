import { z } from 'zod'
import {
  getDefaultWorkspaceId,
  getEffectiveWorkspaceRole,
  getMembership,
  getMemberships,
  isOwner,
  isSystemAdmin,
  permissionForWorkspaceRole,
  recordAudit,
  resolveFileAccess,
  setDefaultWorkspace,
  workspaceRoleAtLeast,
  type AuthUser,
  type ResourcePermission,
  type ResourceScopeType,
  type SystemRole,
  type WorkspaceRole
} from './access'
import { hashPassword, sha256Text } from './auth'
import { encryptCredential } from './credential-crypto'
import { HttpError, json, requestJson, type JsonRequestLike } from './http'
import { deviceInfoSchema, type DeviceInfoInput } from './collaboration'
import { StorageRouter, type StorageRuntimeEnv } from './storage-router'
import { telegramGetMe, telegramGetUpdates } from './telegram-storage'

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

type RuntimeEnv = StorageRuntimeEnv

const usernameSchema = z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_.-]+$/)
const inviteCreateSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(100),
  workspaceId: z.string().uuid(),
  workspaceRole: z.enum(['MANAGER', 'EDITOR', 'VIEWER']).default('EDITOR'),
  accountType: z.enum(['INTERNAL', 'EXTERNAL']).default('INTERNAL'),
  userExpiresAt: z.string().datetime().nullable().optional(),
  expiresInHours: z.number().int().min(1).max(24 * 30).default(72)
})
const inviteActivateSchema = z.object({
  code: z.string().trim().min(6).max(128),
  password: z.string().min(12).max(256),
  device: deviceInfoSchema.optional()
})
const workspaceCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  type: z.enum(['PERSONAL', 'TEAM', 'PROJECT']).default('TEAM'),
  defaultStorageConnectionId: z.string().uuid().nullable().optional()
})
const membershipSchema = z.object({ userId: z.string().uuid(), role: z.enum(['MANAGER', 'EDITOR', 'VIEWER']) })
const lifecycleSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']), reassignToUserId: z.string().uuid().nullable().optional() })
const systemRoleSchema = z.object({ systemRole: z.enum(['ADMIN', 'MEMBER']) })
const accountPolicySchema = z.object({
  accountType: z.enum(['INTERNAL', 'EXTERNAL']),
  accessExpiresAt: z.string().datetime().nullable().optional()
})
const workspaceStorageSchema = z.object({ storageConnectionId: z.string().uuid() })
const taskCreateSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(240),
  description: z.string().max(4000).default(''),
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).default('TODO'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  assigneeUserId: z.string().uuid().nullable().optional(),
  legacyAssigneeText: z.string().max(200).nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  fileIds: z.array(z.string().uuid()).max(50).default([]),
  legacyClientId: z.string().max(160).nullable().optional()
})
const taskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  description: z.string().max(4000).optional(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  fileIds: z.array(z.string().uuid()).max(50).optional()
})
const taskMigrationSchema = z.object({ tasks: z.array(taskCreateSchema.extend({ legacyClientId: z.string().min(1).max(160) })).max(200) })
const storageCreateSchema = z.object({ name: z.string().trim().min(1).max(160), botToken: z.string().trim().min(20).max(256) })
const storageTokenSchema = z.object({ botToken: z.string().trim().min(20).max(256) })
const resourceScopeSchema = z.object({
  scopeType: z.enum(['WORKSPACE', 'STORAGE', 'FOLDER', 'FILE']),
  scopeValue: z.string().trim().min(1).max(1000)
})
const resourceAccessReplaceSchema = z.object({
  workspaceRole: z.enum(['MANAGER', 'EDITOR', 'VIEWER']),
  scopes: z.array(resourceScopeSchema).min(1).max(500)
})

function nowIso(): string {
  return new Date().toISOString()
}

type InviteActivationThrottleState = {
  failures: number
  windowStartedAt: string
  blockedUntil: string | null
}

const INVITE_ACTIVATION_IP_FAILURE_LIMIT = 12
const INVITE_ACTIVATION_WINDOW_MS = 15 * 60 * 1000
const INVITE_ACTIVATION_BLOCK_MS = 15 * 60 * 1000

function inviteActivationClientIp(request: Pick<JsonRequestLike, 'headers'>): string {
  return (request.headers.get('cf-connecting-ip')?.trim() || 'unknown').slice(0, 128)
}

async function inviteActivationThrottleKey(request: Pick<JsonRequestLike, 'headers'>): Promise<string> {
  return `invite_activation_throttle:ip:${await sha256Text(inviteActivationClientIp(request))}`
}

async function loadInviteActivationThrottle(env: RuntimeEnv, key: string, now = Date.now()): Promise<InviteActivationThrottleState | null> {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ? LIMIT 1').bind(key).first<{ value: string }>()
  if (!row?.value) return null
  try {
    const state = JSON.parse(row.value) as InviteActivationThrottleState
    const started = new Date(state.windowStartedAt).getTime()
    const blocked = state.blockedUntil ? new Date(state.blockedUntil).getTime() : 0
    if (!Number.isFinite(started) || !Number.isInteger(state.failures) || state.failures < 0) throw new Error('INVALID')
    if (now - started > INVITE_ACTIVATION_WINDOW_MS && (!blocked || blocked <= now)) {
      await env.DB.prepare('DELETE FROM app_settings WHERE key = ?').bind(key).run()
      return null
    }
    return state
  } catch {
    await env.DB.prepare('DELETE FROM app_settings WHERE key = ?').bind(key).run()
    return null
  }
}

async function assertInviteActivationNotThrottled(env: RuntimeEnv, key: string): Promise<void> {
  const state = await loadInviteActivationThrottle(env, key)
  const blockedUntil = state?.blockedUntil ? new Date(state.blockedUntil).getTime() : 0
  if (blockedUntil > Date.now()) {
    throw new HttpError(429, 'TOO_MANY_ACTIVATION_ATTEMPTS', 'TOO_MANY_ACTIVATION_ATTEMPTS', {
      retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000))
    })
  }
}

async function recordInviteActivationFailure(env: RuntimeEnv, key: string): Promise<boolean> {
  const now = Date.now()
  const current = await loadInviteActivationThrottle(env, key, now)
  const sameWindow = current && now - new Date(current.windowStartedAt).getTime() <= INVITE_ACTIVATION_WINDOW_MS
  const windowStartedAt = sameWindow ? current.windowStartedAt : new Date(now).toISOString()
  const failures = (sameWindow ? current.failures : 0) + 1
  const blockedUntil = failures >= INVITE_ACTIVATION_IP_FAILURE_LIMIT ? new Date(now + INVITE_ACTIVATION_BLOCK_MS).toISOString() : null
  const state: InviteActivationThrottleState = { failures, windowStartedAt, blockedUntil }
  await env.DB.prepare(
    `INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, JSON.stringify(state), nowIso()).run()
  return Boolean(blockedUntil)
}

async function clearInviteActivationThrottle(env: RuntimeEnv, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM app_settings WHERE key = ?').bind(key).run()
}

function requireAdmin(user: AuthUser): void {
  if (!isSystemAdmin(user)) throw new HttpError(403, 'FORBIDDEN')
}

function requireOwner(user: AuthUser): void {
  if (!isOwner(user)) throw new HttpError(403, 'OWNER_REQUIRED')
}

function generateInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let raw = ''
  for (const byte of bytes) raw += INVITE_ALPHABET[byte % INVITE_ALPHABET.length]
  return `XS-${raw.slice(0, 4)}-${raw.slice(4, 8)}`
}

async function requireWorkspaceRole(env: RuntimeEnv, user: AuthUser, workspaceId: string, required: WorkspaceRole): Promise<WorkspaceRole> {
  const role = await getEffectiveWorkspaceRole(env, user, workspaceId)
  if (!workspaceRoleAtLeast(role, required)) throw new HttpError(403, 'WORKSPACE_FORBIDDEN')
  return role!
}

async function ensureOrgWorkspace(env: RuntimeEnv, user: AuthUser, workspaceId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT id FROM workspaces WHERE id = ? AND organization_id = ? LIMIT 1')
    .bind(workspaceId, user.organizationId).first<{ id: string }>()
  if (!row) throw new HttpError(404, 'WORKSPACE_NOT_FOUND')
}

async function validateTaskAssignee(env: RuntimeEnv, workspaceId: string, assigneeUserId: string | null | undefined): Promise<void> {
  if (!assigneeUserId) return
  const row = await env.DB.prepare(
    `SELECT u.system_role, wm.role
       FROM users u LEFT JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ?
      WHERE u.id = ? AND u.lifecycle_status = 'ACTIVE' LIMIT 1`
  ).bind(workspaceId, assigneeUserId).first<{ system_role: SystemRole; role: WorkspaceRole | null }>()
  if (!row || (!(row.system_role === 'OWNER' || row.system_role === 'ADMIN') && !row.role)) {
    throw new HttpError(400, 'ASSIGNEE_NOT_IN_WORKSPACE')
  }
}

async function validateTaskFiles(env: RuntimeEnv, user: AuthUser, workspaceId: string, fileIds: string[]): Promise<void> {
  for (const fileId of [...new Set(fileIds)]) {
    const access = await resolveFileAccess(env, user, fileId, 'VIEWER')
    if (!access || access.workspaceId !== workspaceId) throw new HttpError(400, 'TASK_FILE_NOT_ACCESSIBLE')
  }
}

export async function activateInvite(request: JsonRequestLike, env: RuntimeEnv): Promise<{ user: AuthUser; device?: DeviceInfoInput }> {
  const input = await requestJson(request, inviteActivateSchema)
  const throttleKey = await inviteActivationThrottleKey(request)
  await assertInviteActivationNotThrottled(env, throttleKey)
  const tokenHash = await sha256Text(input.code.toUpperCase())
  const invite = await env.DB.prepare(
    `SELECT id, organization_id, username, display_name, workspace_id, workspace_role,
            account_type, user_expires_at, expires_at, status
       FROM invites WHERE token_hash = ? LIMIT 1`
  ).bind(tokenHash).first<{
    id: string
    organization_id: string
    username: string
    display_name: string
    workspace_id: string | null
    workspace_role: WorkspaceRole | null
    account_type: AuthUser['accountType']
    user_expires_at: string | null
    expires_at: string
    status: string
  }>()
  if (!invite || invite.status !== 'PENDING') {
    const blocked = await recordInviteActivationFailure(env, throttleKey)
    if (blocked) {
      throw new HttpError(429, 'TOO_MANY_ACTIVATION_ATTEMPTS', 'TOO_MANY_ACTIVATION_ATTEMPTS', {
        retryAfterSeconds: INVITE_ACTIVATION_BLOCK_MS / 1000
      })
    }
    throw new HttpError(400, 'INVITE_INVALID')
  }
  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    await env.DB.prepare("UPDATE invites SET status = 'EXPIRED' WHERE id = ? AND status = 'PENDING'").bind(invite.id).run()
    throw new HttpError(400, 'INVITE_EXPIRED')
  }
  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE LIMIT 1').bind(invite.username).first<{ id: string }>()
  if (existing) throw new HttpError(409, 'USERNAME_ALREADY_EXISTS')
  const passwordHash = await hashPassword(input.password)
  const userId = crypto.randomUUID()
  const timestamp = nowIso()
  const workspaceId = invite.workspace_id
  const statements = [
    env.DB.prepare(
      `INSERT INTO users(
         id, organization_id, username, display_name, password_hash, system_role, lifecycle_status,
         account_type, access_expires_at, created_at, status
       ) VALUES (?, ?, ?, ?, ?, 'MEMBER', 'ACTIVE', ?, ?, ?, 'active')`
    ).bind(userId, invite.organization_id, invite.username, invite.display_name, passwordHash,
      invite.account_type, invite.user_expires_at, timestamp),
    env.DB.prepare("UPDATE invites SET status = 'USED', used_at = ? WHERE id = ? AND status = 'PENDING'").bind(timestamp, invite.id)
  ]
  if (workspaceId && invite.workspace_role) {
    statements.push(env.DB.prepare(
      'INSERT INTO workspace_members(workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    ).bind(workspaceId, userId, invite.workspace_role, timestamp))
    statements.push(env.DB.prepare(
      `INSERT INTO resource_access_rules(
        id, organization_id, workspace_id, principal_type, principal_id, scope_type, scope_value,
        permission, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'USER', ?, 'WORKSPACE', ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), invite.organization_id, workspaceId, userId, workspaceId,
      permissionForWorkspaceRole(invite.workspace_role), userId, timestamp, timestamp))
    statements.push(env.DB.prepare(
      `INSERT INTO user_preferences(user_id, default_workspace_id, updated_at) VALUES (?, ?, ?)`
    ).bind(userId, workspaceId, timestamp))
  }
  await env.DB.batch(statements)
  await clearInviteActivationThrottle(env, throttleKey)
  const user: AuthUser = {
    id: userId,
    username: invite.username,
    displayName: invite.display_name,
    organizationId: invite.organization_id,
    systemRole: 'MEMBER',
    status: 'ACTIVE',
    accountType: invite.account_type,
    accessExpiresAt: invite.user_expires_at
  }
  await recordAudit(env, user, 'USER_ACTIVATED', 'user', userId, { inviteId: invite.id, workspaceId })
  return { user, device: input.device }
}

export async function handleAuthMe(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  return json({ user, memberships: await getMemberships(env, user), defaultWorkspaceId: await getDefaultWorkspaceId(env, user) })
}

export async function handleInviteList(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  requireAdmin(user)
  const result = await env.DB.prepare(
    `SELECT i.id, i.username, i.display_name, i.workspace_id, i.workspace_role,
            i.account_type, i.user_expires_at, i.expires_at, i.used_at, i.status, i.created_at,
            w.name AS workspace_name
       FROM invites i LEFT JOIN workspaces w ON w.id = i.workspace_id
      WHERE i.organization_id = ? ORDER BY i.created_at DESC LIMIT 500`
  ).bind(user.organizationId).all()
  return json({ invites: result.results })
}

export async function handleInviteCreate(request: Request, env: RuntimeEnv, user: AuthUser): Promise<Response> {
  requireAdmin(user)
  const input = await requestJson(request, inviteCreateSchema)
  await ensureOrgWorkspace(env, user, input.workspaceId)
  const existingUser = await env.DB.prepare('SELECT id FROM users WHERE organization_id = ? AND username = ? COLLATE NOCASE LIMIT 1')
    .bind(user.organizationId, input.username).first<{ id: string }>()
  if (existingUser) throw new HttpError(409, 'USERNAME_ALREADY_EXISTS')
  await env.DB.prepare("UPDATE invites SET status = 'REVOKED' WHERE organization_id = ? AND username = ? COLLATE NOCASE AND status = 'PENDING'")
    .bind(user.organizationId, input.username).run()
  const code = generateInviteCode()
  const tokenHash = await sha256Text(code)
  const inviteId = crypto.randomUUID()
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + input.expiresInHours * 3600_000).toISOString()
  if (input.userExpiresAt && new Date(input.userExpiresAt).getTime() <= Date.now()) throw new HttpError(400, 'USER_EXPIRY_INVALID')
  if (input.accountType === 'EXTERNAL' && input.workspaceRole === 'MANAGER') throw new HttpError(400, 'EXTERNAL_MANAGER_FORBIDDEN')
  await env.DB.prepare(
    `INSERT INTO invites(
       id, organization_id, username, display_name, token_hash, created_by_user_id, workspace_id, workspace_role,
       account_type, user_expires_at, expires_at, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`
  ).bind(inviteId, user.organizationId, input.username, input.displayName, tokenHash, user.id,
    input.workspaceId, input.workspaceRole, input.accountType, input.userExpiresAt ?? null, expiresAt, createdAt).run()
  await recordAudit(env, user, 'INVITE_CREATED', 'invite', inviteId, {
    username: input.username,
    workspaceId: input.workspaceId,
    workspaceRole: input.workspaceRole,
    accountType: input.accountType,
    userExpiresAt: input.userExpiresAt ?? null,
    expiresAt
  })
  return json({ id: inviteId, code, expiresAt }, 201)
}

export async function handleInviteRevoke(env: RuntimeEnv, user: AuthUser, inviteId: string): Promise<Response> {
  requireAdmin(user)
  const result = await env.DB.prepare("UPDATE invites SET status = 'REVOKED' WHERE id = ? AND organization_id = ? AND status = 'PENDING'")
    .bind(inviteId, user.organizationId).run()
  if ((result.meta.changes ?? 0) !== 1) throw new HttpError(404, 'INVITE_NOT_PENDING')
  await recordAudit(env, user, 'INVITE_REVOKED', 'invite', inviteId)
  return json({ ok: true })
}

export async function handleInviteRegenerate(env: RuntimeEnv, user: AuthUser, inviteId: string): Promise<Response> {
  requireAdmin(user)
  const invite = await env.DB.prepare(
    `SELECT username, display_name, workspace_id, workspace_role, account_type, user_expires_at
       FROM invites WHERE id = ? AND organization_id = ? LIMIT 1`
  ).bind(inviteId, user.organizationId).first<{
    username: string
    display_name: string
    workspace_id: string
    workspace_role: WorkspaceRole
    account_type: AuthUser['accountType']
    user_expires_at: string | null
  }>()
  if (!invite) throw new HttpError(404, 'INVITE_NOT_FOUND')
  await env.DB.prepare("UPDATE invites SET status = 'REVOKED' WHERE id = ? AND status = 'PENDING'").bind(inviteId).run()
  const code = generateInviteCode()
  const hash = await sha256Text(code)
  const newId = crypto.randomUUID()
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + 72 * 3600_000).toISOString()
  await env.DB.prepare(
    `INSERT INTO invites(
       id, organization_id, username, display_name, token_hash, created_by_user_id, workspace_id, workspace_role,
       account_type, user_expires_at, expires_at, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`
  ).bind(newId, user.organizationId, invite.username, invite.display_name, hash, user.id,
    invite.workspace_id, invite.workspace_role, invite.account_type, invite.user_expires_at, expiresAt, createdAt).run()
  await recordAudit(env, user, 'INVITE_REGENERATED', 'invite', newId, { replacedInviteId: inviteId })
  return json({ id: newId, code, expiresAt }, 201)
}

export async function handleUsersList(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  requireAdmin(user)
  const result = await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.system_role, u.account_type, u.access_expires_at,
            u.lifecycle_status AS status, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ? AND s.revoked_at IS NULL) AS active_sessions,
            (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.status = 'ACTIVE') AS active_devices,
            (SELECT COUNT(*) FROM workspace_members wm WHERE wm.user_id = u.id) AS workspace_count,
            (SELECT COUNT(*) FROM tasks t WHERE t.assignee_user_id = u.id AND t.status != 'DONE') AS open_tasks
       FROM users u WHERE u.organization_id = ? ORDER BY u.created_at ASC`
  ).bind(nowIso(), user.organizationId).all()
  return json({ users: result.results })
}

export async function handleUserLifecycle(request: Request, env: RuntimeEnv, user: AuthUser, targetUserId: string): Promise<Response> {
  requireAdmin(user)
  const input = await requestJson(request, lifecycleSchema)
  const target = await env.DB.prepare('SELECT id, system_role FROM users WHERE id = ? AND organization_id = ? LIMIT 1')
    .bind(targetUserId, user.organizationId).first<{ id: string; system_role: string }>()
  if (!target) throw new HttpError(404, 'USER_NOT_FOUND')
  if (target.system_role === 'OWNER' && targetUserId !== user.id) throw new HttpError(403, 'OWNER_PROTECTED')
  if (targetUserId === user.id && input.status !== 'ACTIVE') throw new HttpError(400, 'CANNOT_DISABLE_SELF')
  if (input.reassignToUserId) {
    const recipient = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND organization_id = ? AND lifecycle_status = 'ACTIVE' LIMIT 1")
      .bind(input.reassignToUserId, user.organizationId).first<{ id: string }>()
    if (!recipient) throw new HttpError(400, 'REASSIGN_TARGET_INVALID')
    await env.DB.prepare(
      `UPDATE tasks SET assignee_user_id = ?, updated_at = ?
        WHERE assignee_user_id = ? AND status != 'DONE'
          AND workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?)`
    ).bind(input.reassignToUserId, nowIso(), targetUserId, input.reassignToUserId).run()
  }
  const legacyStatus = input.status === 'ACTIVE' ? 'active' : 'disabled'
  const timestamp = nowIso()
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET lifecycle_status = ?, status = ? WHERE id = ? AND organization_id = ?')
      .bind(input.status, legacyStatus, targetUserId, user.organizationId),
    ...(input.status === 'ACTIVE'
      ? []
      : [
          env.DB.prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL")
            .bind(timestamp, `USER_${input.status}`, targetUserId),
          env.DB.prepare("UPDATE devices SET status = 'REVOKED', last_seen_at = ? WHERE user_id = ?")
            .bind(timestamp, targetUserId),
          env.DB.prepare('DELETE FROM file_presence WHERE user_id = ?').bind(targetUserId)
        ])
  ])
  const openTasks = await env.DB.prepare("SELECT COUNT(*) AS count FROM tasks WHERE assignee_user_id = ? AND status != 'DONE'")
    .bind(targetUserId).first<{ count: number }>()
  await recordAudit(env, user, `USER_${input.status}`, 'user', targetUserId, { reassignToUserId: input.reassignToUserId ?? null })
  return json({ ok: true, openTasks: openTasks?.count ?? 0 })
}

export async function handleUserForceLogout(env: RuntimeEnv, user: AuthUser, targetUserId: string): Promise<Response> {
  requireAdmin(user)
  const target = await env.DB.prepare('SELECT id, system_role FROM users WHERE id = ? AND organization_id = ? LIMIT 1')
    .bind(targetUserId, user.organizationId).first<{ id: string; system_role: SystemRole }>()
  if (!target) throw new HttpError(404, 'USER_NOT_FOUND')
  if (user.systemRole !== 'OWNER' && target.system_role === 'OWNER') throw new HttpError(403, 'OWNER_PROTECTED')
  const timestamp = nowIso()
  const result = await env.DB.prepare(
    "UPDATE sessions SET revoked_at = ?, revoked_reason = 'ADMIN_FORCE_LOGOUT' WHERE user_id = ? AND revoked_at IS NULL"
  ).bind(timestamp, targetUserId).run()
  await env.DB.batch([
    env.DB.prepare("UPDATE devices SET status = 'REVOKED', last_seen_at = ? WHERE user_id = ?").bind(timestamp, targetUserId),
    env.DB.prepare('DELETE FROM file_presence WHERE user_id = ?').bind(targetUserId)
  ])
  await recordAudit(env, user, 'SESSIONS_INVALIDATED', 'user', targetUserId, { count: result.meta.changes ?? 0 })
  return json({ ok: true, invalidated: result.meta.changes ?? 0 })
}

export async function handleUserRole(request: Request, env: RuntimeEnv, user: AuthUser, targetUserId: string): Promise<Response> {
  requireOwner(user)
  const input = await requestJson(request, systemRoleSchema)
  if (targetUserId === user.id) throw new HttpError(400, 'OWNER_ROLE_IMMUTABLE')
  const target = await env.DB.prepare('SELECT id, system_role, account_type FROM users WHERE id = ? AND organization_id = ? LIMIT 1')
    .bind(targetUserId, user.organizationId).first<{ id: string; system_role: SystemRole; account_type: AuthUser['accountType'] }>()
  if (!target || target.system_role === 'OWNER') throw new HttpError(404, 'USER_NOT_FOUND')
  if (target.account_type === 'EXTERNAL' && input.systemRole === 'ADMIN') throw new HttpError(400, 'EXTERNAL_ADMIN_FORBIDDEN')
  const result = await env.DB.prepare("UPDATE users SET system_role = ? WHERE id = ? AND organization_id = ? AND system_role != 'OWNER'")
    .bind(input.systemRole, targetUserId, user.organizationId).run()
  if ((result.meta.changes ?? 0) !== 1) throw new HttpError(404, 'USER_NOT_FOUND')
  await recordAudit(env, user, 'SYSTEM_ROLE_CHANGED', 'user', targetUserId, { systemRole: input.systemRole })
  return json({ ok: true })
}

export async function handleUserAccountPolicy(request: Request, env: RuntimeEnv, user: AuthUser, targetUserId: string): Promise<Response> {
  requireAdmin(user)
  const input = await requestJson(request, accountPolicySchema)
  const target = await env.DB.prepare(
    'SELECT id, system_role, account_type, access_expires_at FROM users WHERE id = ? AND organization_id = ? LIMIT 1'
  ).bind(targetUserId, user.organizationId).first<{
    id: string
    system_role: SystemRole
    account_type: AuthUser['accountType']
    access_expires_at: string | null
  }>()
  if (!target) throw new HttpError(404, 'USER_NOT_FOUND')
  if (target.system_role === 'OWNER' && input.accountType !== 'INTERNAL') throw new HttpError(400, 'OWNER_MUST_BE_INTERNAL')
  if (target.system_role === 'ADMIN' && input.accountType === 'EXTERNAL') throw new HttpError(400, 'EXTERNAL_ADMIN_FORBIDDEN')
  if (input.accessExpiresAt && new Date(input.accessExpiresAt).getTime() <= Date.now()) throw new HttpError(400, 'USER_EXPIRY_INVALID')
  await env.DB.prepare('UPDATE users SET account_type = ?, access_expires_at = ? WHERE id = ? AND organization_id = ?')
    .bind(input.accountType, input.accessExpiresAt ?? null, targetUserId, user.organizationId).run()
  await recordAudit(env, user, 'USER_ACCOUNT_POLICY_CHANGED', 'user', targetUserId, {
    accountType: input.accountType,
    accessExpiresAt: input.accessExpiresAt ?? null
  })
  return json({ ok: true })
}

export async function handleWorkspacesList(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  const admin = isSystemAdmin(user)
  const result = await env.DB.prepare(
    admin
      ? `SELECT w.id, w.name, w.type, w.status, w.default_storage_connection_id, w.created_at,
                (SELECT COUNT(*) FROM workspace_members wm WHERE wm.workspace_id = w.id) AS member_count,
                (SELECT COUNT(*) FROM files f WHERE f.workspace_id = w.id AND f.status != 'deleted') AS file_count
           FROM workspaces w WHERE w.organization_id = ? ORDER BY w.status, w.name COLLATE NOCASE`
      : `SELECT w.id, w.name, w.type, w.status, w.default_storage_connection_id, w.created_at, wm.role,
                (SELECT COUNT(*) FROM workspace_members x WHERE x.workspace_id = w.id) AS member_count,
                (SELECT COUNT(*) FROM files f WHERE f.workspace_id = w.id AND f.status != 'deleted') AS file_count
           FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = ?
          WHERE w.organization_id = ? ORDER BY w.status, w.name COLLATE NOCASE`
  ).bind(...(admin ? [user.organizationId] : [user.id, user.organizationId])).all()
  return json({ workspaces: result.results, defaultWorkspaceId: await getDefaultWorkspaceId(env, user) })
}

export async function handleWorkspaceCreate(request: Request, env: RuntimeEnv, user: AuthUser): Promise<Response> {
  requireAdmin(user)
  const input = await requestJson(request, workspaceCreateSchema)
  if (input.defaultStorageConnectionId) {
    const storage = await env.DB.prepare('SELECT id FROM storage_connections WHERE id = ? AND organization_id = ? AND status != \'DISABLED\' LIMIT 1')
      .bind(input.defaultStorageConnectionId, user.organizationId).first<{ id: string }>()
    if (!storage) throw new HttpError(400, 'STORAGE_CONNECTION_INVALID')
  }
  const id = crypto.randomUUID()
  const createdAt = nowIso()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspaces(id, organization_id, name, type, status, default_storage_connection_id, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`
    ).bind(id, user.organizationId, input.name, input.type, input.defaultStorageConnectionId ?? null, user.id, createdAt),
    env.DB.prepare("INSERT INTO workspace_members(workspace_id, user_id, role, joined_at) VALUES (?, ?, 'MANAGER', ?)")
      .bind(id, user.id, createdAt),
    env.DB.prepare(
      `INSERT INTO resource_access_rules(
        id, organization_id, workspace_id, principal_type, principal_id, scope_type, scope_value,
        permission, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'USER', ?, 'WORKSPACE', ?, 'MANAGE', ?, ?, ?)`
    ).bind(crypto.randomUUID(), user.organizationId, id, user.id, id, user.id, createdAt, createdAt)
  ])
  await recordAudit(env, user, 'WORKSPACE_CREATED', 'workspace', id, { name: input.name, type: input.type })
  return json({ id, name: input.name }, 201)
}

export async function handleWorkspaceArchive(env: RuntimeEnv, user: AuthUser, workspaceId: string): Promise<Response> {
  requireAdmin(user)
  await ensureOrgWorkspace(env, user, workspaceId)
  const activeCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE organization_id = ? AND status = 'ACTIVE'")
    .bind(user.organizationId).first<{ count: number }>()
  if ((activeCount?.count ?? 0) <= 1) throw new HttpError(409, 'LAST_WORKSPACE_CANNOT_ARCHIVE')
  await env.DB.prepare("UPDATE workspaces SET status = 'ARCHIVED', archived_at = ? WHERE id = ? AND organization_id = ?")
    .bind(nowIso(), workspaceId, user.organizationId).run()
  await recordAudit(env, user, 'WORKSPACE_ARCHIVED', 'workspace', workspaceId)
  return json({ ok: true })
}

export async function handleWorkspaceMembers(env: RuntimeEnv, user: AuthUser, workspaceId: string): Promise<Response> {
  await ensureOrgWorkspace(env, user, workspaceId)
  if (!isSystemAdmin(user)) await requireWorkspaceRole(env, user, workspaceId, 'MANAGER')
  const result = await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.lifecycle_status AS status, wm.role, wm.joined_at
       FROM workspace_members wm JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = ? ORDER BY CASE wm.role WHEN 'MANAGER' THEN 0 WHEN 'EDITOR' THEN 1 ELSE 2 END, u.display_name COLLATE NOCASE`
  ).bind(workspaceId).all()
  return json({ members: result.results })
}

export async function handleWorkspaceMemberPut(request: Request, env: RuntimeEnv, user: AuthUser, workspaceId: string): Promise<Response> {
  await ensureOrgWorkspace(env, user, workspaceId)
  if (!isSystemAdmin(user)) await requireWorkspaceRole(env, user, workspaceId, 'MANAGER')
  const input = await requestJson(request, membershipSchema)
  const target = await env.DB.prepare("SELECT id, account_type FROM users WHERE id = ? AND organization_id = ? AND lifecycle_status != 'DEACTIVATED' LIMIT 1")
    .bind(input.userId, user.organizationId).first<{ id: string; account_type: AuthUser['accountType'] }>()
  if (!target) throw new HttpError(404, 'USER_NOT_FOUND')
  if (target.account_type === 'EXTERNAL' && input.role === 'MANAGER') throw new HttpError(400, 'EXTERNAL_MANAGER_FORBIDDEN')
  const existing = await env.DB.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? LIMIT 1')
    .bind(workspaceId, input.userId).first<{ role: WorkspaceRole }>()
  const timestamp = nowIso()
  const permission = permissionForWorkspaceRole(input.role)
  const statements = [
    env.DB.prepare(
      `INSERT INTO workspace_members(workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`
    ).bind(workspaceId, input.userId, input.role, timestamp)
  ]
  if (!existing) {
    statements.push(env.DB.prepare(
      `INSERT INTO resource_access_rules(
        id, organization_id, workspace_id, principal_type, principal_id, scope_type, scope_value,
        permission, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'USER', ?, 'WORKSPACE', ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), user.organizationId, workspaceId, input.userId, workspaceId, permission, user.id, timestamp, timestamp))
  } else {
    statements.push(env.DB.prepare(
      `UPDATE resource_access_rules SET permission = ?, updated_at = ?
        WHERE workspace_id = ? AND principal_type = 'USER' AND principal_id = ?`
    ).bind(permission, timestamp, workspaceId, input.userId))
  }
  await env.DB.batch(statements)
  await recordAudit(env, user, 'WORKSPACE_MEMBER_CHANGED', 'workspace', workspaceId, { userId: input.userId, role: input.role })
  return json({ ok: true })
}

export async function handleWorkspaceMemberDelete(env: RuntimeEnv, user: AuthUser, workspaceId: string, targetUserId: string): Promise<Response> {
  await ensureOrgWorkspace(env, user, workspaceId)
  if (!isSystemAdmin(user)) await requireWorkspaceRole(env, user, workspaceId, 'MANAGER')
  const managers = await env.DB.prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND role = 'MANAGER'")
    .bind(workspaceId).first<{ count: number }>()
  const target = await getMembership(env, targetUserId, workspaceId)
  if (!target) throw new HttpError(404, 'WORKSPACE_MEMBER_NOT_FOUND')
  if (target === 'MANAGER' && (managers?.count ?? 0) <= 1) throw new HttpError(409, 'LAST_MANAGER_CANNOT_REMOVE')
  await env.DB.batch([
    env.DB.prepare('DELETE FROM resource_access_rules WHERE workspace_id = ? AND principal_type = \'USER\' AND principal_id = ?').bind(workspaceId, targetUserId),
    env.DB.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, targetUserId)
  ])
  await recordAudit(env, user, 'WORKSPACE_MEMBER_REMOVED', 'workspace', workspaceId, { userId: targetUserId })
  return json({ ok: true })
}

function normalizeFolderScope(value: string): string {
  const normalized = value.replaceAll('\\', '/').trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/')
  if (!normalized || normalized.length > 1000) throw new HttpError(400, 'INVALID_FOLDER_SCOPE')
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new HttpError(400, 'INVALID_FOLDER_SCOPE')
  return normalized
}

async function callerCanGrantScope(
  env: RuntimeEnv,
  user: AuthUser,
  workspaceId: string,
  scopeType: ResourceScopeType,
  scopeValue: string
): Promise<boolean> {
  if (isSystemAdmin(user)) return true
  if (scopeType === 'FILE') return Boolean(await resolveFileAccess(env, user, scopeValue, 'MANAGER'))
  const rules = await env.DB.prepare(
    `SELECT scope_type, scope_value FROM resource_access_rules
      WHERE workspace_id = ? AND principal_type = 'USER' AND principal_id = ? AND permission = 'MANAGE'`
  ).bind(workspaceId, user.id).all<{ scope_type: ResourceScopeType; scope_value: string }>()
  if (rules.results.some((rule) => rule.scope_type === 'WORKSPACE' && rule.scope_value === workspaceId)) return true
  if (scopeType === 'STORAGE') return rules.results.some((rule) => rule.scope_type === 'STORAGE' && rule.scope_value === scopeValue)
  if (scopeType === 'FOLDER') return rules.results.some((rule) => rule.scope_type === 'FOLDER' && (scopeValue === rule.scope_value || scopeValue.startsWith(`${rule.scope_value}/`)))
  return false
}

export async function handleResourceAccessGet(
  env: RuntimeEnv,
  user: AuthUser,
  workspaceId: string,
  targetUserId: string
): Promise<Response> {
  await ensureOrgWorkspace(env, user, workspaceId)
  await requireWorkspaceRole(env, user, workspaceId, 'MANAGER')
  const target = await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.system_role, wm.role
       FROM workspace_members wm JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = ? AND u.id = ? AND u.organization_id = ? LIMIT 1`
  ).bind(workspaceId, targetUserId, user.organizationId).first<{
    id: string; username: string; display_name: string; system_role: SystemRole; role: WorkspaceRole
  }>()
  if (!target) throw new HttpError(404, 'WORKSPACE_MEMBER_NOT_FOUND')

  const rules = await env.DB.prepare(
    `SELECT id, scope_type, scope_value, permission, created_at, updated_at
       FROM resource_access_rules
      WHERE organization_id = ? AND workspace_id = ? AND principal_type = 'USER' AND principal_id = ?
      ORDER BY CASE scope_type WHEN 'WORKSPACE' THEN 0 WHEN 'STORAGE' THEN 1 WHEN 'FOLDER' THEN 2 ELSE 3 END, scope_value COLLATE NOCASE`
  ).bind(user.organizationId, workspaceId, targetUserId).all()
  const inheritedRules = await env.DB.prepare(
    `SELECT r.id, r.scope_type, r.scope_value, r.permission, r.created_at, r.updated_at,
            g.id AS group_id, g.name AS group_name
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id AND g.organization_id = ? AND g.status = 'ACTIVE'
       JOIN resource_access_rules r ON r.principal_type = 'GROUP' AND r.principal_id = g.id
      WHERE gm.user_id = ? AND r.workspace_id = ? AND r.organization_id = ?
      ORDER BY g.name COLLATE NOCASE,
               CASE r.scope_type WHEN 'WORKSPACE' THEN 0 WHEN 'STORAGE' THEN 1 WHEN 'FOLDER' THEN 2 ELSE 3 END,
               r.scope_value COLLATE NOCASE`
  ).bind(user.organizationId, targetUserId, workspaceId, user.organizationId).all()

  const admin = isSystemAdmin(user)
  const files = await env.DB.prepare(
    admin
      ? `SELECT f.id, f.logical_name, f.relative_path, f.home_storage_connection_id, f.current_version, f.status
           FROM files f WHERE f.workspace_id = ? AND f.status != 'deleted' ORDER BY f.relative_path COLLATE NOCASE LIMIT 2000`
      : `SELECT f.id, f.logical_name, f.relative_path, f.home_storage_connection_id, f.current_version, f.status
           FROM files f
          WHERE f.workspace_id = ? AND f.status != 'deleted'
            AND EXISTS (
              SELECT 1 FROM resource_access_rules r
               WHERE r.workspace_id = f.workspace_id AND r.permission = 'MANAGE'
                 AND (
                   (r.principal_type = 'USER' AND r.principal_id = ?)
                   OR (r.principal_type = 'GROUP' AND r.principal_id IN (
                     SELECT gm.group_id FROM group_members gm
                     JOIN groups g ON g.id = gm.group_id AND g.status = 'ACTIVE'
                     WHERE gm.user_id = ? AND g.organization_id = ?
                   ))
                 )
                 AND (
                   (r.scope_type = 'WORKSPACE' AND r.scope_value = f.workspace_id)
                   OR (r.scope_type = 'STORAGE' AND r.scope_value = COALESCE(f.home_storage_connection_id, ''))
                   OR (r.scope_type = 'FILE' AND r.scope_value = f.id)
                   OR (r.scope_type = 'FOLDER' AND (f.relative_path = r.scope_value OR f.relative_path LIKE r.scope_value || '/%'))
                 )
            )
          ORDER BY f.relative_path COLLATE NOCASE LIMIT 2000`
  ).bind(...(admin ? [workspaceId] : [workspaceId, user.id, user.id, user.organizationId])).all<Record<string, unknown>>()

  const storages = await env.DB.prepare(
    `SELECT id, name, status FROM storage_connections WHERE organization_id = ? ORDER BY name COLLATE NOCASE`
  ).bind(user.organizationId).all()
  const folders = new Set<string>()
  for (const row of files.results) {
    const parts = String(row.relative_path ?? '').replaceAll('\\', '/').split('/').filter(Boolean)
    parts.pop()
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      folders.add(current)
    }
  }
  return json({
    member: target,
    rules: rules.results,
    inheritedRules: inheritedRules.results,
    files: files.results,
    folders: [...folders].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    storages: storages.results
  })
}

export async function handleResourceAccessReplace(
  request: Request,
  env: RuntimeEnv,
  user: AuthUser,
  workspaceId: string,
  targetUserId: string
): Promise<Response> {
  await ensureOrgWorkspace(env, user, workspaceId)
  await requireWorkspaceRole(env, user, workspaceId, 'MANAGER')
  const input = await requestJson(request, resourceAccessReplaceSchema)
  const target = await env.DB.prepare(
    `SELECT u.id, u.system_role, u.account_type, wm.role
       FROM workspace_members wm JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = ? AND u.id = ? AND u.organization_id = ? LIMIT 1`
  ).bind(workspaceId, targetUserId, user.organizationId).first<{
    id: string
    system_role: SystemRole
    account_type: AuthUser['accountType']
    role: WorkspaceRole
  }>()
  if (!target) throw new HttpError(404, 'WORKSPACE_MEMBER_NOT_FOUND')
  if (target.system_role !== 'MEMBER') throw new HttpError(409, 'SYSTEM_ADMIN_SCOPE_BYPASS')
  if (target.account_type === 'EXTERNAL' && input.workspaceRole === 'MANAGER') throw new HttpError(400, 'EXTERNAL_MANAGER_FORBIDDEN')

  const normalizedScopes: Array<{ scopeType: ResourceScopeType; scopeValue: string }> = []
  const seen = new Set<string>()
  for (const scope of input.scopes) {
    let value = scope.scopeValue
    if (scope.scopeType === 'WORKSPACE') value = workspaceId
    if (scope.scopeType === 'FOLDER') value = normalizeFolderScope(value)
    if (scope.scopeType === 'STORAGE') {
      const storage = await env.DB.prepare('SELECT id FROM storage_connections WHERE id = ? AND organization_id = ? LIMIT 1')
        .bind(value, user.organizationId).first<{ id: string }>()
      if (!storage) throw new HttpError(400, 'STORAGE_SCOPE_INVALID')
    }
    if (scope.scopeType === 'FILE') {
      const file = await env.DB.prepare('SELECT id FROM files WHERE id = ? AND workspace_id = ? LIMIT 1')
        .bind(value, workspaceId).first<{ id: string }>()
      if (!file) throw new HttpError(400, 'FILE_SCOPE_INVALID')
    }
    if (!(await callerCanGrantScope(env, user, workspaceId, scope.scopeType, value))) {
      throw new HttpError(403, 'RESOURCE_SCOPE_GRANT_FORBIDDEN')
    }
    const key = `${scope.scopeType}:${value}`
    if (!seen.has(key)) {
      seen.add(key)
      normalizedScopes.push({ scopeType: scope.scopeType, scopeValue: value })
    }
  }
  if (normalizedScopes.length === 0) throw new HttpError(400, 'RESOURCE_SCOPE_REQUIRED')

  const timestamp = nowIso()
  const permission = permissionForWorkspaceRole(input.workspaceRole)
  const statements = [
    env.DB.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?')
      .bind(input.workspaceRole, workspaceId, targetUserId),
    env.DB.prepare("DELETE FROM resource_access_rules WHERE workspace_id = ? AND principal_type = 'USER' AND principal_id = ?")
      .bind(workspaceId, targetUserId)
  ]
  for (const scope of normalizedScopes) {
    statements.push(env.DB.prepare(
      `INSERT INTO resource_access_rules(
        id, organization_id, workspace_id, principal_type, principal_id, scope_type, scope_value,
        permission, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'USER', ?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), user.organizationId, workspaceId, targetUserId, scope.scopeType, scope.scopeValue,
      permission, user.id, timestamp, timestamp))
  }
  await env.DB.batch(statements)
  await recordAudit(env, user, 'RESOURCE_ACCESS_REPLACED', 'user', targetUserId, {
    workspaceId,
    workspaceRole: input.workspaceRole,
    scopes: normalizedScopes
  })
  return json({ ok: true, workspaceRole: input.workspaceRole, scopes: normalizedScopes })
}

export async function handleDefaultWorkspace(request: Request, env: RuntimeEnv, user: AuthUser, workspaceId: string): Promise<Response> {
  await requireWorkspaceRole(env, user, workspaceId, 'VIEWER')
  await setDefaultWorkspace(env, user.id, workspaceId)
  return json({ ok: true, defaultWorkspaceId: workspaceId })
}

export async function handleWorkspaceStorage(request: Request, env: RuntimeEnv, user: AuthUser, workspaceId: string): Promise<Response> {
  requireAdmin(user)
  await requireWorkspaceRole(env, user, workspaceId, 'MANAGER')
  const input = await requestJson(request, workspaceStorageSchema)
  const storage = await env.DB.prepare("SELECT id FROM storage_connections WHERE id = ? AND organization_id = ? AND status != 'DISABLED' LIMIT 1")
    .bind(input.storageConnectionId, user.organizationId).first<{ id: string }>()
  if (!storage) throw new HttpError(400, 'STORAGE_CONNECTION_INVALID')
  await env.DB.prepare('UPDATE workspaces SET default_storage_connection_id = ? WHERE id = ? AND organization_id = ?')
    .bind(input.storageConnectionId, workspaceId, user.organizationId).run()
  await recordAudit(env, user, 'WORKSPACE_DEFAULT_STORAGE_CHANGED', 'workspace', workspaceId, { storageConnectionId: input.storageConnectionId })
  return json({ ok: true })
}

async function taskResponse(env: RuntimeEnv, user: AuthUser, workspaceIds: string[], extraWhere = '', extraBindings: unknown[] = []): Promise<unknown[]> {
  if (workspaceIds.length === 0) return []
  const placeholders = workspaceIds.map(() => '?').join(',')
  const result = await env.DB.prepare(
    `SELECT t.id, t.workspace_id, w.name AS workspace_name, t.title, t.description, t.status, t.priority,
            t.created_by_user_id, t.assignee_user_id, au.display_name AS assignee_name, t.legacy_assignee_text,
            t.due_at, t.created_at, t.updated_at, t.completed_at,
            (SELECT json_group_array(file_id) FROM task_file_links l WHERE l.task_id = t.id) AS file_ids
       FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
       LEFT JOIN users au ON au.id = t.assignee_user_id
      WHERE t.workspace_id IN (${placeholders}) ${extraWhere}
      ORDER BY CASE t.status WHEN 'DONE' THEN 1 ELSE 0 END, CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, COALESCE(t.due_at, '9999') ASC, t.updated_at DESC
      LIMIT 1000`
  ).bind(...workspaceIds, ...extraBindings).all<Record<string, unknown>>()
  const rows: unknown[] = []
  for (const row of result.results) {
    const rawIds = typeof row.file_ids === 'string' ? JSON.parse(row.file_ids) as string[] : []
    const fileIds: string[] = []
    if (isSystemAdmin(user)) {
      fileIds.push(...rawIds)
    } else {
      for (const fileId of rawIds) {
        if (await resolveFileAccess(env, user, fileId, 'VIEWER')) fileIds.push(fileId)
      }
    }
    rows.push({ ...row, file_ids: fileIds })
  }
  return rows
}

export async function handleTasksList(request: Request, env: RuntimeEnv, user: AuthUser): Promise<Response> {
  const memberships = await getMemberships(env, user)
  const workspaceParam = new URL(request.url).searchParams.get('workspaceId')
  const allowed = memberships.filter((item) => item.status === 'ACTIVE').map((item) => item.workspaceId)
  const workspaceIds = workspaceParam ? (allowed.includes(workspaceParam) ? [workspaceParam] : []) : allowed
  if (workspaceParam && workspaceIds.length === 0) throw new HttpError(403, 'WORKSPACE_FORBIDDEN')
  return json({ tasks: await taskResponse(env, user, workspaceIds) })
}

export async function handleMyTasks(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  const workspaceIds = (await getMemberships(env, user)).filter((item) => item.status === 'ACTIVE').map((item) => item.workspaceId)
  return json({ tasks: await taskResponse(env, user, workspaceIds, 'AND (t.assignee_user_id = ? OR (t.assignee_user_id IS NULL AND t.created_by_user_id = ?))', [user.id, user.id]) })
}

async function createTaskRecord(env: RuntimeEnv, user: AuthUser, input: z.infer<typeof taskCreateSchema>): Promise<{ id: string; created: boolean }> {
  const workspaceId = input.workspaceId ?? await getDefaultWorkspaceId(env, user)
  if (!workspaceId) throw new HttpError(400, 'DEFAULT_WORKSPACE_REQUIRED')
  const role = await requireWorkspaceRole(env, user, workspaceId, 'VIEWER')
  if (!workspaceRoleAtLeast(role, 'MANAGER') && input.assigneeUserId && input.assigneeUserId !== user.id) {
    throw new HttpError(403, 'TASK_ASSIGN_FORBIDDEN')
  }
  await validateTaskAssignee(env, workspaceId, input.assigneeUserId)
  await validateTaskFiles(env, user, workspaceId, input.fileIds)
  if (input.legacyClientId) {
    const existing = await env.DB.prepare('SELECT id FROM tasks WHERE created_by_user_id = ? AND legacy_client_id = ? LIMIT 1')
      .bind(user.id, input.legacyClientId).first<{ id: string }>()
    if (existing) return { id: existing.id, created: false }
  }
  const id = crypto.randomUUID()
  const timestamp = nowIso()
  const completedAt = input.status === 'DONE' ? timestamp : null
  const statements = [env.DB.prepare(
    `INSERT INTO tasks(id, workspace_id, title, description, status, priority, created_by_user_id, assignee_user_id,
                       legacy_assignee_text, legacy_client_id, due_at, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, workspaceId, input.title, input.description, input.status, input.priority, user.id, input.assigneeUserId ?? null,
    input.legacyAssigneeText ?? null, input.legacyClientId ?? null, input.dueAt ?? null, timestamp, timestamp, completedAt)]
  for (const fileId of input.fileIds) statements.push(env.DB.prepare('INSERT INTO task_file_links(task_id, file_id, created_at) VALUES (?, ?, ?)').bind(id, fileId, timestamp))
  await env.DB.batch(statements)
  return { id, created: true }
}

export async function handleTaskCreate(request: Request, env: RuntimeEnv, user: AuthUser): Promise<Response> {
  const input = await requestJson(request, taskCreateSchema)
  const result = await createTaskRecord(env, user, input)
  return json(result, result.created ? 201 : 200)
}

export async function handleTaskMigration(request: Request, env: RuntimeEnv, user: AuthUser): Promise<Response> {
  const input = await requestJson(request, taskMigrationSchema)
  const imported: string[] = []
  const existing: string[] = []
  for (const task of input.tasks) {
    const result = await createTaskRecord(env, user, task)
    ;(result.created ? imported : existing).push(result.id)
  }
  return json({ ok: true, imported, existing })
}

export async function handleTaskUpdate(request: Request, env: RuntimeEnv, user: AuthUser, taskId: string): Promise<Response> {
  const input = await requestJson(request, taskUpdateSchema)
  const task = await env.DB.prepare('SELECT workspace_id, created_by_user_id, assignee_user_id, status FROM tasks WHERE id = ? LIMIT 1')
    .bind(taskId).first<{ workspace_id: string; created_by_user_id: string; assignee_user_id: string | null; status: string }>()
  if (!task) throw new HttpError(404, 'TASK_NOT_FOUND')
  const role = await requireWorkspaceRole(env, user, task.workspace_id, 'VIEWER')
  const ownsTask = task.created_by_user_id === user.id || task.assignee_user_id === user.id
  if (!workspaceRoleAtLeast(role, 'MANAGER') && !ownsTask) throw new HttpError(403, 'TASK_FORBIDDEN')
  if (input.assigneeUserId !== undefined) {
    if (!workspaceRoleAtLeast(role, 'MANAGER') && input.assigneeUserId !== user.id) throw new HttpError(403, 'TASK_ASSIGN_FORBIDDEN')
    await validateTaskAssignee(env, task.workspace_id, input.assigneeUserId)
  }
  if (input.fileIds) await validateTaskFiles(env, user, task.workspace_id, input.fileIds)
  const timestamp = nowIso()
  const nextStatus = input.status ?? task.status
  const completedAt = nextStatus === 'DONE' ? timestamp : null
  await env.DB.prepare(
    `UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description), status = COALESCE(?, status),
      priority = COALESCE(?, priority), assignee_user_id = CASE WHEN ? = 1 THEN ? ELSE assignee_user_id END,
      due_at = CASE WHEN ? = 1 THEN ? ELSE due_at END, updated_at = ?, completed_at = ? WHERE id = ?`
  ).bind(input.title ?? null, input.description ?? null, input.status ?? null, input.priority ?? null,
    input.assigneeUserId !== undefined ? 1 : 0, input.assigneeUserId ?? null,
    input.dueAt !== undefined ? 1 : 0, input.dueAt ?? null, timestamp, completedAt, taskId).run()
  if (input.fileIds) {
    const statements = [env.DB.prepare('DELETE FROM task_file_links WHERE task_id = ?').bind(taskId)]
    for (const fileId of input.fileIds) statements.push(env.DB.prepare('INSERT INTO task_file_links(task_id, file_id, created_at) VALUES (?, ?, ?)').bind(taskId, fileId, timestamp))
    await env.DB.batch(statements)
  }
  return json({ ok: true })
}

export async function handleTaskDelete(env: RuntimeEnv, user: AuthUser, taskId: string): Promise<Response> {
  const task = await env.DB.prepare('SELECT workspace_id, created_by_user_id FROM tasks WHERE id = ? LIMIT 1').bind(taskId).first<{ workspace_id: string; created_by_user_id: string }>()
  if (!task) throw new HttpError(404, 'TASK_NOT_FOUND')
  const role = await requireWorkspaceRole(env, user, task.workspace_id, 'VIEWER')
  if (task.created_by_user_id !== user.id && !workspaceRoleAtLeast(role, 'MANAGER')) throw new HttpError(403, 'TASK_FORBIDDEN')
  await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(taskId).run()
  return json({ ok: true })
}

export async function handleStorageList(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  requireAdmin(user)
  const router = new StorageRouter(env)
  return json({ connections: await router.listConnections(user.organizationId) })
}

export async function handleStorageCreate(request: Request, env: RuntimeEnv, user: AuthUser): Promise<Response> {
  requireAdmin(user)
  if (!env.STORAGE_MASTER_KEY) throw new HttpError(503, 'STORAGE_MASTER_KEY_NOT_CONFIGURED')
  const input = await requestJson(request, storageCreateSchema)
  let me: Awaited<ReturnType<typeof telegramGetMe>>
  try {
    me = await telegramGetMe(input.botToken)
  } catch {
    throw new HttpError(400, 'TELEGRAM_BOT_TOKEN_INVALID')
  }
  const encrypted = await encryptCredential(env.STORAGE_MASTER_KEY, input.botToken)
  const id = crypto.randomUUID()
  const timestamp = nowIso()
  await env.DB.prepare(
    `INSERT INTO storage_connections(id, organization_id, provider, name, telegram_bot_id, telegram_bot_username, telegram_bot_name,
      credential_ciphertext, credential_iv, credential_source, status, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, 'telegram', ?, ?, ?, ?, ?, ?, 'ENCRYPTED', 'DEGRADED', ?, ?, ?)`
  ).bind(id, user.organizationId, input.name, String(me.id), me.username ?? null, me.name ?? me.username ?? null,
    encrypted.ciphertext, encrypted.iv, user.id, timestamp, timestamp).run()
  await recordAudit(env, user, 'STORAGE_CONNECTION_CREATED', 'storage_connection', id, { provider: 'telegram', botId: String(me.id), botUsername: me.username ?? null })
  return json({ id, name: input.name, provider: 'telegram', botId: String(me.id), botUsername: me.username ?? null, botName: me.name ?? null, status: 'DEGRADED' }, 201)
}

export async function handleStorageRotateToken(request: Request, env: RuntimeEnv, user: AuthUser, storageId: string): Promise<Response> {
  requireAdmin(user)
  if (!env.STORAGE_MASTER_KEY) throw new HttpError(503, 'STORAGE_MASTER_KEY_NOT_CONFIGURED')
  const input = await requestJson(request, storageTokenSchema)
  const row = await env.DB.prepare('SELECT id FROM storage_connections WHERE id = ? AND organization_id = ? LIMIT 1').bind(storageId, user.organizationId).first<{ id: string }>()
  if (!row) throw new HttpError(404, 'STORAGE_CONNECTION_NOT_FOUND')
  let me: Awaited<ReturnType<typeof telegramGetMe>>
  try { me = await telegramGetMe(input.botToken) } catch { throw new HttpError(400, 'TELEGRAM_BOT_TOKEN_INVALID') }
  const encrypted = await encryptCredential(env.STORAGE_MASTER_KEY, input.botToken)
  await env.DB.prepare(
    `UPDATE storage_connections SET telegram_bot_id = ?, telegram_bot_username = ?, telegram_bot_name = ?,
      credential_ciphertext = ?, credential_iv = ?, credential_source = 'ENCRYPTED', status = CASE WHEN chat_id IS NULL THEN 'DEGRADED' ELSE 'ACTIVE' END,
      updated_at = ?, last_error = NULL WHERE id = ? AND organization_id = ?`
  ).bind(String(me.id), me.username ?? null, me.name ?? me.username ?? null, encrypted.ciphertext, encrypted.iv, nowIso(), storageId, user.organizationId).run()
  await recordAudit(env, user, 'STORAGE_TOKEN_ROTATED', 'storage_connection', storageId, { botId: String(me.id), botUsername: me.username ?? null })
  return json({ ok: true, botId: String(me.id), botUsername: me.username ?? null, botName: me.name ?? null })
}

export async function handleStoragePairStart(env: RuntimeEnv, user: AuthUser, storageId: string): Promise<Response> {
  requireAdmin(user)
  const router = new StorageRouter(env)
  const resolved = await router.resolveConnectionForCredentialCheck(storageId, user.organizationId)
  const code = generateInviteCode().replace('XS-', 'PAIR-')
  const hash = await sha256Text(code)
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
  await env.DB.prepare(
    `INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(`storage_pair:${storageId}:${user.id}`, JSON.stringify({ hash, expiresAt }), nowIso()).run()
  const username = resolved.botUsername
  if (!username) throw new HttpError(409, 'TELEGRAM_BOT_USERNAME_REQUIRED')
  return json({ code, deepLink: `https://t.me/${encodeURIComponent(username)}?start=${encodeURIComponent(code)}`, expiresAt, botUsername: username })
}

export async function handleStoragePairConfirm(env: RuntimeEnv, user: AuthUser, storageId: string): Promise<Response> {
  requireAdmin(user)
  const router = new StorageRouter(env)
  const resolved = await router.resolveConnectionForCredentialCheck(storageId, user.organizationId)
  const key = `storage_pair:${storageId}:${user.id}`
  const setting = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ? LIMIT 1').bind(key).first<{ value: string }>()
  if (!setting) throw new HttpError(409, 'PAIR_NOT_STARTED')
  let pair: { hash: string; expiresAt: string }
  try { pair = JSON.parse(setting.value) as { hash: string; expiresAt: string } } catch { throw new HttpError(500, 'PAIR_STATE_INVALID') }
  if (new Date(pair.expiresAt).getTime() <= Date.now()) throw new HttpError(409, 'PAIR_EXPIRED')
  const updates = await telegramGetUpdates(resolved.token)
  let matched: { chatId: string; chatTitle: string } | null = null
  for (const update of updates.slice().sort((a, b) => b.update_id - a.update_id)) {
    const message = update.message
    if (!message || !message.text?.startsWith('/start')) continue
    const payload = message.text.split(/\s+/, 2)[1]
    if (!payload || await sha256Text(payload) !== pair.hash) continue
    matched = {
      chatId: String(message.chat.id),
      chatTitle: message.chat.title || message.chat.username || [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' ') || String(message.chat.id)
    }
    break
  }
  if (!matched) throw new HttpError(404, 'PAIR_MESSAGE_NOT_FOUND')
  const timestamp = nowIso()
  await env.DB.batch([
    env.DB.prepare("UPDATE storage_connections SET chat_id = ?, chat_title = ?, status = 'ACTIVE', updated_at = ?, last_error = NULL WHERE id = ? AND organization_id = ?")
      .bind(matched.chatId, matched.chatTitle, timestamp, storageId, user.organizationId),
    env.DB.prepare('DELETE FROM app_settings WHERE key = ?').bind(key)
  ])
  await recordAudit(env, user, 'STORAGE_PAIRED', 'storage_connection', storageId, { chatId: matched.chatId, chatTitle: matched.chatTitle })
  return json({ ok: true, chatId: matched.chatId, chatTitle: matched.chatTitle })
}

export async function handleStorageDisable(env: RuntimeEnv, user: AuthUser, storageId: string): Promise<Response> {
  requireAdmin(user)
  const inUse = await env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE organization_id = ? AND default_storage_connection_id = ? AND status = 'ACTIVE'")
    .bind(user.organizationId, storageId).first<{ count: number }>()
  if ((inUse?.count ?? 0) > 0) throw new HttpError(409, 'STORAGE_CONNECTION_IN_USE')
  const result = await env.DB.prepare("UPDATE storage_connections SET status = 'DISABLED', updated_at = ? WHERE id = ? AND organization_id = ?")
    .bind(nowIso(), storageId, user.organizationId).run()
  if ((result.meta.changes ?? 0) !== 1) throw new HttpError(404, 'STORAGE_CONNECTION_NOT_FOUND')
  await recordAudit(env, user, 'STORAGE_CONNECTION_DISABLED', 'storage_connection', storageId)
  return json({ ok: true })
}

export async function handleStorageHealth(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  requireAdmin(user)
  const router = new StorageRouter(env)
  const connections = await router.listConnections(user.organizationId)
  const statuses = [] as Array<Record<string, unknown>>
  for (const connection of connections) {
    if (connection.status === 'DISABLED') {
      statuses.push({ id: connection.id, name: connection.name, status: 'DISABLED', reachable: false })
      continue
    }
    const checkedAt = nowIso()
    try {
      const resolved = await router.resolveConnection(connection.id)
      const status = await resolved.provider.status()
      const nextStatus = status.reachable ? 'ACTIVE' : 'DEGRADED'
      await env.DB.prepare('UPDATE storage_connections SET status = ?, last_health_check_at = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .bind(nextStatus, checkedAt, status.reachable ? null : (status.detail ?? 'STORAGE_UNAVAILABLE').slice(0, 500), checkedAt, connection.id).run()
      statuses.push({ id: connection.id, name: connection.name, status: nextStatus, reachable: status.reachable, detail: status.detail })
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'STORAGE_UNAVAILABLE'
      await env.DB.prepare("UPDATE storage_connections SET status = 'DEGRADED', last_health_check_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .bind(checkedAt, detail.slice(0, 500), checkedAt, connection.id).run()
      statuses.push({ id: connection.id, name: connection.name, status: 'DEGRADED', reachable: false, detail })
    }
  }
  return json({ connections: statuses })
}

export async function handleAuditLogs(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  requireAdmin(user)
  const result = await env.DB.prepare(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.detail_json, a.created_at,
            u.username AS actor_username, u.display_name AS actor_display_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.organization_id = ? ORDER BY a.created_at DESC LIMIT 500`
  ).bind(user.organizationId).all()
  return json({ logs: result.results })
}

export async function handleSystemStatus(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  requireAdmin(user)
  const [db, users, workspaces, tasks, conflicts, syncErrors] = await Promise.all([
    env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE organization_id = ? AND lifecycle_status = 'ACTIVE'").bind(user.organizationId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE organization_id = ? AND status = 'ACTIVE'").bind(user.organizationId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM tasks t JOIN workspaces w ON w.id = t.workspace_id WHERE w.organization_id = ? AND t.status != 'DONE'").bind(user.organizationId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM sync_events WHERE event_type = 'CONFLICT'").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM sync_events WHERE event_type LIKE '%ERROR%'").first<{ count: number }>()
  ])
  return json({
    worker: 'ok',
    database: db?.ok === 1 ? 'ok' : 'error',
    activeUsers: users?.count ?? 0,
    activeWorkspaces: workspaces?.count ?? 0,
    pendingTasks: tasks?.count ?? 0,
    conflictCount: conflicts?.count ?? 0,
    syncErrorCount: syncErrors?.count ?? 0,
    storageConnections: await new StorageRouter(env).listConnections(user.organizationId)
  })
}
