import { z } from 'zod'
import {
  canCreateResourceAtPath,
  getDefaultWorkspaceId,
  getEffectiveWorkspaceRole,
  getMemberships,
  isOwner,
  isSystemAdmin,
  recordAudit,
  resolveFileAccess,
  setDefaultWorkspace,
  workspaceRoleAtLeast,
  type AuthUser,
  type WorkspaceRole
} from './access'
import { HttpError, json, requestJson } from './http'
import { encryptCredential } from './credential-crypto'
import {
  activateInvite,
  handleAuditLogs,
  handleAuthMe,
  handleDefaultWorkspace,
  handleInviteCreate,
  handleInviteList,
  handleInviteRegenerate,
  handleInviteRevoke,
  handleMyTasks,
  handleResourceAccessGet,
  handleResourceAccessReplace,
  handleStorageCreate,
  handleStorageDisable,
  handleStorageHealth,
  handleStorageList,
  handleStoragePairConfirm,
  handleStoragePairStart,
  handleStorageRotateToken,
  handleSystemStatus,
  handleTaskCreate,
  handleTaskDelete,
  handleTaskMigration,
  handleTasksList,
  handleTaskUpdate,
  handleUserAccountPolicy,
  handleUserForceLogout,
  handleUserLifecycle,
  handleUserRole,
  handleUsersList,
  handleWorkspaceArchive,
  handleWorkspaceCreate,
  handleWorkspaceMemberDelete,
  handleWorkspaceMemberPut,
  handleWorkspaceMembers,
  handleWorkspacesList,
  handleWorkspaceStorage
} from './enterprise'
import {
  hashPassword,
  newSessionToken,
  randomCode,
  sha256Hex,
  sha256Text,
  verifyPassword
} from './auth'
import { telegramGetMe, telegramGetUpdates } from './telegram-storage'
import { StorageRouter } from './storage-router'
import {
  deviceInfoSchema,
  handleAdminUserDevices,
  handleClientVersion,
  handleGroupArchive,
  handleGroupCreate,
  handleGroupMembers,
  handleGroupMembersReplace,
  handleGroupResourceAccessGet,
  handleGroupResourceAccessReplace,
  handleGroups,
  handleLogoutAllDevices,
  handleLogoutDevice,
  handleLogoutOtherDevices,
  handleMyDevices,
  handlePresenceClear,
  handlePresenceGet,
  handlePresenceUpsert,
  upsertLoginDevice,
  type RequestAuth
} from './collaboration'
import { fileCategoryForName, isSupportedFileName, matchesExpectedFileSignature, mimeForFileName } from '../../src/shared/file-types'
import { capabilitiesForStorageProvider } from '../../src/shared/storage-capabilities'
import { TELEGRAM_OFFICIAL_BOT_CAPABILITIES } from '../../src/shared/storage-capabilities'
import {
  assertFileLeaseCompatible,
  createNotification,
  handleAdminActiveLocks,
  handleAdvancedSearch,
  handleCommentCreate,
  handleCommentResolve,
  handleCommentsList,
  handleFileLeaseAcquire,
  handleFileLeaseForceTakeover,
  handleFileLeaseGet,
  handleFileLeaseHeartbeat,
  handleFileLeaseRelease,
  handleFileLeaseTakeoverRequest,
  handleNotificationRead,
  handleNotificationReadAll,
  handleNotifications,
  handleRewindExecute,
  handleRewindHistory,
  handleRewindPreview,
  handleRewindRetry,
  handleUnifiedActivity,
  recordDomainEvent,
  recordFileStateSnapshot
} from './collab-upgrade'

const MAX_FILE_BYTES = TELEGRAM_OFFICIAL_BOT_CAPABILITIES.maxReliableFileBytes
const DEFAULT_RETENTION = 20
const DEFAULT_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'
const DEFAULT_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002'
const LEGACY_STORAGE_CONNECTION_ID = '00000000-0000-4000-8000-000000000003'
const DUMMY_PASSWORD_HASH = 'pbkdf2-sha256$100000$RXhjZWxTeW5jRHVtbXkxMg$9gSjtDUmpYjNTd6oFOZ2h5FIkYlvC4zfQ4NHYrmDir4'
const LOGIN_USER_FAILURE_LIMIT = 6
const LOGIN_IP_FAILURE_LIMIT = 30
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_BLOCK_MS = 15 * 60 * 1000

type LoginThrottleState = {
  failures: number
  windowStartedAt: string
  blockedUntil: string | null
}

type RuntimeEnv = Env & {
  TELEGRAM_BOT_TOKEN?: string
  STORAGE_MASTER_KEY?: string
  CLIENT_LATEST_VERSION?: string
  CLIENT_MINIMUM_VERSION?: string
  CLIENT_UPDATE_URL?: string
  CLIENT_ROLLOUT_PERCENT?: string
  API_VERSION?: string
}

type FileRow = {
  id: string
  logical_name: string
  relative_path: string
  current_version: number
  current_telegram_file_id: string | null
  current_telegram_message_id: number | null
  current_storage_backend: 'telegram_user_group' | 'telegram_bot' | null
  current_storage_locator: string | null
  current_hash: string | null
  owner_user_id: string
  workspace_id: string | null
  home_storage_connection_id: string | null
  created_by_user_id: string | null
  updated_by_user_id: string | null
  created_at: string
  updated_at: string
  updated_by: string
  status: 'active' | 'trashed' | 'deleted'
  trashed_at: string | null
  trashed_by: string | null
}

type IntentRow = {
  id: string
  idempotency_key: string
  file_id: string
  owner_user_id: string
  workspace_id: string | null
  storage_connection_id: string | null
  logical_name: string
  base_version: number
  hash: string
  size: number
  status: 'reserved' | 'uploaded' | 'committed' | 'abandoned'
  telegram_file_id: string | null
  telegram_message_id: number | null
  telegram_file_unique_id: string | null
  storage_backend: 'telegram_user_group' | 'telegram_bot' | null
  storage_locator: string | null
  upload_receipt: string | null
  restored_from_version: number | null
  created_at: string
  updated_at: string
}

type VersionRow = {
  id: string
  file_id: string
  version: number
  telegram_file_id: string
  telegram_message_id: number
  telegram_file_unique_id: string | null
  hash: string
  size: number
  base_version: number
  restored_from_version: number | null
  created_at: string
  created_by: string
  storage_connection_id: string | null
  storage_backend: 'telegram_user_group' | 'telegram_bot' | null
  storage_locator: string | null
  status: 'active' | 'archived' | 'expired'
}

const usernameSchema = z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_.-]+$/)
const bootstrapSchema = z.object({
  username: usernameSchema,
  password: z.string().min(12).max(256),
  displayName: z.string().trim().min(1).max(100).optional(),
  organizationName: z.string().trim().min(1).max(160).optional()
})

const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(256),
  device: deviceInfoSchema.optional()
})
const inviteCreateSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(100),
  workspaceId: z.string().uuid(),
  workspaceRole: z.enum(['MANAGER', 'EDITOR', 'VIEWER']).default('EDITOR'),
  expiresInHours: z.number().int().min(1).max(24 * 30).default(72)
})
const workspaceCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  type: z.enum(['PERSONAL', 'TEAM', 'PROJECT']).default('TEAM'),
  defaultStorageConnectionId: z.string().uuid().nullable().optional()
})
const membershipSchema = z.object({ userId: z.string().uuid(), role: z.enum(['MANAGER', 'EDITOR', 'VIEWER']) })
const userLifecycleSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']),
  reassignToUserId: z.string().uuid().nullable().optional()
})
const userRoleSchema = z.object({ systemRole: z.enum(['ADMIN', 'MEMBER']) })
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

const preflightSchema = z.object({
  fileId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  logicalName: z.string().min(1).max(240),
  relativePath: z.string().min(1).max(1000).optional(),
  hash: z.string().regex(/^[a-f0-9]{64}$/i),
  size: z.number().int().positive(),
  baseVersion: z.number().int().min(0),
  idempotencyKey: z.string().min(16).max(160),
  storageBackend: z.enum(['telegram_user_group', 'telegram_bot']).optional(),
  restoredFromVersion: z.number().int().positive().nullable().optional()
})

const uploadReceiptSchema = z.object({
  intentId: z.string().uuid(),
  receipt: z.object({
    backend: z.literal('telegram_user_group'),
    chatId: z.string().min(1).max(128),
    messageId: z.number().int().positive(),
    fileName: z.string().min(1).max(240),
    size: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    mimeType: z.string().min(1).max(200),
    createdAt: z.string().datetime()
  })
})

const commitSchema = z.object({
  intentId: z.string().uuid()
})

const deleteSchema = z.object({
  baseVersion: z.number().int().min(0)
})

const renameSchema = z.object({
  logicalName: z.string().min(1).max(240),
  relativePath: z.string().min(1).max(1000).optional(),
  baseVersion: z.number().int().min(0)
})

const restoreSchema = z.object({
  version: z.number().int().positive(),
  baseVersion: z.number().int().min(0)
})

const settingsSchema = z.object({
  retentionLimit: z.number().int().min(2).max(500)
})

const integrityRepairSchema = z.object({
  fileId: z.string().uuid().optional(),
  batchSize: z.number().int().min(1).max(20).optional()
})

function nowIso(): string {
  return new Date().toISOString()
}

function parseRetention(env: RuntimeEnv): number {
  const value = Number(env.RETENTION_LIMIT)
  return Number.isInteger(value) && value >= 2 && value <= 500 ? value : DEFAULT_RETENTION
}

async function getRetention(env: RuntimeEnv, userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT retention_limit FROM user_settings WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first<{ retention_limit: number }>()
  const value = Number(row?.retention_limit)
  return Number.isInteger(value) && value >= 2 && value <= 500 ? value : parseRetention(env)
}

function parseSessionTtl(env: RuntimeEnv): number {
  const value = Number(env.SESSION_TTL_SECONDS)
  return Number.isInteger(value) && value >= 3600 && value <= 90 * 86400 ? value : 30 * 86400
}

function validateLogicalName(name: string): string {
  const clean = name.replace(/[\\/\0]/g, '_').trim()
  if (!clean || clean.length > 240) throw new HttpError(400, 'INVALID_FILE_NAME')
  if (!isSupportedFileName(clean)) throw new HttpError(415, 'UNSUPPORTED_FILE_TYPE')
  if (clean.startsWith('~$')) throw new HttpError(400, 'TEMP_FILE_REJECTED')
  return clean
}

function isUnsafeWindowsPathSegment(segment: string): boolean {
  return /[<>:"|?*\u0000-\u001F]/.test(segment) || /[. ]$/.test(segment) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(segment)
}

function normalizeRelativePath(value: string): string {
  const replaced = value.replaceAll('\\', '/')
  if (replaced !== replaced.trim()) throw new HttpError(400, 'INVALID_RELATIVE_PATH')
  const normalized = replaced.replace(/\/{2,}/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.length > 1000 || normalized.includes('\0')) {
    throw new HttpError(400, 'INVALID_RELATIVE_PATH')
  }
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || isUnsafeWindowsPathSegment(part))) throw new HttpError(400, 'INVALID_RELATIVE_PATH')
  const fileName = validateLogicalName(parts.at(-1)!)
  parts[parts.length - 1] = fileName
  return parts.join('/')
}

function fileNameFromRelativePath(relativePath: string): string {
  return relativePath.split('/').at(-1) ?? relativePath
}

function telegramRelativePath(fileName: string, caption?: string): string {
  const safeName = validateLogicalName(fileName)
  const raw = caption?.trim() ?? ''
  const match = raw.match(/^(?:路径|path)\s*[:：]\s*(.+)$/i)
  if (!match?.[1]) return normalizeRelativePath(`Telegram/${fileCategoryForName(safeName) ?? 'other'}/${safeName}`)
  const folder = match[1].trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  if (!folder) return normalizeRelativePath(`Telegram/${fileCategoryForName(safeName) ?? 'other'}/${safeName}`)
  return normalizeRelativePath(`${folder}/${safeName}`)
}

function mimeFor(name: string): string {
  return mimeForFileName(name)
}

