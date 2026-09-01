export type SystemRole = 'OWNER' | 'ADMIN' | 'MEMBER'
export type UserLifecycleStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED'
export type AccountType = 'INTERNAL' | 'EXTERNAL'
export type WorkspaceRole = 'MANAGER' | 'EDITOR' | 'VIEWER'
export type ResourcePermission = 'MANAGE' | 'EDIT' | 'VIEW'
export type ResourceScopeType = 'WORKSPACE' | 'STORAGE' | 'FOLDER' | 'FILE'

export interface AuthUser {
  id: string
  username: string
  displayName: string
  organizationId: string
  systemRole: SystemRole
  status: UserLifecycleStatus
  accountType?: AccountType
  accessExpiresAt?: string | null
}

export interface MembershipView {
  workspaceId: string
  workspaceName: string
  workspaceType: string
  role: WorkspaceRole
  status: string
  defaultStorageConnectionId: string | null
}

export interface FileAccessView {
  workspaceId: string
  workspaceRole: WorkspaceRole
  resourcePermission: ResourcePermission
}

const WORKSPACE_RANK: Record<WorkspaceRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  MANAGER: 3
}

const RESOURCE_RANK: Record<ResourcePermission, number> = {
  VIEW: 1,
  EDIT: 2,
  MANAGE: 3
}

export function isSystemAdmin(user: AuthUser): boolean {
  return user.accountType !== 'EXTERNAL' && (user.systemRole === 'OWNER' || user.systemRole === 'ADMIN')
}

export function isOwner(user: AuthUser): boolean {
  return user.systemRole === 'OWNER'
}

export function workspaceRoleAtLeast(actual: WorkspaceRole | null | undefined, required: WorkspaceRole): boolean {
  return Boolean(actual && WORKSPACE_RANK[actual] >= WORKSPACE_RANK[required])
}

export function resourcePermissionAtLeast(actual: ResourcePermission | null | undefined, required: WorkspaceRole): boolean {
  return Boolean(actual && RESOURCE_RANK[actual] >= WORKSPACE_RANK[required])
}

export function permissionForWorkspaceRole(role: WorkspaceRole): ResourcePermission {
  return role === 'MANAGER' ? 'MANAGE' : role === 'EDITOR' ? 'EDIT' : 'VIEW'
}

export async function getMembership(env: Env, userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
  const row = await env.DB.prepare(
    `SELECT wm.role
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ? AND wm.workspace_id = ? AND w.status = 'ACTIVE'
      LIMIT 1`
  ).bind(userId, workspaceId).first<{ role: WorkspaceRole }>()
  return row?.role ?? null
}

export async function getEffectiveWorkspaceRole(env: Env, user: AuthUser, workspaceId: string): Promise<WorkspaceRole | null> {
  if (isSystemAdmin(user)) {
    const row = await env.DB.prepare(
      `SELECT id FROM workspaces WHERE id = ? AND organization_id = ? AND status = 'ACTIVE' LIMIT 1`
    ).bind(workspaceId, user.organizationId).first<{ id: string }>()
    return row ? 'MANAGER' : null
  }
  return getMembership(env, user.id, workspaceId)
}

export async function getMemberships(env: Env, user: AuthUser): Promise<MembershipView[]> {
  const admin = isSystemAdmin(user)
  const result = await env.DB.prepare(
    admin
      ? `SELECT w.id AS workspace_id, w.name AS workspace_name, w.type AS workspace_type, w.status,
                w.default_storage_connection_id, 'MANAGER' AS role
           FROM workspaces w
          WHERE w.organization_id = ?
          ORDER BY CASE w.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, w.name COLLATE NOCASE`
      : `SELECT w.id AS workspace_id, w.name AS workspace_name, w.type AS workspace_type, w.status,
                w.default_storage_connection_id, wm.role
           FROM workspace_members wm
           JOIN workspaces w ON w.id = wm.workspace_id
          WHERE wm.user_id = ? AND w.organization_id = ?
          ORDER BY CASE w.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, w.name COLLATE NOCASE`
  ).bind(...(admin ? [user.organizationId] : [user.id, user.organizationId])).all<Record<string, unknown>>()
  return result.results.map((row) => ({
    workspaceId: String(row.workspace_id),
    workspaceName: String(row.workspace_name),
    workspaceType: String(row.workspace_type),
    role: String(row.role) as WorkspaceRole,
    status: String(row.status),
    defaultStorageConnectionId: row.default_storage_connection_id == null ? null : String(row.default_storage_connection_id)
  }))
}

