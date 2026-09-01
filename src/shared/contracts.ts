import type { StorageBackend } from './storage-capabilities'

export type SyncStatus = 'SYNCED' | 'PENDING' | 'UPLOADING' | 'RETRY_WAIT' | 'CONFLICT' | 'ERROR'
export type CloudFileStatus = 'active' | 'trashed' | 'deleted'
export type AccountType = 'INTERNAL' | 'EXTERNAL'
export type DeviceStatus = 'ACTIVE' | 'REVOKED'
export type PresenceState = 'OPEN' | 'EDITING'

export interface LocalFileView {
  id: string
  relativePath: string
  logicalName: string
  extension: string
  currentVersion: number
  currentHash: string | null
  status: SyncStatus
  cloudStatus: CloudFileStatus
  exists: boolean
  size: number
  mtimeMs: number
  updatedAt: string
  favorite: boolean
  lastOpenedAt: string | null
  storageBackend?: StorageBackend | null
}

export interface TrashFileView {
  id: string
  logicalName: string
  relativePath: string
  currentVersion: number
  currentHash: string | null
  status: 'trashed' | 'deleted'
  size: number
  trashedAt: string
  updatedAt: string
}

export interface PendingView {
  id: string
  fileId: string
  logicalName: string
  operation: 'UPSERT' | 'DELETE' | 'RENAME'
  status: SyncStatus
  attemptCount: number
  priority: number
  nextRetryAt: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface TransferProgressView {
  id: string
  direction: 'upload' | 'download'
  fileName: string
  phase: 'verifying' | 'transferring' | 'finalizing' | 'done'
  transferredBytes: number
  totalBytes: number
  bytesPerSecond: number
  updatedAt: number
}

export interface SpreadsheetPreviewSheet {
  name: string
  rowCount: number
  columnCount: number
  rows: string[][]
}

export type PreviewView =
  | {
      kind: 'spreadsheet'
      logicalName: string
      sheetNames: string[]
      selectedSheet: string | null
      sheet: SpreadsheetPreviewSheet | null
      sheetCount: number
    }
  | {
      kind: 'text'
      logicalName: string
      format: 'plain' | 'markdown' | 'json'
      text: string
    }
  | {
      kind: 'binary'
      logicalName: string
      media: 'image' | 'pdf'
      mimeType: string
      base64: string
    }
  | {
      kind: 'zip'
      logicalName: string
      entries: Array<{ name: string; directory: boolean }>
      truncated: boolean
    }
  | {
      kind: 'unsupported'
      logicalName: string
      message: string
    }

export interface ActivityView {
  id: string
  fileId: string | null
  eventType: string
  detail: string | null
  createdAt: string
}

export interface VersionView {
  version: number
  hash: string | null
  size: number | null
  base_version: number | null
  restored_from_version: number | null
  created_at: string | null
  status: string
  storage_connection_id?: string | null
  storage_name?: string | null
  storage_status?: string | null
  storage_backend?: StorageBackend | null
  storage_locator?: string | null
  integrity_status?: 'HEALTHY' | 'MISSING_METADATA' | 'MISSING_STORAGE_REFERENCE' | 'MISSING_REMOTE_FILE_REFERENCE' | 'LEGACY_UNRECOVERABLE' | string
  available?: boolean
}

export interface SettingsView {
  syncDirectory: string
  workerUrl: string
  autoSync: boolean
  startWithWindows: boolean
  retryBaseSeconds: number
  retentionLimit: number
  defaultStorageBackend: StorageBackend
}

export type TelegramUserStorageState =
  | 'UNCONFIGURED'
  | 'UNAUTHORIZED'
  | 'WAITING_CODE'
  | 'WAITING_2FA'
  | 'AUTH_FAILED'
  | 'RESOLVING_GROUP'
  | 'CONNECTED'
  | 'SYNCING'
  | 'ERROR'

export interface TelegramUserStorageStatusView {
  state: TelegramUserStorageState
  authorized: boolean
  bridgeReachable: boolean
  phoneMasked: string | null
  chatId: string | null
  chatTitle: string | null
  lastSyncAt: string | null
  errorCode: string | null
  errorMessage: string | null
}

export interface TelegramUserStorageReceipt {
  backend: 'telegram_user_group'
  chatId: string
  messageId: number
  fileName: string
  size: number
  sha256: string
  mimeType: string
  createdAt: string
}

export interface HealthView {
  online: boolean
  worker: 'ok' | 'offline' | 'error'
  telegram: {
    tokenConfigured: boolean
    chatConfigured: boolean
    reachable: boolean
    detail?: string
  }
}

export interface DashboardView {
  health: HealthView
  syncedFiles: number
  pending: number
  syncing: number
  waitingRetry: number
  needsAttention: number
  conflicts: number
  errors: number
  recentActivity: ActivityView[]
}

export interface ProblemView {
  id: string
  fileId: string
  logicalName: string
  status: SyncStatus
  severity: 'WAITING' | 'ATTENTION'
  automatic: boolean
  title: string
  message: string
  action: 'NONE' | 'RETRY' | 'OPEN_LOCATION' | 'LOGIN' | 'RESOLVE_CONFLICT'
  nextRetryAt: string | null
  errorCode: string | null
}

export interface ClientVersionInfo {
  latest: string
  minimum: string
  mandatory: boolean
  rollout: number
  apiVersion: string
  updateUrl: string | null
  updateAvailable: boolean
  updateRequired: boolean
}

export type SystemRole = 'OWNER' | 'ADMIN' | 'MEMBER'
export type WorkspaceRole = 'MANAGER' | 'EDITOR' | 'VIEWER'
export type UserLifecycleStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED'

export interface WorkspaceMembershipView {
  workspaceId: string
  workspaceName: string
  workspaceType: 'PERSONAL' | 'TEAM' | 'PROJECT' | string
  role: WorkspaceRole
  status: 'ACTIVE' | 'ARCHIVED' | string
  defaultStorageConnectionId: string | null
}

export interface AuthUserView {
  id: string
  username: string
  displayName: string
  organizationId: string
  systemRole: SystemRole
  status: UserLifecycleStatus
  accountType: AccountType
  accessExpiresAt: string | null
}

export interface DeviceView {
  id: string
  deviceName: string
  osName: string
  osVersion: string
  clientVersion: string
  firstSeenAt: string
  lastSeenAt: string
  status: DeviceStatus
  current: boolean
  activeSessions: number
}

export interface GroupView {
  id: string
  name: string
  status: 'ACTIVE' | 'ARCHIVED'
  memberCount: number
  createdAt: string
  updatedAt: string
}

export interface GroupMemberView {
  id: string
  username: string
  displayName: string
  accountType: AccountType
  status: UserLifecycleStatus
  addedAt: string
}

export interface FilePresenceEntryView {
  userId: string
  displayName: string
  username: string
  deviceId: string
  deviceName: string
  state: PresenceState
  startedAt: string
  lastSeenAt: string
  currentUser: boolean
  currentDevice: boolean
}

export interface FilePresenceView {
  fileId: string
  activeUserCount: number
  editingUserCount: number
  entries: FilePresenceEntryView[]
}

export interface FileLeaseView {
  fileId: string
  locked: boolean
  workspaceId?: string
  ownerUserId?: string
  ownerDisplayName?: string
  ownerUsername?: string
  ownerDeviceId?: string
  ownerDeviceName?: string
  leaseId?: string
  lockType?: 'EDIT'
  createdAt?: string
  heartbeatAt?: string
  expiresAt?: string
  currentUser?: boolean
  currentDevice?: boolean
}

export type NotificationCategory = 'FILE' | 'TASK' | 'SYSTEM' | 'SECURITY' | 'COLLABORATION' | 'RECOVERY'

export interface NotificationView {
  id: string
  event_id: string
  category: NotificationCategory
  title: string
  body: string
  resource_type: string | null
  resource_id: string | null
  comment_id: string | null
  created_at: string
  read_at: string | null
  expires_at: string | null
}

export interface NotificationListView {
  notifications: NotificationView[]
  unreadCount: number
  nextCursor: string | null
}

export interface FileCommentView {
  id: string
  file_id: string
  workspace_id: string
  parent_comment_id: string | null
  file_version: number | null
  body: string
  created_by_user_id: string
  created_by_name: string
  created_by_username: string
  created_at: string
  updated_at: string
  resolved_at: string | null
  resolved_by_user_id: string | null
  mention_user_ids: string[]
}

export interface AdvancedSearchInput {
  q?: string
  type?: 'Excel' | 'Word' | 'PDF' | 'CSV' | 'ZIP' | 'PPT' | 'Image' | 'EXE' | 'Other' | ''
  state?: 'locked' | 'editing' | 'trashed' | ''
  workspaceId?: string
  path?: string
  modifiedBy?: string
  createdBy?: string
  modifiedFrom?: string
  modifiedTo?: string
}

export interface AdvancedSearchFileView {
  id: string
  workspace_id: string
  workspace_name: string
  logical_name: string
  relative_path: string
  current_version: number
  current_hash: string | null
  status: CloudFileStatus
  created_at: string
  updated_at: string
  created_by_user_id: string | null
  updated_by_user_id: string | null
  created_by_name: string | null
  updated_by_name: string | null
  lease_id: string | null
  lock_owner_user_id: string | null
  lock_owner_name: string | null
  lock_heartbeat_at: string | null
  lock_expires_at: string | null
  active_user_count: number
  editing_user_count: number
}

export interface VersionDiffCellView {
  address: string
  oldValue: string
  newValue: string
  oldFormula: string | null
  newFormula: string | null
  changeType: 'VALUE' | 'FORMULA' | 'VALUE_AND_FORMULA'
}

export interface VersionDiffSheetView {
  name: string
  status: 'ADDED' | 'REMOVED' | 'CHANGED' | 'UNCHANGED'
  oldName?: string | null
  newName?: string | null
  modifiedCells: number
  addedRows: number
  removedRows: number
  oldRowCount: number
  newRowCount: number
  oldColumnCount: number
  newColumnCount: number
  changes: VersionDiffCellView[]
  truncated: boolean
}

export interface VersionDiffView {
  kind: 'excel' | 'metadata'
  fromVersion: number
  toVersion: number
  summary: {
    sheetsAdded: number
    sheetsRemoved: number
    sheetsChanged: number
    modifiedCells: number
    truncated: boolean
    guardReason?: string | null
  }
  sheets: VersionDiffSheetView[]
  metadata: Array<{ field: string; oldValue: string; newValue: string }>
}

export interface RewindPreviewView {
  workspaceId: string
  scopeType: 'FOLDER' | 'WORKSPACE'
  scopeValue: string
  targetTime: string
  summary: Record<string, number>
  actions: Array<Record<string, unknown>>
  unsupported: Array<{ fileId: string; logicalName: string; reason: string }>
}

export interface RewindOperationView {
  id: string
  scope_type: 'FOLDER' | 'WORKSPACE'
  scope_value: string
  target_time: string
  status: 'PLANNED' | 'RUNNING' | 'PARTIAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  created_by_user_id: string
  created_at: string
  started_at: string | null
  completed_at: string | null
  summary_json: string | null
  error_text: string | null
}

export interface AuthState {
  authenticated: boolean
  username?: string
  setupProvisioned?: boolean
  user?: AuthUserView
  memberships?: WorkspaceMembershipView[]
  defaultWorkspaceId?: string | null
}

export interface AdminUserView {
  id: string
  username: string
  display_name: string
  system_role: SystemRole
  account_type: AccountType
  access_expires_at: string | null
  status: UserLifecycleStatus
  created_at: string
  last_login_at: string | null
  active_sessions: number
  active_devices: number
  workspace_count: number
  open_tasks: number
}

export interface InviteView {
  id: string
  username: string
  display_name: string
  workspace_id: string | null
  workspace_name: string | null
  workspace_role: WorkspaceRole | null
  account_type: AccountType
  user_expires_at: string | null
  expires_at: string
  used_at: string | null
  status: 'PENDING' | 'USED' | 'REVOKED' | 'EXPIRED'
  created_at: string
}

export interface WorkspaceView {
  id: string
  name: string
  type: 'PERSONAL' | 'TEAM' | 'PROJECT'
  status: 'ACTIVE' | 'ARCHIVED'
  default_storage_connection_id: string | null
  created_at: string
  role?: WorkspaceRole
  member_count: number
  file_count: number
}

export interface WorkspaceMemberView {
  id: string
  username: string
  display_name: string
  status: UserLifecycleStatus
  role: WorkspaceRole
  joined_at: string
}

export type ResourceScopeType = 'WORKSPACE' | 'STORAGE' | 'FOLDER' | 'FILE'
export type ResourcePermission = 'VIEW' | 'EDIT' | 'MANAGE'

export interface ResourceAccessRuleView {
  id: string
  scope_type: ResourceScopeType
  scope_value: string
  permission: ResourcePermission
  created_at: string
  updated_at: string
}

export interface ResourceAccessFileView {
  id: string
  logical_name: string
  relative_path: string
  home_storage_connection_id: string | null
  current_version: number
  status: string
}

export interface ResourceAccessView {
  member: {
    id: string
    username: string
    display_name: string
    system_role: SystemRole
    role: WorkspaceRole
  }
  rules: ResourceAccessRuleView[]
  inheritedRules: Array<ResourceAccessRuleView & { group_id: string; group_name: string }>
  files: ResourceAccessFileView[]
  folders: string[]
  storages: Array<{ id: string; name: string; status: string }>
}

export interface GroupResourceAccessView {
  group: { id: string; name: string }
  rules: ResourceAccessRuleView[]
  files: ResourceAccessFileView[]
  folders: string[]
  storages: Array<{ id: string; name: string; status: string }>
}

export interface VersionIntegrityFindingView {
  file_id: string
  logical_name: string
  relative_path: string
  workspace_id: string
  workspace_name: string
  current_version: number
  recorded_versions: number
  missing_versions: number[]
  status: 'HEALTHY' | 'MISSING_METADATA' | 'MISSING_STORAGE_REFERENCE' | 'MISSING_REMOTE_FILE_REFERENCE' | 'LEGACY_UNRECOVERABLE' | string
  issues: string[]
  current_reference_repairable: boolean
}

export interface VersionIntegrityView {
  summary: Record<string, number>
  findings: VersionIntegrityFindingView[]
}

export interface UserTaskView {
  id: string
  workspace_id: string
  workspace_name: string
  title: string
  description: string
  status: 'TODO' | 'IN_PROGRESS' | 'DONE'
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'
  created_by_user_id: string
  assignee_user_id: string | null
  assignee_name: string | null
  legacy_assignee_text: string | null
  due_at: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  file_ids: string[]
}

export interface StorageConnectionView {
  id: string
  name: string
  provider: string
  telegramBotId: string | null
  telegramBotUsername: string | null
  telegramBotName: string | null
  chatId: string | null
  chatTitle: string | null
  status: 'ACTIVE' | 'DEGRADED' | 'DISABLED' | string
  credentialSource: 'ENCRYPTED' | 'LEGACY_WORKER_SECRET' | string
  lastHealthCheckAt: string | null
  lastError: string | null
}

export interface AuditLogView {
  id: string
  action: string
  target_type: string
  target_id: string | null
  detail_json: string | null
  created_at: string
  actor_username: string | null
  actor_display_name: string | null
}

export interface SystemStatusView {
  worker: 'ok' | 'error'
  database: 'ok' | 'error'
  activeUsers: number
  activeWorkspaces: number
  pendingTasks: number
  conflictCount: number
  syncErrorCount: number
  storageConnections: StorageConnectionView[]
}

export interface PairInfo {
  code: string
  deepLink: string
  expiresAt: string
}

export interface ExcelSyncBridge {
  authState(): Promise<AuthState>
  bootstrap(username: string, password: string, setupCode: string): Promise<void>
  login(username: string, password: string): Promise<void>
  activateInvite(code: string, password: string): Promise<void>
  logout(): Promise<void>
  devices(): Promise<DeviceView[]>
  logoutDevice(deviceId: string): Promise<void>
  logoutOtherDevices(): Promise<number>
  logoutAllDevices(): Promise<number>
  dashboard(): Promise<DashboardView>
  files(): Promise<LocalFileView[]>
  trash(): Promise<TrashFileView[]>
  activity(): Promise<ActivityView[]>
  notifications(filter?: 'all' | 'unread' | 'file' | 'task' | 'system'): Promise<NotificationListView>
  markNotificationRead(notificationId: string): Promise<void>
  markAllNotificationsRead(): Promise<number>
  advancedSearch(input: AdvancedSearchInput): Promise<AdvancedSearchFileView[]>
  pending(): Promise<PendingView[]>
  problems(): Promise<ProblemView[]>
  versions(fileId: string): Promise<VersionView[]>
  previewVersion(fileId: string, version: number, sheetName?: string): Promise<PreviewView>
  downloadVersion(fileId: string, version: number): Promise<string | null>
  openVersionCopy(fileId: string, version: number): Promise<void>
  restore(fileId: string, version: number): Promise<void>
  compareVersions(fileId: string, fromVersion: number, toVersion: number): Promise<VersionDiffView>
  fileLease(fileId: string): Promise<FileLeaseView>
  requestFileLeaseTakeover(fileId: string): Promise<void>
  forceFileLeaseTakeover(fileId: string): Promise<FileLeaseView>
  comments(fileId: string): Promise<FileCommentView[]>
  createComment(fileId: string, input: { body: string; parentCommentId?: string | null; fileVersion?: number | null }): Promise<FileCommentView[]>
  resolveComment(commentId: string, reopen?: boolean): Promise<void>
  rewindPreview(input: { workspaceId: string; scopeType: 'FOLDER' | 'WORKSPACE'; scopeValue: string; targetTime: string }): Promise<RewindPreviewView>
  executeRewind(input: { workspaceId: string; scopeType: 'FOLDER' | 'WORKSPACE'; scopeValue: string; targetTime: string }): Promise<Record<string, unknown>>
  rewindHistory(workspaceId: string): Promise<RewindOperationView[]>
  retryRewind(operationId: string): Promise<Record<string, unknown>>
  activeLocks(): Promise<Array<Record<string, unknown>>>
  restoreLocalCopy(fileId: string): Promise<void>
  trashFile(fileId: string): Promise<void>
  restoreTrash(fileId: string): Promise<void>
  permanentlyDelete(fileId: string): Promise<void>
  openFile(fileId: string): Promise<void>
  setFileFavorite(fileId: string, favorite: boolean): Promise<void>
  previewFile(fileId: string, sheetName?: string): Promise<PreviewView>
  downloadFile(fileId: string): Promise<string | null>
  downloadFiles(fileIds: string[]): Promise<string[] | null>
  renameFile(fileId: string, newName: string): Promise<void>
  moveFile(fileId: string, newRelativePath: string): Promise<void>
  copyFile(fileId: string): Promise<void>
  createFolder(relativeParent: string, folderName: string): Promise<void>
  retryTask(taskId: string): Promise<void>
  cancelTask(taskId: string): Promise<void>
  resolveConflict(fileId: string, choice: 'local' | 'cloud' | 'both'): Promise<void>
  importExcelFiles(storageBackend?: StorageBackend): Promise<string[]>
  importExcelFolder(storageBackend?: StorageBackend): Promise<string[]>
  importDroppedFiles(files: File[], storageBackend?: StorageBackend): Promise<string[]>
  selectSyncDirectory(): Promise<string | null>
  openSyncDirectory(): Promise<void>
  settings(): Promise<SettingsView>
  updateSettings(patch: Partial<SettingsView>): Promise<SettingsView>
  telegramUserStatus(): Promise<TelegramUserStorageStatusView>
  beginTelegramUserAuth(phone: string): Promise<TelegramUserStorageStatusView>
  submitTelegramUserCode(code: string): Promise<TelegramUserStorageStatusView>
  submitTelegramUserPassword(password: string): Promise<TelegramUserStorageStatusView>
  syncTelegramUserGroup(): Promise<number>
  reauthorizeTelegramUser(): Promise<TelegramUserStorageStatusView>
  restartTelegramUserAuth(): Promise<TelegramUserStorageStatusView>
  syncNow(): Promise<void>
  pauseSync(paused: boolean): Promise<void>
  workspaces(): Promise<{ workspaces: WorkspaceView[]; defaultWorkspaceId: string | null }>
  setDefaultWorkspace(workspaceId: string): Promise<void>
  workspaceMembers(workspaceId: string): Promise<WorkspaceMemberView[]>
  saveWorkspaceMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void>
  removeWorkspaceMember(workspaceId: string, userId: string): Promise<void>
  createWorkspace(input: { name: string; type: 'PERSONAL' | 'TEAM' | 'PROJECT'; defaultStorageConnectionId?: string | null }): Promise<{ id: string; name: string }>
  archiveWorkspace(workspaceId: string): Promise<void>
  setWorkspaceStorage(workspaceId: string, storageConnectionId: string): Promise<void>
  resourceAccess(workspaceId: string, userId: string): Promise<ResourceAccessView>
  replaceResourceAccess(workspaceId: string, userId: string, input: { workspaceRole: WorkspaceRole; scopes: Array<{ scopeType: ResourceScopeType; scopeValue: string }> }): Promise<void>
  tasks(scope?: 'mine' | 'all', workspaceId?: string): Promise<UserTaskView[]>
  createUserTask(input: Record<string, unknown>): Promise<{ id: string; created: boolean }>
  updateUserTask(taskId: string, input: Record<string, unknown>): Promise<void>
  deleteUserTask(taskId: string): Promise<void>
  migrateLocalTasks(tasks: Array<Record<string, unknown>>): Promise<{ imported: string[]; existing: string[] }>
  adminUsers(): Promise<AdminUserView[]>
  adminUserDevices(userId: string): Promise<DeviceView[]>
  adminInvites(): Promise<InviteView[]>
  createInvite(input: { username: string; displayName: string; workspaceId: string; workspaceRole: WorkspaceRole; accountType: AccountType; userExpiresAt?: string | null; expiresInHours: number }): Promise<{ id: string; code: string; expiresAt: string }>
  revokeInvite(inviteId: string): Promise<void>
  regenerateInvite(inviteId: string): Promise<{ id: string; code: string; expiresAt: string }>
  setUserLifecycle(userId: string, status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED', reassignToUserId?: string | null): Promise<{ openTasks: number }>
  forceLogoutUser(userId: string): Promise<number>
  setUserSystemRole(userId: string, systemRole: 'ADMIN' | 'MEMBER'): Promise<void>
  setUserAccountPolicy(userId: string, accountType: AccountType, accessExpiresAt?: string | null): Promise<void>
  groups(): Promise<GroupView[]>
  createGroup(name: string): Promise<GroupView>
  archiveGroup(groupId: string): Promise<void>
  groupMembers(groupId: string): Promise<GroupMemberView[]>
  replaceGroupMembers(groupId: string, userIds: string[]): Promise<void>
  groupResourceAccess(workspaceId: string, groupId: string): Promise<GroupResourceAccessView>
  replaceGroupResourceAccess(workspaceId: string, groupId: string, input: { permission: ResourcePermission; scopes: Array<{ scopeType: ResourceScopeType; scopeValue: string }> }): Promise<void>
  storageConnections(): Promise<StorageConnectionView[]>
  createStorageConnection(name: string, botToken: string): Promise<{ id: string; name: string; botUsername: string | null; botName: string | null }>
  rotateStorageToken(storageId: string, botToken: string): Promise<void>
  startStoragePair(storageId: string): Promise<PairInfo & { botUsername: string }>
  confirmStoragePair(storageId: string): Promise<{ chatId: string; chatTitle: string }>
  disableStorageConnection(storageId: string): Promise<void>
  checkStorageHealth(): Promise<Array<Record<string, unknown>>>
  auditLogs(): Promise<AuditLogView[]>
  systemStatus(): Promise<SystemStatusView>
  versionIntegrity(): Promise<VersionIntegrityView>
  repairVersionIntegrity(fileId?: string): Promise<{ repaired: Array<Record<string, unknown>>; skipped: Array<Record<string, unknown>> }>
  filePresence(fileId: string): Promise<FilePresenceView>
  setFilePresence(fileId: string, state: PresenceState): Promise<FilePresenceView>
  clearFilePresence(fileId: string): Promise<void>
  clientVersion(): Promise<ClientVersionInfo>
  storageStatus(): Promise<{ reachable: boolean; status?: string; message?: string; connections?: StorageConnectionView[] }>
  startTelegramPair(): Promise<PairInfo>
  confirmTelegramPair(): Promise<void>
  openTelegramPairLink(url: string): Promise<void>
  onStateChanged(callback: () => void): () => void
  onTransferProgress(callback: (progress: TransferProgressView) => void): () => void
  onAuthChanged(callback: () => void): () => void
}