async function requireAuth(request: Request, env: RuntimeEnv): Promise<RequestAuth> {
  const authorization = request.headers.get('authorization') ?? ''
  if (!authorization.startsWith('Bearer ')) throw new HttpError(401, 'AUTH_REQUIRED')
  const token = authorization.slice(7).trim()
  if (token.length < 32 || token.length > 256) throw new HttpError(401, 'INVALID_SESSION')
  const tokenHash = await sha256Text(token)
  const timestamp = nowIso()
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.device_id,
            u.id, u.username, COALESCE(u.display_name, u.username) AS display_name,
            u.organization_id, u.system_role, u.lifecycle_status, u.account_type, u.access_expires_at, u.status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND s.revoked_at IS NULL
      LIMIT 1`
  )
    .bind(tokenHash, timestamp)
    .first<{
      session_id: string
      device_id: string | null
      id: string
      username: string
      display_name: string
      organization_id: string | null
      system_role: AuthUser['systemRole']
      lifecycle_status: AuthUser['status']
      account_type: AuthUser['accountType']
      access_expires_at: string | null
      status: string
    }>()
  if (!row?.organization_id || row.status !== 'active' || row.lifecycle_status !== 'ACTIVE') throw new HttpError(401, 'INVALID_SESSION')
  if (row.access_expires_at && new Date(row.access_expires_at).getTime() <= Date.now()) {
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET lifecycle_status = 'SUSPENDED', status = 'disabled' WHERE id = ?").bind(row.id),
      env.DB.prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = 'ACCESS_EXPIRED' WHERE user_id = ? AND revoked_at IS NULL").bind(timestamp, row.id),
      env.DB.prepare('DELETE FROM file_presence WHERE user_id = ?').bind(row.id)
    ])
    throw new HttpError(401, 'ACCOUNT_EXPIRED')
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(timestamp, row.session_id),
    ...(row.device_id ? [env.DB.prepare("UPDATE devices SET last_seen_at = ?, status = 'ACTIVE' WHERE id = ? AND user_id = ?").bind(timestamp, row.device_id, row.id)] : [])
  ])
  return {
    sessionId: row.session_id,
    deviceId: row.device_id,
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      organizationId: row.organization_id,
      systemRole: row.system_role,
      status: row.lifecycle_status,
      accountType: row.account_type,
      accessExpiresAt: row.access_expires_at
    }
  }
}

async function getOwnedFile(
  env: RuntimeEnv,
  user: AuthUser,
  fileId: string,
  requiredRole: WorkspaceRole = 'VIEWER'
): Promise<FileRow> {
  const access = await resolveFileAccess(env, user, fileId, requiredRole)
  if (!access) throw new HttpError(404, 'FILE_NOT_FOUND')
  const row = await env.DB.prepare(
    `SELECT f.* FROM files f
       JOIN workspaces w ON w.id = f.workspace_id AND w.organization_id = ?
      WHERE f.id = ? LIMIT 1`
  ).bind(user.organizationId, fileId).first<FileRow>()
  if (!row) throw new HttpError(404, 'FILE_NOT_FOUND')
  return row
}

async function getTelegram(env: RuntimeEnv) {
  try {
    return (await new StorageRouter(env).resolve('files-primary')).provider
  } catch (error) {
    const code = error instanceof Error ? error.message : 'FILES_STORAGE_UNAVAILABLE'
    if (code.includes('SECRET_NOT_CONFIGURED')) throw new HttpError(503, 'TELEGRAM_SECRET_NOT_CONFIGURED')
    if (code.includes('CHAT_NOT_CONNECTED')) throw new HttpError(503, 'TELEGRAM_CHAT_NOT_CONNECTED')
    throw new HttpError(503, code)
  }
}

async function recordEvent(
  env: RuntimeEnv,
  userId: string,
  fileId: string | null,
  eventType: string,
  detail?: string
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO sync_events(id, user_id, file_id, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(crypto.randomUUID(), userId, fileId, eventType, detail?.slice(0, 1000) ?? null, nowIso())
    .run()
}

async function sessionResponse(env: RuntimeEnv, user: AuthUser, device?: z.infer<typeof deviceInfoSchema>): Promise<Response> {
  const token = newSessionToken()
  const sessionId = crypto.randomUUID()
  const tokenHash = await sha256Text(token)
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + parseSessionTtl(env) * 1000).toISOString()
  const deviceId = await upsertLoginDevice(env, user, device)
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO sessions(id, token_hash, user_id, device_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(sessionId, tokenHash, user.id, deviceId, createdAt, createdAt, expiresAt),
    env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(createdAt, user.id)
  ])
  const memberships = await getMemberships(env, user)
  const defaultWorkspaceId = await getDefaultWorkspaceId(env, user)
  return json({ token, expiresAt, deviceId, user, memberships, defaultWorkspaceId })
}

function loginClientIp(request: Request): string {
  const direct = request.headers.get('cf-connecting-ip')?.trim()
  return (direct || 'unknown').slice(0, 128)
}

async function loginThrottleKeys(request: Request, username: string): Promise<{ userKey: string; ipKey: string }> {
  const normalizedUser = username.trim().toLocaleLowerCase('en-US')
  const ip = loginClientIp(request)
  const [userHash, ipHash] = await Promise.all([sha256Text(normalizedUser), sha256Text(ip)])
  return { userKey: `login_throttle:user:${userHash}`, ipKey: `login_throttle:ip:${ipHash}` }
}

async function loadLoginThrottle(env: RuntimeEnv, key: string, now = Date.now()): Promise<LoginThrottleState | null> {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ? LIMIT 1').bind(key).first<{ value: string }>()
  if (!row?.value) return null
  try {
    const state = JSON.parse(row.value) as LoginThrottleState
    const started = new Date(state.windowStartedAt).getTime()
    const blocked = state.blockedUntil ? new Date(state.blockedUntil).getTime() : 0
    if (!Number.isFinite(started) || !Number.isInteger(state.failures) || state.failures < 0) throw new Error('INVALID')
    if (now - started > LOGIN_WINDOW_MS && (!blocked || blocked <= now)) {
      await env.DB.prepare('DELETE FROM app_settings WHERE key = ?').bind(key).run()
      return null
    }
    return state
  } catch {
    await env.DB.prepare('DELETE FROM app_settings WHERE key = ?').bind(key).run()
    return null
  }
}

async function assertLoginNotThrottled(env: RuntimeEnv, keys: { userKey: string; ipKey: string }): Promise<void> {
  const now = Date.now()
  const states = await Promise.all([loadLoginThrottle(env, keys.userKey, now), loadLoginThrottle(env, keys.ipKey, now)])
  const blockedUntil = states.reduce((latest, state) => {
    const value = state?.blockedUntil ? new Date(state.blockedUntil).getTime() : 0
    return Math.max(latest, Number.isFinite(value) ? value : 0)
  }, 0)
  if (blockedUntil > now) {
    throw new HttpError(429, 'TOO_MANY_LOGIN_ATTEMPTS', 'TOO_MANY_LOGIN_ATTEMPTS', { retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)) })
  }
}

async function recordLoginFailure(env: RuntimeEnv, keys: { userKey: string; ipKey: string }): Promise<boolean> {
  const now = Date.now()
  let blocked = false
  for (const [key, limit] of [[keys.userKey, LOGIN_USER_FAILURE_LIMIT], [keys.ipKey, LOGIN_IP_FAILURE_LIMIT]] as const) {
    const current = await loadLoginThrottle(env, key, now)
    const started = current && now - new Date(current.windowStartedAt).getTime() <= LOGIN_WINDOW_MS
      ? current.windowStartedAt
      : new Date(now).toISOString()
    const failures = (current && started === current.windowStartedAt ? current.failures : 0) + 1
    const blockedUntil = failures >= limit ? new Date(now + LOGIN_BLOCK_MS).toISOString() : null
    blocked ||= Boolean(blockedUntil)
    const state: LoginThrottleState = { failures, windowStartedAt: started, blockedUntil }
    await env.DB.prepare(
      `INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(key, JSON.stringify(state), nowIso()).run()
  }
  return blocked
}

async function clearSuccessfulLoginThrottle(env: RuntimeEnv, userKey: string): Promise<void> {
  await env.DB.prepare('DELETE FROM app_settings WHERE key = ?').bind(userKey).run()
}