export async function getDefaultWorkspaceId(env: Env, user: AuthUser): Promise<string | null> {
  const preferred = await env.DB.prepare(
    isSystemAdmin(user)
      ? `SELECT p.default_workspace_id AS id
           FROM user_preferences p
           JOIN workspaces w ON w.id = p.default_workspace_id
          WHERE p.user_id = ? AND w.organization_id = ? AND w.status = 'ACTIVE' LIMIT 1`
      : `SELECT p.default_workspace_id AS id
           FROM user_preferences p
           JOIN workspace_members wm ON wm.workspace_id = p.default_workspace_id AND wm.user_id = p.user_id
           JOIN workspaces w ON w.id = p.default_workspace_id
          WHERE p.user_id = ? AND w.status = 'ACTIVE' LIMIT 1`
  ).bind(...(isSystemAdmin(user) ? [user.id, user.organizationId] : [user.id])).first<{ id: string | null }>()
  if (preferred?.id) return preferred.id

  const fallback = await env.DB.prepare(
    isSystemAdmin(user)
      ? `SELECT w.id FROM workspaces w
          WHERE w.organization_id = ? AND w.status = 'ACTIVE'
          ORDER BY w.created_at ASC LIMIT 1`
      : `SELECT wm.workspace_id AS id
           FROM workspace_members wm
           JOIN workspaces w ON w.id = wm.workspace_id
          WHERE wm.user_id = ? AND w.status = 'ACTIVE'
          ORDER BY CASE wm.role WHEN 'MANAGER' THEN 0 WHEN 'EDITOR' THEN 1 ELSE 2 END, w.created_at ASC
          LIMIT 1`
  ).bind(...(isSystemAdmin(user) ? [user.organizationId] : [user.id])).first<{ id: string }>()
  return fallback?.id ?? null
}

