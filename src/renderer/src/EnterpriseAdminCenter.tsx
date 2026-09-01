import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  AccountType,
  AdminUserView,
  AuditLogView,
  DeviceView,
  GroupMemberView,
  GroupResourceAccessView,
  GroupView,
  InviteView,
  ResourceAccessView,
  ResourcePermission,
  ResourceScopeType,
  StorageConnectionView,
  SystemRole,
  SystemStatusView,
  VersionIntegrityView,
  WorkspaceMemberView,
  WorkspaceRole,
  WorkspaceView
} from '../../shared/contracts'

type AdminTab = 'users' | 'groups' | 'workspaces' | 'resources' | 'storage' | 'audit' | 'status'

const ROLE_LABEL: Record<WorkspaceRole, string> = { MANAGER: '负责人', EDITOR: '编辑者', VIEWER: '查看者' }
const SYSTEM_ROLE_LABEL: Record<SystemRole, string> = { OWNER: 'Owner', ADMIN: '管理员', MEMBER: '成员' }

function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN')
}

export function EnterpriseAdminCenter({ systemRole, currentUserId, onToast, onSessionInvalidated }: {
  systemRole: SystemRole
  currentUserId: string
  onToast: (message: string) => void
  onSessionInvalidated: () => Promise<void>
}): ReactElement {
  const [tab, setTab] = useState<AdminTab>('users')
  const [users, setUsers] = useState<AdminUserView[]>([])
  const [invites, setInvites] = useState<InviteView[]>([])
  const [groups, setGroups] = useState<GroupView[]>([])
  const [groupMembers, setGroupMembers] = useState<GroupMemberView[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [groupName, setGroupName] = useState('')
  const [selectedGroupUserIds, setSelectedGroupUserIds] = useState<string[]>([])
  const [groupAccess, setGroupAccess] = useState<GroupResourceAccessView | null>(null)
  const [groupPermission, setGroupPermission] = useState<ResourcePermission>('VIEW')
  const [groupScopeType, setGroupScopeType] = useState<ResourceScopeType>('WORKSPACE')
  const [groupScopeValues, setGroupScopeValues] = useState<string[]>([])
  const [groupResourceSearch, setGroupResourceSearch] = useState('')
  const [selectedUserDevices, setSelectedUserDevices] = useState<DeviceView[]>([])
  const [selectedDeviceUserId, setSelectedDeviceUserId] = useState('')
  const [selectedPolicyUserId, setSelectedPolicyUserId] = useState('')
  const [policyAccountType, setPolicyAccountType] = useState<AccountType>('INTERNAL')
  const [policyExpiresAt, setPolicyExpiresAt] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([])
  const [storage, setStorage] = useState<StorageConnectionView[]>([])
  const [audit, setAudit] = useState<AuditLogView[]>([])
  const [status, setStatus] = useState<SystemStatusView | null>(null)
  const [integrity, setIntegrity] = useState<VersionIntegrityView | null>(null)
  const [resourceAccess, setResourceAccess] = useState<ResourceAccessView | null>(null)
  const [selectedResourceUserId, setSelectedResourceUserId] = useState('')
  const [resourceRole, setResourceRole] = useState<WorkspaceRole>('VIEWER')
  const [resourceScopeType, setResourceScopeType] = useState<ResourceScopeType>('WORKSPACE')
  const [resourceScopeValues, setResourceScopeValues] = useState<string[]>([])
  const [resourceSearch, setResourceSearch] = useState('')
  const [pairWorkspaceByStorage, setPairWorkspaceByStorage] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [lastInviteCode, setLastInviteCode] = useState('')
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('')
  const [members, setMembers] = useState<WorkspaceMemberView[]>([])
  const [inviteForm, setInviteForm] = useState({
    username: '',
    displayName: '',
    workspaceId: '',
    workspaceRole: 'EDITOR' as WorkspaceRole,
    accountType: 'INTERNAL' as AccountType,
    userExpiresAt: null as string | null,
    expiresInHours: 72
  })
  const [workspaceForm, setWorkspaceForm] = useState({ name: '', type: 'TEAM' as 'PERSONAL' | 'TEAM' | 'PROJECT' })
  const [memberForm, setMemberForm] = useState({ userId: '', role: 'EDITOR' as WorkspaceRole })
  const [storageForm, setStorageForm] = useState({ name: '', token: '' })
  const [pairingStorageId, setPairingStorageId] = useState<string | null>(null)

  const selectedWorkspace = useMemo(() => workspaces.find((item) => item.id === selectedWorkspaceId) ?? null, [workspaces, selectedWorkspaceId])
  const resourceMembers = useMemo(() => members.filter((member) => users.find((user) => user.id === member.id)?.system_role === 'MEMBER'), [members, users])
  const visibleResourceFiles = useMemo(() => {
    if (!resourceAccess) return []
    const query = resourceSearch.trim().toLocaleLowerCase('zh-CN')
    if (!query) return resourceAccess.files
    return resourceAccess.files.filter((file) => `${file.logical_name}\n${file.relative_path}`.toLocaleLowerCase('zh-CN').includes(query))
  }, [resourceAccess, resourceSearch])
  const visibleGroupFiles = useMemo(() => {
    if (!groupAccess) return []
    const query = groupResourceSearch.trim().toLocaleLowerCase('zh-CN')
    if (!query) return groupAccess.files
    return groupAccess.files.filter((file) => `${file.logical_name}\n${file.relative_path}`.toLocaleLowerCase('zh-CN').includes(query))
  }, [groupAccess, groupResourceSearch])

  async function refreshCore(): Promise<void> {
    const [userRows, inviteRows, groupRows, workspaceRows, storageRows] = await Promise.all([
      window.excelSync.adminUsers(),
      window.excelSync.adminInvites(),
      window.excelSync.groups(),
      window.excelSync.workspaces(),
      window.excelSync.storageConnections()
    ])
    setUsers(userRows)
    setInvites(inviteRows)
    setGroups(groupRows)
    setWorkspaces(workspaceRows.workspaces)
    setStorage(storageRows)
    const defaultWorkspace = workspaceRows.workspaces.find((item) => item.id === workspaceRows.defaultWorkspaceId) ?? workspaceRows.workspaces[0]
    const nextWorkspaceId = selectedWorkspaceId || defaultWorkspace?.id || ''
    setSelectedWorkspaceId(nextWorkspaceId)
    setInviteForm((current) => ({ ...current, workspaceId: current.workspaceId || nextWorkspaceId }))
    if (nextWorkspaceId) setMembers(await window.excelSync.workspaceMembers(nextWorkspaceId))
    const nextGroupId = selectedGroupId || groupRows.find((item) => item.status === 'ACTIVE')?.id || ''
    setSelectedGroupId(nextGroupId)
    if (nextGroupId) {
      const rows = await window.excelSync.groupMembers(nextGroupId)
      setGroupMembers(rows)
      setSelectedGroupUserIds(rows.map((item) => item.id))
    } else {
      setGroupMembers([])
      setSelectedGroupUserIds([])
    }
  }

  async function refreshTab(): Promise<void> {
    if (tab === 'audit') setAudit(await window.excelSync.auditLogs())
    if (tab === 'status') {
      const [system, versionIntegrity] = await Promise.all([
        window.excelSync.systemStatus(),
        window.excelSync.versionIntegrity()
      ])
      setStatus(system)
      setIntegrity(versionIntegrity)
    }
  }

  useEffect(() => {
    void refreshCore().catch((error) => onToast(error instanceof Error ? error.message : String(error)))
  }, [])

  useEffect(() => {
    void refreshTab().catch((error) => onToast(error instanceof Error ? error.message : String(error)))
  }, [tab])

  useEffect(() => {
    if (!selectedGroupId) {
      setGroupMembers([])
      setSelectedGroupUserIds([])
      return
    }
    void window.excelSync.groupMembers(selectedGroupId).then((rows) => {
      setGroupMembers(rows)
      setSelectedGroupUserIds(rows.map((item) => item.id))
    }).catch((error) => onToast(error instanceof Error ? error.message : String(error)))
  }, [selectedGroupId])

  useEffect(() => {
    if (tab !== 'groups' || !selectedWorkspaceId || !selectedGroupId) {
      setGroupAccess(null)
      return
    }
    void window.excelSync.groupResourceAccess(selectedWorkspaceId, selectedGroupId).then((data) => {
      setGroupAccess(data)
      const first = data.rules[0]
      const nextType = first?.scope_type ?? 'WORKSPACE'
      setGroupScopeType(nextType)
      setGroupPermission(first?.permission ?? 'VIEW')
      setGroupScopeValues(data.rules.filter((rule) => rule.scope_type === nextType).map((rule) => rule.scope_value))
      setGroupResourceSearch('')
    }).catch((error) => onToast(error instanceof Error ? error.message : String(error)))
  }, [tab, selectedWorkspaceId, selectedGroupId])

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setMembers([])
      return
    }
    void window.excelSync.workspaceMembers(selectedWorkspaceId).then(setMembers).catch((error) => onToast(error instanceof Error ? error.message : String(error)))
  }, [selectedWorkspaceId])

  useEffect(() => {
    if (tab !== 'resources') return
    if (resourceMembers.length === 0) {
      setSelectedResourceUserId('')
      setResourceAccess(null)
      return
    }
    if (!resourceMembers.some((member) => member.id === selectedResourceUserId)) {
      setSelectedResourceUserId(resourceMembers[0]?.id ?? '')
    }
  }, [tab, resourceMembers, selectedResourceUserId])

  useEffect(() => {
    if (tab !== 'resources' || !selectedWorkspaceId || !selectedResourceUserId) return
    void window.excelSync.resourceAccess(selectedWorkspaceId, selectedResourceUserId).then((data) => {
      setResourceAccess(data)
      setResourceRole(data.member.role)
      const firstType = data.rules[0]?.scope_type ?? 'WORKSPACE'
      setResourceScopeType(firstType)
      setResourceScopeValues(data.rules.filter((rule) => rule.scope_type === firstType).map((rule) => rule.scope_value))
      setResourceSearch('')
    }).catch((error) => onToast(error instanceof Error ? error.message : String(error)))
  }, [tab, selectedWorkspaceId, selectedResourceUserId])

  async function run(action: () => Promise<void>, success: string): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await action()
      await refreshCore()
      if (tab === 'audit' || tab === 'status') await refreshTab()
      onToast(success)
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function createInvite(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!inviteForm.workspaceId) return
    await run(async () => {
      const created = await window.excelSync.createInvite(inviteForm)
      setLastInviteCode(created.code)
      setInviteForm((current) => ({ ...current, username: '', displayName: '' }))
    }, '邀请码已创建。邀请码只会在创建或重新生成时显示。')
  }

  async function createGroup(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    const name = groupName.trim()
    if (!name) return
    await run(async () => {
      const created = await window.excelSync.createGroup(name)
      setSelectedGroupId(created.id)
      setGroupName('')
    }, '用户组已创建。')
  }

  async function saveGroupMembers(): Promise<void> {
    if (!selectedGroupId) return
    await run(async () => {
      await window.excelSync.replaceGroupMembers(selectedGroupId, selectedGroupUserIds)
      setGroupMembers(await window.excelSync.groupMembers(selectedGroupId))
    }, '用户组成员已更新。')
  }

  function changeGroupScopeType(nextType: ResourceScopeType): void {
    setGroupScopeType(nextType)
    if (!groupAccess) {
      setGroupScopeValues([])
      return
    }
    if (nextType === 'WORKSPACE') {
      setGroupScopeValues(selectedWorkspaceId ? [selectedWorkspaceId] : [])
      return
    }
    setGroupScopeValues(groupAccess.rules.filter((rule) => rule.scope_type === nextType).map((rule) => rule.scope_value))
  }

  function toggleGroupScopeValue(value: string): void {
    setGroupScopeValues((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value])
  }

  async function saveGroupAccess(): Promise<void> {
    if (!selectedGroupId || !selectedWorkspaceId) return
    const values = groupScopeType === 'WORKSPACE' ? [selectedWorkspaceId] : groupScopeValues
    if (values.length === 0) {
      onToast('至少选择一个用户组资源范围。')
      return
    }
    await run(async () => {
      await window.excelSync.replaceGroupResourceAccess(selectedWorkspaceId, selectedGroupId, {
        permission: groupPermission,
        scopes: values.map((scopeValue) => ({ scopeType: groupScopeType, scopeValue }))
      })
      setGroupAccess(await window.excelSync.groupResourceAccess(selectedWorkspaceId, selectedGroupId))
    }, '用户组资源权限已更新。')
  }

  async function showUserDevices(userId: string): Promise<void> {
    try {
      setSelectedDeviceUserId(userId)
      setSelectedUserDevices(await window.excelSync.adminUserDevices(userId))
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error))
    }
  }

  function editUserPolicy(user: AdminUserView): void {
    setSelectedPolicyUserId(user.id)
    setPolicyAccountType(user.account_type)
    setPolicyExpiresAt(user.access_expires_at)
  }

  async function saveUserPolicy(): Promise<void> {
    if (!selectedPolicyUserId) return
    await run(async () => {
      await window.excelSync.setUserAccountPolicy(selectedPolicyUserId, policyAccountType, policyExpiresAt)
      setSelectedPolicyUserId('')
    }, '账号类型与访问期限已更新。')
  }

  async function forceLogout(user: AdminUserView): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await window.excelSync.forceLogoutUser(user.id)
      if (user.id === currentUserId) {
        onToast('我的所有设备已注销。')
        await onSessionInvalidated()
        return
      }
      await refreshCore()
      onToast('此用户的所有设备已注销。')
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function createWorkspace(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    const name = workspaceForm.name.trim()
    if (!name) return
    await run(async () => {
      const created = await window.excelSync.createWorkspace({ name, type: workspaceForm.type })
      setSelectedWorkspaceId(created.id)
      setWorkspaceForm((current) => ({ ...current, name: '' }))
    }, '工作空间已创建。')
  }

  async function addMember(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!selectedWorkspaceId || !memberForm.userId) return
    await run(async () => {
      await window.excelSync.saveWorkspaceMember(selectedWorkspaceId, memberForm.userId, memberForm.role)
      setMembers(await window.excelSync.workspaceMembers(selectedWorkspaceId))
    }, '工作空间成员已更新。')
  }

  async function createStorage(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    const name = storageForm.name.trim()
    const token = storageForm.token.trim()
    if (!name || !token) return
    await run(async () => {
      await window.excelSync.createStorageConnection(name, token)
      setStorageForm({ name: '', token: '' })
    }, 'Telegram 存储连接已添加。Token 已发送给 Worker 加密保存，客户端未保留。')
  }

  async function beginPair(connection: StorageConnectionView): Promise<void> {
    await run(async () => {
      const info = await window.excelSync.startStoragePair(connection.id)
      setPairingStorageId(connection.id)
      await window.excelSync.openTelegramPairLink(info.deepLink)
    }, `已打开 @${connection.telegramBotUsername ?? 'Telegram Bot'}，发送 /start 后点击“确认配对”。`)
  }

  async function confirmPair(connection: StorageConnectionView): Promise<void> {
    await run(async () => {
      const result = await window.excelSync.confirmStoragePair(connection.id)
      const workspaceId = pairWorkspaceByStorage[connection.id]
      if (workspaceId) await window.excelSync.setWorkspaceStorage(workspaceId, connection.id)
      setPairingStorageId(null)
      onToast(workspaceId ? `已绑定 Telegram Chat：${result.chatTitle}，并设为所选 Workspace 默认存储。` : `已绑定 Telegram Chat：${result.chatTitle}`)
    }, '存储连接配对完成。')
  }

  function changeResourceScopeType(nextType: ResourceScopeType): void {
    setResourceScopeType(nextType)
    if (!resourceAccess) {
      setResourceScopeValues([])
      return
    }
    if (nextType === 'WORKSPACE') {
      setResourceScopeValues(selectedWorkspaceId ? [selectedWorkspaceId] : [])
      return
    }
    setResourceScopeValues(resourceAccess.rules.filter((rule) => rule.scope_type === nextType).map((rule) => rule.scope_value))
  }

  function toggleResourceValue(value: string): void {
    setResourceScopeValues((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value])
  }

  async function saveResourceAccess(): Promise<void> {
    if (!selectedWorkspaceId || !selectedResourceUserId) return
    const values = resourceScopeType === 'WORKSPACE' ? [selectedWorkspaceId] : resourceScopeValues
    if (values.length === 0) {
      onToast('至少选择一个资源范围。')
      return
    }
    await run(async () => {
      await window.excelSync.replaceResourceAccess(selectedWorkspaceId, selectedResourceUserId, {
        workspaceRole: resourceRole,
        scopes: values.map((scopeValue) => ({ scopeType: resourceScopeType, scopeValue }))
      })
      const data = await window.excelSync.resourceAccess(selectedWorkspaceId, selectedResourceUserId)
      setResourceAccess(data)
    }, '资源权限已更新。')
  }

  return <div className="admin-center page-stack">
    <section className="panel admin-hero">
      <div className="panel-header"><div><p className="eyebrow">ADMIN CENTER</p><h2>管理中心</h2><p className="muted">账号、Workspace、存储连接、审计与系统状态都由 Worker 权限校验。当前身份：{SYSTEM_ROLE_LABEL[systemRole]}。</p></div></div>
      <div className="admin-tabs">
        {([['users', '用户'], ['groups', '用户组'], ['workspaces', '工作空间'], ['resources', '资源权限'], ['storage', '存储连接'], ['audit', '审计日志'], ['status', '系统状态']] as Array<[AdminTab, string]>).map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
      </div>
    </section>

    {tab === 'users' && <>
      <section className="panel">
        <div className="panel-header"><div><h3>邀请成员</h3><p className="muted">管理员分发一次性邀请码，成员自行设置最终密码。</p></div></div>
        <form className="admin-form-grid" onSubmit={(event) => void createInvite(event)}>
          <label>显示名称<input value={inviteForm.displayName} onChange={(event) => setInviteForm((current) => ({ ...current, displayName: event.target.value }))} required /></label>
          <label>用户名<input value={inviteForm.username} onChange={(event) => setInviteForm((current) => ({ ...current, username: event.target.value }))} required /></label>
          <label>Workspace<select value={inviteForm.workspaceId} onChange={(event) => setInviteForm((current) => ({ ...current, workspaceId: event.target.value }))}>{workspaces.filter((item) => item.status === 'ACTIVE').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>账号类型<select value={inviteForm.accountType} onChange={(event) => setInviteForm((current) => ({ ...current, accountType: event.target.value as AccountType, workspaceRole: event.target.value === 'EXTERNAL' && current.workspaceRole === 'MANAGER' ? 'VIEWER' : current.workspaceRole }))}><option value="INTERNAL">内部成员</option><option value="EXTERNAL">外部协作人</option></select></label>
          <label>Workspace 权限<select value={inviteForm.workspaceRole} onChange={(event) => setInviteForm((current) => ({ ...current, workspaceRole: event.target.value as WorkspaceRole }))}><option value="VIEWER">查看者</option><option value="EDITOR">编辑者</option>{inviteForm.accountType === 'INTERNAL' && <option value="MANAGER">负责人</option>}</select></label>
          <label>账号到期时间（可选）<input type="datetime-local" value={inviteForm.userExpiresAt ? new Date(inviteForm.userExpiresAt).toISOString().slice(0, 16) : ''} onChange={(event) => setInviteForm((current) => ({ ...current, userExpiresAt: event.target.value ? new Date(event.target.value).toISOString() : null }))} /></label>
          <label>邀请码有效期（小时）<input type="number" min={1} max={720} value={inviteForm.expiresInHours} onChange={(event) => setInviteForm((current) => ({ ...current, expiresInHours: Number(event.target.value) || 72 }))} /></label>
          <div className="admin-form-action"><button className="primary" disabled={busy}>创建邀请码</button></div>
        </form>
        {lastInviteCode && <div className="invite-code-box"><span>一次性邀请码</span><strong>{lastInviteCode}</strong><small>请现在复制并发送给成员；D1 中只保存 Hash。</small></div>}
      </section>
      <section className="panel"><div className="panel-header"><div><h3>邀请状态</h3></div></div><div className="admin-table">
        {invites.map((invite) => <div className="admin-row" key={invite.id}><div><b>{invite.display_name}</b><small>{invite.username} · {invite.account_type === 'EXTERNAL' ? '外部协作人' : '内部成员'} · {invite.workspace_name ?? '未指定'} · {invite.workspace_role ? ROLE_LABEL[invite.workspace_role] : '—'}</small></div><span>{invite.status}</span><small>邀请至 {formatTime(invite.expires_at)}{invite.user_expires_at ? ` · 账号至 ${formatTime(invite.user_expires_at)}` : ''}</small><div className="row-actions">{invite.status === 'PENDING' && <><button className="secondary" disabled={busy} onClick={() => void run(async () => { const next = await window.excelSync.regenerateInvite(invite.id); setLastInviteCode(next.code) }, '邀请码已重新生成。')}>重新生成</button><button className="secondary danger" disabled={busy} onClick={() => void run(() => window.excelSync.revokeInvite(invite.id), '邀请已撤销。')}>撤销</button></>}</div></div>)}
      </div></section>
      <section className="panel"><div className="panel-header"><div><h3>用户</h3><p className="muted">暂停和停用都会让现有 Session 失效；停用不会删除 Workspace 文件、任务或审计历史。</p></div></div><div className="admin-table">
        {users.map((user) => <div className="admin-row admin-user-row" key={user.id}><div><b>{user.display_name}{user.id === currentUserId ? ' · 我' : ''}</b><small>{user.username} · {user.account_type === 'EXTERNAL' ? '外部协作人' : '内部成员'} · {SYSTEM_ROLE_LABEL[user.system_role]} · 最后登录 {formatTime(user.last_login_at)}{user.access_expires_at ? ` · 到期 ${formatTime(user.access_expires_at)}` : ''}</small></div><span>{user.status}</span><small>Workspace {user.workspace_count} · 设备 {user.active_devices} · Session {user.active_sessions} · 未完成任务 {user.open_tasks}</small><div className="row-actions">
          {systemRole === 'OWNER' && user.system_role !== 'OWNER' && user.account_type === 'INTERNAL' && <select value={user.system_role} onChange={(event) => void run(() => window.excelSync.setUserSystemRole(user.id, event.target.value as 'ADMIN' | 'MEMBER'), '系统角色已更新。')}><option value="MEMBER">成员</option><option value="ADMIN">管理员</option></select>}
          {user.status !== 'SUSPENDED' && user.system_role !== 'OWNER' && <button className="secondary" disabled={busy} onClick={() => void run(() => window.excelSync.setUserLifecycle(user.id, 'SUSPENDED').then(() => undefined), '用户已暂停，所有 Session 已失效。')}>暂停</button>}
          {user.status === 'SUSPENDED' && <button className="secondary" disabled={busy} onClick={() => void run(() => window.excelSync.setUserLifecycle(user.id, 'ACTIVE').then(() => undefined), '用户已恢复。')}>恢复</button>}
          {user.status !== 'DEACTIVATED' && user.system_role !== 'OWNER' && <button className="secondary danger" disabled={busy} onClick={() => void run(() => window.excelSync.setUserLifecycle(user.id, 'DEACTIVATED').then(() => undefined), '用户已停用。')}>停用</button>}
          <button className="secondary" disabled={busy} onClick={() => editUserPolicy(user)}>账号策略</button>
          <button className="secondary" disabled={busy} onClick={() => void showUserDevices(user.id)}>设备</button>
          <button className="secondary" disabled={busy} onClick={() => void forceLogout(user)}>注销全部设备</button>
        </div></div>)}
      </div></section>
      {selectedDeviceUserId && <section className="panel"><div className="panel-header"><div><h3>设备 Session</h3><p className="muted">显示所选用户已登记的设备和仍有效的 Session。管理员注销全部设备会立即让现有 Session 失效。</p></div><button className="secondary" onClick={() => { setSelectedDeviceUserId(''); setSelectedUserDevices([]) }}>关闭</button></div><div className="admin-table">{selectedUserDevices.map((device) => <div className="admin-row" key={device.id}><div><b>{device.deviceName}</b><small>{device.osName} {device.osVersion} · 客户端 {device.clientVersion}</small></div><span>{device.status}</span><small>首次 {formatTime(device.firstSeenAt)} · 最后活动 {formatTime(device.lastSeenAt)} · Session {device.activeSessions}</small></div>)}{selectedUserDevices.length === 0 && <div className="empty-state compact">该用户当前没有登记设备。</div>}</div></section>}
      {selectedPolicyUserId && <section className="panel"><div className="panel-header"><div><h3>账号策略</h3><p className="muted">内部成员可承担管理角色；外部协作人不能成为系统管理员或 Workspace 负责人。到期时间由 Worker 在每次请求时强制校验。</p></div><button className="secondary" onClick={() => setSelectedPolicyUserId('')}>关闭</button></div><div className="admin-form-grid"><label>账号类型<select value={policyAccountType} onChange={(event) => setPolicyAccountType(event.target.value as AccountType)}><option value="INTERNAL">内部成员</option><option value="EXTERNAL">外部协作人</option></select></label><label>访问到期时间（可选）<input type="datetime-local" value={policyExpiresAt ? new Date(policyExpiresAt).toISOString().slice(0, 16) : ''} onChange={(event) => setPolicyExpiresAt(event.target.value ? new Date(event.target.value).toISOString() : null)} /></label><div className="admin-form-action"><button className="primary" disabled={busy} onClick={() => void saveUserPolicy()}>保存账号策略</button></div></div></section>}
    </>}

    {tab === 'groups' && <>
      <section className="panel"><div className="panel-header"><div><h3>用户组</h3><p className="muted">组只负责批量继承资源范围；最终可执行动作仍受每个成员自己的 Workspace Role 上限约束。</p></div></div><form className="admin-form-grid" onSubmit={(event) => void createGroup(event)}><label>组名称<input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="例如：财务、外部审计、项目 A" required /></label><div className="admin-form-action"><button className="primary" disabled={busy}>创建用户组</button></div></form></section>
      <section className="panel"><div className="workspace-admin-grid"><div className="workspace-list">{groups.map((group) => <button key={group.id} className={selectedGroupId === group.id ? 'active' : ''} onClick={() => setSelectedGroupId(group.id)}><b>{group.name}</b><small>{group.status} · {group.memberCount} 人 · 更新 {formatTime(group.updatedAt)}</small></button>)}{groups.length === 0 && <div className="empty-state compact">还没有用户组。</div>}</div>{selectedGroupId && <div className="workspace-detail"><h4>{groups.find((item) => item.id === selectedGroupId)?.name ?? '用户组'}</h4><p className="muted">选择组成员；被暂停或停用的账号不会获得有效访问。</p><div className="scope-picker">{users.filter((item) => item.system_role === 'MEMBER' && item.status !== 'DEACTIVATED').map((user) => <label key={user.id}><input type="checkbox" checked={selectedGroupUserIds.includes(user.id)} onChange={() => setSelectedGroupUserIds((current) => current.includes(user.id) ? current.filter((id) => id !== user.id) : [...current, user.id])} /><span><b>{user.display_name}</b><small>{user.username} · {user.account_type === 'EXTERNAL' ? '外部协作人' : '内部成员'}</small></span></label>)}</div><div className="row-actions"><button className="primary" disabled={busy} onClick={() => void saveGroupMembers()}>保存组成员</button>{groups.find((item) => item.id === selectedGroupId)?.status === 'ACTIVE' && <button className="secondary danger" disabled={busy} onClick={() => void run(() => window.excelSync.archiveGroup(selectedGroupId), '用户组已归档。')}>归档组</button>}</div></div>}</div></section>
      {selectedGroupId && <section className="panel"><div className="panel-header"><div><h3>用户组资源权限</h3><p className="muted">对组授予 Workspace / Storage / Folder / File 范围。成员最终权限 = 个人规则与组规则合并后，再受 Workspace Role 上限约束。</p></div></div><div className="admin-form-grid resource-access-head"><label>Workspace<select value={selectedWorkspaceId} onChange={(event) => setSelectedWorkspaceId(event.target.value)}>{workspaces.filter((item) => item.status === 'ACTIVE').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>允许动作<select value={groupPermission} onChange={(event) => setGroupPermission(event.target.value as ResourcePermission)}><option value="VIEW">查看</option><option value="EDIT">编辑</option><option value="MANAGE">管理</option></select></label><label>资源范围<select value={groupScopeType} onChange={(event) => changeGroupScopeType(event.target.value as ResourceScopeType)}><option value="WORKSPACE">整个 Workspace</option><option value="STORAGE">指定 Storage</option><option value="FOLDER">指定文件夹</option><option value="FILE">指定文件</option></select></label></div>{!groupAccess ? <div className="empty-state compact">正在读取用户组权限…</div> : <>{groupScopeType === 'WORKSPACE' && <div className="scope-info">该组覆盖整个 Workspace；成员能否编辑/管理仍由成员自己的 Workspace Role 决定。</div>}{groupScopeType === 'STORAGE' && <div className="scope-picker">{groupAccess.storages.map((item) => <label key={item.id}><input type="checkbox" checked={groupScopeValues.includes(item.id)} onChange={() => toggleGroupScopeValue(item.id)} /><span><b>{item.name}</b><small>{item.status}</small></span></label>)}</div>}{groupScopeType === 'FOLDER' && <div className="scope-picker">{groupAccess.folders.map((folder) => <label key={folder}><input type="checkbox" checked={groupScopeValues.includes(folder)} onChange={() => toggleGroupScopeValue(folder)} /><span><b>{folder}</b><small>包含子目录</small></span></label>)}</div>}{groupScopeType === 'FILE' && <div className="resource-file-picker"><input placeholder="搜索文件名或路径…" value={groupResourceSearch} onChange={(event) => setGroupResourceSearch(event.target.value)} /><div className="scope-picker">{visibleGroupFiles.map((file) => <label key={file.id}><input type="checkbox" checked={groupScopeValues.includes(file.id)} onChange={() => toggleGroupScopeValue(file.id)} /><span><b>{file.logical_name}</b><small>{file.relative_path} · V{file.current_version}</small></span></label>)}</div></div>}<div className="resource-access-actions"><span>已选择 {groupScopeType === 'WORKSPACE' ? 1 : groupScopeValues.length} 个范围</span><button className="primary" disabled={busy || (groupScopeType !== 'WORKSPACE' && groupScopeValues.length === 0)} onClick={() => void saveGroupAccess()}>保存组权限</button></div></>}</section>}
    </>}

    {tab === 'workspaces' && <>
      <section className="panel"><div className="panel-header"><div><h3>创建 Workspace</h3></div></div><form className="admin-form-grid" onSubmit={(event) => void createWorkspace(event)}><label>名称<input value={workspaceForm.name} onChange={(event) => setWorkspaceForm((current) => ({ ...current, name: event.target.value }))} required /></label><label>类型<select value={workspaceForm.type} onChange={(event) => setWorkspaceForm((current) => ({ ...current, type: event.target.value as typeof workspaceForm.type }))}><option value="TEAM">团队</option><option value="PROJECT">项目</option><option value="PERSONAL">个人</option></select></label><div className="admin-form-action"><button className="primary" disabled={busy}>创建</button></div></form></section>
      <section className="panel"><div className="panel-header"><div><h3>工作空间</h3><p className="muted">归档不会硬删文件。默认存储只决定后续新版本写入位置。</p></div></div><div className="workspace-admin-grid"><div className="workspace-list">{workspaces.map((workspace) => <button key={workspace.id} className={selectedWorkspaceId === workspace.id ? 'active' : ''} onClick={() => setSelectedWorkspaceId(workspace.id)}><b>{workspace.name}</b><small>{workspace.type} · {workspace.status} · {workspace.member_count} 人 · {workspace.file_count} 文件</small></button>)}</div>{selectedWorkspace && <div className="workspace-detail"><h4>{selectedWorkspace.name}</h4><label>新版本默认存储<select value={selectedWorkspace.default_storage_connection_id ?? ''} onChange={(event) => void run(() => window.excelSync.setWorkspaceStorage(selectedWorkspace.id, event.target.value), 'Workspace 默认存储已更新；历史版本不会迁移。')}><option value="" disabled>选择存储连接</option>{storage.filter((item) => item.status !== 'DISABLED').map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label><button className="secondary" disabled={busy} onClick={() => void run(() => window.excelSync.setDefaultWorkspace(selectedWorkspace.id), '个人默认 Workspace 已更新。')}>设为我的默认 Workspace</button>{selectedWorkspace.status === 'ACTIVE' && <button className="secondary danger" disabled={busy} onClick={() => void run(() => window.excelSync.archiveWorkspace(selectedWorkspace.id), 'Workspace 已归档。')}>归档 Workspace</button>}</div>}</div></section>
      {selectedWorkspace && <section className="panel"><div className="panel-header"><div><h3>成员 · {selectedWorkspace.name}</h3></div></div><form className="admin-form-grid" onSubmit={(event) => void addMember(event)}><label>用户<select value={memberForm.userId} onChange={(event) => setMemberForm((current) => ({ ...current, userId: event.target.value }))}><option value="">选择用户</option>{users.filter((item) => item.status === 'ACTIVE').map((item) => <option key={item.id} value={item.id}>{item.display_name} · {item.username}</option>)}</select></label><label>角色<select value={memberForm.role} onChange={(event) => setMemberForm((current) => ({ ...current, role: event.target.value as WorkspaceRole }))}><option value="VIEWER">查看者</option><option value="EDITOR">编辑者</option><option value="MANAGER">负责人</option></select></label><div className="admin-form-action"><button className="primary" disabled={busy || !memberForm.userId}>添加 / 更新</button></div></form><div className="admin-table">{members.map((member) => <div className="admin-row" key={member.id}><div><b>{member.display_name}</b><small>{member.username} · {member.status}</small></div><select value={member.role} onChange={(event) => void run(() => window.excelSync.saveWorkspaceMember(selectedWorkspace.id, member.id, event.target.value as WorkspaceRole), '成员权限已更新。')}><option value="VIEWER">查看者</option><option value="EDITOR">编辑者</option><option value="MANAGER">负责人</option></select><small>{formatTime(member.joined_at)}</small><div className="row-actions"><button className="secondary danger" disabled={busy} onClick={() => void run(() => window.excelSync.removeWorkspaceMember(selectedWorkspace.id, member.id), '成员已移出 Workspace。')}>移除</button></div></div>)}</div></section>}
    </>}

    {tab === 'resources' && <>
      <section className="panel">
        <div className="panel-header"><div><h3>资源权限</h3><p className="muted">Workspace Role 决定操作上限；资源范围决定 MEMBER 实际能看到哪些逻辑文件。OWNER / ADMIN 始终拥有组织级全局可见与管理权限。</p></div></div>
        <div className="admin-form-grid resource-access-head">
          <label>Workspace<select value={selectedWorkspaceId} onChange={(event) => setSelectedWorkspaceId(event.target.value)}>{workspaces.filter((item) => item.status === 'ACTIVE').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>成员<select value={selectedResourceUserId} onChange={(event) => setSelectedResourceUserId(event.target.value)}><option value="">选择 MEMBER</option>{resourceMembers.map((member) => <option key={member.id} value={member.id}>{member.display_name} · {member.username}</option>)}</select></label>
          <label>Workspace Role<select value={resourceRole} onChange={(event) => setResourceRole(event.target.value as WorkspaceRole)}><option value="VIEWER">查看者</option><option value="EDITOR">编辑者</option><option value="MANAGER">负责人</option></select></label>
          <label>资源范围<select value={resourceScopeType} onChange={(event) => changeResourceScopeType(event.target.value as ResourceScopeType)}><option value="WORKSPACE">整个 Workspace</option><option value="STORAGE">指定 Bot / Storage</option><option value="FOLDER">指定文件夹</option><option value="FILE">指定文件</option></select></label>
        </div>
        {!selectedResourceUserId && <div className="empty-state compact">先选择一个普通 MEMBER。系统级 OWNER / ADMIN 不受资源范围隔离。</div>}
        {selectedResourceUserId && resourceAccess && <>
          <div className="resource-access-summary"><span>当前成员</span><b>{resourceAccess.member.display_name}</b><small>{resourceAccess.member.username} · {ROLE_LABEL[resourceAccess.member.role]}</small></div>
          {resourceAccess.inheritedRules.length > 0 && <div className="scope-info"><b>用户组继承</b><span>{resourceAccess.inheritedRules.map((rule) => `${rule.group_name}：${rule.permission} · ${rule.scope_type}`).join('；')}</span><small>个人规则与用户组规则取更高有效权限，再受 Workspace Role 上限约束。</small></div>}
          {resourceScopeType === 'WORKSPACE' && <div className="scope-info">该成员可见当前 Workspace 内全部逻辑文件；操作能力仍受所选 Workspace Role 限制。</div>}
          {resourceScopeType === 'STORAGE' && <div className="scope-picker">{resourceAccess.storages.map((item) => <label key={item.id}><input type="checkbox" checked={resourceScopeValues.includes(item.id)} onChange={() => toggleResourceValue(item.id)} /><span><b>{item.name}</b><small>{item.status} · 仅影响逻辑归属该 Storage 的文件；历史版本仍按版本自己的 storage_connection_id 读取</small></span></label>)}</div>}
          {resourceScopeType === 'FOLDER' && <div className="scope-picker">{resourceAccess.folders.length === 0 ? <div className="empty-state compact">当前可管理范围内没有文件夹。</div> : resourceAccess.folders.map((folder) => <label key={folder}><input type="checkbox" checked={resourceScopeValues.includes(folder)} onChange={() => toggleResourceValue(folder)} /><span><b>{folder}</b><small>包含该路径下的子目录和文件</small></span></label>)}</div>}
          {resourceScopeType === 'FILE' && <div className="resource-file-picker"><input aria-label="搜索可授权文件" placeholder="搜索文件名或路径…" value={resourceSearch} onChange={(event) => setResourceSearch(event.target.value)} /><div className="scope-picker">{visibleResourceFiles.length === 0 ? <div className="empty-state compact">没有匹配文件。</div> : visibleResourceFiles.map((file) => <label key={file.id}><input type="checkbox" checked={resourceScopeValues.includes(file.id)} onChange={() => toggleResourceValue(file.id)} /><span><b>{file.logical_name}</b><small>{file.relative_path} · V{file.current_version}</small></span></label>)}</div></div>}
          <div className="resource-access-actions"><span>已选择 {resourceScopeType === 'WORKSPACE' ? 1 : resourceScopeValues.length} 个范围</span><button className="primary" disabled={busy || (resourceScopeType !== 'WORKSPACE' && resourceScopeValues.length === 0)} onClick={() => void saveResourceAccess()}>保存资源权限</button></div>
        </>}
      </section>
    </>}

    {tab === 'storage' && <>
      <section className="panel"><div className="panel-header"><div><h3>添加 Telegram 存储</h3><p className="muted">Bot Token 只用于这次 HTTPS 请求；验证成功后由 Worker 使用 STORAGE_MASTER_KEY + AES-GCM 加密写入 D1。</p></div></div><form className="admin-form-grid storage-form" onSubmit={(event) => void createStorage(event)}><label>连接名称<input value={storageForm.name} onChange={(event) => setStorageForm((current) => ({ ...current, name: event.target.value }))} required /></label><label>Bot Token<input type="password" autoComplete="off" value={storageForm.token} onChange={(event) => setStorageForm((current) => ({ ...current, token: event.target.value }))} required /></label><div className="admin-form-action"><button className="primary" disabled={busy}>验证并添加</button></div></form></section>
      <section className="panel"><div className="panel-header"><div><h3>存储连接</h3></div><button className="secondary" disabled={busy} onClick={() => void run(() => window.excelSync.checkStorageHealth().then(() => undefined), '存储健康检查已完成。')}>检查全部</button></div><div className="admin-table">{storage.map((connection) => <div className="admin-row storage-row" key={connection.id}><div><b>{connection.name}</b><small>@{connection.telegramBotUsername ?? '—'} · {connection.chatTitle || '未配对 Chat'} · Token {connection.credentialSource === 'ENCRYPTED' ? '已加密' : '旧版 Worker Secret'}</small></div><span>{connection.status}</span><small>检查 {formatTime(connection.lastHealthCheckAt)}{connection.lastError ? ` · ${connection.lastError}` : ''}</small><div className="row-actions storage-pair-actions"><select aria-label={`配对后绑定 ${connection.name} 到 Workspace`} value={pairWorkspaceByStorage[connection.id] ?? ''} onChange={(event) => setPairWorkspaceByStorage((current) => ({ ...current, [connection.id]: event.target.value }))}><option value="">配对后不自动绑定 Workspace</option>{workspaces.filter((item) => item.status === 'ACTIVE').map((item) => <option key={item.id} value={item.id}>绑定到 {item.name}</option>)}</select><button className="secondary" disabled={busy} onClick={() => void beginPair(connection)}>开始配对</button>{pairingStorageId === connection.id && <button className="primary" disabled={busy} onClick={() => void confirmPair(connection)}>确认配对</button>}<button className="secondary" disabled={busy} onClick={() => { const token = window.prompt('输入新的 Bot Token。旧 Token 不会显示。')?.trim(); if (token) void run(() => window.excelSync.rotateStorageToken(connection.id, token), 'Bot Token 已更换并重新加密保存。') }}>更换 Token</button>{connection.status !== 'DISABLED' && <button className="secondary danger" disabled={busy} onClick={() => void run(() => window.excelSync.disableStorageConnection(connection.id), '存储连接已停用。')}>停用</button>}</div></div>)}</div></section>
    </>}

    {tab === 'audit' && <section className="panel"><div className="panel-header"><div><h3>审计日志</h3><p className="muted">记录关键管理动作，不记录密码、Bot Token、邀请码明文或 Session Token。</p></div></div><div className="admin-table">{audit.map((row) => <div className="admin-row audit-row" key={row.id}><div><b>{row.action}</b><small>{row.actor_display_name || row.actor_username || 'SYSTEM'} · {row.target_type}{row.target_id ? ` · ${row.target_id}` : ''}</small></div><small>{formatTime(row.created_at)}</small><code>{row.detail_json || '—'}</code></div>)}</div></section>}

    {tab === 'status' && <>
      <section className="panel"><div className="panel-header"><div><h3>系统状态</h3></div><button className="secondary" onClick={() => void refreshTab()}>刷新</button></div>{status ? <div className="system-metrics"><div><span>Worker</span><b>{status.worker}</b></div><div><span>D1</span><b>{status.database}</b></div><div><span>活跃用户</span><b>{status.activeUsers}</b></div><div><span>Workspace</span><b>{status.activeWorkspaces}</b></div><div><span>待处理任务</span><b>{status.pendingTasks}</b></div><div><span>冲突 / 错误</span><b>{status.conflictCount} / {status.syncErrorCount}</b></div></div> : <div className="empty-state compact">正在读取系统状态…</div>}<div className="admin-table">{status?.storageConnections.map((connection) => <div className="admin-row" key={connection.id}><div><b>{connection.name}</b><small>{connection.provider} · @{connection.telegramBotUsername ?? '—'}</small></div><span>{connection.status}</span><small>{formatTime(connection.lastHealthCheckAt)}</small></div>)}</div></section>
      <section className="panel"><div className="panel-header"><div><h3>历史版本完整性</h3><p className="muted">审计 V1…Vn metadata、远端文件引用和 Storage 引用。只在真实远端字节通过 SHA-256 校验时补回缺失的当前版本 metadata；更老的无证据缺口不会伪造。</p></div><button className="secondary" disabled={busy} onClick={() => void run(() => window.excelSync.repairVersionIntegrity().then(() => undefined), '完整性修复已执行；只修复可验证项目。')}>安全修复可恢复项</button></div>{integrity ? <><div className="system-metrics integrity-metrics"><div><span>健康</span><b>{integrity.summary.HEALTHY ?? 0}</b></div><div><span>缺 metadata</span><b>{integrity.summary.MISSING_METADATA ?? 0}</b></div><div><span>缺 Storage</span><b>{integrity.summary.MISSING_STORAGE_REFERENCE ?? 0}</b></div><div><span>缺远端引用</span><b>{integrity.summary.MISSING_REMOTE_FILE_REFERENCE ?? 0}</b></div><div><span>旧版本不可恢复</span><b>{integrity.summary.LEGACY_UNRECOVERABLE ?? 0}</b></div></div><div className="admin-table">{integrity.findings.filter((item) => item.status !== 'HEALTHY').map((item) => <div className="admin-row integrity-row" key={item.file_id}><div><b>{item.logical_name}</b><small>{item.workspace_name} · {item.relative_path}</small></div><span>{item.status}</span><small>V{item.current_version} · 缺失 {item.missing_versions.join(', ') || '—'}</small><div className="row-actions">{item.current_reference_repairable && <button className="secondary" disabled={busy} onClick={() => void run(() => window.excelSync.repairVersionIntegrity(item.file_id).then(() => undefined), `已尝试修复 ${item.logical_name} 的当前版本 metadata。`)}>修复当前版本</button>}</div></div>)}{integrity.findings.every((item) => item.status === 'HEALTHY') && <div className="empty-state compact">当前未发现历史版本完整性缺口。</div>}</div></> : <div className="empty-state compact">正在读取版本完整性…</div>}</section>
    </>}
  </div>
}