async function handleBootstrap(request: Request, env: RuntimeEnv): Promise<Response> {
  const input = await requestJson(request, bootstrapSchema)
  const nonce = request.headers.get('x-setup-nonce') ?? ''
  if (nonce.length < 24 || nonce.length > 256) throw new HttpError(403, 'SETUP_NONCE_REQUIRED')

  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>()
  if ((count?.count ?? 0) > 0) throw new HttpError(409, 'SETUP_ALREADY_COMPLETED')

  const setting = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'setup_nonce_hash' LIMIT 1")
    .first<{ value: string }>()
  if (!setting) throw new HttpError(503, 'SETUP_NOT_PROVISIONED')
  const suppliedHash = await sha256Text(nonce)
  const expected = new TextEncoder().encode(setting.value)
  const supplied = new TextEncoder().encode(suppliedHash)
  if (expected.length !== supplied.length) throw new HttpError(403, 'INVALID_SETUP_NONCE')
  let diff = 0
  for (let i = 0; i < expected.length; i += 1) diff |= (expected[i] ?? 0) ^ (supplied[i] ?? 0)
  if (diff !== 0) throw new HttpError(403, 'INVALID_SETUP_NONCE')

  const passwordHash = await hashPassword(input.password)
  const userId = crypto.randomUUID()
  const createdAt = nowIso()
  const displayName = input.displayName?.trim() || input.username
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE organizations SET name = ? WHERE id = ?`
    ).bind(input.organizationName?.trim() || 'ExcelSync Organization', DEFAULT_ORGANIZATION_ID),
    env.DB.prepare(
      `INSERT INTO users(
        id, organization_id, username, display_name, password_hash, system_role, lifecycle_status, created_at, status
      ) VALUES (?, ?, ?, ?, ?, 'OWNER', 'ACTIVE', ?, 'active')`
    ).bind(userId, DEFAULT_ORGANIZATION_ID, input.username, displayName, passwordHash, createdAt),
    env.DB.prepare(
      `INSERT OR REPLACE INTO workspace_members(workspace_id, user_id, role, joined_at) VALUES (?, ?, 'MANAGER', ?)`
    ).bind(DEFAULT_WORKSPACE_ID, userId, createdAt),
    env.DB.prepare(
      `INSERT OR REPLACE INTO user_preferences(user_id, default_workspace_id, file_view_mode, sort_by, page_size, ui_density, updated_at)
       VALUES (?, ?, 'list', 'updated_desc', 100, 'comfortable', ?)`
    ).bind(userId, DEFAULT_WORKSPACE_ID, createdAt),
    env.DB.prepare('UPDATE workspaces SET created_by_user_id = COALESCE(created_by_user_id, ?) WHERE id = ?')
      .bind(userId, DEFAULT_WORKSPACE_ID),
    env.DB.prepare('UPDATE storage_connections SET created_by_user_id = COALESCE(created_by_user_id, ?) WHERE id = ?')
      .bind(userId, LEGACY_STORAGE_CONNECTION_ID),
    env.DB.prepare("DELETE FROM app_settings WHERE key = 'setup_nonce_hash'")
  ])
  return json({ ok: true, userId, organizationId: DEFAULT_ORGANIZATION_ID, workspaceId: DEFAULT_WORKSPACE_ID }, 201)
}

async function handleLogin(request: Request, env: RuntimeEnv): Promise<Response> {
  const input = await requestJson(request, loginSchema)
  const throttleKeys = await loginThrottleKeys(request, input.username)
  await assertLoginNotThrottled(env, throttleKeys)
  const row = await env.DB.prepare(
    `SELECT id, username, COALESCE(display_name, username) AS display_name, password_hash,
            organization_id, system_role, lifecycle_status, account_type, access_expires_at, status
       FROM users WHERE username = ? COLLATE NOCASE LIMIT 1`
  )
    .bind(input.username)
    .first<{
      id: string
      username: string
      display_name: string
      password_hash: string
      organization_id: string | null
      system_role: AuthUser['systemRole']
      lifecycle_status: AuthUser['status']
      account_type: AuthUser['accountType']
      access_expires_at: string | null
      status: string
    }>()
  const verified = await verifyPassword(input.password, row?.password_hash ?? DUMMY_PASSWORD_HASH)
  if (!row || !verified || row.status !== 'active' || row.lifecycle_status !== 'ACTIVE' || !row.organization_id) {
    const blocked = await recordLoginFailure(env, throttleKeys)
    if (blocked) throw new HttpError(429, 'TOO_MANY_LOGIN_ATTEMPTS', 'TOO_MANY_LOGIN_ATTEMPTS', { retryAfterSeconds: LOGIN_BLOCK_MS / 1000 })
    throw new HttpError(401, 'INVALID_CREDENTIALS')
  }
  await clearSuccessfulLoginThrottle(env, throttleKeys.userKey)
  if (row.access_expires_at && new Date(row.access_expires_at).getTime() <= Date.now()) {
    const timestamp = nowIso()
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET lifecycle_status = 'SUSPENDED', status = 'disabled' WHERE id = ?").bind(row.id),
      env.DB.prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = 'ACCESS_EXPIRED' WHERE user_id = ? AND revoked_at IS NULL").bind(timestamp, row.id),
      env.DB.prepare('DELETE FROM file_presence WHERE user_id = ?').bind(row.id)
    ])
    throw new HttpError(401, 'ACCOUNT_EXPIRED')
  }
  const user: AuthUser = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    organizationId: row.organization_id,
    systemRole: row.system_role,
    status: row.lifecycle_status,
    accountType: row.account_type,
    accessExpiresAt: row.access_expires_at
  }
  return sessionResponse(env, user, input.device)
}

async function handleLogout(env: RuntimeEnv, auth: RequestAuth): Promise<Response> {
  const timestamp = nowIso()
  await env.DB.batch([
    env.DB.prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = 'USER_LOGOUT' WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .bind(timestamp, auth.sessionId, auth.user.id),
    ...(auth.deviceId ? [env.DB.prepare('DELETE FROM file_presence WHERE user_id = ? AND device_id = ?').bind(auth.user.id, auth.deviceId)] : [])
  ])
  return json({ ok: true })
}

async function handleHealth(env: RuntimeEnv): Promise<Response> {
  const [db, users, setup, storage] = await Promise.all([
    env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>(),
    env.DB.prepare("SELECT value FROM app_settings WHERE key = 'setup_nonce_hash' LIMIT 1").first<{ value: string }>(),
    env.DB.prepare("SELECT chat_id FROM storage_config WHERE provider = 'telegram'").first<{ chat_id: string | null }>()
  ])
  const tokenConfigured = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN !== 'UNCONFIGURED')
  const chatConfigured = Boolean(storage?.chat_id)
  return json({
    ok: db?.ok === 1,
    worker: 'ok',
    database: db?.ok === 1 ? 'ok' : 'error',
    setupAvailable: (users?.count ?? 0) === 0 && Boolean(setup?.value),
    telegram: {
      tokenConfigured,
      chatConfigured,
      reachable: tokenConfigured && chatConfigured
    },
    maxFileBytes: MAX_FILE_BYTES
  })
}

async function handleFilesList(request: Request, env: RuntimeEnv, user: AuthUser): Promise<Response> {
  const url = new URL(request.url)
  const includeAll = url.searchParams.get('include') === 'all'
  const workspaceId = url.searchParams.get('workspaceId')
  if (workspaceId && !(await getEffectiveWorkspaceRole(env, user, workspaceId))) throw new HttpError(403, 'WORKSPACE_FORBIDDEN')
  const statusClause = includeAll ? "f.status IN ('active','trashed','deleted')" : "f.status = 'active'"
  const admin = isSystemAdmin(user)
  const result = await env.DB.prepare(
    admin
      ? `SELECT f.id, f.workspace_id, f.logical_name, f.relative_path, f.current_version, f.current_hash,
                f.current_storage_backend, f.current_storage_locator, f.updated_at, f.status
           FROM files f
           JOIN workspaces w ON w.id = f.workspace_id AND w.organization_id = ?
          WHERE (? IS NULL OR f.workspace_id = ?) AND ${statusClause}
          ORDER BY f.updated_at DESC LIMIT 1000`
      : `SELECT f.id, f.workspace_id, f.logical_name, f.relative_path, f.current_version, f.current_hash,
                f.current_storage_backend, f.current_storage_locator, f.updated_at, f.status
           FROM files f
           JOIN workspace_members wm ON wm.workspace_id = f.workspace_id AND wm.user_id = ?
           JOIN workspaces w ON w.id = f.workspace_id AND w.organization_id = ?
          WHERE (? IS NULL OR f.workspace_id = ?) AND ${statusClause}
            AND EXISTS (
              SELECT 1 FROM resource_access_rules r
               WHERE r.organization_id = ? AND r.workspace_id = f.workspace_id
                 AND (
                   (r.principal_type = 'USER' AND r.principal_id = ?)
                   OR (r.principal_type = 'GROUP' AND r.principal_id IN (
                     SELECT gm.group_id FROM group_members gm
                     JOIN groups g ON g.id = gm.group_id AND g.status = 'ACTIVE'
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
            )
          ORDER BY f.updated_at DESC LIMIT 1000`
  ).bind(...(admin
    ? [user.organizationId, workspaceId, workspaceId]
    : [user.id, user.organizationId, workspaceId, workspaceId, user.organizationId, user.id, user.id, user.organizationId])).all()
  return json({ files: result.results })
}

export async function handleTrashList(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  const admin = isSystemAdmin(user)
  const result = await env.DB.prepare(
    admin
      ? `SELECT f.id, f.workspace_id, f.logical_name, f.relative_path, f.current_version, f.current_hash, f.status,
                COALESCE(f.trashed_at, f.updated_at) AS trashed_at, f.updated_at, COALESCE(v.size, 0) AS size
           FROM files f
           JOIN workspaces w ON w.id = f.workspace_id AND w.organization_id = ?
           LEFT JOIN file_versions v ON v.file_id = f.id AND v.version = f.current_version
          WHERE f.status = 'trashed'
          ORDER BY COALESCE(f.trashed_at, f.updated_at) DESC LIMIT 1000`
      : `SELECT f.id, f.workspace_id, f.logical_name, f.relative_path, f.current_version, f.current_hash, f.status,
                COALESCE(f.trashed_at, f.updated_at) AS trashed_at, f.updated_at, COALESCE(v.size, 0) AS size
           FROM files f
           JOIN workspace_members wm ON wm.workspace_id = f.workspace_id AND wm.user_id = ?
           JOIN workspaces w ON w.id = f.workspace_id AND w.organization_id = ?
           LEFT JOIN file_versions v ON v.file_id = f.id AND v.version = f.current_version
          WHERE f.status = 'trashed'
            AND EXISTS (
              SELECT 1 FROM resource_access_rules r
               WHERE r.organization_id = ? AND r.workspace_id = f.workspace_id
                 AND (
                   (r.principal_type = 'USER' AND r.principal_id = ?)
                   OR (r.principal_type = 'GROUP' AND r.principal_id IN (
                     SELECT gm.group_id FROM group_members gm
                     JOIN groups g ON g.id = gm.group_id AND g.status = 'ACTIVE'
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
            )
          ORDER BY COALESCE(f.trashed_at, f.updated_at) DESC LIMIT 1000`
  ).bind(...(admin ? [user.organizationId] : [user.id, user.organizationId, user.organizationId, user.id, user.id, user.organizationId])).all()
  return json({ files: result.results })
}

async function handleActivity(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT id, file_id, event_type, detail, created_at
       FROM sync_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`
  )
    .bind(user.id)
    .all()
  return json({ events: result.results })
}

async function handleVersions(env: RuntimeEnv, user: AuthUser, fileId: string): Promise<Response> {
  const file = await getOwnedFile(env, user, fileId)
  const result = await env.DB.prepare(
    `SELECT fv.version, fv.hash, fv.size, fv.base_version, fv.restored_from_version, fv.created_at, fv.status,
            fv.storage_connection_id, fv.storage_backend, fv.storage_locator, sc.name AS storage_name, sc.status AS storage_status
       FROM file_versions fv
       LEFT JOIN storage_connections sc ON sc.id = fv.storage_connection_id AND sc.organization_id = ?
      WHERE fv.file_id = ?
      ORDER BY fv.version DESC LIMIT 500`
  ).bind(user.organizationId, fileId).all<Record<string, unknown>>()
  const byVersion = new Map<number, Record<string, unknown>>()
  for (const row of result.results) byVersion.set(Number(row.version), row)
  const versions: Array<Record<string, unknown>> = []
  for (let version = file.current_version; version >= 1; version -= 1) {
    const row = byVersion.get(version)
    if (!row) {
      versions.push({
        version,
        hash: '',
        size: 0,
        base_version: Math.max(0, version - 1),
        restored_from_version: null,
        created_at: '',
        status: 'missing',
        storage_connection_id: null,
        storage_backend: null,
        storage_locator: null,
        storage_name: null,
        storage_status: null,
        integrity_status: version === file.current_version ? 'MISSING_METADATA' : 'LEGACY_UNRECOVERABLE',
        available: false,
        is_current: version === file.current_version
      })
      continue
    }
    let integrityStatus = 'HEALTHY'
    let available = true
    if (String(row.status) === 'expired') available = false
    const backend = String(row.storage_backend ?? 'telegram_bot')
    if (backend === 'telegram_user_group') {
      if (!row.storage_locator) {
        integrityStatus = 'MISSING_STORAGE_REFERENCE'
        available = false
      }
    } else if (!row.storage_connection_id || !row.storage_name) {
      integrityStatus = 'MISSING_STORAGE_REFERENCE'
      available = false
    } else if (String(row.storage_status) === 'DISABLED') {
      available = false
    }
    versions.push({
      ...row,
      storage_name: backend === 'telegram_user_group' ? 'Telegram 私人群组' : row.storage_name,
      storage_status: backend === 'telegram_user_group' ? (row.storage_locator ? 'ACTIVE' : 'DEGRADED') : row.storage_status,
      integrity_status: integrityStatus,
      available,
      is_current: version === file.current_version
    })
  }
  return json({ versions })
}

async function handleVersionIntegrityAudit(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  if (!isSystemAdmin(user)) throw new HttpError(403, 'FORBIDDEN')
  const files = await env.DB.prepare(
    `SELECT f.id, f.logical_name, f.relative_path, f.current_version, f.current_hash,
            f.current_telegram_file_id, f.current_telegram_message_id, f.home_storage_connection_id,
            f.workspace_id, w.name AS workspace_name
       FROM files f JOIN workspaces w ON w.id = f.workspace_id
      WHERE w.organization_id = ? AND f.status != 'deleted'
      ORDER BY f.updated_at DESC LIMIT 5000`
  ).bind(user.organizationId).all<Record<string, unknown>>()
  const versions = await env.DB.prepare(
    `SELECT fv.file_id, fv.version, fv.telegram_file_id, fv.storage_connection_id, sc.name AS storage_name
       FROM file_versions fv
       JOIN files f ON f.id = fv.file_id
       JOIN workspaces w ON w.id = f.workspace_id
       LEFT JOIN storage_connections sc ON sc.id = fv.storage_connection_id AND sc.organization_id = ?
      WHERE w.organization_id = ?
      ORDER BY fv.file_id, fv.version`
  ).bind(user.organizationId, user.organizationId).all<Record<string, unknown>>()
  const grouped = new Map<string, Array<Record<string, unknown>>>()
  for (const row of versions.results) {
    const key = String(row.file_id)
    const list = grouped.get(key) ?? []
    list.push(row)
    grouped.set(key, list)
  }

  const findings = files.results.map((file) => {
    const currentVersion = Number(file.current_version ?? 0)
    const rows = grouped.get(String(file.id)) ?? []
    const present = new Set(rows.map((row) => Number(row.version)))
    const missingVersions: number[] = []
    for (let version = 1; version <= currentVersion; version += 1) {
      if (!present.has(version)) missingVersions.push(version)
    }
    const missingCurrent = currentVersion > 0 && missingVersions.includes(currentVersion)
    const missingRemoteReference = rows.some((row) => !row.telegram_file_id)
    const missingStorageReference = rows.some((row) => !row.storage_connection_id || !row.storage_name)
    const issues: string[] = []
    if (missingCurrent) issues.push('MISSING_METADATA')
    if (missingRemoteReference) issues.push('MISSING_REMOTE_FILE_REFERENCE')
    if (missingStorageReference) issues.push('MISSING_STORAGE_REFERENCE')
    if (missingVersions.some((version) => version !== currentVersion)) issues.push('LEGACY_UNRECOVERABLE')
    let status = 'HEALTHY'
    if (missingRemoteReference) status = 'MISSING_REMOTE_FILE_REFERENCE'
    else if (missingStorageReference) status = 'MISSING_STORAGE_REFERENCE'
    else if (missingCurrent) status = 'MISSING_METADATA'
    else if (missingVersions.length > 0) status = 'LEGACY_UNRECOVERABLE'
    return {
      file_id: file.id,
      logical_name: file.logical_name,
      relative_path: file.relative_path,
      workspace_id: file.workspace_id,
      workspace_name: file.workspace_name,
      current_version: currentVersion,
      recorded_versions: rows.length,
      missing_versions: missingVersions,
      status,
      issues,
      current_reference_repairable: Boolean(
        missingCurrent && file.current_telegram_file_id && file.current_telegram_message_id != null && file.current_hash
      )
    }
  })
  const summary = findings.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.status)
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  return json({ summary, findings })
}

async function handleVersionIntegrityRepair(request: Request, env: RuntimeEnv, user: AuthUser): Promise<Response> {
  if (!isSystemAdmin(user)) throw new HttpError(403, 'FORBIDDEN')
  const input = await requestJson(request, integrityRepairSchema)
  const batchSize = input.fileId ? 1 : (input.batchSize ?? 10)
  const files = await env.DB.prepare(
    `SELECT f.id, f.logical_name, f.current_version, f.current_hash, f.current_telegram_file_id,
            f.current_telegram_message_id, f.home_storage_connection_id, f.workspace_id,
            f.updated_at, f.updated_by, w.default_storage_connection_id
       FROM files f JOIN workspaces w ON w.id = f.workspace_id
      WHERE w.organization_id = ? AND f.status != 'deleted'
        AND f.current_version > 0
        AND (? IS NULL OR f.id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM file_versions fv WHERE fv.file_id = f.id AND fv.version = f.current_version
        )
      ORDER BY f.updated_at DESC LIMIT ?`
  ).bind(user.organizationId, input.fileId ?? null, input.fileId ?? null, batchSize).all<{
    id: string
    logical_name: string
    current_version: number
    current_hash: string | null
    current_telegram_file_id: string | null
    current_telegram_message_id: number | null
    home_storage_connection_id: string | null
    workspace_id: string
    updated_at: string
    updated_by: string
    default_storage_connection_id: string | null
  }>()
  const allStorages = await env.DB.prepare(
    `SELECT id FROM storage_connections WHERE organization_id = ? AND status != 'DISABLED' ORDER BY created_at ASC`
  ).bind(user.organizationId).all<{ id: string }>()
  const repaired: Array<Record<string, unknown>> = []
  const skipped: Array<Record<string, unknown>> = []
  const router = new StorageRouter(env)

  for (const file of files.results) {
    if (!file.current_telegram_file_id || file.current_telegram_message_id == null || !file.current_hash) {
      const detail = 'Current version pointer is incomplete; refusing to fabricate metadata.'
      await env.DB.prepare(
        `INSERT INTO version_integrity_repairs(id, organization_id, file_id, version, repair_status, detail, created_by, created_at)
         VALUES (?, ?, ?, ?, 'SKIPPED', ?, ?, ?)`
      ).bind(crypto.randomUUID(), user.organizationId, file.id, file.current_version, detail, user.id, nowIso()).run()
      skipped.push({ fileId: file.id, version: file.current_version, reason: 'CURRENT_POINTER_INCOMPLETE' })
      continue
    }
    const candidateIds = [...new Set([
      file.home_storage_connection_id,
      file.default_storage_connection_id,
      LEGACY_STORAGE_CONNECTION_ID,
      ...allStorages.results.map((row) => row.id)
    ].filter((value): value is string => Boolean(value)))]
    let matchedStorageId: string | null = null
    let size = 0
    for (const storageId of candidateIds) {
      try {
        const resolved = await router.resolveConnection(storageId)
        const response = await resolved.provider.download(file.current_telegram_file_id)
        const bytes = new Uint8Array(await response.arrayBuffer())
        if ((await sha256Hex(bytes)) !== file.current_hash.toLowerCase()) continue
        matchedStorageId = storageId
        size = bytes.byteLength
        break
      } catch {
        // Try the next known storage connection. The hash check prevents accepting a wrong Bot/file-id pair.
      }
    }
    if (!matchedStorageId) {
      const detail = 'No known storage connection returned bytes matching current_hash.'
      await env.DB.prepare(
        `INSERT INTO version_integrity_repairs(id, organization_id, file_id, version, repair_status, detail, created_by, created_at)
         VALUES (?, ?, ?, ?, 'SKIPPED', ?, ?, ?)`
      ).bind(crypto.randomUUID(), user.organizationId, file.id, file.current_version, detail, user.id, nowIso()).run()
      skipped.push({ fileId: file.id, version: file.current_version, reason: 'REMOTE_REFERENCE_NOT_VERIFIED' })
      continue
    }
    const versionId = crypto.randomUUID()
    const timestamp = nowIso()
    const batch = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO file_versions(
           id, file_id, version, telegram_file_id, telegram_message_id, telegram_file_unique_id,
           hash, size, base_version, restored_from_version, created_at, created_by, storage_connection_id, status
         ) SELECT ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, 'active'
           WHERE NOT EXISTS (SELECT 1 FROM file_versions WHERE file_id = ? AND version = ?)`
      ).bind(versionId, file.id, file.current_version, file.current_telegram_file_id, file.current_telegram_message_id,
        file.current_hash.toLowerCase(), size, Math.max(0, file.current_version - 1), file.updated_at || timestamp,
        file.updated_by || user.id, matchedStorageId, file.id, file.current_version),
      env.DB.prepare(
        `INSERT INTO version_integrity_repairs(id, organization_id, file_id, version, repair_status, detail, created_by, created_at)
         SELECT ?, ?, ?, ?, 'REPAIRED', ?, ?, ? WHERE EXISTS (SELECT 1 FROM file_versions WHERE id = ?)`
      ).bind(crypto.randomUUID(), user.organizationId, file.id, file.current_version,
        `Recovered from files.current_* and verified against storage ${matchedStorageId}`, user.id, timestamp, versionId)
    ])
    if ((batch[0]?.meta.changes ?? 0) === 1) {
      repaired.push({ fileId: file.id, version: file.current_version, storageConnectionId: matchedStorageId, size })
      await recordAudit(env, user, 'VERSION_INTEGRITY_REPAIRED', 'file', file.id, { version: file.current_version, storageConnectionId: matchedStorageId })
    }
  }
  return json({ repaired, skipped })
}

async function handlePreflight(request: Request, env: RuntimeEnv, auth: RequestAuth): Promise<Response> {
  const user = auth.user
  const input = await requestJson(request, preflightSchema)
  const requestedName = validateLogicalName(input.logicalName)
  const relativePath = normalizeRelativePath(input.relativePath ?? requestedName)
  const logicalName = fileNameFromRelativePath(relativePath)
  const requestedStorageBackend = input.storageBackend ?? 'telegram_bot'
  let workspaceId = input.workspaceId ?? await getDefaultWorkspaceId(env, user)
  if (!workspaceId) throw new HttpError(400, 'DEFAULT_WORKSPACE_REQUIRED')
  let role = await getEffectiveWorkspaceRole(env, user, workspaceId)
  if (!workspaceRoleAtLeast(role, 'EDITOR')) throw new HttpError(403, 'WORKSPACE_UPLOAD_FORBIDDEN')

  let file: FileRow | null = null
  if (input.fileId) {
    const raw = await env.DB.prepare('SELECT * FROM files WHERE id = ? LIMIT 1').bind(input.fileId).first<FileRow>()
    if (raw) {
      file = await getOwnedFile(env, user, input.fileId, 'EDITOR')
      if (!file.workspace_id) throw new HttpError(409, 'FILE_WORKSPACE_MISSING')
      if (input.workspaceId && input.workspaceId !== file.workspace_id) throw new HttpError(409, 'FILE_WORKSPACE_MISMATCH')
      workspaceId = file.workspace_id
      role = await getEffectiveWorkspaceRole(env, user, workspaceId)
      if (!workspaceRoleAtLeast(role, 'EDITOR')) throw new HttpError(403, 'WORKSPACE_UPLOAD_FORBIDDEN')
      if (file.status !== 'active') throw new HttpError(409, 'FILE_NOT_ACTIVE')
    }
  }

  const replayedIntent = await env.DB.prepare(
    'SELECT * FROM upload_intents WHERE owner_user_id = ? AND idempotency_key = ? LIMIT 1'
  ).bind(user.id, input.idempotencyKey).first<IntentRow>()
  if (replayedIntent) {
    if (
      (input.fileId && input.fileId !== replayedIntent.file_id) ||
      replayedIntent.workspace_id !== workspaceId ||
      replayedIntent.logical_name !== logicalName ||
      replayedIntent.hash.toLowerCase() !== input.hash.toLowerCase() ||
      replayedIntent.size !== input.size ||
      replayedIntent.base_version !== input.baseVersion ||
      (replayedIntent.storage_backend ?? 'telegram_bot') !== requestedStorageBackend
    ) {
      throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED')
    }
    const replayFile = await getOwnedFile(env, user, replayedIntent.file_id, 'EDITOR')
    if (
      replayFile.status !== 'active' ||
      replayFile.workspace_id !== workspaceId ||
      replayFile.relative_path.toLowerCase() !== relativePath.toLowerCase()
    ) {
      throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED')
    }
    file = replayFile
  }

  const pathConflict = await env.DB.prepare(
    `SELECT id FROM files WHERE workspace_id = ? AND relative_path = ? COLLATE NOCASE AND status = 'active' LIMIT 1`
  ).bind(workspaceId, relativePath).first<{ id: string }>()
  const expectedPathFileId = file?.id ?? input.fileId
  if (pathConflict && pathConflict.id !== expectedPathFileId) throw new HttpError(409, 'PATH_ALREADY_EXISTS')

  const storage = await env.DB.prepare(
    `SELECT w.default_storage_connection_id AS id, sc.provider
       FROM workspaces w
       LEFT JOIN storage_connections sc ON sc.id = w.default_storage_connection_id AND sc.organization_id = w.organization_id
      WHERE w.id = ? AND w.organization_id = ? AND w.status = 'ACTIVE' LIMIT 1`
  ).bind(workspaceId, user.organizationId).first<{ id: string | null; provider: string | null }>()
  if (!storage) throw new HttpError(404, 'WORKSPACE_NOT_FOUND')
  if (requestedStorageBackend === 'telegram_bot' && !storage.id) throw new HttpError(503, 'WORKSPACE_STORAGE_NOT_CONFIGURED')
  const storageConnectionId = storage.id ?? null
  const storageCapabilities = capabilitiesForStorageProvider(requestedStorageBackend)
  if (storageCapabilities.maxReliableFileBytes <= 0) throw new HttpError(503, 'STORAGE_PROVIDER_UNSUPPORTED')
  if (input.size > storageCapabilities.maxReliableFileBytes) {
    throw new HttpError(413, 'FILE_TOO_LARGE', 'FILE_TOO_LARGE', { capabilities: storageCapabilities })
  }

  if (!file) {
    if (!(await canCreateResourceAtPath(env, user, workspaceId, relativePath, storageConnectionId, 'EDITOR'))) {
      throw new HttpError(403, 'RESOURCE_CREATE_FORBIDDEN')
    }
    const fileId = input.fileId ?? crypto.randomUUID()
    const created = nowIso()
    await env.DB.prepare(
      `INSERT INTO files(
        id, workspace_id, home_storage_connection_id, logical_name, relative_path, current_version,
        current_telegram_file_id, current_telegram_message_id, current_hash, owner_user_id,
        created_by_user_id, updated_by_user_id, created_at, updated_at, updated_by, status
      ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, 'active')`
    )
      .bind(fileId, workspaceId, storageConnectionId, logicalName, relativePath, user.id, user.id, user.id, created, created, user.id)
      .run()
    file = await getOwnedFile(env, user, fileId, 'EDITOR')
    const eventId = await recordDomainEvent(env, {
      organizationId: user.organizationId,
      workspaceId,
      fileId,
      actorUserId: user.id,
      eventKey: `file-created:${fileId}`,
      eventType: 'FILE_CREATED',
      category: 'FILE',
      targetType: 'file',
      targetId: fileId,
      detail: { logicalName, relativePath }
    })
    await recordFileStateSnapshot(env, fileId, 'CREATE', user.id, eventId)
  }

  if (file.current_version > 0) await assertFileLeaseCompatible(env, auth, file.id)

  if (file.current_hash?.toLowerCase() === input.hash.toLowerCase() && file.current_version > 0) {
    return json({ action: 'noop', fileId: file.id, currentVersion: file.current_version, currentHash: file.current_hash })
  }
  if (file.current_version !== input.baseVersion) {
    const eventId = await recordDomainEvent(env, {
      organizationId: user.organizationId,
      workspaceId,
      fileId: file.id,
      actorUserId: user.id,
      eventKey: `sync-conflict:${file.id}:${input.idempotencyKey}:${file.current_version}`,
      eventType: 'SYNC_CONFLICT',
      category: 'FILE',
      targetType: 'file',
      targetId: file.id,
      detail: { baseVersion: input.baseVersion, currentVersion: file.current_version }
    })
    await createNotification(env, {
      organizationId: user.organizationId,
      recipientUserId: user.id,
      eventId,
      category: 'FILE',
      title: '文件发生版本冲突',
      body: `${file.logical_name} 的云端版本已更新到 V${file.current_version}。`,
      resourceType: 'file',
      resourceId: file.id
    })
    return json({ action: 'conflict', fileId: file.id, currentVersion: file.current_version, currentHash: file.current_hash }, 409)
  }

  const existing = replayedIntent ?? await env.DB.prepare(
    'SELECT * FROM upload_intents WHERE owner_user_id = ? AND idempotency_key = ? LIMIT 1'
  ).bind(user.id, input.idempotencyKey).first<IntentRow>()
  if (existing) {
    if (existing.file_id !== file.id || existing.hash.toLowerCase() !== input.hash.toLowerCase() || existing.base_version !== input.baseVersion ||
        (existing.storage_backend ?? 'telegram_bot') !== requestedStorageBackend) {
      throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED')
    }
    if (existing.status === 'committed') {
      const fresh = await getOwnedFile(env, user, file.id, 'VIEWER')
      return json({ action: 'committed', fileId: fresh.id, intentId: existing.id, currentVersion: fresh.current_version, currentHash: fresh.current_hash })
    }
    if (existing.status === 'uploaded') return json({ action: 'commit_required', fileId: file.id, intentId: existing.id })
    if (existing.status === 'abandoned') throw new HttpError(409, 'INTENT_ABANDONED')
    return json({ action: 'upload_required', fileId: file.id, intentId: existing.id })
  }

  const intentId = crypto.randomUUID()
  const created = nowIso()
  await env.DB.prepare(
    `INSERT INTO upload_intents(
      id, idempotency_key, file_id, owner_user_id, workspace_id, storage_connection_id, logical_name, base_version, hash, size,
      storage_backend, restored_from_version, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`
  ).bind(intentId, input.idempotencyKey, file.id, user.id, workspaceId, storageConnectionId, logicalName, input.baseVersion,
    input.hash.toLowerCase(), input.size, requestedStorageBackend, input.restoredFromVersion ?? null, created, created).run()

  return json({ action: 'upload_required', fileId: file.id, intentId, workspaceId }, 201)
}

async function handleUpload(request: Request, env: RuntimeEnv, auth: RequestAuth): Promise<Response> {
  const user = auth.user
  const type = request.headers.get('content-type') ?? ''
  if (!type.includes('multipart/form-data')) throw new HttpError(415, 'MULTIPART_REQUIRED')
  const form = await request.formData()
  const intentId = String(form.get('intentId') ?? '')
  const filePart = form.get('file')
  if (!z.string().uuid().safeParse(intentId).success || !(filePart instanceof File)) {
    throw new HttpError(400, 'INVALID_UPLOAD')
  }
  if (filePart.size <= 0) throw new HttpError(413, 'FILE_TOO_LARGE')

  const intent = await env.DB.prepare('SELECT * FROM upload_intents WHERE id = ? AND owner_user_id = ? LIMIT 1')
    .bind(intentId, user.id)
    .first<IntentRow>()
  if (!intent) throw new HttpError(404, 'INTENT_NOT_FOUND')
  if (intent.status === 'committed' || intent.status === 'uploaded') {
    return json({
      ok: true,
      intentId,
      status: intent.status,
      telegramFileId: intent.telegram_file_id,
      telegramMessageId: intent.telegram_message_id
    })
  }
  if (intent.status !== 'reserved') throw new HttpError(409, 'INTENT_NOT_UPLOADABLE')
  if ((intent.storage_backend ?? 'telegram_bot') === 'telegram_user_group') {
    throw new HttpError(409, 'DESKTOP_STORAGE_REQUIRED', 'Telegram User Group upload must be completed by the Windows ExcelSync client')
  }

  const storageConnectionId = intent.storage_connection_id ?? LEGACY_STORAGE_CONNECTION_ID
  let storageProvider
  try {
    storageProvider = (await new StorageRouter(env).resolveConnection(storageConnectionId)).provider
  } catch (error) {
    throw new HttpError(503, 'CLOUD_STORAGE_UNAVAILABLE', error instanceof Error ? error.message : 'CLOUD_STORAGE_UNAVAILABLE')
  }
  if (filePart.size > storageProvider.capabilities.maxReliableFileBytes || intent.size > storageProvider.capabilities.maxReliableFileBytes) {
    throw new HttpError(413, 'FILE_TOO_LARGE', 'FILE_TOO_LARGE', { capabilities: storageProvider.capabilities })
  }

  const cloudFile = await getOwnedFile(env, user, intent.file_id, 'EDITOR')
  await assertFileLeaseCompatible(env, auth, intent.file_id)
  if (cloudFile.current_version !== intent.base_version) throw new HttpError(409, 'BASE_VERSION_CONFLICT')
  if (filePart.size !== intent.size) throw new HttpError(409, 'UPLOAD_SIZE_MISMATCH')
  const bytes = new Uint8Array(await filePart.arrayBuffer())
  if (!matchesExpectedFileSignature(intent.logical_name, bytes.subarray(0, Math.min(bytes.byteLength, 4096)))) {
    throw new HttpError(415, 'FILE_SIGNATURE_MISMATCH')
  }
  const actualHash = await sha256Hex(bytes)
  if (actualHash !== intent.hash) throw new HttpError(409, 'UPLOAD_HASH_MISMATCH')

  const stored = await storageProvider.upload({
    bytes,
    fileName: validateLogicalName(intent.logical_name),
    mimeType: mimeFor(intent.logical_name),
    caption: `ExcelSync ${intent.file_id} base=${intent.base_version} hash=${intent.hash.slice(0, 12)}`
  })

  const updatedAt = nowIso()
  const saved = await env.DB.prepare(
    `UPDATE upload_intents
        SET status = 'uploaded', telegram_file_id = ?, telegram_message_id = ?, telegram_file_unique_id = ?,
            storage_backend = 'telegram_bot', storage_locator = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND status = 'reserved'`
  )
    .bind(stored.fileId, stored.messageId, stored.fileUniqueId ?? null,
      JSON.stringify({ fileId: stored.fileId, messageId: stored.messageId }), updatedAt, intent.id, user.id)
    .run()
  if ((saved.meta.changes ?? 0) !== 1) {
    throw new HttpError(503, 'UPLOAD_METADATA_PERSIST_FAILED')
  }
  return json({ ok: true, intentId, status: 'uploaded' })
}

async function handleUploadReceipt(request: Request, env: RuntimeEnv, auth: RequestAuth): Promise<Response> {
  const user = auth.user
  const input = await requestJson(request, uploadReceiptSchema)
  const intent = await env.DB.prepare('SELECT * FROM upload_intents WHERE id = ? AND owner_user_id = ? LIMIT 1')
    .bind(input.intentId, user.id)
    .first<IntentRow>()
  if (!intent) throw new HttpError(404, 'INTENT_NOT_FOUND')
  if ((intent.storage_backend ?? 'telegram_bot') !== 'telegram_user_group') throw new HttpError(409, 'STORAGE_BACKEND_MISMATCH')
  if (intent.status === 'committed' || intent.status === 'uploaded') return json({ ok: true, intentId: intent.id, status: intent.status })
  if (intent.status !== 'reserved') throw new HttpError(409, 'INTENT_NOT_UPLOADABLE')
  if (input.receipt.size !== intent.size) throw new HttpError(409, 'UPLOAD_SIZE_MISMATCH')
  if (input.receipt.sha256.toLowerCase() !== intent.hash.toLowerCase()) throw new HttpError(409, 'UPLOAD_HASH_MISMATCH')

  const locator = JSON.stringify({ chatId: input.receipt.chatId, messageId: input.receipt.messageId })
  const syntheticFileId = `user-group:${input.receipt.chatId}:${input.receipt.messageId}`
  const updated = await env.DB.prepare(
    `UPDATE upload_intents
        SET status = 'uploaded', telegram_file_id = ?, telegram_message_id = ?, telegram_file_unique_id = NULL,
            storage_backend = 'telegram_user_group', storage_locator = ?, upload_receipt = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND status = 'reserved'`
  ).bind(syntheticFileId, input.receipt.messageId, locator, JSON.stringify(input.receipt), nowIso(), intent.id, user.id).run()
  if ((updated.meta.changes ?? 0) !== 1) throw new HttpError(503, 'UPLOAD_METADATA_PERSIST_FAILED')
  return json({ ok: true, intentId: intent.id, status: 'uploaded' })
}

async function commitUploadedIntent(env: RuntimeEnv, auth: RequestAuth, intent: IntentRow): Promise<{
  fileId: string
  version: number
  hash: string
}> {
  const user = auth.user
  if (intent.status === 'committed') {
    const file = await getOwnedFile(env, user, intent.file_id, 'VIEWER')
    return { fileId: file.id, version: file.current_version, hash: file.current_hash ?? intent.hash }
  }
  if (
    intent.status !== 'uploaded' ||
    !intent.telegram_file_id ||
    intent.telegram_message_id === null
  ) {
    throw new HttpError(409, 'INTENT_NOT_COMMITTABLE')
  }

  const current = await getOwnedFile(env, user, intent.file_id, 'EDITOR')
  await assertFileLeaseCompatible(env, auth, intent.file_id)
  if (current.current_version !== intent.base_version) {
    if (current.current_hash === intent.hash) {
      await env.DB.prepare("UPDATE upload_intents SET status = 'abandoned', updated_at = ? WHERE id = ?")
        .bind(nowIso(), intent.id)
        .run()
      return { fileId: current.id, version: current.current_version, hash: current.current_hash }
    }
    throw new HttpError(409, 'BASE_VERSION_CONFLICT', 'Cloud version advanced before commit', {
      currentVersion: current.current_version,
      currentHash: current.current_hash
    })
  }

  const newVersion = intent.base_version + 1
  const versionId = crypto.randomUUID()
  const eventId = crypto.randomUUID()
  const timestamp = nowIso()
  const retention = await getRetention(env, user.id)
  const expireThrough = newVersion - retention

  const batch = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO file_versions(
         id, file_id, version, telegram_file_id, telegram_message_id, telegram_file_unique_id,
         hash, size, base_version, restored_from_version, created_at, created_by, storage_connection_id,
         storage_backend, storage_locator, status
       )
       SELECT ?, f.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active'
         FROM files f
        WHERE f.id = ? AND f.workspace_id = ? AND f.current_version = ?`
    ).bind(
      versionId,
      newVersion,
      intent.telegram_file_id,
      intent.telegram_message_id,
      intent.telegram_file_unique_id,
      intent.hash,
      intent.size,
      intent.base_version,
      intent.restored_from_version ?? null,
      timestamp,
      user.id,
      intent.storage_connection_id ?? LEGACY_STORAGE_CONNECTION_ID,
      intent.storage_backend ?? 'telegram_bot',
      intent.storage_locator,
      intent.file_id,
      current.workspace_id,
      intent.base_version
    ),
    env.DB.prepare(
      `UPDATE files
          SET logical_name = ?, current_version = ?, current_telegram_file_id = ?,
              current_telegram_message_id = ?, current_storage_backend = ?, current_storage_locator = ?,
              current_hash = ?, updated_at = ?, updated_by = ?, updated_by_user_id = ?, status = 'active'
        WHERE id = ? AND workspace_id = ? AND current_version = ?
          AND EXISTS (SELECT 1 FROM file_versions WHERE id = ?)`
    ).bind(
      intent.logical_name,
      newVersion,
      intent.telegram_file_id,
      intent.telegram_message_id,
      intent.storage_backend ?? 'telegram_bot',
      intent.storage_locator,
      intent.hash,
      timestamp,
      user.id,
      user.id,
      intent.file_id,
      current.workspace_id,
      intent.base_version,
      versionId
    ),
    env.DB.prepare(
      `UPDATE upload_intents SET status = 'committed', updated_at = ?
        WHERE id = ? AND owner_user_id = ? AND status = 'uploaded'
          AND EXISTS (SELECT 1 FROM file_versions WHERE id = ?)`
    ).bind(timestamp, intent.id, user.id, versionId),
    env.DB.prepare(
      `UPDATE file_versions SET status = 'archived'
        WHERE file_id = ? AND version < ? AND status = 'active'
          AND EXISTS (SELECT 1 FROM file_versions WHERE id = ?)`
    ).bind(intent.file_id, newVersion, versionId),
    env.DB.prepare(
      `UPDATE file_versions SET status = 'expired'
        WHERE file_id = ? AND version <= ? AND status != 'expired'
          AND EXISTS (SELECT 1 FROM file_versions WHERE id = ?)`
    ).bind(intent.file_id, expireThrough, versionId),
    env.DB.prepare(
      `INSERT INTO sync_events(id, user_id, file_id, event_type, detail, created_at)
       SELECT ?, ?, ?, 'SYNC_COMMIT', ?, ?
        WHERE EXISTS (SELECT 1 FROM file_versions WHERE id = ?)`
    ).bind(eventId, user.id, intent.file_id, `V${newVersion}`, timestamp, versionId)
  ])

  if ((batch[0]?.meta.changes ?? 0) !== 1 || (batch[1]?.meta.changes ?? 0) !== 1) {
    throw new HttpError(409, 'BASE_VERSION_CONFLICT')
  }
  const domainEventId = await recordDomainEvent(env, {
    organizationId: user.organizationId,
    workspaceId: current.workspace_id,
    fileId: intent.file_id,
    actorUserId: user.id,
    eventKey: `content-update:${intent.id}:${newVersion}`,
    eventType: newVersion === 1 ? 'FILE_CONTENT_CREATED' : 'FILE_CONTENT_UPDATED',
    category: 'FILE',
    targetType: 'file',
    targetId: intent.file_id,
    detail: { version: newVersion, baseVersion: intent.base_version, size: intent.size }
  })
  await recordFileStateSnapshot(env, intent.file_id, 'CONTENT_UPDATE', user.id, domainEventId)
  return { fileId: intent.file_id, version: newVersion, hash: intent.hash }
}

async function handleCommit(request: Request, env: RuntimeEnv, auth: RequestAuth): Promise<Response> {
  const user = auth.user
  const input = await requestJson(request, commitSchema)
  const intent = await env.DB.prepare('SELECT * FROM upload_intents WHERE id = ? AND owner_user_id = ? LIMIT 1')
    .bind(input.intentId, user.id)
    .first<IntentRow>()
  if (!intent) throw new HttpError(404, 'INTENT_NOT_FOUND')
  const committed = await commitUploadedIntent(env, auth, intent)
  return json({ ok: true, ...committed })
}

async function handleRename(request: Request, env: RuntimeEnv, user: AuthUser, fileId: string): Promise<Response> {
  const input = await requestJson(request, renameSchema)
  const requestedName = validateLogicalName(input.logicalName)
  const relativePath = normalizeRelativePath(input.relativePath ?? requestedName)
  const logicalName = fileNameFromRelativePath(relativePath)
  const file = await getOwnedFile(env, user, fileId, 'EDITOR')
  if (!file.workspace_id) throw new HttpError(409, 'FILE_WORKSPACE_MISSING')
  if (!(await canCreateResourceAtPath(env, user, file.workspace_id, relativePath, file.home_storage_connection_id, 'EDITOR', file.id))) {
    throw new HttpError(403, 'RESOURCE_MOVE_FORBIDDEN')
  }
  if (file.current_version !== input.baseVersion) {
    return json({ code: 'BASE_VERSION_CONFLICT', currentVersion: file.current_version }, 409)
  }
  const timestamp = nowIso()
  const pathConflict = await env.DB.prepare(
    `SELECT id FROM files WHERE workspace_id = ? AND relative_path = ? COLLATE NOCASE AND status = 'active' AND id != ? LIMIT 1`
  ).bind(file.workspace_id, relativePath, fileId).first<{ id: string }>()
  if (pathConflict) throw new HttpError(409, 'PATH_ALREADY_EXISTS')
  const result = await env.DB.prepare(
    `UPDATE files SET logical_name = ?, relative_path = ?, updated_at = ?, updated_by = ?, updated_by_user_id = ?
      WHERE id = ? AND workspace_id = ? AND current_version = ?`
  )
    .bind(logicalName, relativePath, timestamp, user.id, user.id, fileId, file.workspace_id, input.baseVersion)
    .run()
  if ((result.meta.changes ?? 0) !== 1) throw new HttpError(409, 'BASE_VERSION_CONFLICT')
  await recordEvent(env, user.id, fileId, 'RENAME', relativePath)
  const eventId = await recordDomainEvent(env, {
    organizationId: user.organizationId,
    workspaceId: file.workspace_id,
    fileId,
    actorUserId: user.id,
    eventKey: `rename:${fileId}:${timestamp}`,
    eventType: file.relative_path === relativePath ? 'FILE_RENAMED' : 'FILE_MOVED',
    category: 'FILE',
    targetType: 'file',
    targetId: fileId,
    detail: { from: file.relative_path, to: relativePath }
  })
  await recordFileStateSnapshot(env, fileId, file.relative_path === relativePath ? 'RENAME' : 'MOVE', user.id, eventId)
  return json({ ok: true, currentVersion: file.current_version })
}

export async function handleDelete(request: Request, env: RuntimeEnv, user: AuthUser, fileId: string): Promise<Response> {
  const input = await requestJson(request, deleteSchema)
  const file = await getOwnedFile(env, user, fileId, 'EDITOR')
  if (file.current_version !== input.baseVersion) {
    return json({ code: 'BASE_VERSION_CONFLICT', currentVersion: file.current_version }, 409)
  }
  await recordEvent(env, user.id, fileId, 'LEGACY_LOCAL_DELETE_IGNORED', `base=${input.baseVersion}`)
  return json({ ok: true, retained: true })
}

export async function handleTrash(request: Request, env: RuntimeEnv, user: AuthUser, fileId: string): Promise<Response> {
  const input = await requestJson(request, deleteSchema)
  const file = await getOwnedFile(env, user, fileId, 'EDITOR')
  if (file.status !== 'active') throw new HttpError(409, 'FILE_NOT_ACTIVE')
  if (file.current_version !== input.baseVersion) {
    return json({ code: 'BASE_VERSION_CONFLICT', currentVersion: file.current_version }, 409)
  }
  const timestamp = nowIso()
  const result = await env.DB.prepare(
    `UPDATE files
        SET status = 'trashed', trashed_at = ?, trashed_by = ?, updated_at = ?, updated_by = ?, updated_by_user_id = ?
      WHERE id = ? AND workspace_id = ? AND status = 'active' AND current_version = ?`
  )
    .bind(timestamp, user.id, timestamp, user.id, user.id, fileId, file.workspace_id, input.baseVersion)
    .run()
  if ((result.meta.changes ?? 0) !== 1) throw new HttpError(409, 'BASE_VERSION_CONFLICT')
  await recordEvent(env, user.id, fileId, 'SAAS_TRASHED', `base=${input.baseVersion}`)
  const eventId = await recordDomainEvent(env, {
    organizationId: user.organizationId,
    workspaceId: file.workspace_id,
    fileId,
    actorUserId: user.id,
    eventKey: `trash:${fileId}:${timestamp}`,
    eventType: 'FILE_TRASHED',
    category: 'FILE',
    targetType: 'file',
    targetId: fileId,
    detail: { version: file.current_version }
  })
  await recordFileStateSnapshot(env, fileId, 'TRASH', user.id, eventId)
  return json({ ok: true })
}

export async function handlePermanentDelete(env: RuntimeEnv, user: AuthUser, fileId: string): Promise<Response> {
  const file = await getOwnedFile(env, user, fileId, 'MANAGER')
  if (file.status !== 'trashed') throw new HttpError(409, 'FILE_NOT_TRASHED')
  const timestamp = nowIso()
  const result = await env.DB.prepare(
    `UPDATE files
        SET status = 'deleted', updated_at = ?, updated_by = ?, updated_by_user_id = ?
      WHERE id = ? AND workspace_id = ? AND status = 'trashed'`
  ).bind(timestamp, user.id, user.id, fileId, file.workspace_id).run()
  if ((result.meta.changes ?? 0) !== 1) throw new HttpError(409, 'FILE_NOT_TRASHED')
  await recordEvent(env, user.id, fileId, 'SAAS_PERMANENTLY_DELETED', `V${file.current_version}; storage object retained by provider policy`)
  const eventId = await recordDomainEvent(env, {
    organizationId: user.organizationId,
    workspaceId: file.workspace_id,
    fileId,
    actorUserId: user.id,
    eventKey: `delete:${fileId}:${timestamp}`,
    eventType: 'FILE_PERMANENTLY_DELETED',
    category: 'FILE',
    targetType: 'file',
    targetId: fileId,
    detail: { version: file.current_version, storageRetained: true }
  })
  await recordFileStateSnapshot(env, fileId, 'DELETE', user.id, eventId)
  return json({ ok: true, storageRetained: true })
}

export async function handleRestoreFromTrash(env: RuntimeEnv, user: AuthUser, fileId: string): Promise<Response> {
  const file = await getOwnedFile(env, user, fileId, 'EDITOR')
  if (file.status !== 'trashed') throw new HttpError(409, 'FILE_NOT_TRASHED')
  const relativePath = normalizeRelativePath(file.relative_path || file.logical_name)
  const pathConflict = await env.DB.prepare(
    `SELECT id FROM files WHERE workspace_id = ? AND relative_path = ? COLLATE NOCASE AND status = 'active' AND id != ? LIMIT 1`
  ).bind(file.workspace_id, relativePath, fileId).first<{ id: string }>()
  if (pathConflict) throw new HttpError(409, 'PATH_ALREADY_EXISTS')
  const timestamp = nowIso()
  const result = await env.DB.prepare(
    `UPDATE files
        SET status = 'active', trashed_at = NULL, trashed_by = NULL, updated_at = ?, updated_by = ?, updated_by_user_id = ?
      WHERE id = ? AND workspace_id = ? AND status = 'trashed'`
  )
    .bind(timestamp, user.id, user.id, fileId, file.workspace_id)
    .run()
  if ((result.meta.changes ?? 0) !== 1) throw new HttpError(409, 'FILE_NOT_TRASHED')
  const restored = await env.DB.prepare(
    `SELECT f.id, f.logical_name, f.relative_path, f.current_version, f.current_hash, f.status,
            COALESCE(v.size, 0) AS size
       FROM files f
       LEFT JOIN file_versions v ON v.file_id = f.id AND v.version = f.current_version
      WHERE f.id = ? AND f.workspace_id = ? LIMIT 1`
  ).bind(fileId, file.workspace_id).first<Record<string, unknown>>()
  await recordEvent(env, user.id, fileId, 'SAAS_TRASH_RESTORED', `V${file.current_version}`)
  const eventId = await recordDomainEvent(env, {
    organizationId: user.organizationId,
    workspaceId: file.workspace_id,
    fileId,
    actorUserId: user.id,
    eventKey: `trash-restore:${fileId}:${timestamp}`,
    eventType: 'FILE_RESTORED_FROM_TRASH',
    category: 'FILE',
    targetType: 'file',
    targetId: fileId,
    detail: { version: file.current_version }
  })
  await recordFileStateSnapshot(env, fileId, 'RESTORE', user.id, eventId)
  return json(restored)
}

function desktopStorageRequired(input: { backend: string | null; locator: string | null; hash: string | null; size: number | null; version: number }): never {
  throw new HttpError(409, 'DESKTOP_STORAGE_REQUIRED', 'Telegram User Group download requires the Windows ExcelSync client', {
    backend: input.backend ?? 'telegram_user_group',
    locator: input.locator,
    hash: input.hash,
    size: input.size,
    version: input.version
  })
}

async function handleDownload(env: RuntimeEnv, user: AuthUser, fileId: string): Promise<Response> {
  const file = await getOwnedFile(env, user, fileId, 'VIEWER')
  if (file.current_version <= 0) throw new HttpError(404, 'FILE_HAS_NO_STORED_VERSION')
  const version = await env.DB.prepare(
    `SELECT telegram_file_id, storage_connection_id, storage_backend, storage_locator, hash, size FROM file_versions
      WHERE file_id = ? AND version = ? LIMIT 1`
  ).bind(file.id, file.current_version).first<{
    telegram_file_id: string
    storage_connection_id: string | null
    storage_backend: string | null
    storage_locator: string | null
    hash: string | null
    size: number | null
  }>()
  const backend = version?.storage_backend ?? file.current_storage_backend ?? 'telegram_bot'
  const locator = version?.storage_locator ?? file.current_storage_locator
  if (backend === 'telegram_user_group') {
    desktopStorageRequired({ backend, locator, hash: version?.hash ?? file.current_hash, size: version?.size ?? null, version: file.current_version })
  }
  const storageFileId = version?.telegram_file_id ?? file.current_telegram_file_id
  if (!storageFileId) throw new HttpError(404, 'FILE_HAS_NO_STORED_VERSION')
  try {
    const resolved = await new StorageRouter(env).resolveConnection(version?.storage_connection_id ?? LEGACY_STORAGE_CONNECTION_ID)
    const response = await resolved.provider.download(storageFileId)
    return new Response(response.body, {
      status: 200,
      headers: {
        'content-type': mimeFor(file.logical_name),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.logical_name)}`,
        'cache-control': 'no-store',
        'x-excelsync-version': String(file.current_version),
        'x-excelsync-hash': file.current_hash ?? ''
      }
    })
  } catch {
    throw new HttpError(503, 'CLOUD_STORAGE_UNAVAILABLE')
  }
}

async function handleVersionDownload(
  env: RuntimeEnv,
  user: AuthUser,
  fileId: string,
  versionNumber: number
): Promise<Response> {
  const file = await getOwnedFile(env, user, fileId, 'VIEWER')
  const version = await env.DB.prepare(
    `SELECT fv.telegram_file_id, fv.hash, fv.size, fv.status, fv.storage_connection_id, fv.storage_backend, fv.storage_locator, sc.name AS storage_name
       FROM file_versions fv
       LEFT JOIN storage_connections sc ON sc.id = fv.storage_connection_id AND sc.organization_id = ?
      WHERE fv.file_id = ? AND fv.version = ? LIMIT 1`
  ).bind(user.organizationId, file.id, versionNumber).first<{
    telegram_file_id: string | null
    hash: string
    size: number
    status: string
    storage_connection_id: string | null
    storage_backend: string | null
    storage_locator: string | null
    storage_name: string | null
  }>()
  if (!version) throw new HttpError(404, 'VERSION_NOT_AVAILABLE')
  if (version.status === 'expired') throw new HttpError(410, 'VERSION_EXPIRED')
  if ((version.storage_backend ?? 'telegram_bot') === 'telegram_user_group') {
    desktopStorageRequired({ backend: version.storage_backend, locator: version.storage_locator, hash: version.hash, size: version.size, version: versionNumber })
  }
  if (!version.telegram_file_id) throw new HttpError(409, 'VERSION_REMOTE_REFERENCE_MISSING')
  if (!version.storage_connection_id || !version.storage_name) throw new HttpError(409, 'VERSION_STORAGE_REFERENCE_MISSING')
  try {
    const resolved = await new StorageRouter(env).resolveConnection(version.storage_connection_id)
    const response = await resolved.provider.download(version.telegram_file_id)
    return new Response(response.body, {
      status: 200,
      headers: {
        'content-type': mimeFor(file.logical_name),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`V${versionNumber}-${file.logical_name}`)}`,
        'cache-control': 'no-store',
        'x-excelsync-version': String(versionNumber),
        'x-excelsync-hash': version.hash,
        'x-excelsync-size': String(version.size),
        'x-excelsync-storage': version.storage_name
      }
    })
  } catch (error) {
    const code = error instanceof Error ? error.message : 'CLOUD_STORAGE_UNAVAILABLE'
    throw new HttpError(503, 'CLOUD_STORAGE_UNAVAILABLE', code)
  }
}

async function handleRestore(
  request: Request,
  env: RuntimeEnv,
  user: AuthUser,
  fileId: string
): Promise<Response> {
  const input = await requestJson(request, restoreSchema)
  const file = await getOwnedFile(env, user, fileId, 'EDITOR')
  if (!file.workspace_id) throw new HttpError(409, 'FILE_WORKSPACE_MISSING')
  if (file.current_version !== input.baseVersion) throw new HttpError(409, 'BASE_VERSION_CONFLICT')
  const source = await env.DB.prepare(
    `SELECT * FROM file_versions
      WHERE file_id = ? AND version = ? AND status != 'expired' LIMIT 1`
  ).bind(fileId, input.version).first<VersionRow>()
  if (!source) throw new HttpError(404, 'VERSION_NOT_AVAILABLE')
  if ((source.storage_backend ?? 'telegram_bot') === 'telegram_user_group') {
    desktopStorageRequired({
      backend: source.storage_backend,
      locator: source.storage_locator,
      hash: source.hash,
      size: source.size,
      version: source.version
    })
  }

  const router = new StorageRouter(env)
  let sourceResolved
  let destinationResolved
  try {
    sourceResolved = await router.resolveConnection(source.storage_connection_id ?? LEGACY_STORAGE_CONNECTION_ID)
    destinationResolved = await router.resolveWorkspaceDefault(file.workspace_id)
  } catch {
    throw new HttpError(503, 'CLOUD_STORAGE_UNAVAILABLE')
  }

  let stored
  const caption = `ExcelSync restore ${file.id} V${file.current_version + 1} from V${source.version}`
  if (sourceResolved.connection.id === destinationResolved.connection.id) {
    stored = await destinationResolved.provider.clone({ fileId: source.telegram_file_id, caption })
  } else {
    const download = await sourceResolved.provider.download(source.telegram_file_id)
    const bytes = new Uint8Array(await download.arrayBuffer())
    stored = await destinationResolved.provider.upload({
      bytes,
      fileName: file.logical_name,
      mimeType: mimeFor(file.logical_name),
      caption
    })
  }

  const newVersion = file.current_version + 1
  const versionId = crypto.randomUUID()
  const eventId = crypto.randomUUID()
  const timestamp = nowIso()
  const retention = await getRetention(env, user.id)
  const expireThrough = newVersion - retention
  const batch = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO file_versions(
         id, file_id, version, telegram_file_id, telegram_message_id, telegram_file_unique_id,
         hash, size, base_version, restored_from_version, created_at, created_by, storage_connection_id, status
       )
       SELECT ?, f.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active'
         FROM files f
        WHERE f.id = ? AND f.workspace_id = ? AND f.current_version = ?`
    ).bind(versionId, newVersion, stored.fileId, stored.messageId, stored.fileUniqueId ?? null, source.hash, source.size,
      file.current_version, source.version, timestamp, user.id, destinationResolved.connection.id, file.id, file.workspace_id, file.current_version),
    env.DB.prepare(
      `UPDATE files SET current_version = ?, current_telegram_file_id = ?, current_telegram_message_id = ?,
                        current_hash = ?, updated_at = ?, updated_by = ?, updated_by_user_id = ?, status = 'active'
        WHERE id = ? AND workspace_id = ? AND current_version = ?
          AND EXISTS (SELECT 1 FROM file_versions WHERE id = ?)`
    ).bind(newVersion, stored.fileId, stored.messageId, source.hash, timestamp, user.id, user.id,
      file.id, file.workspace_id, file.current_version, versionId),
    env.DB.prepare(
      `UPDATE file_versions SET status = 'archived'
        WHERE file_id = ? AND version < ? AND status = 'active'
          AND EXISTS (SELECT 1 FROM file_versions WHERE id = ?)`
    ).bind(file.id, newVersion, versionId),
    env.DB.prepare(
      `UPDATE file_versions SET status = 'expired'
        WHERE file_id = ? AND version <= ? AND status != 'expired'
          AND EXISTS (SELECT 1 FROM file_versions WHERE id = ?)`
    ).bind(file.id, expireThrough, versionId),
    env.DB.prepare(
      `INSERT INTO sync_events(id, user_id, file_id, event_type, detail, created_at)
       SELECT ?, ?, ?, 'RESTORE', ?, ?
        WHERE EXISTS (SELECT 1 FROM file_versions WHERE id = ?)`
    ).bind(eventId, user.id, file.id, `V${newVersion} restored from V${source.version}`, timestamp, versionId)
  ])
  if ((batch[0]?.meta.changes ?? 0) !== 1 || (batch[1]?.meta.changes ?? 0) !== 1) throw new HttpError(409, 'BASE_VERSION_CONFLICT')
  const domainEventId = await recordDomainEvent(env, {
    organizationId: user.organizationId,
    workspaceId: file.workspace_id,
    fileId: file.id,
    actorUserId: user.id,
    eventKey: `version-restore:${file.id}:${newVersion}:${source.version}`,
    eventType: 'VERSION_RESTORED',
    category: 'RECOVERY',
    targetType: 'file',
    targetId: file.id,
    detail: { newVersion, restoredFromVersion: source.version }
  })
  await recordFileStateSnapshot(env, file.id, 'VERSION_RESTORE', user.id, domainEventId)
  return json({ ok: true, fileId: file.id, version: newVersion, restoredFromVersion: source.version, hash: source.hash })
}

async function handleGetSettings(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  return json({ retentionLimit: await getRetention(env, user.id) })
}

async function handlePutSettings(request: Request, env: RuntimeEnv, user: AuthUser): Promise<Response> {
  const input = await requestJson(request, settingsSchema)
  const timestamp = nowIso()
  await env.DB.prepare(
    `INSERT INTO user_settings(user_id, retention_limit, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET retention_limit = excluded.retention_limit, updated_at = excluded.updated_at`
  )
    .bind(user.id, input.retentionLimit, timestamp)
    .run()
  await recordEvent(env, user.id, null, 'SETTINGS_UPDATED', `retention=${input.retentionLimit}`)
  return json({ retentionLimit: input.retentionLimit })
}

async function persistTelegramImportOffset(env: RuntimeEnv, updateId: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings(key, value, updated_at) VALUES ('telegram_import_offset', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(String(updateId), nowIso()).run()
}

async function importTelegramDocument(
  env: RuntimeEnv,
  user: AuthUser,
  message: NonNullable<import('./telegram-storage').TelegramUpdate['message']>
): Promise<{ fileId: string; relativePath: string; version: number; hash: string }> {
  const document = message.document
  if (!document?.file_id || !document.file_name) throw new HttpError(400, 'TELEGRAM_DOCUMENT_INVALID')
  const workspaceId = await getDefaultWorkspaceId(env, user)
  if (!workspaceId) throw new HttpError(400, 'DEFAULT_WORKSPACE_REQUIRED')
  const role = await getEffectiveWorkspaceRole(env, user, workspaceId)
  if (!workspaceRoleAtLeast(role, 'EDITOR')) throw new HttpError(403, 'WORKSPACE_UPLOAD_FORBIDDEN')
  const relativePath = telegramRelativePath(document.file_name, message.caption)
  const logicalName = fileNameFromRelativePath(relativePath)
  if (document.file_size && document.file_size > MAX_FILE_BYTES) throw new HttpError(413, 'FILE_TOO_LARGE')

  let provider
  try {
    provider = (await new StorageRouter(env).resolveConnection(LEGACY_STORAGE_CONNECTION_ID)).provider
  } catch {
    throw new HttpError(503, 'CLOUD_STORAGE_UNAVAILABLE')
  }
  const response = await provider.download(document.file_id)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_FILE_BYTES) throw new HttpError(413, 'FILE_TOO_LARGE')
  if (!matchesExpectedFileSignature(document.file_name, bytes.subarray(0, Math.min(bytes.byteLength, 4096)))) {
    throw new HttpError(415, 'FILE_SIGNATURE_MISMATCH')
  }
  const hash = await sha256Hex(bytes)
  const existing = await env.DB.prepare(
    `SELECT * FROM files
      WHERE workspace_id = ? AND relative_path = ? COLLATE NOCASE AND status = 'active' LIMIT 1`
  ).bind(workspaceId, relativePath).first<FileRow>()

  if (existing?.current_hash?.toLowerCase() === hash.toLowerCase() && existing.current_version > 0) {
    await recordEvent(env, user.id, existing.id, 'TELEGRAM_IMPORT_NOOP', relativePath)
    return { fileId: existing.id, relativePath, version: existing.current_version, hash }
  }

  const fileId = existing?.id ?? crypto.randomUUID()
  const baseVersion = existing?.current_version ?? 0
  const newVersion = baseVersion + 1
  const timestamp = nowIso()
  const versionId = crypto.randomUUID()
  const retention = await getRetention(env, user.id)
  const expireThrough = newVersion - retention

  if (!existing) {
    if (!(await canCreateResourceAtPath(env, user, workspaceId, relativePath, LEGACY_STORAGE_CONNECTION_ID, 'EDITOR'))) {
      throw new HttpError(403, 'RESOURCE_CREATE_FORBIDDEN')
    }
    const batch = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO files(
           id, workspace_id, home_storage_connection_id, logical_name, relative_path, current_version,
           current_telegram_file_id, current_telegram_message_id, current_hash, owner_user_id,
           created_by_user_id, updated_by_user_id, created_at, updated_at, updated_by, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
      ).bind(fileId, workspaceId, LEGACY_STORAGE_CONNECTION_ID, logicalName, relativePath, newVersion, document.file_id, message.message_id, hash,
        user.id, user.id, user.id, timestamp, timestamp, user.id),
      env.DB.prepare(
        `INSERT INTO file_versions(
           id, file_id, version, telegram_file_id, telegram_message_id, telegram_file_unique_id,
           hash, size, base_version, restored_from_version, created_at, created_by, storage_connection_id, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, 'active')`
      ).bind(versionId, fileId, newVersion, document.file_id, message.message_id, document.file_unique_id ?? null,
        hash, bytes.byteLength, timestamp, user.id, LEGACY_STORAGE_CONNECTION_ID)
    ])
    if ((batch[0]?.meta.changes ?? 0) !== 1 || (batch[1]?.meta.changes ?? 0) !== 1) throw new HttpError(503, 'TELEGRAM_IMPORT_PERSIST_FAILED')
  } else {
    const batch = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO file_versions(
           id, file_id, version, telegram_file_id, telegram_message_id, telegram_file_unique_id,
           hash, size, base_version, restored_from_version, created_at, created_by, storage_connection_id, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'active')`
      ).bind(versionId, fileId, newVersion, document.file_id, message.message_id, document.file_unique_id ?? null,
        hash, bytes.byteLength, baseVersion, timestamp, user.id, LEGACY_STORAGE_CONNECTION_ID),
      env.DB.prepare(
        `UPDATE files SET logical_name = ?, relative_path = ?, current_version = ?, current_telegram_file_id = ?,
                          current_telegram_message_id = ?, current_hash = ?, updated_at = ?, updated_by = ?, updated_by_user_id = ?, status = 'active'
          WHERE id = ? AND workspace_id = ? AND current_version = ?`
      ).bind(logicalName, relativePath, newVersion, document.file_id, message.message_id, hash, timestamp, user.id, user.id,
        fileId, workspaceId, baseVersion)
    ])
    if ((batch[0]?.meta.changes ?? 0) !== 1 || (batch[1]?.meta.changes ?? 0) !== 1) throw new HttpError(409, 'TELEGRAM_IMPORT_CONFLICT')
  }

  await env.DB.batch([
    env.DB.prepare(`UPDATE file_versions SET status = 'archived' WHERE file_id = ? AND version < ? AND status = 'active'`).bind(fileId, newVersion),
    env.DB.prepare(`UPDATE file_versions SET status = 'expired' WHERE file_id = ? AND version <= ? AND status != 'expired'`).bind(fileId, expireThrough)
  ])
  await recordEvent(env, user.id, fileId, 'TELEGRAM_IMPORT', `${relativePath} V${newVersion}`)
  return { fileId, relativePath, version: newVersion, hash }
}

