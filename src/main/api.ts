import { readFile } from 'node:fs/promises'
import type {
  ActivityView,
  AdminUserView,
  AdvancedSearchFileView,
  AdvancedSearchInput,
  AuditLogView,
  AuthUserView,
  CloudFileStatus,
  ClientVersionInfo,
  DeviceView,
  FileCommentView,
  FileLeaseView,
  FilePresenceView,
  NotificationListView,
  GroupMemberView,
  GroupResourceAccessView,
  GroupView,
  InviteView,
  PresenceState,
  ResourceAccessView,
  ResourcePermission,
  ResourceScopeType,
  RewindOperationView,
  RewindPreviewView,
  StorageConnectionView,
  SystemStatusView,
  TrashFileView,
  UserTaskView,
  VersionIntegrityView,
  VersionView,
  WorkspaceMemberView,
  WorkspaceMembershipView,
  WorkspaceRole,
  WorkspaceView,
  TelegramUserStorageReceipt
} from '../shared/contracts'
import { mimeForFileName } from '../shared/file-types'
import type { SessionStore } from './session-store'

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
    message = code,
    readonly detail?: unknown
  ) {
    super(message)
  }
}

export type PreflightResult =
  | { action: 'noop'; fileId: string; currentVersion: number; currentHash: string }
  | { action: 'conflict'; fileId: string; currentVersion: number; currentHash: string | null }
  | { action: 'committed'; fileId: string; intentId: string; currentVersion: number; currentHash: string }
  | { action: 'commit_required'; fileId: string; intentId: string }
  | { action: 'upload_required'; fileId: string; intentId: string }

interface ApiEnvelopeError {
  error?: { code?: string; message?: string; detail?: unknown }
}

function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function retryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024

async function readBoundedJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('application/json')) {
    throw new ApiError('INVALID_RESPONSE_CONTENT_TYPE', 502, true)
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_RESPONSE_BYTES) {
    throw new ApiError('RESPONSE_TOO_LARGE', 502, false)
  }
  if (!response.body) throw new ApiError('EMPTY_RESPONSE', 502, true)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_JSON_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new ApiError('RESPONSE_TOO_LARGE', 502, false)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(bytes)
  if (!text.trim()) throw new ApiError('EMPTY_RESPONSE', 502, true)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError('INVALID_RESPONSE_JSON', 502, true)
  }
}

export interface ClientIdentity {
  deviceName: string
  osName: string
  osVersion: string
  clientVersion: string
}