export async function setDefaultWorkspace(env: Env, userId: string, workspaceId: string): Promise<void> {
  const timestamp = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO user_preferences(user_id, default_workspace_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET default_workspace_id = excluded.default_workspace_id, updated_at = excluded.updated_at`
  ).bind(userId, workspaceId, timestamp).run()
}

function bestPermission(values: Array<{ permission: ResourcePermission }>): ResourcePermission | null {
  let best: ResourcePermission | null = null
  for (const row of values) {
    if (!best || RESOURCE_RANK[row.permission] > RESOURCE_RANK[best]) best = row.permission
  }
  return best
}

export async function resolveFileAccess(
  env: Env,
  user: AuthUser,
  fileId: string,
  requiredRole: WorkspaceRole = 'VIEWER'
): Promise<FileAccessView | null> {
  const file = await env.DB.prepare(
    `SELECT f.id, f.workspace_id, f.relative_path, f.home_storage_connection_id, w.organization_id, w.status AS workspace_status
       FROM files f JOIN workspaces w ON w.id = f.workspace_id
      WHERE f.id = ? AND w.organization_id = ? LIMIT 1`
  ).bind(fileId, user.organizationId).first<{
    id: string
    workspace_id: string
    relative_path: string
    home_storage_connection_id: string | null
    organization_id: string
    workspace_status: string
  }>()
  if (!file || file.workspace_status !== 'ACTIVE') return null

  if (isSystemAdmin(user)) {
    return { workspaceId: file.workspace_id, workspaceRole: 'MANAGER', resourcePermission: 'MANAGE' }
  }

  const role = await getMembership(env, user.id, file.workspace_id)
  if (!workspaceRoleAtLeast(role, requiredRole)) return null
  const rules = await env.DB.prepare(
    `SELECT permission
       FROM resource_access_rules
      WHERE organization_id = ? AND workspace_id = ?
        AND (
          (principal_type = 'USER' AND principal_id = ?)
          OR (principal_type = 'GROUP' AND principal_id IN (
            SELECT gm.group_id
              FROM group_members gm
              JOIN groups g ON g.id = gm.group_id AND g.status = 'ACTIVE'
             WHERE gm.user_id = ? AND g.organization_id = ?
          ))
        )
        AND (
          (scope_type = 'WORKSPACE' AND scope_value = ?)
          OR (scope_type = 'STORAGE' AND scope_value = COALESCE(?, ''))
          OR (scope_type = 'FILE' AND scope_value = ?)
          OR (scope_type = 'FOLDER' AND (? = scope_value OR ? LIKE scope_value || '/%'))
        )`
  ).bind(
    user.organizationId,
    file.workspace_id,
    user.id,
    user.id,
    user.organizationId,
    file.workspace_id,
    file.home_storage_connection_id,
    file.id,
    file.relative_path,
    file.relative_path
  ).all<{ permission: ResourcePermission }>()
  const permission = bestPermission(rules.results)
  if (!resourcePermissionAtLeast(permission, requiredRole)) return null
  return { workspaceId: file.workspace_id, workspaceRole: role!, resourcePermission: permission! }
}

export async function canCreateResourceAtPath(
  env: Env,
  user: AuthUser,
  workspaceId: string,
  relativePath: string,
  homeStorageConnectionId: string | null,
  requiredRole: WorkspaceRole = 'EDITOR',
  existingFileId: string | null = null
): Promise<boolean> {
  const role = await getEffectiveWorkspaceRole(env, user, workspaceId)
  if (!workspaceRoleAtLeast(role, requiredRole)) return false
  if (isSystemAdmin(user)) return true
  const rules = await env.DB.prepare(
    `SELECT permission
       FROM resource_access_rules
      WHERE organization_id = ? AND workspace_id = ?
        AND (
          (principal_type = 'USER' AND principal_id = ?)
          OR (principal_type = 'GROUP' AND principal_id IN (
            SELECT gm.group_id
              FROM group_members gm
              JOIN groups g ON g.id = gm.group_id AND g.status = 'ACTIVE'
             WHERE gm.user_id = ? AND g.organization_id = ?
          ))
        )
        AND (
          (scope_type = 'WORKSPACE' AND scope_value = ?)
          OR (scope_type = 'STORAGE' AND scope_value = COALESCE(?, ''))
          OR (scope_type = 'FILE' AND scope_value = COALESCE(?, ''))
          OR (scope_type = 'FOLDER' AND (? = scope_value OR ? LIKE scope_value || '/%'))
        )`
  ).bind(user.organizationId, workspaceId, user.id, user.id, user.organizationId, workspaceId, homeStorageConnectionId, existingFileId, relativePath, relativePath)
    .all<{ permission: ResourcePermission }>()
  return resourcePermissionAtLeast(bestPermission(rules.results), requiredRole)
}

export async function fileWorkspaceRole(
  env: Env,
  userId: string,
  fileId: string
): Promise<{ workspaceId: string; role: WorkspaceRole } | null> {
  const row = await env.DB.prepare(
    `SELECT f.workspace_id AS workspace_id, wm.role
       FROM files f
       JOIN workspace_members wm ON wm.workspace_id = f.workspace_id AND wm.user_id = ?
       JOIN workspaces w ON w.id = f.workspace_id AND w.status = 'ACTIVE'
      WHERE f.id = ? LIMIT 1`
  ).bind(userId, fileId).first<{ workspace_id: string; role: WorkspaceRole }>()
  return row ? { workspaceId: row.workspace_id, role: row.role } : null
}

export async function recordAudit(
  env: Env,
  user: Pick<AuthUser, 'id' | 'organizationId'>,
  action: string,
  targetType: string,
  targetId: string | null,
  detail?: Record<string, unknown>
): Promise<void> {
  const safeDetail = detail ? JSON.stringify(detail).slice(0, 4000) : null
  await env.DB.prepare(
    `INSERT INTO audit_logs(id, organization_id, actor_user_id, action, target_type, target_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    user.organizationId,
    user.id,
    action,
    targetType,
    targetId,
    safeDetail,
    new Date().toISOString()
  ).run()
}