async function handleTelegramImportPull(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  const token = env.TELEGRAM_BOT_TOKEN
  if (!token || token === 'UNCONFIGURED') throw new HttpError(503, 'TELEGRAM_SECRET_NOT_CONFIGURED')
  const storageConnection = await env.DB.prepare(
    'SELECT chat_id FROM storage_connections WHERE id = ? AND organization_id = ? LIMIT 1'
  ).bind(LEGACY_STORAGE_CONNECTION_ID, user.organizationId).first<{ chat_id: string | null }>()
  const legacyConfig = storageConnection?.chat_id ? null : await env.DB.prepare(
    "SELECT chat_id FROM storage_config WHERE provider = 'telegram' LIMIT 1"
  ).first<{ chat_id: string | null }>()
  const chatId = storageConnection?.chat_id ?? legacyConfig?.chat_id ?? null
  if (!chatId) throw new HttpError(503, 'CLOUD_STORAGE_UNAVAILABLE')

  const offsetSetting = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = 'telegram_import_offset' LIMIT 1"
  ).first<{ value: string }>()
  const lastOffset = Number(offsetSetting?.value ?? 0)
  const updates = await telegramGetUpdates(token, Number.isInteger(lastOffset) && lastOffset > 0 ? lastOffset + 1 : undefined)
  const imported: Array<{ fileId: string; relativePath: string; version: number; hash: string }> = []

  for (const update of updates.slice().sort((a, b) => a.update_id - b.update_id)) {
    const message = update.message
    if (!message || String(message.chat.id) !== chatId || message.chat.type !== 'private') {
      await persistTelegramImportOffset(env, update.update_id)
      continue
    }
    const document = message.document
    const fileName = document?.file_name ?? ''
    if (!document || !isSupportedFileName(fileName)) {
      await persistTelegramImportOffset(env, update.update_id)
      continue
    }
    if ((document.file_size ?? 0) > MAX_FILE_BYTES) {
      await recordEvent(env, user.id, null, 'TELEGRAM_IMPORT_SKIPPED', `${fileName}: FILE_TOO_LARGE`)
      await persistTelegramImportOffset(env, update.update_id)
      continue
    }

    try {
      const result = await importTelegramDocument(env, user, message)
      imported.push(result)
    } catch (error) {
      if (error instanceof HttpError && ['FILE_SIGNATURE_MISMATCH', 'FILE_TOO_LARGE'].includes(error.code)) {
        await recordEvent(env, user.id, null, 'TELEGRAM_IMPORT_SKIPPED', `${fileName}: ${error.code}`)
      } else {
        throw error
      }
    }
    await persistTelegramImportOffset(env, update.update_id)
  }

  return json({ ok: true, importedCount: imported.length, imported })
}