export class WorkerApi {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly getBaseUrl: () => string,
    private readonly fetcher: Fetcher = (input, init) => globalThis.fetch(input, init),
    private readonly getClientIdentity: () => ClientIdentity = () => ({
      deviceName: 'Windows PC',
      osName: process.platform,
      osVersion: process.version,
      clientVersion: '0.0.0'
    }),
    private readonly onAuthInvalidated?: () => void
  ) {}

  private async devicePayload(): Promise<ClientIdentity & { stableDeviceId: string }> {
    return { ...this.getClientIdentity(), stableDeviceId: await this.sessionStore.stableDeviceId() }
  }

  private async request(
    path: string,
    init: RequestInit = {},
    options: { auth?: boolean; setupNonce?: string; timeoutMs?: number } = { auth: true }
  ): Promise<Response> {
    const base = trimBase(this.getBaseUrl())
    if (!base.startsWith('https://') && !base.startsWith('http://127.0.0.1') && !base.startsWith('http://localhost')) {
      throw new ApiError('WORKER_URL_NOT_CONFIGURED', 0, false)
    }
    const headers = new Headers(init.headers)
    const client = this.getClientIdentity()
    headers.set('x-excelsync-client-version', client.clientVersion)
    headers.set('x-excelsync-api-version', '2026-08-31')
    if (options.auth !== false) {
      const session = await this.sessionStore.load()
      if (!session) throw new ApiError('AUTH_REQUIRED', 401, false)
      headers.set('authorization', `Bearer ${session.token}`)
    }
    if (options.setupNonce) headers.set('x-setup-nonce', options.setupNonce)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000)
    try {
      const response = await this.fetcher(`${base}${path}`, { ...init, headers, signal: init.signal ?? controller.signal })
      if (!response.ok) {
        let payload: ApiEnvelopeError = {}
        try {
          payload = (await response.clone().json()) as ApiEnvelopeError
        } catch {
          // Keep status-based error if server did not return JSON.
        }
        const code = payload.error?.code ?? `HTTP_${response.status}`
        if (response.status === 401 && options.auth !== false) {
          await this.sessionStore.clear()
          this.onAuthInvalidated?.()
        }
        throw new ApiError(code, response.status, retryableStatus(response.status), payload.error?.message ?? code, payload.error?.detail)
      }
      return response
    } catch (error) {
      if (error instanceof ApiError) throw error
      const message = error instanceof Error ? error.message : 'Network error'
      throw new ApiError('NETWORK_ERROR', 0, true, message)
    } finally {
      clearTimeout(timeout)
    }
  }

  private async json<T>(
    path: string,
    init: RequestInit = {},
    options: { auth?: boolean; setupNonce?: string; timeoutMs?: number } = { auth: true }
  ): Promise<T> {
    const response = await this.request(path, init, options)
    return readBoundedJson<T>(response)
  }

  async health(): Promise<{
    ok: boolean
    worker: string
    database: string
    setupAvailable: boolean
    telegram: { tokenConfigured: boolean; chatConfigured: boolean; reachable: boolean; detail?: string }
  }> {
    return this.json('/health', { method: 'GET' }, { auth: false })
  }

  async bootstrap(username: string, password: string, setupCode: string): Promise<void> {
    const nonce = setupCode.trim() || (await this.sessionStore.readBootstrapNonce()) || ''
    if (!nonce) throw new ApiError('SETUP_CODE_REQUIRED', 0, false)
    await this.json(
      '/auth/bootstrap',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
      },
      { auth: false, setupNonce: nonce }
    )
    await this.sessionStore.deleteBootstrapNonce()
    await this.login(username, password)
  }

  async login(username: string, password: string): Promise<void> {
    const device = await this.devicePayload()
    const result = await this.json<{
      token: string
      expiresAt: string
      deviceId: string | null
      user: AuthUserView
      memberships: WorkspaceMembershipView[]
      defaultWorkspaceId: string | null
    }>(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, device })
      },
      { auth: false }
    )
    await this.sessionStore.save({
      token: result.token,
      expiresAt: result.expiresAt,
      username: result.user.username,
      deviceId: result.deviceId,
      auth: { user: result.user, memberships: result.memberships, defaultWorkspaceId: result.defaultWorkspaceId }
    })
  }

  async activateInvite(code: string, password: string): Promise<void> {
    const device = await this.devicePayload()
    const result = await this.json<{
      token: string
      expiresAt: string
      deviceId: string | null
      user: AuthUserView
      memberships: WorkspaceMembershipView[]
      defaultWorkspaceId: string | null
    }>(
      '/auth/activate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, password, device })
      },
      { auth: false }
    )
    await this.sessionStore.save({
      token: result.token,
      expiresAt: result.expiresAt,
      username: result.user.username,
      deviceId: result.deviceId,
      auth: { user: result.user, memberships: result.memberships, defaultWorkspaceId: result.defaultWorkspaceId }
    })
  }

  async me(): Promise<{ user: AuthUserView; memberships: WorkspaceMembershipView[]; defaultWorkspaceId: string | null }> {
    const auth = await this.json<{ user: AuthUserView; memberships: WorkspaceMembershipView[]; defaultWorkspaceId: string | null }>('/auth/me')
    const stored = await this.sessionStore.load()
    if (stored) await this.sessionStore.save({ ...stored, username: auth.user.username, auth })
    return auth
  }

  async logout(): Promise<void> {
    try {
      await this.json('/auth/logout', { method: 'POST' })
    } finally {
      await this.sessionStore.clear()
      this.onAuthInvalidated?.()
    }
  }

  async devices(): Promise<DeviceView[]> {
    const result = await this.json<{ devices: DeviceView[] }>('/auth/devices')
    return result.devices
  }

  async logoutDevice(deviceId: string): Promise<void> {
    const result = await this.json<{ current: boolean }>(`/auth/devices/${encodeURIComponent(deviceId)}/logout`, { method: 'POST' })
    if (result.current) {
      await this.sessionStore.clear()
      this.onAuthInvalidated?.()
    }
  }

  async logoutOtherDevices(): Promise<number> {
    const result = await this.json<{ invalidated: number }>('/auth/logout-other-devices', { method: 'POST' })
    return result.invalidated
  }

  async logoutAllDevices(): Promise<number> {
    const result = await this.json<{ invalidated: number }>('/auth/logout-all-devices', { method: 'POST' })
    await this.sessionStore.clear()
    this.onAuthInvalidated?.()
    return result.invalidated
  }

  async preflight(input: {
    fileId?: string
    logicalName: string
    relativePath: string
    hash: string
    size: number
    baseVersion: number
    idempotencyKey: string
    storageBackend?: 'telegram_user_group' | 'telegram_bot'
    restoredFromVersion?: number | null
  }): Promise<PreflightResult> {
    try {
      return await this.json<PreflightResult>('/sync/preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input)
      })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === 'BASE_VERSION_CONFLICT') {
        const detail = (error.detail ?? {}) as { currentVersion?: number; currentHash?: string | null }
        return {
          action: 'conflict',
          fileId: input.fileId ?? '',
          currentVersion: detail.currentVersion ?? input.baseVersion + 1,
          currentHash: detail.currentHash ?? null
        }
      }
      throw error
    }
  }

  async upload(intentId: string, localPath: string): Promise<void> {
    const bytes = await readFile(localPath)
    const form = new FormData()
    form.set('intentId', intentId)
    const fileName = localPath.split(/[\\/]/).pop() ?? 'file.bin'
    form.set('file', new File([bytes], fileName, { type: mimeForFileName(fileName) }))
    await this.json('/sync/upload', { method: 'POST', body: form }, { auth: true, timeoutMs: 180_000 })
  }

  async recordUploadReceipt(intentId: string, receipt: TelegramUserStorageReceipt): Promise<void> {
    await this.json('/sync/upload-receipt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intentId, receipt })
    })
  }

  async commit(intentId: string): Promise<{ fileId: string; version: number; hash: string }> {
    return this.json('/sync/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intentId })
    })
  }

  async renameFile(fileId: string, logicalName: string, relativePath: string, baseVersion: number): Promise<void> {
    await this.json(`/files/${encodeURIComponent(fileId)}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logicalName, relativePath, baseVersion })
    })
  }

  /** Legacy compatibility only. The Worker deliberately ignores this local-delete endpoint. */
  async trashFile(fileId: string, baseVersion: number): Promise<void> {
    await this.json(`/files/${encodeURIComponent(fileId)}/trash`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseVersion })
    })
  }

  async permanentlyDelete(fileId: string): Promise<void> {
    await this.json(`/files/${encodeURIComponent(fileId)}/permanent-delete`, { method: 'POST' })
  }

  async restoreTrash(fileId: string): Promise<{
    id: string
    logical_name: string
    relative_path: string
    current_version: number
    current_hash: string | null
    size: number
    status: 'active'
  }> {
    return this.json(`/files/${encodeURIComponent(fileId)}/restore-from-trash`, { method: 'POST' })
  }

  async trashList(): Promise<TrashFileView[]> {
    const result = await this.json<{ files: Array<{
      id: string
      logical_name: string
      relative_path: string
      current_version: number
      current_hash: string | null
      status: 'trashed' | 'deleted'
      size: number
      trashed_at: string
      updated_at: string
    }> }>('/files/trash')
    return result.files.map((file) => ({
      id: file.id,
      logicalName: file.logical_name,
      relativePath: file.relative_path,
      currentVersion: file.current_version,
      currentHash: file.current_hash,
      status: file.status,
      size: Number(file.size ?? 0),
      trashedAt: file.trashed_at,
      updatedAt: file.updated_at
    }))
  }

  async downloadCurrent(fileId: string): Promise<{ bytes: Uint8Array; version: number; hash: string | null }> {
    const response = await this.request(`/files/${encodeURIComponent(fileId)}/download`, { method: 'GET' }, { auth: true, timeoutMs: 180_000 })
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      version: Number(response.headers.get('x-excelsync-version') ?? 0),
      hash: response.headers.get('x-excelsync-hash') || null
    }
  }

  async downloadVersion(fileId: string, version: number): Promise<{ bytes: Uint8Array; version: number; hash: string | null }> {
    const response = await this.request(
      `/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(String(version))}/download`,
      { method: 'GET' },
      { auth: true, timeoutMs: 180_000 }
    )
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      version: Number(response.headers.get('x-excelsync-version') ?? version),
      hash: response.headers.get('x-excelsync-hash') || null
    }
  }

  async versions(fileId: string): Promise<VersionView[]> {
    const result = await this.json<{ versions: VersionView[] }>(`/versions/${encodeURIComponent(fileId)}`)
    return result.versions
  }

  async restore(fileId: string, version: number, baseVersion: number): Promise<{ version: number; hash: string }> {
    return this.json(`/versions/${encodeURIComponent(fileId)}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version, baseVersion })
    })
  }

  async updateCloudSettings(retentionLimit: number): Promise<{ retentionLimit: number }> {
    return this.json('/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retentionLimit })
    })
  }

  async filesList(): Promise<Array<{
    id: string
    logical_name: string
    relative_path: string
    current_version: number
    current_hash: string | null
    current_storage_backend: 'telegram_user_group' | 'telegram_bot' | null
    current_storage_locator: string | null
    updated_at: string
    status: CloudFileStatus
  }>> {
    const result = await this.json<{ files: Array<{
      id: string
      logical_name: string
      relative_path: string
      current_version: number
      current_hash: string | null
      current_storage_backend: 'telegram_user_group' | 'telegram_bot' | null
      current_storage_locator: string | null
      updated_at: string
      status: CloudFileStatus
    }> }>('/files/list?include=all')
    return result.files
  }

  async pullTelegramImports(): Promise<{ importedCount: number }> {
    return this.json('/storage/import/pull', { method: 'POST' })
  }

  async workspaces(): Promise<{ workspaces: WorkspaceView[]; defaultWorkspaceId: string | null }> {
    return this.json('/workspaces')
  }

  async createWorkspace(input: { name: string; type: 'PERSONAL' | 'TEAM' | 'PROJECT'; defaultStorageConnectionId?: string | null }): Promise<{ id: string; name: string }> {
    return this.json('/workspaces', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
    })
  }

  async archiveWorkspace(workspaceId: string): Promise<void> {
    await this.json(`/workspaces/${encodeURIComponent(workspaceId)}/archive`, { method: 'POST' })
  }

  async setDefaultWorkspace(workspaceId: string): Promise<void> {
    await this.json(`/workspaces/${encodeURIComponent(workspaceId)}/set-default`, { method: 'POST' })
  }

  async workspaceMembers(workspaceId: string): Promise<WorkspaceMemberView[]> {
    const result = await this.json<{ members: WorkspaceMemberView[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/members`)
    return result.members
  }

  async saveWorkspaceMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
    await this.json(`/workspaces/${encodeURIComponent(workspaceId)}/members`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId, role })
    })
  }

  async removeWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
    await this.json(`/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })
  }

  async setWorkspaceStorage(workspaceId: string, storageConnectionId: string): Promise<void> {
    await this.json(`/workspaces/${encodeURIComponent(workspaceId)}/default-storage`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storageConnectionId })
    })
  }

  async resourceAccess(workspaceId: string, userId: string): Promise<ResourceAccessView> {
    return this.json(`/workspaces/${encodeURIComponent(workspaceId)}/resource-access/${encodeURIComponent(userId)}`)
  }

  async replaceResourceAccess(
    workspaceId: string,
    userId: string,
    input: { workspaceRole: WorkspaceRole; scopes: Array<{ scopeType: ResourceScopeType; scopeValue: string }> }
  ): Promise<void> {
    await this.json(`/workspaces/${encodeURIComponent(workspaceId)}/resource-access/${encodeURIComponent(userId)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
    })
  }

  async tasks(scope: 'mine' | 'all' = 'mine', workspaceId?: string): Promise<UserTaskView[]> {
    const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''
    const result = await this.json<{ tasks: UserTaskView[] }>(scope === 'mine' ? '/tasks/mine' : `/tasks${query}`)
    return result.tasks
  }

  async createUserTask(input: Record<string, unknown>): Promise<{ id: string; created: boolean }> {
    return this.json('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  }

  async updateUserTask(taskId: string, input: Record<string, unknown>): Promise<void> {
    await this.json(`/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  }

  async deleteUserTask(taskId: string): Promise<void> {
    await this.json(`/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' })
  }

  async migrateLocalTasks(tasks: Array<Record<string, unknown>>): Promise<{ imported: string[]; existing: string[] }> {
    return this.json('/tasks/migrate-local', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tasks })
    })
  }

  async adminUsers(): Promise<AdminUserView[]> {
    const result = await this.json<{ users: AdminUserView[] }>('/admin/users')
    return result.users
  }

  async adminUserDevices(userId: string): Promise<DeviceView[]> {
    const result = await this.json<{ devices: DeviceView[] }>(`/admin/users/${encodeURIComponent(userId)}/devices`)
    return result.devices
  }

  async adminInvites(): Promise<InviteView[]> {
    const result = await this.json<{ invites: InviteView[] }>('/admin/invites')
    return result.invites
  }

  async createInvite(input: { username: string; displayName: string; workspaceId: string; workspaceRole: WorkspaceRole; accountType: 'INTERNAL' | 'EXTERNAL'; userExpiresAt?: string | null; expiresInHours: number }): Promise<{ id: string; code: string; expiresAt: string }> {
    return this.json('/admin/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  }

  async revokeInvite(inviteId: string): Promise<void> {
    await this.json(`/admin/invites/${encodeURIComponent(inviteId)}/revoke`, { method: 'POST' })
  }

  async regenerateInvite(inviteId: string): Promise<{ id: string; code: string; expiresAt: string }> {
    return this.json(`/admin/invites/${encodeURIComponent(inviteId)}/regenerate`, { method: 'POST' })
  }

  async setUserLifecycle(userId: string, status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED', reassignToUserId?: string | null): Promise<{ openTasks: number }> {
    return this.json(`/admin/users/${encodeURIComponent(userId)}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status, reassignToUserId: reassignToUserId ?? null })
    })
  }

  async forceLogoutUser(userId: string): Promise<number> {
    const current = await this.sessionStore.load()
    const result = await this.json<{ invalidated: number }>(`/admin/users/${encodeURIComponent(userId)}/force-logout`, { method: 'POST' })
    if (current?.auth?.user.id === userId) {
      await this.sessionStore.clear()
      this.onAuthInvalidated?.()
    }
    return result.invalidated
  }

  async setUserSystemRole(userId: string, systemRole: 'ADMIN' | 'MEMBER'): Promise<void> {
    await this.json(`/admin/users/${encodeURIComponent(userId)}/role`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ systemRole })
    })
  }

  async setUserAccountPolicy(userId: string, accountType: 'INTERNAL' | 'EXTERNAL', accessExpiresAt?: string | null): Promise<void> {
    await this.json(`/admin/users/${encodeURIComponent(userId)}/account-policy`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountType, accessExpiresAt: accessExpiresAt ?? null })
    })
  }

  async groups(): Promise<GroupView[]> {
    const result = await this.json<{ groups: GroupView[] }>('/admin/groups')
    return result.groups
  }

  async createGroup(name: string): Promise<GroupView> {
    return this.json('/admin/groups', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name })
    })
  }

  async archiveGroup(groupId: string): Promise<void> {
    await this.json(`/admin/groups/${encodeURIComponent(groupId)}/archive`, { method: 'POST' })
  }

  async groupMembers(groupId: string): Promise<GroupMemberView[]> {
    const result = await this.json<{ members: GroupMemberView[] }>(`/admin/groups/${encodeURIComponent(groupId)}/members`)
    return result.members
  }

  async replaceGroupMembers(groupId: string, userIds: string[]): Promise<void> {
    await this.json(`/admin/groups/${encodeURIComponent(groupId)}/members`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userIds })
    })
  }

  async groupResourceAccess(workspaceId: string, groupId: string): Promise<GroupResourceAccessView> {
    return this.json(`/workspaces/${encodeURIComponent(workspaceId)}/group-access/${encodeURIComponent(groupId)}`)
  }

  async replaceGroupResourceAccess(
    workspaceId: string,
    groupId: string,
    input: { permission: ResourcePermission; scopes: Array<{ scopeType: ResourceScopeType; scopeValue: string }> }
  ): Promise<void> {
    await this.json(`/workspaces/${encodeURIComponent(workspaceId)}/group-access/${encodeURIComponent(groupId)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
    })
  }

  async storageConnections(): Promise<StorageConnectionView[]> {
    const result = await this.json<{ connections: StorageConnectionView[] }>('/admin/storage-connections')
    return result.connections
  }

  async createStorageConnection(name: string, botToken: string): Promise<{ id: string; name: string; botUsername: string | null; botName: string | null }> {
    return this.json('/admin/storage-connections', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, botToken })
    })
  }

  async rotateStorageToken(storageId: string, botToken: string): Promise<void> {
    await this.json(`/admin/storage-connections/${encodeURIComponent(storageId)}/token`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ botToken })
    })
  }

  async startStoragePair(storageId: string): Promise<{ code: string; deepLink: string; expiresAt: string; botUsername: string }> {
    return this.json(`/admin/storage-connections/${encodeURIComponent(storageId)}/pair/start`, { method: 'POST' })
  }

  async confirmStoragePair(storageId: string): Promise<{ chatId: string; chatTitle: string }> {
    return this.json(`/admin/storage-connections/${encodeURIComponent(storageId)}/pair/confirm`, { method: 'POST' })
  }

  async disableStorageConnection(storageId: string): Promise<void> {
    await this.json(`/admin/storage-connections/${encodeURIComponent(storageId)}/disable`, { method: 'POST' })
  }

  async checkStorageHealth(): Promise<Array<Record<string, unknown>>> {
    const result = await this.json<{ connections: Array<Record<string, unknown>> }>('/admin/storage-health', { method: 'POST' })
    return result.connections
  }

  async auditLogs(): Promise<AuditLogView[]> {
    const result = await this.json<{ logs: AuditLogView[] }>('/admin/audit-logs')
    return result.logs
  }

  async systemStatus(): Promise<SystemStatusView> {
    return this.json('/admin/system-status')
  }

  async versionIntegrity(): Promise<VersionIntegrityView> {
    return this.json('/admin/version-integrity')
  }

  async repairVersionIntegrity(fileId?: string): Promise<{ repaired: Array<Record<string, unknown>>; skipped: Array<Record<string, unknown>> }> {
    return this.json('/admin/version-integrity/repair', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fileId ? { fileId } : { batchSize: 10 })
    }, { auth: true, timeoutMs: 120_000 })
  }

  async filePresence(fileId: string): Promise<FilePresenceView> {
    return this.json(`/files/${encodeURIComponent(fileId)}/presence`)
  }

  async setFilePresence(fileId: string, state: PresenceState): Promise<FilePresenceView> {
    return this.json(`/files/${encodeURIComponent(fileId)}/presence`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state })
    })
  }

  async clearFilePresence(fileId: string): Promise<void> {
    await this.json(`/files/${encodeURIComponent(fileId)}/presence`, { method: 'DELETE' })
  }

  async fileLease(fileId: string): Promise<FileLeaseView> {
    return this.json(`/files/${encodeURIComponent(fileId)}/lease`)
  }

  async acquireFileLease(fileId: string, leaseId?: string): Promise<FileLeaseView> {
    return this.json(`/files/${encodeURIComponent(fileId)}/lease`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(leaseId ? { leaseId } : {})
    })
  }

  async heartbeatFileLease(fileId: string, leaseId: string): Promise<FileLeaseView> {
    return this.json(`/files/${encodeURIComponent(fileId)}/lease`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaseId })
    })
  }

  async releaseFileLease(fileId: string, leaseId: string): Promise<void> {
    await this.json(`/files/${encodeURIComponent(fileId)}/lease`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaseId })
    })
  }

  async requestFileLeaseTakeover(fileId: string): Promise<void> {
    await this.json(`/files/${encodeURIComponent(fileId)}/lease/request-takeover`, { method: 'POST' })
  }

  async forceFileLeaseTakeover(fileId: string): Promise<FileLeaseView> {
    return this.json(`/files/${encodeURIComponent(fileId)}/lease/force-takeover`, { method: 'POST' })
  }

  async activity(): Promise<ActivityView[]> {
    const result = await this.json<{ events: Array<{ id: string; file_id: string | null; event_type: string; detail: string | null; created_at: string }> }>('/activity')
    return result.events.map((row) => ({
      id: row.id,
      fileId: row.file_id,
      eventType: row.event_type,
      detail: row.detail,
      createdAt: row.created_at
    }))
  }

  async notifications(filter = 'all', cursor?: string): Promise<NotificationListView> {
    const query = new URLSearchParams({ filter })
    if (cursor) query.set('cursor', cursor)
    return this.json(`/notifications?${query.toString()}`)
  }

  async markNotificationRead(notificationId: string): Promise<void> {
    await this.json(`/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'POST' })
  }

  async markAllNotificationsRead(): Promise<number> {
    const result = await this.json<{ changed: number }>('/notifications/read-all', { method: 'POST' })
    return result.changed
  }

  async comments(fileId: string): Promise<FileCommentView[]> {
    const result = await this.json<{ comments: FileCommentView[] }>(`/files/${encodeURIComponent(fileId)}/comments`)
    return result.comments
  }

  async createComment(fileId: string, input: { body: string; parentCommentId?: string | null; fileVersion?: number | null }): Promise<FileCommentView[]> {
    const result = await this.json<{ comments: FileCommentView[] }>(`/files/${encodeURIComponent(fileId)}/comments`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
    })
    return result.comments
  }

  async resolveComment(commentId: string, reopen = false): Promise<void> {
    await this.json(`/comments/${encodeURIComponent(commentId)}/${reopen ? 'reopen' : 'resolve'}`, { method: 'POST' })
  }

  async advancedSearch(input: AdvancedSearchInput): Promise<AdvancedSearchFileView[]> {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(input)) if (value) query.set(key, value)
    const result = await this.json<{ files: AdvancedSearchFileView[] }>(`/search/files?${query.toString()}`)
    return result.files
  }

  async rewindPreview(input: { workspaceId: string; scopeType: 'FOLDER' | 'WORKSPACE'; scopeValue: string; targetTime: string }): Promise<RewindPreviewView> {
    return this.json('/rewind/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
    })
  }

  async executeRewind(input: { workspaceId: string; scopeType: 'FOLDER' | 'WORKSPACE'; scopeValue: string; targetTime: string; idempotencyKey: string }): Promise<Record<string, unknown>> {
    return this.json('/rewind/execute', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
    }, { auth: true, timeoutMs: 180_000 })
  }

  async rewindHistory(workspaceId: string): Promise<RewindOperationView[]> {
    const result = await this.json<{ operations: RewindOperationView[] }>(`/rewind/history?workspaceId=${encodeURIComponent(workspaceId)}`)
    return result.operations
  }

  async retryRewind(operationId: string): Promise<Record<string, unknown>> {
    return this.json(`/rewind/${encodeURIComponent(operationId)}/retry`, { method: 'POST' }, { auth: true, timeoutMs: 180_000 })
  }

  async activeLocks(): Promise<Array<Record<string, unknown>>> {
    const result = await this.json<{ locks: Array<Record<string, unknown>> }>('/admin/active-locks')
    return result.locks
  }

  async clientVersion(): Promise<ClientVersionInfo> {
    const device = await this.sessionStore.stableDeviceId()
    const current = this.getClientIdentity().clientVersion
    return this.json(`/client/version?current=${encodeURIComponent(current)}&device=${encodeURIComponent(device)}`, { method: 'GET' }, { auth: false })
  }

  async storageStatus(): Promise<{ reachable: boolean; status?: string; message?: string; connections?: StorageConnectionView[] }> {
    return this.json('/storage/status')
  }

  async pairStart(): Promise<{ code: string; deepLink: string; expiresAt: string }> {
    return this.json('/storage/pair/start', { method: 'POST' })
  }

  async pairConfirm(): Promise<void> {
    await this.json('/storage/pair/confirm', { method: 'POST' })
  }
}