async function handleStorageStatus(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  const profiles = await new StorageRouter(env).status(user.organizationId)
  const reachable = profiles.some((item) => item.reachable)
  if (!isSystemAdmin(user)) {
    return json({ reachable, status: reachable ? 'ok' : 'unavailable', message: reachable ? '云端存储可用' : '云端存储暂时不可用，请稍后重试' })
  }
  const connections = await new StorageRouter(env).listConnections(user.organizationId)
  return json({
    reachable,
    connections,
    profiles: profiles.map((item) => ({
      id: item.id,
      profile: item.profile,
      purpose: item.purpose,
      provider: item.provider,
      configured: item.configured,
      reachable: item.reachable,
      detail: item.detail
    }))
  })
}

async function handlePairStart(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN === 'UNCONFIGURED') {
    throw new HttpError(503, 'TELEGRAM_SECRET_NOT_CONFIGURED')
  }
  const me = await telegramGetMe(env.TELEGRAM_BOT_TOKEN)
  if (!me.username) throw new HttpError(409, 'TELEGRAM_BOT_USERNAME_REQUIRED')
  const code = randomCode(9)
  const hash = await sha256Text(code)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  const value = JSON.stringify({ hash, expiresAt })
  await env.DB.prepare(
    `INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(`telegram_pair:${user.id}`, value, nowIso())
    .run()
  return json({ code, deepLink: `https://t.me/${encodeURIComponent(me.username)}?start=${encodeURIComponent(code)}`, expiresAt, botUsername: me.username })
}

async function handlePairConfirm(env: RuntimeEnv, user: AuthUser): Promise<Response> {
  const token = env.TELEGRAM_BOT_TOKEN
  if (!token || token === 'UNCONFIGURED') throw new HttpError(503, 'TELEGRAM_SECRET_NOT_CONFIGURED')
  const key = `telegram_pair:${user.id}`
  const setting = await env.DB.prepare('SELECT value, updated_at FROM app_settings WHERE key = ? LIMIT 1')
    .bind(key)
    .first<{ value: string; updated_at: string }>()
  if (!setting) throw new HttpError(409, 'PAIR_NOT_STARTED')
  let pair: { hash: string; expiresAt: string }
  try {
    pair = JSON.parse(setting.value) as { hash: string; expiresAt: string }
  } catch {
    throw new HttpError(500, 'PAIR_STATE_INVALID')
  }
  if (new Date(pair.expiresAt).getTime() <= Date.now()) throw new HttpError(409, 'PAIR_EXPIRED')

  const updates = await telegramGetUpdates(token)
  const recent = updates.slice().sort((a, b) => b.update_id - a.update_id)
  let matchedChatId: string | null = null
  for (const update of recent) {
    const message = update.message
    if (!message || message.chat.type !== 'private' || !message.text?.startsWith('/start')) continue
    const payload = message.text.split(/\s+/, 2)[1]
    if (!payload) continue
    if ((await sha256Text(payload)) === pair.hash) {
      matchedChatId = String(message.chat.id)
      break
    }
  }

  if (!matchedChatId) throw new HttpError(404, 'PAIR_MESSAGE_NOT_FOUND')

  const timestamp = nowIso()
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE storage_config SET chat_id = ?, connected_by = ?, connected_at = ? WHERE provider = 'telegram'`
    ).bind(matchedChatId, user.id, timestamp),
    env.DB.prepare(
      `INSERT INTO storage_profiles(profile, purpose, provider, chat_id, connected_by, connected_at, enabled)
       VALUES ('files-primary', 'files', 'telegram', ?, ?, ?, 1)
       ON CONFLICT(profile) DO UPDATE SET chat_id = excluded.chat_id, connected_by = excluded.connected_by,
         connected_at = excluded.connected_at, enabled = 1`
    ).bind(matchedChatId, user.id, timestamp),
    env.DB.prepare(
      `UPDATE storage_connections SET chat_id = ?, status = 'ACTIVE', updated_at = ?, last_error = NULL
        WHERE id = ? AND organization_id = ?`
    ).bind(matchedChatId, timestamp, LEGACY_STORAGE_CONNECTION_ID, user.organizationId),
    env.DB.prepare('DELETE FROM app_settings WHERE key = ?').bind(key)
  ])
  return json({ ok: true, provider: 'telegram', profile: 'files-primary', connectedAt: timestamp })
}

async function route(request: Request, env: RuntimeEnv): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (request.method === 'GET' && path === '/') return json({ service: 'ExcelSync Worker', status: 'ok', client: 'Windows desktop' })
  if (request.method === 'GET' && path === '/health') return handleHealth(env)
  if (request.method === 'GET' && path === '/client/version') return handleClientVersion(request, env)
  if (request.method === 'POST' && path === '/auth/bootstrap') return handleBootstrap(request, env)
  if (request.method === 'POST' && path === '/auth/login') return handleLogin(request, env)
  if (request.method === 'POST' && path === '/auth/activate') {
    const activated = await activateInvite(request, env)
    return sessionResponse(env, activated.user, activated.device)
  }

  const auth = await requireAuth(request, env)
  const user = auth.user

  if (request.method === 'POST' && path === '/auth/logout') return handleLogout(env, auth)
  if (request.method === 'GET' && path === '/auth/me') return handleAuthMe(env, user)
  if (request.method === 'GET' && path === '/auth/devices') return handleMyDevices(env, auth)
  if (request.method === 'POST' && path === '/auth/logout-other-devices') return handleLogoutOtherDevices(env, auth)
  if (request.method === 'POST' && path === '/auth/logout-all-devices') return handleLogoutAllDevices(env, auth)
  if (request.method === 'GET' && path === '/files/list') return handleFilesList(request, env, user)
  if (request.method === 'GET' && path === '/files/trash') return handleTrashList(env, user)
  if (request.method === 'GET' && path === '/activity') return handleUnifiedActivity(env, user)
  if (request.method === 'GET' && path === '/search/files') return handleAdvancedSearch(request, env, user)
  if (request.method === 'GET' && path === '/notifications') return handleNotifications(request, env, user)
  if (request.method === 'POST' && path === '/notifications/read-all') return handleNotificationReadAll(env, user)
  if (request.method === 'POST' && path === '/rewind/preview') return handleRewindPreview(request, env, user)
  if (request.method === 'POST' && path === '/rewind/execute') return handleRewindExecute(request, env, user)
  if (request.method === 'GET' && path === '/rewind/history') {
    const workspaceId = url.searchParams.get('workspaceId')
    if (!workspaceId || !z.string().uuid().safeParse(workspaceId).success) throw new HttpError(400, 'WORKSPACE_ID_REQUIRED')
    return handleRewindHistory(env, user, workspaceId)
  }
  if (request.method === 'GET' && path === '/settings') return handleGetSettings(env, user)
  if (request.method === 'PUT' && path === '/settings') return handlePutSettings(request, env, user)
  if (request.method === 'POST' && path === '/sync/preflight') return handlePreflight(request, env, auth)
  if (request.method === 'POST' && path === '/sync/upload') return handleUpload(request, env, auth)
  if (request.method === 'POST' && path === '/sync/upload-receipt') return handleUploadReceipt(request, env, auth)
  if (request.method === 'POST' && path === '/sync/commit') return handleCommit(request, env, auth)
  if (request.method === 'GET' && path === '/tasks') return handleTasksList(request, env, user)
  if (request.method === 'GET' && path === '/tasks/mine') return handleMyTasks(env, user)
  if (request.method === 'POST' && path === '/tasks') return handleTaskCreate(request, env, user)
  if (request.method === 'POST' && path === '/tasks/migrate-local') return handleTaskMigration(request, env, user)
  if (request.method === 'GET' && path === '/workspaces') return handleWorkspacesList(env, user)
  if (request.method === 'POST' && path === '/workspaces') return handleWorkspaceCreate(request, env, user)

  if (request.method === 'GET' && path === '/admin/users') return handleUsersList(env, user)
  if (request.method === 'GET' && path === '/admin/groups') return handleGroups(env, user)
  if (request.method === 'POST' && path === '/admin/groups') return handleGroupCreate(request, env, user)
  if (request.method === 'GET' && path === '/admin/invites') return handleInviteList(env, user)
  if (request.method === 'POST' && path === '/admin/invites') return handleInviteCreate(request, env, user)
  if (request.method === 'GET' && path === '/admin/storage-connections') return handleStorageList(env, user)
  if (request.method === 'POST' && path === '/admin/storage-connections') return handleStorageCreate(request, env, user)
  if (request.method === 'POST' && path === '/admin/storage-health') return handleStorageHealth(env, user)
  if (request.method === 'GET' && path === '/admin/audit-logs') return handleAuditLogs(env, user)
  if (request.method === 'GET' && path === '/admin/system-status') return handleSystemStatus(env, user)
  if (request.method === 'GET' && path === '/admin/version-integrity') return handleVersionIntegrityAudit(env, user)
  if (request.method === 'POST' && path === '/admin/version-integrity/repair') return handleVersionIntegrityRepair(request, env, user)
  if (request.method === 'GET' && path === '/admin/active-locks') return handleAdminActiveLocks(env, user)

  if (request.method === 'GET' && path === '/storage/status') return handleStorageStatus(env, user)
  if (request.method === 'POST' && path === '/storage/import/pull') return handleTelegramImportPull(env, user)
  if (request.method === 'POST' && path === '/storage/pair/start') {
    if (!isSystemAdmin(user)) throw new HttpError(403, 'FORBIDDEN')
    return handlePairStart(env, user)
  }
  if (request.method === 'POST' && path === '/storage/pair/confirm') {
    if (!isSystemAdmin(user)) throw new HttpError(403, 'FORBIDDEN')
    return handlePairConfirm(env, user)
  }

  const userStatusMatch = path.match(/^\/admin\/users\/([0-9a-f-]{36})\/status$/i)
  if (request.method === 'PATCH' && userStatusMatch?.[1]) return handleUserLifecycle(request, env, user, userStatusMatch[1])
  const userLogoutMatch = path.match(/^\/admin\/users\/([0-9a-f-]{36})\/force-logout$/i)
  if (request.method === 'POST' && userLogoutMatch?.[1]) return handleUserForceLogout(env, user, userLogoutMatch[1])
  const userRoleMatch = path.match(/^\/admin\/users\/([0-9a-f-]{36})\/role$/i)
  if (request.method === 'PATCH' && userRoleMatch?.[1]) return handleUserRole(request, env, user, userRoleMatch[1])
  const userAccountPolicyMatch = path.match(/^\/admin\/users\/([0-9a-f-]{36})\/account-policy$/i)
  if (request.method === 'PATCH' && userAccountPolicyMatch?.[1]) return handleUserAccountPolicy(request, env, user, userAccountPolicyMatch[1])
  const adminUserDevicesMatch = path.match(/^\/admin\/users\/([0-9a-f-]{36})\/devices$/i)
  if (request.method === 'GET' && adminUserDevicesMatch?.[1]) return handleAdminUserDevices(env, user, adminUserDevicesMatch[1])
  const deviceLogoutMatch = path.match(/^\/auth\/devices\/([0-9a-f-]{36})\/logout$/i)
  if (request.method === 'POST' && deviceLogoutMatch?.[1]) return handleLogoutDevice(env, auth, deviceLogoutMatch[1])
  const groupArchiveMatch = path.match(/^\/admin\/groups\/([0-9a-f-]{36})\/archive$/i)
  if (request.method === 'POST' && groupArchiveMatch?.[1]) return handleGroupArchive(env, user, groupArchiveMatch[1])
  const groupMembersMatch = path.match(/^\/admin\/groups\/([0-9a-f-]{36})\/members$/i)
  if (request.method === 'GET' && groupMembersMatch?.[1]) return handleGroupMembers(env, user, groupMembersMatch[1])
  if (request.method === 'PUT' && groupMembersMatch?.[1]) return handleGroupMembersReplace(request, env, user, groupMembersMatch[1])
  const groupAccessMatch = path.match(/^\/workspaces\/([0-9a-f-]{36})\/group-access\/([0-9a-f-]{36})$/i)
  if (groupAccessMatch?.[1] && groupAccessMatch[2]) {
    if (request.method === 'GET') return handleGroupResourceAccessGet(env, user, groupAccessMatch[1], groupAccessMatch[2])
    if (request.method === 'PUT') return handleGroupResourceAccessReplace(request, env, user, groupAccessMatch[1], groupAccessMatch[2])
  }
  const inviteRevokeMatch = path.match(/^\/admin\/invites\/([0-9a-f-]{36})\/revoke$/i)
  if (request.method === 'POST' && inviteRevokeMatch?.[1]) return handleInviteRevoke(env, user, inviteRevokeMatch[1])
  const inviteRegenerateMatch = path.match(/^\/admin\/invites\/([0-9a-f-]{36})\/regenerate$/i)
  if (request.method === 'POST' && inviteRegenerateMatch?.[1]) return handleInviteRegenerate(env, user, inviteRegenerateMatch[1])

  const workspaceArchiveMatch = path.match(/^\/workspaces\/([0-9a-f-]{36})\/archive$/i)
  if (request.method === 'POST' && workspaceArchiveMatch?.[1]) return handleWorkspaceArchive(env, user, workspaceArchiveMatch[1])
  const workspaceMembersMatch = path.match(/^\/workspaces\/([0-9a-f-]{36})\/members$/i)
  if (request.method === 'GET' && workspaceMembersMatch?.[1]) return handleWorkspaceMembers(env, user, workspaceMembersMatch[1])
  if (request.method === 'PUT' && workspaceMembersMatch?.[1]) return handleWorkspaceMemberPut(request, env, user, workspaceMembersMatch[1])
  const workspaceMemberDeleteMatch = path.match(/^\/workspaces\/([0-9a-f-]{36})\/members\/([0-9a-f-]{36})$/i)
  if (request.method === 'DELETE' && workspaceMemberDeleteMatch?.[1] && workspaceMemberDeleteMatch[2]) {
    return handleWorkspaceMemberDelete(env, user, workspaceMemberDeleteMatch[1], workspaceMemberDeleteMatch[2])
  }
  const resourceAccessMatch = path.match(/^\/workspaces\/([0-9a-f-]{36})\/resource-access\/([0-9a-f-]{36})$/i)
  if (resourceAccessMatch?.[1] && resourceAccessMatch[2]) {
    if (request.method === 'GET') return handleResourceAccessGet(env, user, resourceAccessMatch[1], resourceAccessMatch[2])
    if (request.method === 'PUT') return handleResourceAccessReplace(request, env, user, resourceAccessMatch[1], resourceAccessMatch[2])
  }
  const defaultWorkspaceMatch = path.match(/^\/workspaces\/([0-9a-f-]{36})\/set-default$/i)
  if (request.method === 'POST' && defaultWorkspaceMatch?.[1]) return handleDefaultWorkspace(request, env, user, defaultWorkspaceMatch[1])
  const workspaceStorageMatch = path.match(/^\/workspaces\/([0-9a-f-]{36})\/default-storage$/i)
  if (request.method === 'PUT' && workspaceStorageMatch?.[1]) return handleWorkspaceStorage(request, env, user, workspaceStorageMatch[1])

  const taskMatch = path.match(/^\/tasks\/([0-9a-f-]{36})$/i)
  if (request.method === 'PATCH' && taskMatch?.[1]) return handleTaskUpdate(request, env, user, taskMatch[1])
  if (request.method === 'DELETE' && taskMatch?.[1]) return handleTaskDelete(env, user, taskMatch[1])
  const notificationReadMatch = path.match(/^\/notifications\/([0-9a-f-]{36})\/read$/i)
  if (request.method === 'POST' && notificationReadMatch?.[1]) return handleNotificationRead(env, user, notificationReadMatch[1])
  const rewindRetryMatch = path.match(/^\/rewind\/([0-9a-f-]{36})\/retry$/i)
  if (request.method === 'POST' && rewindRetryMatch?.[1]) return handleRewindRetry(env, user, rewindRetryMatch[1])
  const commentResolveMatch = path.match(/^\/comments\/([0-9a-f-]{36})\/(resolve|reopen)$/i)
  if (request.method === 'POST' && commentResolveMatch?.[1] && commentResolveMatch[2]) {
    return handleCommentResolve(env, user, commentResolveMatch[1], commentResolveMatch[2].toLowerCase() === 'reopen')
  }

  const storageTokenMatch = path.match(/^\/admin\/storage-connections\/([0-9a-f-]{36})\/token$/i)
  if (request.method === 'PUT' && storageTokenMatch?.[1]) return handleStorageRotateToken(request, env, user, storageTokenMatch[1])
  const storagePairStartMatch = path.match(/^\/admin\/storage-connections\/([0-9a-f-]{36})\/pair\/start$/i)
  if (request.method === 'POST' && storagePairStartMatch?.[1]) return handleStoragePairStart(env, user, storagePairStartMatch[1])
  const storagePairConfirmMatch = path.match(/^\/admin\/storage-connections\/([0-9a-f-]{36})\/pair\/confirm$/i)
  if (request.method === 'POST' && storagePairConfirmMatch?.[1]) return handleStoragePairConfirm(env, user, storagePairConfirmMatch[1])
  const storageDisableMatch = path.match(/^\/admin\/storage-connections\/([0-9a-f-]{36})\/disable$/i)
  if (request.method === 'POST' && storageDisableMatch?.[1]) return handleStorageDisable(env, user, storageDisableMatch[1])

  const presenceMatch = path.match(/^\/files\/([0-9a-f-]{36})\/presence$/i)
  if (presenceMatch?.[1]) {
    if (request.method === 'GET') return handlePresenceGet(env, auth, presenceMatch[1])
    if (request.method === 'PUT') return handlePresenceUpsert(request, env, auth, presenceMatch[1])
    if (request.method === 'DELETE') return handlePresenceClear(env, auth, presenceMatch[1])
  }
  const leaseMatch = path.match(/^\/files\/([0-9a-f-]{36})\/lease$/i)
  if (leaseMatch?.[1]) {
    if (request.method === 'GET') return handleFileLeaseGet(env, auth, leaseMatch[1])
    if (request.method === 'POST') return handleFileLeaseAcquire(request, env, auth, leaseMatch[1])
    if (request.method === 'PUT') return handleFileLeaseHeartbeat(request, env, auth, leaseMatch[1])
    if (request.method === 'DELETE') return handleFileLeaseRelease(request, env, auth, leaseMatch[1])
  }
  const leaseTakeoverRequestMatch = path.match(/^\/files\/([0-9a-f-]{36})\/lease\/request-takeover$/i)
  if (request.method === 'POST' && leaseTakeoverRequestMatch?.[1]) return handleFileLeaseTakeoverRequest(env, auth, leaseTakeoverRequestMatch[1])
  const leaseForceTakeoverMatch = path.match(/^\/files\/([0-9a-f-]{36})\/lease\/force-takeover$/i)
  if (request.method === 'POST' && leaseForceTakeoverMatch?.[1]) return handleFileLeaseForceTakeover(env, auth, leaseForceTakeoverMatch[1])
  const commentsMatch = path.match(/^\/files\/([0-9a-f-]{36})\/comments$/i)
  if (commentsMatch?.[1]) {
    if (request.method === 'GET') return handleCommentsList(env, user, commentsMatch[1])
    if (request.method === 'POST') return handleCommentCreate(request, env, user, commentsMatch[1])
  }

  const versionsMatch = path.match(/^\/versions\/([0-9a-f-]{36})$/i)
  if (request.method === 'GET' && versionsMatch?.[1]) return handleVersions(env, user, versionsMatch[1])

  const restoreMatch = path.match(/^\/versions\/([0-9a-f-]{36})\/restore$/i)
  if (request.method === 'POST' && restoreMatch?.[1]) {
    await assertFileLeaseCompatible(env, auth, restoreMatch[1])
    return handleRestore(request, env, user, restoreMatch[1])
  }

  const versionDownloadMatch = path.match(/^\/files\/([0-9a-f-]{36})\/versions\/(\d+)\/download$/i)
  if (request.method === 'GET' && versionDownloadMatch?.[1] && versionDownloadMatch[2]) {
    const version = Number(versionDownloadMatch[2])
    if (!Number.isInteger(version) || version <= 0) throw new HttpError(400, 'INVALID_VERSION')
    return handleVersionDownload(env, user, versionDownloadMatch[1], version)
  }

  const downloadMatch = path.match(/^\/files\/([0-9a-f-]{36})\/download$/i)
  if (request.method === 'GET' && downloadMatch?.[1]) return handleDownload(env, user, downloadMatch[1])

  const renameMatch = path.match(/^\/files\/([0-9a-f-]{36})\/rename$/i)
  if (request.method === 'POST' && renameMatch?.[1]) {
    await assertFileLeaseCompatible(env, auth, renameMatch[1])
    return handleRename(request, env, user, renameMatch[1])
  }

  const trashMatch = path.match(/^\/files\/([0-9a-f-]{36})\/trash$/i)
  if (request.method === 'POST' && trashMatch?.[1]) {
    await assertFileLeaseCompatible(env, auth, trashMatch[1])
    return handleTrash(request, env, user, trashMatch[1])
  }

  const restoreTrashMatch = path.match(/^\/files\/([0-9a-f-]{36})\/restore-from-trash$/i)
  if (request.method === 'POST' && restoreTrashMatch?.[1]) return handleRestoreFromTrash(env, user, restoreTrashMatch[1])

  const permanentDeleteMatch = path.match(/^\/files\/([0-9a-f-]{36})\/permanent-delete$/i)
  if (request.method === 'POST' && permanentDeleteMatch?.[1]) return handlePermanentDelete(env, user, permanentDeleteMatch[1])

  const deleteMatch = path.match(/^\/files\/([0-9a-f-]{36})\/delete$/i)
  if (request.method === 'POST' && deleteMatch?.[1]) return handleDelete(request, env, user, deleteMatch[1])

  throw new HttpError(404, 'NOT_FOUND')
}

export async function appFetch(request: Request, env: RuntimeEnv): Promise<Response> {
  try {
    return await route(request, env)
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: { code: error.code, message: error.message, detail: error.detail } }, error.status)
    }
    const message = error instanceof Error ? error.message : 'INTERNAL_ERROR'
    const safeMessage = message.startsWith('TELEGRAM_') ? message : 'INTERNAL_ERROR'
    console.error(JSON.stringify({ level: 'error', code: safeMessage, path: new URL(request.url).pathname }))
    return json({ error: { code: safeMessage, message: safeMessage } }, 500)
  }
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    return appFetch(request, env)
  }
} satisfies ExportedHandler<RuntimeEnv>
