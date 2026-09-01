import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  ActivityView,
  AuthState,
  AdvancedSearchFileView,
  AdvancedSearchInput,
  ClientVersionInfo,
  DashboardView,
  DeviceView,
  FileCommentView,
  FileLeaseView,
  FilePresenceView,
  LocalFileView,
  NotificationListView,
  NotificationView,
  PendingView,
  ProblemView,
  PreviewView,
  RewindOperationView,
  RewindPreviewView,
  SettingsView,
  SystemRole,
  TelegramUserStorageStatusView,
  TransferProgressView,
  TrashFileView,
  UserTaskView,
  VersionDiffView,
  VersionView,
  WorkspaceMembershipView,
  WorkspaceRole as CloudWorkspaceRole
} from '../../shared/contracts'
import { FILE_PARTITIONS, extensionLabel, filePartitionForName, filePartitionLabel, type FilePartition } from '../../shared/file-types'
import { EnterpriseAdminCenter } from './EnterpriseAdminCenter'

type Page = 'dashboard' | 'files' | 'favorites' | 'trash' | 'tasks' | 'activity' | 'settings' | 'admin'
type ActionKey = 'importFiles' | 'importFolder' | 'syncNow' | 'pauseSync' | 'chooseFolder' | 'openFolder' | 'saveSettings'
type ActionFeedback = { key: ActionKey; label: string; state: 'running' | 'done' | 'error'; detail: string }
type UiTaskStatus = 'running' | 'done' | 'error'
type UiTask = { id: string; label: string; operation: string; status: UiTaskStatus; completed: number; total: number; detail: string; updatedAt: number }
type UserTaskStatus = 'todo' | 'running' | 'done'
type UserTaskPriority = 'low' | 'medium' | 'high' | 'urgent'
type TaskTemplateId = 'sync-now' | 'import-files' | 'import-folder' | 'retry-failed' | 'review-conflicts' | 'custom'
type TaskDraft = { templateId?: TaskTemplateId; title?: string; description?: string; linkedFileId?: string; linkedResourceLabel?: string }
type UserTask = { id: string; title: string; description: string; templateId: TaskTemplateId; status: UserTaskStatus; priority: UserTaskPriority; dueDate: string; assignee?: string; assigneeUserId?: string | null; workspaceId?: string; linkedFileId?: string; linkedResourceLabel?: string; createdAt: number; updatedAt: number }
type TaskTemplate = { id: TaskTemplateId; title: string; description: string; defaultTitle: string; defaultDescription: string; priority: UserTaskPriority; runnable: boolean; badge: string }

const USER_TASKS_STORAGE_KEY = 'excel-sync-user-tasks-v2'
const LEGACY_USER_TASKS_STORAGE_KEY = 'excel-sync-user-tasks-v1'
const SYSTEM_ROLE_LABELS: Record<SystemRole, string> = { OWNER: 'Owner', ADMIN: '管理员', MEMBER: '成员' }
const WORKSPACE_ROLE_LABELS: Record<CloudWorkspaceRole, string> = { MANAGER: '负责人', EDITOR: '编辑者', VIEWER: '查看者' }
const TASK_TEMPLATES: TaskTemplate[] = [
  { id: 'sync-now', title: '立即同步', description: '立刻检查本地变更并推送当前同步队列。', defaultTitle: '执行一次完整同步', defaultDescription: '检查当前同步目录，将等待同步的文件立即推送到云端。', priority: 'medium', runnable: true, badge: '同步' },
  { id: 'import-files', title: '导入文件', description: '选择一批文件，加入 ExcelSync 管理和同步。', defaultTitle: '导入一批文件', defaultDescription: '从本机选择需要加入 ExcelSync 的文件，并进入同步队列。', priority: 'medium', runnable: true, badge: '导入' },
  { id: 'import-folder', title: '导入文件夹', description: '批量导入文件夹并保留原有目录结构。', defaultTitle: '导入一个文件夹', defaultDescription: '选择一个文件夹，保留目录层级批量导入可支持文件。', priority: 'medium', runnable: true, badge: '批量' },
  { id: 'retry-failed', title: '重试失败任务', description: '把错误和等待重试的同步任务重新排队。', defaultTitle: '重试全部失败同步', defaultDescription: '重新排队当前 ERROR / RETRY_WAIT 项，并刷新任务状态。', priority: 'high', runnable: true, badge: '恢复' },
  { id: 'review-conflicts', title: '处理版本冲突', description: '建立冲突处理清单，逐项决定保留本地、云端或两者。', defaultTitle: '处理当前版本冲突', defaultDescription: '逐项检查冲突文件，并明确选择保留本地、云端或两个版本。', priority: 'urgent', runnable: false, badge: '冲突' },
  { id: 'custom', title: '自定义任务', description: '创建一个自己的文件整理、检查或跟进任务。', defaultTitle: '', defaultDescription: '', priority: 'low', runnable: false, badge: '自定义' }
]

const EMPTY_AUTH: AuthState = { authenticated: false }

function cloudTaskToUserTask(task: UserTaskView): UserTask {
  const status: UserTaskStatus = task.status === 'DONE' ? 'done' : task.status === 'IN_PROGRESS' ? 'running' : 'todo'
  const priority: UserTaskPriority = task.priority.toLowerCase() as UserTaskPriority
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    templateId: 'custom',
    status,
    priority,
    dueDate: task.due_at ? task.due_at.slice(0, 10) : '',
    assignee: task.assignee_name ?? task.legacy_assignee_text ?? undefined,
    assigneeUserId: task.assignee_user_id,
    workspaceId: task.workspace_id,
    linkedFileId: task.file_ids[0],
    linkedResourceLabel: task.file_ids.length > 0 ? `${task.file_ids.length} 个关联文件` : undefined,
    createdAt: Date.parse(task.created_at) || Date.now(),
    updatedAt: Date.parse(task.updated_at) || Date.now()
  }
}

const PAGE_LABELS: Record<Page, string> = {
  dashboard: '概览',
  files: '文件',
  favorites: '收藏',
  trash: '回收站',
  tasks: '任务',
  activity: '同步记录',
  settings: '设置',
  admin: '管理中心'
}

const STATUS_LABELS: Record<LocalFileView['status'], string> = {
  SYNCED: '已同步',
  PENDING: '等待同步',
  UPLOADING: '正在上传',
  RETRY_WAIT: '等待重试',
  CONFLICT: '存在冲突',
  ERROR: '错误'
}

function fileStatusLabel(file: LocalFileView): string {
  if (file.currentVersion > 0 && !file.exists) return '仅云端'
  return STATUS_LABELS[file.status]
}

function fileStatusClass(file: LocalFileView): string {
  if (file.currentVersion > 0 && !file.exists) return 'cloud-only'
  return file.status.toLowerCase()
}

function storageBackendLabel(backend?: 'telegram_user_group' | 'telegram_bot' | null): string {
  return backend === 'telegram_user_group' ? 'Telegram 私人群组' : backend === 'telegram_bot' ? 'Telegram Bot' : '存储未知'
}

const ACTIVITY_LABELS: Record<string, string> = {
  RENAMED: '本地文件已重命名',
  PENDING: '已加入同步队列',
  RENAME_PENDING: '重命名等待同步',
  LOCAL_COPY_REMOVED: '本地副本已删除，云端保留',
  LOCAL_COPY_RESTORED: '已恢复本地副本',
  SAAS_TRASHED: '已移入 SaaS 回收站',
  SAAS_TRASH_RESTORED: '已从 SaaS 回收站恢复',
  LEGACY_DELETE_QUEUE_CLEARED: '已清除旧版自动删除队列',
  LEGACY_DELETE_IGNORED: '已忽略旧版自动删除请求',
  DELETE_PENDING: '旧版删除等待同步',
  RETRY_WAIT: '等待重试',
  ERROR: '同步错误',
  CONFLICT: '同步冲突',
  SYNCED: '同步完成',
  DELETE_SYNCED: '删除已同步',
  RENAME_SYNCED: '重命名已同步',
  REMOTE_APPLIED: '云端文件已同步到本地',
  REMOTE_PATH_CONFLICT: '云端路径冲突',
  REMOTE_PATH_REJECTED: '云端路径被拒绝',
  REMOTE_PULL_ERROR: '拉取云端文件失败'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function formatTime(value: string | number): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN')
}

function shortHash(hash: string | null): string {
  return hash ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : '—'
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, '') : String(error)
  const known: Record<string, string> = {
    SETUP_CODE_REQUIRED: '首次初始化凭据不可用，请重新准备客户端初始化。',
    AUTH_REQUIRED: '登录状态已失效，请重新登录。',
    INVALID_SESSION: '登录状态已失效，请重新登录。',
    INVALID_CREDENTIALS: '用户名或密码不正确。',
    WORKER_URL_MUST_USE_HTTPS: 'Worker 地址必须使用 HTTPS。',
    SYNC_DIRECTORY_NOT_CONFIGURED: '请先在“设置”中选择同步文件夹。',
    FILE_NOT_FOUND: '找不到该文件。',
    UNSUPPORTED_EXCEL_FILE: '该文件类型不在当前支持列表中。',
    UNSUPPORTED_FILE_TYPE: '该文件类型不在当前支持列表中。',
    FILE_SIGNATURE_MISMATCH: '文件后缀与实际文件内容不一致，为避免错误同步已拒绝导入。',
    NOT_A_FILE: '选择的项目不是有效文件。',
    IMPORT_NAME_EXHAUSTED: '同名文件过多，无法生成新的导入文件名。',
    TELEGRAM_CHAT_NOT_CONNECTED: 'Telegram 尚未完成配对。',
    TELEGRAM_SECRET_NOT_CONFIGURED: 'Telegram Bot 密钥尚未配置。',
    FILE_TOO_LARGE: '文件超过当前所选存储后端的可靠大小上限。Telegram Bot 请切换到“Telegram 私人群组”处理大文件。',
    DESKTOP_STORAGE_REQUIRED: 'Telegram 私人群组文件需要 Windows ExcelSync 客户端处理。',
    TELEGRAM_USER_STORAGE_UNAVAILABLE: 'Telegram 私人群组本机存储尚不可用，请在“设置 → 存储”完成授权。',
    TELEGRAM_USER_STORAGE_NOT_CONFIGURED: 'Telegram 私人群组本机凭据尚未配置。',
    TELEGRAM_AUTHORIZATION_LOST: 'Telegram 授权已失效或被撤销，请重新验证。',
    TELEGRAM_CODE_INVALID: 'Telegram 验证码不正确，请重新输入。',
    TELEGRAM_CODE_EXPIRED: 'Telegram 验证码已过期，请重新发送验证码。',
    TELEGRAM_2FA_INVALID: 'Telegram 2FA 密码不正确，请重新输入。',
    TELEGRAM_RATE_LIMITED: 'Telegram 请求过于频繁，请稍后再试。',
    DOWNLOAD_HASH_MISMATCH: '下载完整性校验失败，已拒绝覆盖正式文件。',
    IMPORT_TOO_MANY_FILES: '这个文件夹里的可同步文件过多，一次最多导入 20,000 个。',
    LOCAL_PATH_OCCUPIED: '本地已有其他文件占用了同一个同步路径。',
    PATH_ALREADY_EXISTS: '云端已经存在同一路径的文件。',
    FILE_LOCKED: '该文件正在被其他设备编辑。请先请求接管，或由管理员强制接管。',
    LEASE_LOST: '当前设备的编辑锁已失效或被接管，请重新打开文件。',
    LOCK_TAKEOVER_FORBIDDEN: '当前账号没有强制接管编辑锁的权限。',
    VERSION_UNAVAILABLE: '该历史版本当前不可用。',
    REWIND_TARGET_BEFORE_HISTORY_BASELINE: '目标时间早于可验证历史基线，不能安全回退。'
  }
  const matched = Object.entries(known).find(([code]) => raw.includes(code))
  return matched ? matched[1] : raw
}

function StatusDot({ active, warning = false }: { active: boolean; warning?: boolean }): ReactElement {
  return <span className={`status-dot ${active ? (warning ? 'warning' : 'good') : 'bad'}`} />
}

function ActionButton({ actionKey, label, className, busyAction, disabled = false, onClick }: {
  actionKey: ActionKey
  label: string
  className: 'primary' | 'secondary'
  busyAction: ActionKey | null
  disabled?: boolean
  onClick: () => void
}): ReactElement {
  const busy = busyAction === actionKey
  return (
    <button className={`${className} action-button${busy ? ' is-busy' : ''}`} disabled={disabled || (busyAction !== null && !busy) || busy} onClick={onClick}>
      <span>{busy ? `${label}处理中…` : label}</span>
    </button>
  )
}

function AuthScreen({ auth, onAuthenticated, embedded = false }: { auth: AuthState; onAuthenticated: () => Promise<void>; embedded?: boolean }): ReactElement {
  const [mode, setMode] = useState<'login' | 'join'>('login')
  const [username, setUsername] = useState('owner')
  const [inviteCode, setInviteCode] = useState('')
  const [password, setPassword] = useState('')
  const [workerUrl, setWorkerUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const isSetup = Boolean(auth.setupProvisioned)

  useEffect(() => {
    void window.excelSync.settings().then((settings) => setWorkerUrl(settings.workerUrl))
  }, [])

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (!workerUrl.trim()) throw new Error('请输入 Worker 地址。')
      await window.excelSync.updateSettings({ workerUrl: workerUrl.trim() })
      if (isSetup) await window.excelSync.bootstrap(username.trim(), password, '')
      else if (mode === 'join') await window.excelSync.activateInvite(inviteCode.trim(), password)
      else await window.excelSync.login(username.trim(), password)
      setPassword('')
      setInviteCode('')
      await onAuthenticated()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={embedded ? 'auth-inline' : 'auth-shell'}>
      <section className="auth-card">
        <div className="brand-mark">XS</div>
        <p className="eyebrow">WINDOWS 文件工作台</p>
        <h1>{isSetup ? '初始化企业与 Owner' : mode === 'join' ? '加入组织' : '登录 ExcelSync'}</h1>
        <p className="muted">{isSetup ? '第一次使用会创建默认 Organization、Owner 和默认 Workspace。' : mode === 'join' ? '输入管理员分发的一次性邀请码，然后设置你自己的密码。' : '登录后，Worker 会返回真实系统角色和 Workspace Membership，客户端不会允许手动切换管理员视图。'}</p>
        {!isSetup && <div className="auth-mode-tabs"><button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError('') }}>登录</button><button type="button" className={mode === 'join' ? 'active' : ''} onClick={() => { setMode('join'); setError('') }}>邀请码加入</button></div>}
        <form onSubmit={(event) => void submit(event)}>
          <label>Worker 地址<input value={workerUrl} onChange={(event) => setWorkerUrl(event.target.value)} placeholder="https://excel-sync-worker….workers.dev" /></label>
          {(isSetup || mode === 'login') && <label>用户名<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>}
          {!isSetup && mode === 'join' && <label>一次性邀请码<input value={inviteCode} onChange={(event) => setInviteCode(event.target.value.toUpperCase())} placeholder="XS-K8P4-29QM" autoComplete="off" /></label>}
          <label>密码<input type="password" value={password} minLength={isSetup || mode === 'join' ? 12 : 1} onChange={(event) => setPassword(event.target.value)} autoComplete={isSetup || mode === 'join' ? 'new-password' : 'current-password'} placeholder={isSetup || mode === 'join' ? '至少 12 个字符' : ''} /></label>
          {error && <div className="error-banner">{error}</div>}
          <button className="primary full" type="submit" disabled={busy || (!isSetup && mode === 'join' && !inviteCode.trim())}>{busy ? '正在处理…' : isSetup ? '创建 Owner 并登录' : mode === 'join' ? '激活账号并加入' : '登录'}</button>
        </form>
      </section>
    </div>
  )
}

function Dashboard({ data, files, problems, paused, cloudEnabled, onSync, onPause, onOpen, onPreview, onTasks, onProblem, busyAction }: {
  data: DashboardView | null
  files: LocalFileView[]
  problems: ProblemView[]
  paused: boolean
  cloudEnabled: boolean
  onSync: () => Promise<void>
  onPause: () => Promise<void>
  onOpen: (id: string) => Promise<void>
  onPreview: (file: LocalFileView) => Promise<void>
  onTasks: () => void
  onProblem: (problem: ProblemView) => Promise<void>
  busyAction: ActionKey | null
}): ReactElement {
  if (!data) return <div className="empty-state">正在读取状态…</div>
  const health = data.health
  const recentOpened = files.filter((file) => file.lastOpenedAt).sort((a, b) => Date.parse(b.lastOpenedAt ?? '') - Date.parse(a.lastOpenedAt ?? '')).slice(0, 5)
  const recentModified = [...files].sort((a, b) => (b.mtimeMs || Date.parse(b.updatedAt)) - (a.mtimeMs || Date.parse(a.updatedAt))).slice(0, 5)
  const issues = data.waitingRetry + data.needsAttention
  const cloudOk = health.online && health.worker === 'ok' && health.telegram.reachable
  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">继续工作</p>
          <h2>{!cloudEnabled ? '本地文件已就绪，登录后启用云同步' : paused ? '同步已暂停' : issues > 0 ? `${issues} 项需要处理` : '文件已同步，可以继续工作'}</h2>
          <p className="muted">打开最近文件，或处理等待同步、冲突和失败任务。技术连接信息默认收起。</p>
        </div>
        <div className="hero-actions">
          <ActionButton actionKey="pauseSync" label={paused ? '恢复同步' : '暂停同步'} className="secondary" busyAction={busyAction} disabled={!cloudEnabled} onClick={() => void onPause()} />
          <ActionButton actionKey="syncNow" label="立即同步" className="primary" busyAction={busyAction} disabled={!cloudEnabled || paused} onClick={() => void onSync()} />
        </div>
      </section>

      <div className="dashboard-work-grid">
        <section className="panel">
          <div className="panel-header"><div><h3>最近打开</h3><p className="muted">优先继续最近真正打开过的文件。</p></div></div>
          {recentOpened.length === 0 ? <div className="empty-state compact">还没有打开记录。</div> : <div className="recent-file-list">{recentOpened.map((file) => <div className="recent-file-row" key={file.id}><span className="file-icon">{extensionLabel(file.logicalName)}</span><div><b>{file.logicalName}</b><small>{file.relativePath} · {formatTime(file.lastOpenedAt ?? '')}</small></div><span className={`status-chip ${fileStatusClass(file)}`}>{fileStatusLabel(file)}</span><button className="text-button" onClick={() => void onPreview(file)}>预览</button><button className="text-button" onClick={() => void onOpen(file.id)}>打开</button></div>)}</div>}
          <div className="recent-subhead">最近修改</div>
          {recentModified.length > 0 && <div className="recent-file-list compact-list">{recentModified.map((file) => <div className="recent-file-row" key={`modified-${file.id}`}><span className="file-icon">{extensionLabel(file.logicalName)}</span><div><b>{file.logicalName}</b><small>{file.relativePath} · {formatTime(file.mtimeMs || file.updatedAt)}</small></div><button className="text-button" onClick={() => void onOpen(file.id)}>打开</button></div>)}</div>}
        </section>

        <section className="panel attention-panel">
          <div className="panel-header"><div><h3>需要处理</h3><p className="muted">只显示会影响继续工作的状态。</p></div>{issues > 0 && <button className="text-button" onClick={onTasks}>打开任务中心</button>}</div>
          <div className="attention-list">
            <div><span>正在同步</span><b>{data.syncing}</b></div>
            <div><span>自动等待重试</span><b>{data.waitingRetry}</b></div>
            <div><span>需要人工处理</span><b>{data.needsAttention}</b></div>
          </div>
          {problems.length > 0 && <div className="problem-center-list">{problems.slice(0, 6).map((problem) => <div className={`problem-center-row ${problem.severity.toLowerCase()}`} key={problem.id}><div><b>{problem.logicalName}</b><small>{problem.title} · {problem.message}{problem.nextRetryAt ? ` · 下次尝试 ${formatTime(problem.nextRetryAt)}` : ''}</small></div><span>{problem.automatic ? '自动恢复' : '需要处理'}</span>{problem.action !== 'NONE' && <button className="text-button" onClick={() => void onProblem(problem)}>{problem.action === 'LOGIN' ? '登录' : problem.action === 'OPEN_LOCATION' ? '打开位置' : problem.action === 'RESOLVE_CONFLICT' ? '处理冲突' : '重试'}</button>}</div>)}</div>}
          <div className="cloud-summary"><StatusDot active={cloudOk} warning={!cloudOk && health.online} /><span>云端服务</span><b>{cloudOk ? '正常' : health.online ? '需要检查' : '当前离线'}</b></div>
          <details className="advanced-details"><summary>查看连接详细信息</summary><div><span>服务网关</span><b>{health.worker === 'ok' ? '正常' : health.worker === 'offline' ? '离线' : '异常'}</b></div><div><span>文件存储</span><b>{health.telegram.reachable ? '已连接' : health.telegram.tokenConfigured ? '需要重新连接' : '未配置'}</b></div></details>
        </section>
      </div>

      <section className="panel">
        <div className="panel-header"><h3>最近同步记录</h3></div>
        <ActivityList rows={data.recentActivity} compact />
      </section>
    </div>
  )
}

function MarkdownPreview({ text }: { text: string }): ReactElement {
  const lines = text.split(/\r?\n/)
  return <div className="markdown-preview">{lines.map((line, index) => {
    if (line.startsWith('### ')) return <h4 key={index}>{line.slice(4)}</h4>
    if (line.startsWith('## ')) return <h3 key={index}>{line.slice(3)}</h3>
    if (line.startsWith('# ')) return <h2 key={index}>{line.slice(2)}</h2>
    if (/^[-*] /.test(line)) return <div className="markdown-bullet" key={index}>• {line.slice(2)}</div>
    if (line.startsWith('> ')) return <blockquote key={index}>{line.slice(2)}</blockquote>
    if (line.startsWith('```')) return <div className="markdown-code-marker" key={index}>{line}</div>
    return <p key={index}>{line || '\u00a0'}</p>
  })}</div>
}

function NotificationCenter({ open, data, filter, onToggle, onFilter, onRead, onReadAll, onOpenResource }: {
  open: boolean
  data: NotificationListView | null
  filter: 'all' | 'unread' | 'file' | 'task' | 'system'
  onToggle: () => void
  onFilter: (filter: 'all' | 'unread' | 'file' | 'task' | 'system') => void
  onRead: (notification: NotificationView) => Promise<void>
  onReadAll: () => Promise<void>
  onOpenResource: (notification: NotificationView) => void
}): ReactElement {
  const unread = data?.unreadCount ?? 0
  return <div className="notification-center">
    <button className="notification-button" aria-label="通知中心" aria-expanded={open} onClick={onToggle}>通知{unread > 0 && <span>{unread > 99 ? '99+' : unread}</span>}</button>
    {open && <div className="notification-popover">
      <div className="notification-head"><div><b>通知中心</b><span>{unread > 0 ? `${unread} 条未读` : '没有未读通知'}</span></div><button className="text-button" disabled={unread === 0} onClick={() => void onReadAll()}>全部已读</button></div>
      <div className="notification-filters">{([['all', '全部'], ['unread', '未读'], ['file', '文件'], ['task', '任务'], ['system', '系统']] as const).map(([id, label]) => <button key={id} className={filter === id ? 'active' : ''} onClick={() => onFilter(id)}>{label}</button>)}</div>
      <div className="notification-list">{!data ? <div className="empty-state compact">正在读取通知…</div> : data.notifications.length === 0 ? <div className="empty-state compact">当前筛选下没有通知。</div> : data.notifications.map((notice) => <article key={notice.id} className={notice.read_at ? 'read' : 'unread'}><button className="notification-main" onClick={() => { onOpenResource(notice); void onRead(notice) }}><b>{notice.title}</b><p>{notice.body}</p><span>{formatTime(notice.created_at)}</span></button>{!notice.read_at && <button className="notification-read" aria-label="标记已读" onClick={() => void onRead(notice)}>✓</button>}</article>)}</div>
    </div>}
  </div>
}

function PreviewDrawer({ file, preview, presence, activity, loading, canEdit, canManageLock, onClose, onOpen, onSheet, onVersions, onToast }: {
  file: LocalFileView | null
  preview: PreviewView | null
  presence: FilePresenceView | null
  activity: ActivityView[]
  loading: boolean
  canEdit: boolean
  canManageLock: boolean
  onClose: () => void
  onOpen: () => Promise<void>
  onSheet: (sheet: string) => Promise<void>
  onVersions: () => Promise<void>
  onToast: (message: string) => void
}): ReactElement | null {
  const [query, setQuery] = useState('')
  const [sortColumn, setSortColumn] = useState<number | null>(null)
  const [sortAsc, setSortAsc] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [tab, setTab] = useState<'preview' | 'comments' | 'versions' | 'activity'>('preview')
  const [lease, setLease] = useState<FileLeaseView | null>(null)
  const [comments, setComments] = useState<FileCommentView[]>([])
  const [commentBody, setCommentBody] = useState('')
  const [collabBusy, setCollabBusy] = useState(false)
  useEffect(() => { setQuery(''); setSortColumn(null); setSortAsc(true); setZoom(1); setTab('preview'); setCommentBody('') }, [file?.id])
  useEffect(() => {
    if (!file) { setLease(null); setComments([]); return }
    let active = true
    const refresh = async (): Promise<void> => {
      const [nextLease, nextComments] = await Promise.all([
        window.excelSync.fileLease(file.id).catch(() => null),
        window.excelSync.comments(file.id).catch(() => [] as FileCommentView[])
      ])
      if (!active) return
      setLease(nextLease)
      setComments(nextComments)
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [file?.id])
  if (!file) return null
  const activeFile = file

  let body: ReactElement = <div className="preview-empty">正在准备预览…</div>
  if (!loading && preview) {
    if (preview.kind === 'spreadsheet') {
      const rows = preview.sheet?.rows ?? []
      const header = rows[0] ?? []
      const normalized = query.trim().toLocaleLowerCase('zh-CN')
      let dataRows = rows.slice(1)
      if (normalized) dataRows = dataRows.filter((row) => row.some((cell) => cell.toLocaleLowerCase('zh-CN').includes(normalized)))
      if (sortColumn !== null) dataRows = [...dataRows].sort((a, b) => (a[sortColumn] ?? '').localeCompare(b[sortColumn] ?? '', 'zh-CN', { numeric: true }) * (sortAsc ? 1 : -1))
      body = <div className="spreadsheet-preview">
        <div className="preview-toolbar-row">
          <div className="sheet-tabs">{preview.sheetNames.map((name) => <button key={name} className={preview.selectedSheet === name ? 'active' : ''} onClick={() => void onSheet(name)}>{name}</button>)}</div>
          <input aria-label="在预览中搜索" placeholder="在预览中搜索…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="preview-meta">{preview.sheet ? `${preview.sheet.rowCount} 行 · ${preview.sheet.columnCount} 列 · ${preview.sheetCount} 个 Sheet · 当前显示前 ${Math.min(preview.sheet.rows.length, 500)} 行` : `${preview.sheetCount} 个 Sheet`}</div>
        <div className="preview-table-wrap"><table><thead><tr>{header.map((cell, index) => <th key={index}><button className="preview-sort" onClick={() => { if (sortColumn === index) setSortAsc(!sortAsc); else { setSortColumn(index); setSortAsc(true) } }}>{cell || `列 ${index + 1}`}{sortColumn === index ? (sortAsc ? ' ↑' : ' ↓') : ''}</button></th>)}</tr></thead><tbody>{dataRows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, columnIndex) => <td key={columnIndex}>{row[columnIndex] ?? ''}</td>)}</tr>)}</tbody></table></div>
      </div>
    } else if (preview.kind === 'text') {
      body = preview.format === 'markdown' ? <MarkdownPreview text={preview.text} /> : <pre className="text-preview">{preview.text}</pre>
    } else if (preview.kind === 'binary' && preview.media === 'image') {
      body = <div className="image-preview"><div className="image-preview-controls"><button onClick={() => setZoom((value) => Math.max(.25, value - .25))}>缩小</button><button onClick={() => setZoom(1)}>适应窗口</button><button onClick={() => setZoom((value) => Math.min(4, value + .25))}>放大</button><span>{Math.round(zoom * 100)}%</span></div><div className="image-preview-canvas"><img style={{ transform: `scale(${zoom})` }} src={`data:${preview.mimeType};base64,${preview.base64}`} alt={file.logicalName} /></div></div>
    } else if (preview.kind === 'binary' && preview.media === 'pdf') {
      body = <div className="pdf-preview"><div className="preview-meta">使用 Chromium 内置 PDF 阅读器，可在阅读器工具栏切换页码和缩放。</div><iframe title={file.logicalName} src={`data:application/pdf;base64,${preview.base64}`} /></div>
    } else if (preview.kind === 'zip') {
      body = <div className="zip-preview">{preview.entries.map((entry, index) => <div key={`${entry.name}-${index}`} className={entry.directory ? 'zip-dir' : 'zip-file'} style={{ paddingLeft: `${Math.min(6, entry.name.split('/').length - 1) * 16}px` }}>{entry.directory ? '▸' : '•'} {entry.name}</div>)}{preview.truncated && <div className="preview-meta">目录过大，仅显示前 3000 项。</div>}</div>
    } else if (preview.kind === 'unsupported') {
      body = <div className="preview-empty">{preview.message}</div>
    }
  }

  async function submitComment(): Promise<void> {
    const text = commentBody.trim()
    if (!text || collabBusy) return
    setCollabBusy(true)
    try {
      setComments(await window.excelSync.createComment(activeFile.id, { body: text }))
      setCommentBody('')
      onToast('评论已发布。')
    } catch (error) {
      onToast(errorMessage(error))
    } finally {
      setCollabBusy(false)
    }
  }

  async function toggleCommentResolved(comment: FileCommentView): Promise<void> {
    if (collabBusy) return
    setCollabBusy(true)
    try {
      await window.excelSync.resolveComment(comment.id, Boolean(comment.resolved_at))
      setComments(await window.excelSync.comments(activeFile.id))
    } catch (error) {
      onToast(errorMessage(error))
    } finally {
      setCollabBusy(false)
    }
  }

  async function requestTakeover(force = false): Promise<void> {
    if (collabBusy) return
    setCollabBusy(true)
    try {
      if (force) {
        setLease(await window.excelSync.forceFileLeaseTakeover(activeFile.id))
        onToast('已强制接管该文件的编辑锁。')
      } else {
        await window.excelSync.requestFileLeaseTakeover(activeFile.id)
        onToast('已向当前编辑者发送接管请求。')
      }
    } catch (error) {
      onToast(errorMessage(error))
    } finally {
      setCollabBusy(false)
    }
  }

  const fileActivity = activity.filter((row) => row.fileId === activeFile.id)
  return <aside className="preview-drawer">
    <div className="preview-header"><div><p className="eyebrow">文件详情</p><h3>{file.logicalName}</h3><small>{file.relativePath} · {formatBytes(file.size)} · {formatTime(file.mtimeMs || file.updatedAt)} · 存储：{storageBackendLabel(file.storageBackend)}</small>{presence && <div className="presence-summary"><b>{presence.editingUserCount > 0 ? `${presence.editingUserCount} 人正在编辑` : presence.activeUserCount > 0 ? `${presence.activeUserCount} 人已打开` : '当前无人在线使用'}</b>{presence.entries.length > 0 && <span>{presence.entries.map((entry) => `${entry.displayName}${entry.currentUser ? '（我）' : ''}${entry.state === 'EDITING' ? ' 正在编辑' : ' 已打开'}`).join('、')}</span>}</div>}</div><button className="icon-close" onClick={onClose}>×</button></div>
    {lease?.locked && <div className={`lease-banner ${lease.currentDevice ? 'owned' : 'blocked'}`}><div><b>{lease.currentDevice ? '当前设备持有编辑锁' : `${lease.ownerDisplayName ?? lease.ownerUsername ?? '其他用户'} 正在编辑`}</b><span>{lease.ownerDeviceName ? `${lease.ownerDeviceName} · ` : ''}锁将在 {formatTime(lease.expiresAt ?? '')} 前保持有效</span></div>{!lease.currentDevice && canEdit && <div>{<button className="secondary" disabled={collabBusy} onClick={() => void requestTakeover(false)}>请求接管</button>}{canManageLock && <button className="secondary danger-border" disabled={collabBusy} onClick={() => void requestTakeover(true)}>强制接管</button>}</div>}</div>}
    <div className="preview-actions"><button className="primary" onClick={() => void onOpen()}>{filePartitionForName(file.logicalName) === 'excel' ? '使用 Excel 打开' : '使用默认程序打开'}</button>{file.currentVersion > 0 && <button className="secondary" onClick={() => void onVersions()}>版本历史</button>}</div>
    <div className="preview-tabs">{([['preview', '预览'], ['comments', `评论 ${comments.length}`], ['versions', '版本'], ['activity', `活动 ${fileActivity.length}`]] as const).map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
    <div className="preview-body">
      {tab === 'preview' && body}
      {tab === 'comments' && <div className="comment-panel"><div className="comment-compose"><textarea value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder="写评论；使用 @username 提及成员…" /><div><span>{canEdit ? '评论不会改动文件内容。' : '查看者也可以参与评论。'}</span><button className="primary" disabled={collabBusy || !commentBody.trim()} onClick={() => void submitComment()}>发布</button></div></div>{comments.length === 0 ? <div className="preview-empty">还没有评论。</div> : <div className="comment-list">{comments.map((comment) => <article key={comment.id} className={comment.resolved_at ? 'resolved' : ''}><div className="comment-head"><b>{comment.created_by_name}</b><span>@{comment.created_by_username} · {formatTime(comment.created_at)}{comment.file_version ? ` · V${comment.file_version}` : ''}</span></div><p>{comment.body}</p><div className="comment-actions">{comment.parent_comment_id && <span>回复线程</span>}<button className="text-button" disabled={collabBusy} onClick={() => void toggleCommentResolved(comment)}>{comment.resolved_at ? '重新打开' : '标记已解决'}</button></div></article>)}</div>}</div>}
      {tab === 'versions' && <div className="preview-empty preview-action-card"><b>Version Explorer</b><p>查看历史版本、预览副本、比较两个版本，并可将旧版本恢复为新的当前版本。</p><button className="primary" disabled={file.currentVersion <= 0} onClick={() => void onVersions()}>打开版本历史</button></div>}
      {tab === 'activity' && <div className="preview-activity">{fileActivity.length === 0 ? <div className="preview-empty">暂无该文件的本地活动记录。</div> : <ActivityList rows={fileActivity.slice(0, 100)} />}</div>}
    </div>
  </aside>
}

function TasksPage({ tasks, uiTasks, userTasks, currentUserName, canEditFiles, draft, onDraftConsumed, onCreateUserTask, onUpdateUserTask, onDeleteUserTask, onRunTemplate, onOpenLinkedFile, onRetry, onCancel, onResolveConflict }: {
  tasks: PendingView[]
  uiTasks: UiTask[]
  userTasks: UserTask[]
  currentUserName: string
  canEditFiles: boolean
  draft: TaskDraft | null
  onDraftConsumed: () => void
  onCreateUserTask: (task: Omit<UserTask, 'id' | 'createdAt' | 'updatedAt' | 'status'>) => Promise<void>
  onUpdateUserTask: (id: string, patch: Partial<Pick<UserTask, 'status' | 'title' | 'description' | 'priority' | 'dueDate' | 'assignee'>>) => Promise<void>
  onDeleteUserTask: (id: string) => Promise<void>
  onRunTemplate: (task: UserTask) => Promise<void>
  onOpenLinkedFile: (fileId: string) => Promise<void>
  onRetry: (task: PendingView) => Promise<void>
  onCancel: (task: PendingView) => Promise<void>
  onResolveConflict: (task: PendingView, choice: 'local' | 'cloud' | 'both') => Promise<void>
}): ReactElement {
  const operationLabel: Record<PendingView['operation'], string> = { UPSERT: '上传 / 同步', DELETE: '删除', RENAME: '重命名 / 移动' }
  const priorityLabel: Record<UserTaskPriority, string> = { low: '低', medium: '普通', high: '高', urgent: '紧急' }
  const statusLabel: Record<UserTaskStatus, string> = { todo: '待执行', running: '进行中', done: '已完成' }
  const recentUiTasks = [...uiTasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30)
  const [showCreate, setShowCreate] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<TaskTemplateId>('sync-now')
  const [title, setTitle] = useState(TASK_TEMPLATES[0]?.defaultTitle ?? '')
  const [description, setDescription] = useState(TASK_TEMPLATES[0]?.defaultDescription ?? '')
  const [priority, setPriority] = useState<UserTaskPriority>(TASK_TEMPLATES[0]?.priority ?? 'medium')
  const [dueDate, setDueDate] = useState('')
  const [assignee, setAssignee] = useState(currentUserName)
  const [linkedFileId, setLinkedFileId] = useState('')
  const [linkedResourceLabel, setLinkedResourceLabel] = useState('')
  const [userFilter, setUserFilter] = useState<'all' | UserTaskStatus>('all')
  const visibleUserTasks = [...userTasks]
    .filter((task) => userFilter === 'all' || task.status === userFilter)
    .sort((a, b) => (a.status === b.status ? b.updatedAt - a.updatedAt : a.status === 'running' ? -1 : b.status === 'running' ? 1 : b.updatedAt - a.updatedAt))
  const waitingSystem = tasks.filter((task) => ['PENDING', 'RETRY_WAIT'].includes(task.status)).length
  const runningCount = tasks.filter((task) => task.status === 'UPLOADING').length + recentUiTasks.filter((task) => task.status === 'running').length + userTasks.filter((task) => task.status === 'running').length
  const attentionCount = tasks.filter((task) => ['CONFLICT', 'ERROR'].includes(task.status)).length
  const doneCount = userTasks.filter((task) => task.status === 'done').length + recentUiTasks.filter((task) => task.status === 'done').length

  function chooseTemplate(id: TaskTemplateId): void {
    const template = TASK_TEMPLATES.find((item) => item.id === id) ?? TASK_TEMPLATES[0]!
    setSelectedTemplate(template.id)
    setTitle(template.defaultTitle)
    setDescription(template.defaultDescription)
    setPriority(template.priority)
  }

  function openCreate(id: TaskTemplateId = 'sync-now'): void {
    chooseTemplate(id)
    setDueDate('')
    setAssignee(currentUserName)
    setLinkedFileId('')
    setLinkedResourceLabel('')
    setShowCreate(true)
  }

  useEffect(() => {
    if (!draft) return
    const templateId = draft.templateId ?? 'custom'
    chooseTemplate(templateId)
    if (draft.title !== undefined) setTitle(draft.title)
    if (draft.description !== undefined) setDescription(draft.description)
    setDueDate('')
    setAssignee(currentUserName)
    setLinkedFileId(draft.linkedFileId ?? '')
    setLinkedResourceLabel(draft.linkedResourceLabel ?? '')
    setShowCreate(true)
    onDraftConsumed()
  }, [draft])

  async function createTask(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!title.trim()) return
    await onCreateUserTask({ title: title.trim(), description: description.trim(), templateId: selectedTemplate, priority, dueDate, assignee: assignee.trim() || currentUserName, linkedFileId: linkedFileId || undefined, linkedResourceLabel: linkedResourceLabel || undefined })
    setShowCreate(false)
  }

  return <div className="task-center page-stack">
    <section className="task-center-hero">
      <div><p className="eyebrow">TASK CENTER</p><h2>任务中心</h2><p className="muted">创建操作任务、套用常用模板，并在同一页查看系统同步队列和运行记录。</p></div>
      <button className="primary task-create-button" onClick={() => openCreate('sync-now')}>＋ 创建任务</button>
    </section>

    <div className="task-metric-grid">
      <button onClick={() => setUserFilter('todo')}><span>待执行</span><strong>{userTasks.filter((task) => task.status === 'todo').length + waitingSystem}</strong><small>主动任务 + 同步等待</small></button>
      <button onClick={() => setUserFilter('running')}><span>运行中</span><strong>{runningCount}</strong><small>当前正在执行</small></button>
      <button onClick={() => setUserFilter('all')}><span>需要处理</span><strong>{attentionCount}</strong><small>冲突或同步错误</small></button>
      <button onClick={() => setUserFilter('done')}><span>已完成</span><strong>{doneCount}</strong><small>最近操作与任务</small></button>
    </div>

    <section className="panel task-template-panel">
      <div className="panel-header"><div><h3>常用任务模板</h3><p className="muted">一键套用常见文件 SaaS 工作流；创建后可调整标题、优先级和截止时间。</p></div><button className="text-button" onClick={() => openCreate('custom')}>创建自定义任务</button></div>
      <div className="task-template-grid">{TASK_TEMPLATES.filter((template) => template.id !== 'custom').map((template) => <button className="task-template-card" key={template.id} disabled={!canEditFiles && template.runnable} onClick={() => openCreate(template.id)}><span className="task-template-badge">{template.badge}</span><b>{template.title}</b><small>{!canEditFiles && template.runnable ? '当前 Workspace 为查看权限，不能执行文件写操作。' : template.description}</small><em>{!canEditFiles && template.runnable ? '仅查看' : '使用模板 →'}</em></button>)}</div>
    </section>

    <section className="panel task-user-panel">
      <div className="panel-header"><div><h3>我的任务</h3><p className="muted">这里保存你主动创建的任务；重启客户端后仍会保留。</p></div><div className="task-filter-tabs">{([['all', '全部'], ['todo', '待执行'], ['running', '进行中'], ['done', '已完成']] as const).map(([id, label]) => <button key={id} className={userFilter === id ? 'active' : ''} onClick={() => setUserFilter(id)}>{label}</button>)}</div></div>
      {visibleUserTasks.length === 0 ? <div className="empty-state compact">还没有符合当前筛选的任务。可以从上面的模板开始创建。</div> : <div className="user-task-list">{visibleUserTasks.map((task) => {
        const template = TASK_TEMPLATES.find((item) => item.id === task.templateId) ?? TASK_TEMPLATES[TASK_TEMPLATES.length - 1]!
        const overdue = Boolean(task.dueDate && task.status !== 'done' && new Date(`${task.dueDate}T23:59:59`).getTime() < Date.now())
        return <article className={`user-task-row ${task.status}`} key={task.id}>
          <button className={`task-check ${task.status}`} aria-label={task.status === 'done' ? '重新打开任务' : '完成任务'} onClick={() => void onUpdateUserTask(task.id, { status: task.status === 'done' ? 'todo' : 'done' })}>{task.status === 'done' ? '✓' : ''}</button>
          <div className="user-task-main"><div className="user-task-title"><b>{task.title}</b><span className={`priority-chip ${task.priority}`}>{priorityLabel[task.priority]}</span><span className={`task-state-chip ${task.status}`}>{statusLabel[task.status]}</span></div>{task.description && <p>{task.description}</p>}<div className="user-task-meta"><span>{template.badge} · {template.title}</span><span>负责人 · {task.assignee || currentUserName}</span>{task.dueDate && <span className={overdue ? 'overdue' : ''}>{overdue ? '已逾期 · ' : '截止 · '}{task.dueDate}</span>}<span>更新 {formatTime(task.updatedAt)}</span></div>{task.linkedResourceLabel && <button className="linked-resource" disabled={!task.linkedFileId} onClick={() => task.linkedFileId ? void onOpenLinkedFile(task.linkedFileId) : undefined}>关联文件 · {task.linkedResourceLabel}</button>}</div>
          <div className="user-task-actions">{task.status !== 'done' && (template.runnable ? <button className="secondary" disabled={!canEditFiles} onClick={() => void onRunTemplate(task)}>{task.status === 'running' ? '再次运行' : '运行任务'}</button> : <button className="secondary" onClick={() => void onUpdateUserTask(task.id, { status: task.status === 'running' ? 'todo' : 'running' })}>{task.status === 'running' ? '暂停' : '开始处理'}</button>)}<button className="text-button danger" onClick={() => void onDeleteUserTask(task.id)}>删除</button></div>
        </article>
      })}</div>}
    </section>

    <section className="panel table-panel">
      <div className="panel-header"><div><h3>系统同步队列</h3><p className="muted">这是 ExcelSync 自动生成的真实文件任务；冲突必须明确选择处理方式。</p></div><span className="count-pill">{tasks.length}</span></div>
      {tasks.length === 0 ? <div className="empty-state compact">当前没有系统待处理任务。</div> : <div className="table-wrap"><table><thead><tr><th>文件</th><th>任务</th><th>优先级</th><th>状态</th><th>尝试次数</th><th>更新时间</th><th>错误</th><th>操作</th></tr></thead><tbody>{tasks.map((task) => <tr key={task.id}><td><b>{task.logicalName}</b></td><td>{operationLabel[task.operation]}</td><td><span className="queue-priority">P{task.priority}</span></td><td><span className={`status-chip ${task.status.toLowerCase()}`}>{STATUS_LABELS[task.status]}</span></td><td>{task.attemptCount}</td><td>{formatTime(task.updatedAt)}</td><td>{task.status === 'CONFLICT' ? '本地和云端均有新版本，请选择保留方式。' : task.errorMessage ? errorMessage(new Error(task.errorMessage)) : '—'}</td><td className="actions-cell">{!canEditFiles ? <span className="muted">只读</span> : task.status === 'CONFLICT' ? <div className="conflict-actions"><button className="text-button" onClick={() => void onResolveConflict(task, 'local')}>保留本地</button><button className="text-button" onClick={() => void onResolveConflict(task, 'cloud')}>保留云端</button><button className="text-button" onClick={() => void onResolveConflict(task, 'both')}>两个都保留</button></div> : <>{['ERROR', 'RETRY_WAIT'].includes(task.status) && <button className="text-button" onClick={() => void onRetry(task)}>重试</button>}{task.status !== 'UPLOADING' && <button className="text-button danger" onClick={() => void onCancel(task)}>取消</button>}</>}</td></tr>)}</tbody></table></div>}
    </section>

    <section className="panel">
      <div className="panel-header"><div><h3>最近运行记录</h3><p className="muted">下载、删除、恢复、批量操作等即时任务的最近状态。</p></div><span className="count-pill">{recentUiTasks.length}</span></div>
      {recentUiTasks.length === 0 ? <div className="empty-state compact">还没有运行记录。</div> : <div className="ui-task-list">{recentUiTasks.map((task) => { const percent = task.total > 0 ? Math.round((task.completed / task.total) * 100) : 0; return <div className="ui-task-row" key={task.id}><div><b>{task.label}</b><small>{task.operation} · {task.detail}</small></div><div className="task-progress"><span style={{ width: `${Math.max(task.status === 'running' ? 4 : 0, percent)}%` }} /></div><strong className={task.status}>{task.status === 'running' ? `${percent}%` : task.status === 'done' ? '已完成' : '失败'}</strong></div> })}</div>}
    </section>

    {showCreate && <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}><form className="task-create-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={createTask}><div className="task-create-head"><div><p className="eyebrow">NEW TASK</p><h3>创建任务</h3><p className="muted">任务可以直接关联文件，并明确负责人、优先级和截止日期。</p></div><button type="button" className="icon-button" onClick={() => setShowCreate(false)}>×</button></div><div className="task-create-templates">{TASK_TEMPLATES.map((template) => <button type="button" key={template.id} className={selectedTemplate === template.id ? 'active' : ''} onClick={() => chooseTemplate(template.id)}><span>{template.badge}</span><b>{template.title}</b></button>)}</div>{linkedResourceLabel && <div className="task-linked-banner"><span>关联文件</span><b>{linkedResourceLabel}</b></div>}<div className="task-create-fields"><label className="wide">任务标题<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：整理本周新增 Excel" autoFocus /></label><label className="wide">说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="写清楚这次任务要做什么、做到什么程度。" /></label><label>负责人<input value={assignee} onChange={(event) => setAssignee(event.target.value)} placeholder={currentUserName} /></label><label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value as UserTaskPriority)}><option value="low">低</option><option value="medium">普通</option><option value="high">高</option><option value="urgent">紧急</option></select></label><label>截止日期<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label></div><div className="task-create-footer"><button type="button" className="secondary" onClick={() => setShowCreate(false)}>取消</button><button className="primary" type="submit" disabled={!title.trim()}>创建任务</button></div></form></div>}
  </div>
}

function FilesPage({ files, title = '文件', readOnly = false, onOpen, onPreview, onVersions, onRestoreLocal, onTrash, onDownload, onRename, onMove, onCopy, onFavorite, onCreateTaskForFile, onCreateFolder, onDropFiles, onBulkDownload, onBulkMove, onBulkTrash, onImport, onImportFolder, busyAction, busyFileId }: {
  title?: string
  readOnly?: boolean
  files: LocalFileView[]
  onOpen: (id: string) => Promise<void>
  onPreview: (file: LocalFileView) => Promise<void>
  onVersions: (file: LocalFileView) => Promise<void>
  onRestoreLocal: (file: LocalFileView) => Promise<void>
  onTrash: (file: LocalFileView) => Promise<void>
  onDownload: (file: LocalFileView) => Promise<void>
  onRename: (file: LocalFileView) => Promise<void>
  onMove: (file: LocalFileView) => Promise<void>
  onCopy: (file: LocalFileView) => Promise<void>
  onFavorite: (file: LocalFileView) => Promise<void>
  onCreateTaskForFile: (file: LocalFileView) => void
  onCreateFolder: (parent: string) => Promise<void>
  onDropFiles: (files: File[]) => Promise<void>
  onBulkDownload: (files: LocalFileView[]) => Promise<void>
  onBulkMove: (files: LocalFileView[]) => Promise<void>
  onBulkTrash: (files: LocalFileView[]) => Promise<void>
  onImport: () => Promise<void>
  onImportFolder: () => Promise<void>
  busyAction: ActionKey | null
  busyFileId: string | null
}): ReactElement {
  const [folderPath, setFolderPath] = useState('')
  const [partition, setPartition] = useState<FilePartition | 'all'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const deferredSearch = useDeferredValue(searchQuery)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [dragging, setDragging] = useState(false)
  const [pageIndex, setPageIndex] = useState(0)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: LocalFileView; mode: 'more' | 'context' } | null>(null)
  const lastSelectedId = useRef<string | null>(null)
  useEffect(() => {
    if (!contextMenu) return
    const close = (): void => setContextMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('blur', close) }
  }, [contextMenu])
  const normalizedFolder = folderPath.replace(/^\/+|\/+$/g, '')
  const prefix = normalizedFolder ? `${normalizedFolder}/` : ''
  const folders = new Map<string, number>()
  const visibleFiles: LocalFileView[] = []
  const partitionCounts = new Map<FilePartition, number>()

  const normalizedSearch = deferredSearch.trim().toLocaleLowerCase('zh-CN')
  for (const file of files) {
    const filePartition = filePartitionForName(file.logicalName)
    if (filePartition) partitionCounts.set(filePartition, (partitionCounts.get(filePartition) ?? 0) + 1)
    if (partition !== 'all' && filePartition !== partition) continue
    const path = file.relativePath.replaceAll('\\', '/')
    if (normalizedSearch) {
      const searchable = `${file.logicalName}\n${path}\n${file.extension}\n${filePartitionLabel(file.logicalName)}\n${fileStatusLabel(file)}`.toLocaleLowerCase('zh-CN')
      if (!searchable.includes(normalizedSearch)) continue
      visibleFiles.push(file)
      continue
    }
    if (!path.startsWith(prefix)) continue
    const remainder = path.slice(prefix.length)
    const slash = remainder.indexOf('/')
    if (slash >= 0) {
      const name = remainder.slice(0, slash)
      folders.set(name, (folders.get(name) ?? 0) + 1)
    } else {
      visibleFiles.push(file)
    }
  }

  const folderRows = [...folders.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
  const crumbs = normalizedFolder ? normalizedFolder.split('/') : []
  const pageSize = 250
  const pageCount = Math.max(1, Math.ceil(visibleFiles.length / pageSize))
  const safePageIndex = Math.min(pageIndex, pageCount - 1)
  const pageStart = safePageIndex * pageSize
  const pagedFiles = visibleFiles.slice(pageStart, pageStart + pageSize)
  const selectedFiles = files.filter((file) => selectedIds.has(file.id))
  const allVisibleSelected = visibleFiles.length > 0 && visibleFiles.every((file) => selectedIds.has(file.id))
  useEffect(() => { setPageIndex(0) }, [normalizedFolder, partition, normalizedSearch])
  const enterFolder = (name: string): void => { setFolderPath(prefix + name); setSelectedIds(new Set()) }
  const goToCrumb = (index: number): void => { setFolderPath(crumbs.slice(0, index + 1).join('/')); setSelectedIds(new Set()) }
  const goUp = (): void => { setFolderPath(crumbs.slice(0, -1).join('/')); setSelectedIds(new Set()) }

  function selectFile(file: LocalFileView, event: React.MouseEvent): void {
    const ids = visibleFiles.map((row) => row.id)
    if (event.shiftKey && lastSelectedId.current && ids.includes(lastSelectedId.current)) {
      const start = ids.indexOf(lastSelectedId.current)
      const end = ids.indexOf(file.id)
      const [from, to] = start < end ? [start, end] : [end, start]
      const next = new Set(selectedIds)
      for (const id of ids.slice(from, to + 1)) next.add(id)
      setSelectedIds(next)
    } else if (event.ctrlKey || event.metaKey) {
      const next = new Set(selectedIds)
      if (next.has(file.id)) next.delete(file.id)
      else next.add(file.id)
      setSelectedIds(next)
    } else {
      setSelectedIds(new Set([file.id]))
    }
    lastSelectedId.current = file.id
    void onPreview(file)
  }

  function toggleCheckbox(file: LocalFileView): void {
    const next = new Set(selectedIds)
    if (next.has(file.id)) next.delete(file.id)
    else next.add(file.id)
    setSelectedIds(next)
    lastSelectedId.current = file.id
  }

  function openFileMenu(file: LocalFileView, x: number, y: number, mode: 'more' | 'context'): void {
    const menuWidth = 224
    const menuHeight = mode === 'context' ? (file.currentVersion > 0 ? 470 : 410) : (file.currentVersion > 0 ? 380 : 320)
    const left = Math.max(12, Math.min(x, window.innerWidth - menuWidth - 12))
    const top = Math.max(12, Math.min(y, window.innerHeight - menuHeight - 12))
    setContextMenu({ x: left, y: top, file, mode })
  }

  return (
    <section
      className={`panel table-panel file-workspace${dragging ? ' is-dragging' : ''}`}
      onDragEnter={(event) => { if (readOnly) return; event.preventDefault(); setDragging(true) }}
      onDragOver={(event) => { if (readOnly) return; event.preventDefault(); setDragging(true); event.dataTransfer.dropEffect = 'copy' }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false) }}
      onDrop={(event) => { if (readOnly) return; event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length > 0) void onDropFiles(Array.from(event.dataTransfer.files)) }}
    >
      {dragging && !readOnly && <div className="drop-overlay">拖放到这里即可添加文件或文件夹</div>}
      <div className="panel-header"><div><h2>{title}</h2><p className="muted">{readOnly ? '当前 Workspace 为查看权限：可以预览和下载，但不能上传、移动、重命名或删除。' : '选择文件即可在右侧快速预览；双击用系统默认程序打开。支持拖放添加。'}</p></div><div className="top-actions"><span className="count-pill">{files.length}</span>{!readOnly && <><button className="secondary" onClick={() => void onCreateFolder(normalizedFolder)}>新建文件夹</button><ActionButton actionKey="importFolder" label="上传文件夹" className="secondary" busyAction={busyAction} onClick={() => void onImportFolder()} /><ActionButton actionKey="importFiles" label="＋ 添加文件" className="primary" busyAction={busyAction} onClick={() => void onImport()} /></>}</div></div>

      {selectedFiles.length > 0 ? <div className="selection-toolbar"><b>已选择 {selectedFiles.length} 项</b><button onClick={() => void onBulkDownload(selectedFiles)}>下载</button>{!readOnly && <><button onClick={() => void onBulkMove(selectedFiles)}>移动</button><button className="danger" onClick={() => void onBulkTrash(selectedFiles)}>删除</button></>}<button className="text-button" onClick={() => setSelectedIds(new Set())}>取消选择</button></div> : <div className="file-search-row"><input aria-label="搜索文件" placeholder="搜索文件名、文件夹、路径、类型…" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />{searchQuery && <button className="text-button" onClick={() => setSearchQuery('')}>清除</button>}</div>}

      <div className="file-category-tabs" role="tablist" aria-label="文件类型">
        <button className={partition === 'all' ? 'active' : ''} onClick={() => setPartition('all')}>全部 <span>{files.length}</span></button>
        {FILE_PARTITIONS.map((item) => <button key={item.id} className={partition === item.id ? 'active' : ''} onClick={() => setPartition(item.id)}>{item.label} <span>{partitionCounts.get(item.id) ?? 0}</span></button>)}
      </div>

      {!normalizedSearch && <div className="folder-toolbar"><button className="text-button" onClick={() => { setFolderPath(''); setSelectedIds(new Set()) }}>同步根目录</button>{crumbs.map((crumb, index) => <span className="breadcrumb-part" key={`${crumb}-${index}`}><span>/</span><button className="text-button" onClick={() => goToCrumb(index)}>{crumb}</button></span>)}{normalizedFolder && <button className="secondary folder-up" onClick={goUp}>返回上一级</button>}</div>}

      {files.length === 0 ? <div className="empty-state">{readOnly ? '当前 Workspace 还没有可查看的文件。' : '还没有文件。点击“＋ 添加文件”、上传文件夹，或直接把文件拖到这里。'}</div> : <>
        {folderRows.length > 0 && <div className="folder-grid">{folderRows.map(([name, count]) => <button className="folder-card" key={name} onDoubleClick={() => enterFolder(name)} onClick={() => enterFolder(name)}><span className="folder-icon">▰</span><span><b>{name}</b><small>{count} 个文件</small></span><span className="folder-enter">打开 ›</span></button>)}</div>}

        {visibleFiles.length > 0 && <><div className="table-wrap"><table className="file-table"><thead><tr><th className="select-column"><input aria-label="全选当前筛选结果" type="checkbox" checked={allVisibleSelected} onChange={() => setSelectedIds(allVisibleSelected ? new Set() : new Set(visibleFiles.map((file) => file.id)))} /></th><th>文件</th><th>状态</th><th>大小</th><th>修改时间</th><th>操作</th></tr></thead><tbody>{pagedFiles.map((file) => <tr key={file.id} className={selectedIds.has(file.id) ? 'selected' : ''} onClick={(event) => selectFile(file, event)} onDoubleClick={() => void onOpen(file.id)} onContextMenu={(event) => { event.preventDefault(); openFileMenu(file, event.clientX, event.clientY, 'context') }}><td className="select-column" onClick={(event) => event.stopPropagation()}><input aria-label={`选择 ${file.logicalName}`} type="checkbox" checked={selectedIds.has(file.id)} onChange={() => toggleCheckbox(file)} /></td><td><div className="file-name"><span className="file-icon">{extensionLabel(file.logicalName)}</span><div><b>{file.logicalName}</b><small>{file.relativePath}</small></div></div></td><td><span className={`status-chip ${fileStatusClass(file)}`}>{fileStatusLabel(file)}</span></td><td>{formatBytes(file.size)}</td><td>{formatTime(file.mtimeMs || file.updatedAt)}</td><td className="actions-cell" onClick={(event) => event.stopPropagation()}><button className="text-button" onClick={() => void onPreview(file)}>预览</button><button className="text-button" onClick={() => void onOpen(file.id)}>打开</button>{!file.exists && file.currentVersion > 0 && <button className="text-button" onClick={() => void onRestoreLocal(file)} disabled={busyFileId === file.id}>下载到本地</button>}<button className="text-button file-more-button" aria-haspopup="menu" aria-expanded={contextMenu?.mode === 'more' && contextMenu.file.id === file.id} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openFileMenu(file, rect.right - 224, rect.bottom + 7, 'more') }}>更多</button></td></tr>)}</tbody></table></div>{pageCount > 1 && <div className="file-pagination"><span>显示 {pageStart + 1}–{Math.min(pageStart + pageSize, visibleFiles.length)} / {visibleFiles.length}</span><div><button className="secondary" disabled={safePageIndex === 0} onClick={() => setPageIndex(Math.max(0, safePageIndex - 1))}>上一页</button><b>{safePageIndex + 1} / {pageCount}</b><button className="secondary" disabled={safePageIndex >= pageCount - 1} onClick={() => setPageIndex(Math.min(pageCount - 1, safePageIndex + 1))}>下一页</button></div></div>}</>}

        {folderRows.length === 0 && visibleFiles.length === 0 && <div className="empty-state compact">没有匹配的文件。</div>}
      </>}
      {contextMenu && <div className={`file-context-menu${contextMenu.mode === 'more' ? ' file-more-popover' : ''}`} role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>{contextMenu.mode === 'context' && <><button role="menuitem" onClick={() => { void onOpen(contextMenu.file.id); setContextMenu(null) }}>打开文件</button><button role="menuitem" onClick={() => { void onPreview(contextMenu.file); setContextMenu(null) }}>快速预览</button><div className="menu-separator" /></>}<button role="menuitem" onClick={() => { onCreateTaskForFile(contextMenu.file); setContextMenu(null) }}>创建关联任务</button><button role="menuitem" onClick={() => { void onFavorite(contextMenu.file); setContextMenu(null) }}>{contextMenu.file.favorite ? '取消收藏' : '加入收藏'}</button>{!readOnly && <><button role="menuitem" onClick={() => { void onRename(contextMenu.file); setContextMenu(null) }}>重命名</button><button role="menuitem" onClick={() => { void onMove(contextMenu.file); setContextMenu(null) }}>移动到其他文件夹…</button><button role="menuitem" onClick={() => { void onCopy(contextMenu.file); setContextMenu(null) }}>复制文件</button></>}<div className="menu-separator" /><button role="menuitem" onClick={() => { void onDownload(contextMenu.file); setContextMenu(null) }}>下载副本</button><button role="menuitem" disabled={contextMenu.file.currentVersion === 0} onClick={() => { void onVersions(contextMenu.file); setContextMenu(null) }}>查看历史版本</button>{!readOnly && contextMenu.file.currentVersion > 0 && <><div className="menu-separator" /><button role="menuitem" className="danger" onClick={() => { void onTrash(contextMenu.file); setContextMenu(null) }}>移入回收站</button></>}</div>}
    </section>
  )
}

function TrashPage({ files, canRestore, canPermanentDelete, onRestore, onPermanentDelete, onBulkRestore, busyFileId }: {
  files: TrashFileView[]
  canRestore: boolean
  canPermanentDelete: boolean
  onRestore: (file: TrashFileView) => Promise<void>
  onPermanentDelete: (file: TrashFileView) => Promise<void>
  onBulkRestore: (files: TrashFileView[]) => Promise<void>
  busyFileId: string | null
}): ReactElement {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const query = searchQuery.trim().toLocaleLowerCase('zh-CN')
  const visible = query
    ? files.filter((file) => `${file.logicalName}\n${file.relativePath}`.toLocaleLowerCase('zh-CN').includes(query))
    : files
  const selected = files.filter((file) => selectedIds.has(file.id))
  const allVisibleSelected = visible.length > 0 && visible.every((file) => selectedIds.has(file.id))

  return (
    <section className="panel table-panel">
      <div className="panel-header"><div><h2>回收站</h2><p className="muted">默认删除可恢复；“永久删除”只在这里提供，避免误操作。</p></div><span className="count-pill">{files.length}</span></div>
      {selected.length > 0 ? <div className="selection-toolbar"><b>已选择 {selected.length} 项</b>{canRestore && <button onClick={() => void onBulkRestore(selected)}>批量恢复</button>}<button className="text-button" onClick={() => setSelectedIds(new Set())}>取消选择</button></div> : <div className="file-search-row"><input aria-label="搜索回收站" placeholder="搜索回收站中的文件名或路径…" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />{searchQuery && <button className="text-button" onClick={() => setSearchQuery('')}>清除</button>}</div>}
      {visible.length === 0 ? <div className="empty-state">{files.length === 0 ? '回收站为空。' : '没有匹配的文件。'}</div> : <div className="table-wrap"><table><thead><tr><th className="select-column"><input aria-label="全选回收站当前列表" type="checkbox" checked={allVisibleSelected} onChange={() => setSelectedIds(allVisibleSelected ? new Set() : new Set(visible.map((file) => file.id)))} /></th><th>文件</th><th>版本</th><th>大小</th><th>删除时间</th><th>原路径</th><th>操作</th></tr></thead><tbody>{visible.map((file) => <tr key={file.id} className={selectedIds.has(file.id) ? 'selected' : ''}><td className="select-column"><input aria-label={`选择 ${file.logicalName}`} type="checkbox" checked={selectedIds.has(file.id)} onChange={() => { const next = new Set(selectedIds); if (next.has(file.id)) next.delete(file.id); else next.add(file.id); setSelectedIds(next) }} /></td><td><div className="file-name"><span className="file-icon">{extensionLabel(file.logicalName)}</span><div><b>{file.logicalName}</b><small>{filePartitionLabel(file.logicalName)}</small></div></div></td><td>V{file.currentVersion}</td><td>{formatBytes(file.size)}</td><td>{formatTime(file.trashedAt)}</td><td>{file.relativePath}</td><td className="actions-cell">{canRestore && <button className="text-button" disabled={busyFileId === file.id} onClick={() => void onRestore(file)}>恢复</button>}{canPermanentDelete && <button className="text-button danger" disabled={busyFileId === file.id} onClick={() => void onPermanentDelete(file)}>永久删除</button>}{!canRestore && !canPermanentDelete && <span className="muted">只读</span>}</td></tr>)}</tbody></table></div>}
    </section>
  )
}

function ActivityList({ rows, compact = false }: { rows: ActivityView[]; compact?: boolean }): ReactElement {
  if (rows.length === 0) return <div className="empty-state compact">暂无同步记录。</div>
  return (
    <div className={`activity-list ${compact ? 'compact' : ''}`}>
      {rows.map((row) => (
        <div className="activity-row" key={row.id}>
          <span className="activity-mark" />
          <div><b>{ACTIVITY_LABELS[row.eventType] ?? row.eventType.replaceAll('_', ' ')}</b><span>{row.detail || '—'}</span></div>
          <time>{formatTime(row.createdAt)}</time>
        </div>
      ))}
    </div>
  )
}

function RecoveryPanel({ workspaceId, workspaceRole, canAdmin, onToast, onRefresh }: {
  workspaceId: string | null
  workspaceRole: CloudWorkspaceRole
  canAdmin: boolean
  onToast: (message: string) => void
  onRefresh: () => Promise<void>
}): ReactElement {
  const [scopeType, setScopeType] = useState<'FOLDER' | 'WORKSPACE'>(workspaceRole === 'MANAGER' ? 'WORKSPACE' : 'FOLDER')
  const [scopeValue, setScopeValue] = useState('')
  const [targetLocal, setTargetLocal] = useState(() => {
    const date = new Date(Date.now() - 60 * 60 * 1000)
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    return local.toISOString().slice(0, 16)
  })
  const [preview, setPreview] = useState<RewindPreviewView | null>(null)
  const [history, setHistory] = useState<RewindOperationView[]>([])
  const [locks, setLocks] = useState<Array<Record<string, unknown>>>([])
  const [busy, setBusy] = useState(false)

  async function refreshRecovery(): Promise<void> {
    if (!workspaceId) return
    const [historyRows, lockRows] = await Promise.all([
      window.excelSync.rewindHistory(workspaceId).catch(() => [] as RewindOperationView[]),
      canAdmin ? window.excelSync.activeLocks().catch(() => [] as Array<Record<string, unknown>>) : Promise.resolve([] as Array<Record<string, unknown>>)
    ])
    setHistory(historyRows)
    setLocks(lockRows)
  }

  useEffect(() => { void refreshRecovery() }, [workspaceId, canAdmin])

  function input(): { workspaceId: string; scopeType: 'FOLDER' | 'WORKSPACE'; scopeValue: string; targetTime: string } | null {
    if (!workspaceId || !targetLocal) return null
    if (scopeType === 'FOLDER' && !scopeValue.trim()) return null
    return { workspaceId, scopeType, scopeValue: scopeType === 'WORKSPACE' ? workspaceId : scopeValue.trim().replace(/^\/+|\/+$/g, ''), targetTime: new Date(targetLocal).toISOString() }
  }

  async function previewRewind(): Promise<void> {
    const safe = input()
    if (!safe) { onToast('请选择目标时间；文件夹回退还需要填写目录。'); return }
    setBusy(true)
    try { setPreview(await window.excelSync.rewindPreview(safe)) }
    catch (error) { setPreview(null); onToast(errorMessage(error)) }
    finally { setBusy(false) }
  }

  async function execute(): Promise<void> {
    const safe = input()
    if (!safe || !preview) return
    const affected = preview.actions.length
    if (!window.confirm(`确认执行 Rewind？\n\n范围：${scopeType === 'WORKSPACE' ? '整个 Workspace' : scopeValue}\n目标时间：${formatTime(preview.targetTime)}\n预计操作：${affected} 项\n\n内容恢复会生成新版本，不会把 current_version 倒退。`)) return
    setBusy(true)
    try {
      const result = await window.excelSync.executeRewind(safe)
      onToast(`Rewind 已执行：${String((result as { status?: unknown }).status ?? '已提交')}`)
      setPreview(null)
      await Promise.all([refreshRecovery(), onRefresh()])
    } catch (error) { onToast(`Rewind 失败：${errorMessage(error)}`) }
    finally { setBusy(false) }
  }

  async function retry(operationId: string): Promise<void> {
    setBusy(true)
    try { await window.excelSync.retryRewind(operationId); await refreshRecovery(); await onRefresh(); onToast('已重新执行失败的 Rewind 项。') }
    catch (error) { onToast(errorMessage(error)) }
    finally { setBusy(false) }
  }

  const summary = preview?.summary ?? {}
  return <div className="recovery-stack">
    <section className="panel recovery-panel"><div className="panel-header"><div><h2>Rewind 恢复</h2><p className="muted">先 Preview 再执行。恢复历史内容会生成新版本；路径和回收站状态按可验证 metadata history 恢复。</p></div></div><div className="recovery-controls"><label>范围<select value={scopeType} onChange={(event) => { setScopeType(event.target.value as 'FOLDER' | 'WORKSPACE'); setPreview(null) }}><option value="FOLDER">文件夹</option>{workspaceRole === 'MANAGER' && <option value="WORKSPACE">整个 Workspace</option>}</select></label>{scopeType === 'FOLDER' && <label>目录<input value={scopeValue} onChange={(event) => { setScopeValue(event.target.value); setPreview(null) }} placeholder="例如 Finance/2026" /></label>}<label>目标时间<input type="datetime-local" value={targetLocal} onChange={(event) => { setTargetLocal(event.target.value); setPreview(null) }} /></label><button className="secondary" disabled={busy || !workspaceId} onClick={() => void previewRewind()}>{busy ? '处理中…' : 'Preview'}</button></div>{preview && <div className="rewind-preview"><div className="rewind-summary">{Object.entries(summary).map(([key, value]) => <div key={key}><span>{key}</span><b>{value}</b></div>)}</div>{preview.actions.length > 0 && <div className="rewind-actions-list">{preview.actions.slice(0, 200).map((action, index) => <div key={`${String(action.fileId ?? '')}-${index}`}><b>{String(action.logicalName ?? action.fileId ?? '文件')}</b><span>{String(action.action ?? '')}{action.targetVersion ? ` · V${String(action.targetVersion)}` : ''}{action.targetRelativePath ? ` · ${String(action.targetRelativePath)}` : ''}</span></div>)}</div>}{preview.unsupported.length > 0 && <div className="version-compare-error">{preview.unsupported.length} 个项目缺少足够历史证据，将不会伪造恢复。</div>}<div className="recovery-confirm"><span>预计影响 {preview.actions.length} 项</span><button className="primary" disabled={busy || preview.actions.length === 0} onClick={() => void execute()}>确认执行 Rewind</button></div></div>}</section>
    <section className="panel"><div className="panel-header"><div><h3>Rewind 历史</h3><p className="muted">失败项可以单独重试，不会重新执行已经 DONE 的项。</p></div><span className="count-pill">{history.length}</span></div>{history.length === 0 ? <div className="empty-state compact">暂无 Rewind 记录。</div> : <div className="recovery-history">{history.map((row) => <div key={row.id}><div><b>{row.scope_type === 'WORKSPACE' ? 'Workspace' : row.scope_value}</b><span>{formatTime(row.target_time)} · {formatTime(row.created_at)}</span></div><strong className={row.status.toLowerCase()}>{row.status}</strong>{['PARTIAL', 'FAILED'].includes(row.status) && <button className="secondary" disabled={busy} onClick={() => void retry(row.id)}>重试失败项</button>}</div>)}</div>}</section>
    {canAdmin && <section className="panel"><div className="panel-header"><div><h3>Active Locks</h3><p className="muted">仅显示仍在 TTL 内的编辑 Lease。</p></div><span className="count-pill">{locks.length}</span></div>{locks.length === 0 ? <div className="empty-state compact">当前没有活跃编辑锁。</div> : <div className="active-lock-list">{locks.map((row, index) => <div key={String(row.lease_id ?? index)}><div><b>{String(row.logical_name ?? '文件')}</b><span>{String(row.workspace_name ?? '')} · {String(row.relative_path ?? '')}</span></div><span>{String(row.owner_name ?? '')} · {String(row.device_name ?? '')}</span><time>{formatTime(String(row.expires_at ?? ''))}</time></div>)}</div>}</section>}
  </div>
}

function VersionsDrawer({ file, versions, busy, canRestore, onClose, onPreview, onDownload, onOpenCopy, onRestore }: {
  file: LocalFileView | null
  versions: VersionView[]
  busy: boolean
  canRestore: boolean
  onClose: () => void
  onPreview: (version: number) => Promise<void>
  onDownload: (version: number) => Promise<void>
  onOpenCopy: (version: number) => Promise<void>
  onRestore: (version: number) => Promise<void>
}): ReactElement | null {
  const [fromVersion, setFromVersion] = useState<number | null>(null)
  const [toVersion, setToVersion] = useState<number | null>(null)
  const [diff, setDiff] = useState<VersionDiffView | null>(null)
  const [compareBusy, setCompareBusy] = useState(false)
  const [compareError, setCompareError] = useState('')
  useEffect(() => {
    if (!file) { setFromVersion(null); setToVersion(null); setDiff(null); setCompareError(''); return }
    const available = versions.filter((item) => item.available !== false).map((item) => item.version)
    setFromVersion(available[1] ?? available[0] ?? null)
    setToVersion(available[0] ?? null)
    setDiff(null)
    setCompareError('')
  }, [file?.id, versions.map((item) => `${item.version}:${item.available !== false}`).join('|')])
  if (!file) return null
  const activeFile = file

  async function compare(): Promise<void> {
    if (fromVersion == null || toVersion == null || fromVersion === toVersion) return
    setCompareBusy(true)
    setCompareError('')
    try {
      setDiff(await window.excelSync.compareVersions(activeFile.id, fromVersion, toVersion))
    } catch (error) {
      setDiff(null)
      setCompareError(errorMessage(error))
    } finally {
      setCompareBusy(false)
    }
  }

  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="drawer version-explorer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-head"><div><p className="eyebrow">Version Explorer</p><h3>{file.logicalName}</h3><small>历史副本使用独立缓存，不会进入同步目录。</small></div><button className="icon-button" onClick={onClose}>×</button></div>
        <section className="version-compare-panel">
          <div className="version-compare-controls"><label>旧版本<select value={fromVersion ?? ''} onChange={(event) => setFromVersion(Number(event.target.value))}>{versions.filter((item) => item.available !== false).map((item) => <option key={`from-${item.version}`} value={item.version}>V{item.version}</option>)}</select></label><span>→</span><label>新版本<select value={toVersion ?? ''} onChange={(event) => setToVersion(Number(event.target.value))}>{versions.filter((item) => item.available !== false).map((item) => <option key={`to-${item.version}`} value={item.version}>V{item.version}</option>)}</select></label><button className="secondary" disabled={compareBusy || fromVersion == null || toVersion == null || fromVersion === toVersion} onClick={() => void compare()}>{compareBusy ? '比较中…' : '比较版本'}</button></div>
          {compareError && <div className="version-compare-error">{compareError}</div>}
          {diff && <div className="version-diff"><div className="version-diff-summary"><div><span>Sheet 新增</span><b>{diff.summary.sheetsAdded}</b></div><div><span>Sheet 删除</span><b>{diff.summary.sheetsRemoved}</b></div><div><span>Sheet 变化</span><b>{diff.summary.sheetsChanged}</b></div><div><span>单元格变化</span><b>{diff.summary.modifiedCells}</b></div></div>{diff.summary.truncated && <div className="version-compare-error">差异过大，已降级为摘要：{diff.summary.guardReason ?? '已截断'}</div>}{diff.kind === 'metadata' ? <div className="metadata-diff-list">{diff.metadata.map((row) => <div key={row.field}><b>{row.field}</b><span>{row.oldValue || '—'}</span><span>→</span><span>{row.newValue || '—'}</span></div>)}</div> : <div className="sheet-diff-list">{diff.sheets.filter((sheet) => sheet.status !== 'UNCHANGED').map((sheet) => <details key={sheet.name} open={sheet.status === 'CHANGED'}><summary><b>{sheet.name}</b><span>{sheet.status} · {sheet.modifiedCells} 个 Cell · 行 {sheet.oldRowCount}→{sheet.newRowCount}</span></summary>{sheet.changes.length === 0 ? <div className="preview-meta">没有逐 Cell 明细，可能是 Sheet 新增/删除或触发了大文件保护。</div> : <div className="cell-diff-table"><div className="cell-diff-head"><span>Cell</span><span>旧值 / 公式</span><span>新值 / 公式</span></div>{sheet.changes.slice(0, 500).map((cell) => <div key={`${sheet.name}-${cell.address}`}><b>{cell.address}</b><span>{cell.oldValue || '—'}{cell.oldFormula ? <code>{`=${cell.oldFormula}`}</code> : null}</span><span>{cell.newValue || '—'}{cell.newFormula ? <code>{`=${cell.newFormula}`}</code> : null}</span></div>)}</div>}</details>)}</div>}</div>}
        </section>
        <div className="version-list">
          {versions.map((version) => {
            const current = version.version === file.currentVersion
            const integrity = version.integrity_status ?? 'HEALTHY'
            const available = version.available !== false && !['LEGACY_UNRECOVERABLE', 'MISSING_REMOTE_FILE_REFERENCE', 'MISSING_STORAGE_REFERENCE'].includes(integrity)
            const integrityText = integrity === 'HEALTHY' ? '版本可用' : integrity === 'MISSING_METADATA' ? '旧版历史索引缺失' : integrity === 'MISSING_STORAGE_REFERENCE' ? 'Storage 引用缺失' : integrity === 'MISSING_REMOTE_FILE_REFERENCE' ? '云端文件无法定位' : integrity === 'LEGACY_UNRECOVERABLE' ? '旧版历史不可恢复' : integrity
            return <article className={`version-card ${available ? '' : 'version-unavailable'}`} key={version.version}>
              <div className="version-title"><strong>V{version.version}</strong>{current && <span className="current-version-pill">当前版本</span>}<span>{version.created_at ? formatTime(version.created_at) : '时间未知'}</span></div>
              <div className="version-meta"><span>{version.size == null ? '大小未知' : formatBytes(version.size)}</span><span>{storageBackendLabel(version.storage_backend)}{version.storage_backend !== 'telegram_user_group' && version.storage_name ? ` · ${version.storage_name}` : ''}{version.storage_status ? ` · ${version.storage_status}` : ''}</span></div>
              <div className="version-hash"><span>Hash</span><code>{shortHash(version.hash)}</code></div>
              <p>{version.restored_from_version ? `由 V${version.restored_from_version} 恢复生成` : version.base_version == null ? '基于版本未知' : `基于 V${version.base_version}`}</p>
              <div className={`version-integrity ${available ? 'healthy' : 'warning'}`}>{integrityText}</div>
              <div className="version-actions">
                <button className="secondary" disabled={busy || !available} onClick={() => void onPreview(version.version)}>预览</button>
                <button className="secondary" disabled={busy || !available} onClick={() => void onDownload(version.version)}>下载副本</button>
                <button className="secondary" disabled={busy || !available} onClick={() => void onOpenCopy(version.version)}>{current ? '打开' : '打开历史副本'}</button>
                {!current && <button className="primary" disabled={busy || !available || !canRestore} onClick={() => void onRestore(version.version)}>{!canRestore ? '查看权限不可恢复' : '恢复为新版本'}</button>}
              </div>
            </article>
          })}
          {versions.length === 0 && <div className="empty-state">暂无可定位的版本记录。</div>}
        </div>
      </aside>
    </div>
  )
}

function SettingsPage({ settings, onChange, onSave, onChooseDirectory, canManageStorage, authenticated, onSessionInvalidated, onToast, busyAction }: {
  settings: SettingsView
  onChange: (settings: SettingsView) => void
  onSave: () => Promise<void>
  onChooseDirectory: () => Promise<void>
  canManageStorage: boolean
  authenticated: boolean
  onSessionInvalidated: () => Promise<void>
  onToast: (message: string) => void
  busyAction: ActionKey | null
}): ReactElement {
  const [devices, setDevices] = useState<DeviceView[]>([])
  const [clientVersion, setClientVersion] = useState<ClientVersionInfo | null>(null)
  const [securityBusy, setSecurityBusy] = useState(false)
  const [telegramUserStatus, setTelegramUserStatus] = useState<TelegramUserStorageStatusView | null>(null)
  const [telegramPhone, setTelegramPhone] = useState('')
  const [telegramCode, setTelegramCode] = useState('')
  const [telegramPassword, setTelegramPassword] = useState('')
  const [telegramBusy, setTelegramBusy] = useState(false)
  const telegramStateRef = useRef<TelegramUserStorageStatusView['state'] | null>(null)

  async function refreshSecurity(): Promise<void> {
    const [version, deviceRows] = await Promise.all([
      window.excelSync.clientVersion().catch(() => null),
      authenticated ? window.excelSync.devices().catch(() => [] as DeviceView[]) : Promise.resolve([] as DeviceView[])
    ])
    setClientVersion(version)
    setDevices(deviceRows)
  }

  useEffect(() => {
    void refreshSecurity()
    let disposed = false
    const refreshTelegramStatus = async (): Promise<void> => {
      const next = await window.excelSync.telegramUserStatus().catch(() => null)
      if (!next || disposed) return
      if (next.state === 'AUTH_FAILED' && telegramStateRef.current !== 'AUTH_FAILED') {
        onToast('Telegram 授权失败或已被撤销，可以直接重新验证，无需退出 ExcelSync。')
      }
      telegramStateRef.current = next.state
      setTelegramUserStatus(next)
    }
    void refreshTelegramStatus()
    const timer = window.setInterval(() => { void refreshTelegramStatus() }, 4000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [authenticated])

  async function runTelegramAction(action: () => Promise<TelegramUserStorageStatusView>, success?: string): Promise<void> {
    if (telegramBusy) return
    setTelegramBusy(true)
    try {
      const next = await action()
      setTelegramUserStatus(next)
      if (success) onToast(success)
    } catch (error) {
      onToast(errorMessage(error))
      const current = await window.excelSync.telegramUserStatus().catch(() => null)
      if (current) setTelegramUserStatus(current)
    } finally {
      setTelegramBusy(false)
    }
  }

  async function logoutDevice(device: DeviceView): Promise<void> {
    if (securityBusy) return
    setSecurityBusy(true)
    try {
      await window.excelSync.logoutDevice(device.id)
      if (device.current) {
        onToast('当前设备已注销。')
        await onSessionInvalidated()
      } else {
        await refreshSecurity()
        onToast(`已注销设备：${device.deviceName}`)
      }
    } catch (error) {
      onToast(errorMessage(error))
    } finally {
      setSecurityBusy(false)
    }
  }

  async function logoutOtherDevices(): Promise<void> {
    if (securityBusy) return
    setSecurityBusy(true)
    try {
      const count = await window.excelSync.logoutOtherDevices()
      await refreshSecurity()
      onToast(`已注销其他设备上的 ${count} 个 Session。`)
    } catch (error) {
      onToast(errorMessage(error))
    } finally {
      setSecurityBusy(false)
    }
  }

  async function logoutAllDevices(): Promise<void> {
    if (securityBusy) return
    setSecurityBusy(true)
    try {
      const count = await window.excelSync.logoutAllDevices()
      onToast(`已注销全部设备上的 ${count} 个 Session。`)
      await onSessionInvalidated()
    } catch (error) {
      onToast(errorMessage(error))
    } finally {
      setSecurityBusy(false)
    }
  }

  return (
    <div className="settings-grid">
      <section className="panel">
        <div className="panel-header"><div><h2>同步设置</h2><p className="muted">设置本地同步文件夹、自动同步和版本保留规则。</p></div></div>
        <div className="form-grid">
          <label className="wide">同步文件夹<div className="input-action"><input value={settings.syncDirectory} readOnly placeholder="请选择一个文件夹" /><ActionButton actionKey="chooseFolder" label="选择" className="secondary" busyAction={busyAction} onClick={() => void onChooseDirectory()} /></div></label>
          <label className="wide">Worker 地址<input value={settings.workerUrl} onChange={(event) => onChange({ ...settings, workerUrl: event.target.value })} /></label>
          <label>重试基础间隔（秒）<input type="number" min={2} max={3600} value={settings.retryBaseSeconds} onChange={(event) => onChange({ ...settings, retryBaseSeconds: Number(event.target.value) })} /></label>
          <label>保留版本数量<input type="number" min={2} max={500} value={settings.retentionLimit} onChange={(event) => onChange({ ...settings, retentionLimit: Number(event.target.value) })} /></label>
          <label className="switch-row"><input type="checkbox" checked={settings.autoSync} onChange={(event) => onChange({ ...settings, autoSync: event.target.checked })} /><span><b>自动同步</b><small>联网时自动处理保存到本地的同步队列。</small></span></label>
          <label className="switch-row"><input type="checkbox" checked={settings.startWithWindows} onChange={(event) => onChange({ ...settings, startWithWindows: event.target.checked })} /><span><b>开机启动</b><small>Windows 启动后在系统托盘保持 ExcelSync 运行。</small></span></label>
        </div>
        <ActionButton actionKey="saveSettings" label="保存设置" className="primary" busyAction={busyAction} onClick={() => void onSave()} />
      </section>

      <section className="panel">
        <div className="panel-header"><div><h2>账号与设备</h2><p className="muted">每台电脑使用独立 Device ID；注销设备只撤销对应 Session，不删除本地文件或云端数据。</p></div>{authenticated && <button className="secondary" disabled={securityBusy} onClick={() => void refreshSecurity()}>刷新</button>}</div>
        {!authenticated ? <div className="empty-state compact">登录后可以查看并管理当前账号的设备。</div> : <>
          <div className="admin-table">
            {devices.map((device) => <div className="admin-row" key={device.id}><div><b>{device.deviceName}{device.current ? ' · 当前设备' : ''}</b><small>{device.osName} {device.osVersion} · 客户端 {device.clientVersion}</small></div><span>{device.status}</span><small>最后活动 {formatTime(device.lastSeenAt)} · Session {device.activeSessions}</small><div className="row-actions"><button className="secondary danger" disabled={securityBusy} onClick={() => void logoutDevice(device)}>{device.current ? '注销当前设备' : '注销此设备'}</button></div></div>)}
            {devices.length === 0 && <div className="empty-state compact">当前没有可显示的设备记录。</div>}
          </div>
          <div className="row-actions" style={{ marginTop: 12 }}><button className="secondary" disabled={securityBusy} onClick={() => void logoutOtherDevices()}>注销其他设备</button><button className="secondary danger" disabled={securityBusy} onClick={() => void logoutAllDevices()}>注销全部设备</button></div>
        </>}
      </section>

      <section className="panel">
        <div className="panel-header"><div><h2>客户端版本</h2><p className="muted">版本策略由 Worker 统一返回，支持最低兼容版本和灰度比例。</p></div></div>
        {clientVersion ? <div className="system-metrics"><div><span>最新版本</span><b>{clientVersion.latest}</b></div><div><span>最低兼容</span><b>{clientVersion.minimum}</b></div><div><span>API</span><b>{clientVersion.apiVersion}</b></div><div><span>灰度比例</span><b>{clientVersion.rollout}%</b></div><div><span>更新状态</span><b>{clientVersion.updateRequired ? '必须更新' : clientVersion.updateAvailable ? '可更新' : '当前可用'}</b></div></div> : <div className="empty-state compact">暂时无法读取版本策略。</div>}
      </section>

      <section className="panel">
        <div className="panel-header"><div><h2>存储</h2><p className="muted">新文件默认使用 Telegram 私人群组；旧 Telegram Bot 文件保持原存储并继续兼容。</p></div></div>
        <div className="form-grid">
          <div className="wide">
            <b>默认存储后端</b>
            <label className="switch-row"><input type="radio" name="default-storage" checked={settings.defaultStorageBackend === 'telegram_user_group'} onChange={() => onChange({ ...settings, defaultStorageBackend: 'telegram_user_group' })} /><span><b>Telegram 私人群组</b><small>Windows 本机 MTProto Bridge，大文件默认使用此路径。</small></span></label>
            <label className="switch-row"><input type="radio" name="default-storage" checked={settings.defaultStorageBackend === 'telegram_bot'} onChange={() => onChange({ ...settings, defaultStorageBackend: 'telegram_bot' })} /><span><b>Telegram Bot</b><small>兼容旧文件和备用上传；大文件会明确拒绝，不会静默切换。</small></span></label>
          </div>
        </div>
        <div className="admin-table" style={{ marginTop: 12 }}>
          <div className="admin-row">
            <div><b>Telegram 私人群组</b><small>状态：{telegramUserStatus?.state ?? '读取中'}{telegramUserStatus?.chatTitle ? ` · 群组 ${telegramUserStatus.chatTitle}` : ''}</small></div>
            <span>{telegramUserStatus?.state === 'AUTH_FAILED' ? '授权失败' : telegramUserStatus?.authorized ? '已授权' : '未授权'}</span>
            <small>{telegramUserStatus?.phoneMasked ? `账号 ${telegramUserStatus.phoneMasked}` : 'Telegram 用户 Session 仅保存在本机 ExcelSync 目录'}</small>
            <div className="row-actions">
              <button className="secondary" disabled={telegramBusy} onClick={() => void runTelegramAction(() => window.excelSync.telegramUserStatus())}>刷新状态</button>
              <button className="secondary" disabled={telegramBusy || !telegramUserStatus?.authorized} onClick={() => void (async () => {
                setTelegramBusy(true)
                try {
                  const count = await window.excelSync.syncTelegramUserGroup()
                  const current = await window.excelSync.telegramUserStatus()
                  setTelegramUserStatus(current)
                  onToast(`私人群组同步完成，新增导入 ${count} 个文件。`)
                } catch (error) { onToast(errorMessage(error)) } finally { setTelegramBusy(false) }
              })()}>同步私人群组</button>
              <button className="secondary" disabled={telegramBusy} onClick={() => void runTelegramAction(() => window.excelSync.reauthorizeTelegramUser(), '已清除 ExcelSync 私人群组授权，可重新登录。')}>重新授权</button>
            </div>
          </div>
        </div>
        {telegramUserStatus?.state === 'UNCONFIGURED' && <p className="hint">Telegram API ID / API Hash 不会进入 Renderer。请先在本机主进程安全配置中提供 ExcelSync 专用 Telegram App 凭据，然后在这里完成账号授权。</p>}
        {telegramUserStatus && telegramUserStatus.state !== 'UNCONFIGURED' && !telegramUserStatus.authorized && <div className="form-grid" style={{ marginTop: 12 }}>
          {(telegramUserStatus.state === 'UNAUTHORIZED' || telegramUserStatus.state === 'ERROR') && <label className="wide">手机号<div className="input-action"><input value={telegramPhone} onChange={(event) => setTelegramPhone(event.target.value)} placeholder="+86..." autoComplete="tel" /><button className="secondary" disabled={telegramBusy || telegramPhone.trim().length < 6} onClick={() => void runTelegramAction(() => window.excelSync.beginTelegramUserAuth(telegramPhone))}>发送 Telegram 验证码</button></div></label>}
          {telegramUserStatus.state === 'AUTH_FAILED' && <div className="wide"><p className="hint">Telegram 已拒绝或撤销本次授权。可以直接重新发送验证码，不需要退出 ExcelSync。</p><button className="secondary" disabled={telegramBusy || !telegramUserStatus.phoneMasked} onClick={() => void runTelegramAction(() => window.excelSync.restartTelegramUserAuth(), '新的 Telegram 验证码已发送。')}>重新验证</button></div>}
          {telegramUserStatus.state === 'WAITING_CODE' && <label className="wide">Telegram 验证码<div className="input-action"><input value={telegramCode} onChange={(event) => setTelegramCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" /><button className="secondary" disabled={telegramBusy || telegramCode.trim().length < 3} onClick={() => void runTelegramAction(() => window.excelSync.submitTelegramUserCode(telegramCode))}>验证</button><button className="secondary" disabled={telegramBusy} onClick={() => void runTelegramAction(() => window.excelSync.restartTelegramUserAuth(), '新的 Telegram 验证码已发送。')}>重新发送验证码</button></div><small>验证码只在本机输入；如果 Telegram 提示“不是我”后撤销了授权，可直接重新发送。</small></label>}
          {telegramUserStatus.state === 'WAITING_2FA' && <label className="wide">Telegram 2FA 密码<div className="input-action"><input type="password" value={telegramPassword} onChange={(event) => setTelegramPassword(event.target.value)} autoComplete="current-password" /><button className="secondary" disabled={telegramBusy || !telegramPassword} onClick={() => void runTelegramAction(() => window.excelSync.submitTelegramUserPassword(telegramPassword))}>继续</button></div><small>2FA 密码只在本机输入。</small></label>}
        </div>}
        {telegramUserStatus?.errorMessage && <p className="hint">{telegramUserStatus.errorCode}: {telegramUserStatus.errorMessage}</p>}
        <p className="hint">Telegram Bot：{canManageStorage ? '连接、Bot Token、配对和健康检查仍在“管理中心 → 存储连接”。' : '由组织管理员管理，旧 Bot 文件无需迁移。'}</p>
      </section>
    </div>
  )
}

export default function App(): ReactElement {
  const [auth, setAuth] = useState<AuthState>(EMPTY_AUTH)
  const [page, setPage] = useState<Page>('dashboard')
  const [dashboardData, setDashboardData] = useState<DashboardView | null>(null)
  const [files, setFiles] = useState<LocalFileView[]>([])
  const [trashFiles, setTrashFiles] = useState<TrashFileView[]>([])
  const [tasks, setTasks] = useState<PendingView[]>([])
  const [problems, setProblems] = useState<ProblemView[]>([])
  const [uiTasks, setUiTasks] = useState<UiTask[]>([])
  const [userTasks, setUserTasks] = useState<UserTask[]>([])
  const [taskDraft, setTaskDraft] = useState<TaskDraft | null>(null)
  const [globalSearch, setGlobalSearch] = useState('')
  const deferredGlobalSearch = useDeferredValue(globalSearch)
  const [notificationData, setNotificationData] = useState<NotificationListView | null>(null)
  const [notificationOpen, setNotificationOpen] = useState(false)
  const [notificationFilter, setNotificationFilter] = useState<'all' | 'unread' | 'file' | 'task' | 'system'>('all')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedSearchInput>({})
  const [advancedResults, setAdvancedResults] = useState<AdvancedSearchFileView[]>([])
  const [advancedBusy, setAdvancedBusy] = useState(false)
  const [activity, setActivity] = useState<ActivityView[]>([])
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [uploadStorageBackend, setUploadStorageBackend] = useState<SettingsView['defaultStorageBackend']>('telegram_user_group')
  const [paused, setPaused] = useState(false)
  const [selectedFile, setSelectedFile] = useState<LocalFileView | null>(null)
  const [previewTarget, setPreviewTarget] = useState<LocalFileView | null>(null)
  const [previewData, setPreviewData] = useState<PreviewView | null>(null)
  const [previewPresence, setPreviewPresence] = useState<FilePresenceView | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewVersion, setPreviewVersion] = useState<number | null>(null)
  const [versions, setVersions] = useState<VersionView[]>([])
  const [versionBusy, setVersionBusy] = useState(false)
  const [busyFileId, setBusyFileId] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const [undoTrash, setUndoTrash] = useState<{ fileId: string; logicalName: string; message: string } | null>(null)
  const [busyAction, setBusyAction] = useState<ActionKey | null>(null)
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null)
  const [transferProgress, setTransferProgress] = useState<Record<string, TransferProgressView>>({})
  const busyActionRef = useRef<ActionKey | null>(null)
  const transferCleanupTimersRef = useRef(new Map<string, number>())
  const previewRequestRef = useRef(0)
  const legacyTaskMigrationRef = useRef(false)
  const uploadStorageTouchedRef = useRef(false)

  const memberships = auth.memberships ?? []
  const currentMembership: WorkspaceMembershipView | undefined = memberships.find((item) => item.workspaceId === auth.defaultWorkspaceId && item.status === 'ACTIVE') ?? memberships.find((item) => item.status === 'ACTIVE')
  const workspaceName = currentMembership?.workspaceName ?? '企业工作区'
  const systemRole: SystemRole = auth.user?.systemRole ?? 'MEMBER'
  const canAdmin = systemRole === 'OWNER' || systemRole === 'ADMIN'
  const workspaceRole: CloudWorkspaceRole = canAdmin ? 'MANAGER' : (currentMembership?.role ?? 'VIEWER')
  const visiblePages: Page[] = ['dashboard', 'files', 'favorites', 'trash', 'tasks', 'activity', 'settings', ...(canAdmin ? ['admin' as Page] : [])]
  const normalizedGlobalSearch = deferredGlobalSearch.trim().toLocaleLowerCase('zh-CN')
  const globalFileResults = normalizedGlobalSearch
    ? files.filter((file) => `${file.logicalName}\n${file.relativePath}\n${file.extension}\n${filePartitionLabel(file.logicalName)}`.toLocaleLowerCase('zh-CN').includes(normalizedGlobalSearch)).slice(0, 6)
    : []
  const globalTaskResults = normalizedGlobalSearch
    ? userTasks.filter((task) => `${task.title}\n${task.description}\n${task.assignee ?? ''}\n${task.linkedResourceLabel ?? ''}`.toLocaleLowerCase('zh-CN').includes(normalizedGlobalSearch)).slice(0, 5)
    : []
  const activeTransfers = Object.values(transferProgress).sort((a, b) => b.updatedAt - a.updatedAt)

  useEffect(() => {
    if (!visiblePages.includes(page)) setPage('dashboard')
  }, [page, systemRole, workspaceRole])

  useEffect(() => {
    if (!auth.authenticated || !currentMembership?.workspaceId || legacyTaskMigrationRef.current) return
    legacyTaskMigrationRef.current = true
    void (async () => {
      const raw = localStorage.getItem(USER_TASKS_STORAGE_KEY) ?? localStorage.getItem(LEGACY_USER_TASKS_STORAGE_KEY)
      if (!raw) return
      let legacy: UserTask[] = []
      try {
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed)) legacy = parsed.filter((item): item is UserTask => Boolean(item && typeof item === 'object' && 'id' in item && 'title' in item))
      } catch {
        return
      }
      if (legacy.length === 0) {
        localStorage.removeItem(USER_TASKS_STORAGE_KEY)
        localStorage.removeItem(LEGACY_USER_TASKS_STORAGE_KEY)
        return
      }
      try {
        await window.excelSync.migrateLocalTasks(legacy.slice(0, 200).map((task) => ({
          legacyClientId: task.id,
          workspaceId: currentMembership.workspaceId,
          title: task.title,
          description: task.description || '',
          status: task.status === 'done' ? 'DONE' : task.status === 'running' ? 'IN_PROGRESS' : 'TODO',
          priority: task.priority.toUpperCase(),
          legacyAssigneeText: task.assignee || null,
          dueAt: task.dueDate ? new Date(`${task.dueDate}T23:59:59`).toISOString() : null,
          fileIds: task.linkedFileId ? [task.linkedFileId] : []
        })))
        localStorage.removeItem(USER_TASKS_STORAGE_KEY)
        localStorage.removeItem(LEGACY_USER_TASKS_STORAGE_KEY)
        setUserTasks((await window.excelSync.tasks('mine')).map(cloudTaskToUserTask))
        setToast(`已将 ${legacy.length} 个旧版本地任务迁移到企业任务库。`)
      } catch (error) {
        legacyTaskMigrationRef.current = false
        setToast(`旧任务迁移未完成，原 localStorage 已保留：${errorMessage(error)}`)
      }
    })()
  }, [auth.authenticated, currentMembership?.workspaceId])

  function startUiTask(label: string, operation: string, total = 1): string {
    const id = crypto.randomUUID()
    const task: UiTask = { id, label, operation, status: 'running', completed: 0, total: Math.max(1, total), detail: '正在处理', updatedAt: Date.now() }
    setUiTasks((current) => [task, ...current].slice(0, 60))
    return id
  }

  function updateUiTask(id: string, patch: Partial<Pick<UiTask, 'status' | 'completed' | 'detail'>>): void {
    setUiTasks((current) => current.map((task) => task.id === id ? { ...task, ...patch, updatedAt: Date.now() } : task))
  }

  async function runTrackedAction(key: ActionKey, label: string, task: () => Promise<string>): Promise<void> {
    if (busyActionRef.current) {
      const active = actionFeedback?.label ?? '另一个操作'
      setToast(`${active}正在处理中，请等待完成后再点击。`)
      return
    }
    busyActionRef.current = key
    setBusyAction(key)
    setActionFeedback({ key, label, state: 'running', detail: '正在处理，请不要重复点击。' })
    try {
      const detail = await task()
      setActionFeedback({ key, label, state: 'done', detail })
      setToast(`「${label}」：${detail}`)
    } catch (error) {
      const detail = errorMessage(error)
      setActionFeedback({ key, label, state: 'error', detail })
      setToast(`「${label}」失败：${detail}`)
    } finally {
      busyActionRef.current = null
      setBusyAction(null)
    }
  }

  async function refreshAuth(): Promise<void> {
    const state = await window.excelSync.authState()
    setAuth(state)
    if (!state.authenticated) {
      setPage('dashboard')
      setSelectedFile(null)
      setPreviewTarget(null)
      setVersions([])
      setUserTasks([])
    }
    void refreshAll(state.authenticated, state).catch((error) => setToast(errorMessage(error)))
  }

  async function refreshNotifications(filter = notificationFilter): Promise<void> {
    if (!auth.authenticated) { setNotificationData(null); return }
    try {
      setNotificationData(await window.excelSync.notifications(filter))
    } catch {
      // Notifications are supplemental and must not break the main refresh loop.
    }
  }

  async function markNotificationRead(notification: NotificationView): Promise<void> {
    if (!notification.read_at) await window.excelSync.markNotificationRead(notification.id)
    await refreshNotifications()
  }

  async function markAllNotificationsRead(): Promise<void> {
    await window.excelSync.markAllNotificationsRead()
    await refreshNotifications()
  }

  function openNotificationResource(notification: NotificationView): void {
    if (notification.resource_type === 'file' && notification.resource_id) {
      const file = files.find((row) => row.id === notification.resource_id)
      if (file) void openPreview(file)
      else { setPage('files'); setToast('该通知关联的文件当前不在本地列表中，已打开文件页。') }
      setNotificationOpen(false)
      return
    }
    if (notification.resource_type === 'task') { setPage('tasks'); setNotificationOpen(false); return }
    setNotificationOpen(false)
  }

  async function runAdvancedSearch(): Promise<void> {
    if (!auth.authenticated) return
    setAdvancedBusy(true)
    try {
      setAdvancedResults(await window.excelSync.advancedSearch({ ...advancedFilters, q: globalSearch.trim() || advancedFilters.q }))
    } catch (error) {
      setToast(`高级搜索失败：${errorMessage(error)}`)
    } finally {
      setAdvancedBusy(false)
    }
  }

  async function refreshAll(includeTrash = auth.authenticated, authSnapshot: AuthState = auth): Promise<void> {
    const [dash, fileRows, taskRows, problemRows, activityRows, settingRows, trashRows, userTaskRows] = await Promise.all([
      window.excelSync.dashboard(),
      window.excelSync.files(),
      window.excelSync.pending(),
      window.excelSync.problems(),
      window.excelSync.activity(),
      window.excelSync.settings(),
      includeTrash ? window.excelSync.trash() : Promise.resolve([] as TrashFileView[]),
      authSnapshot.authenticated ? window.excelSync.tasks(
        (authSnapshot.user?.systemRole === 'OWNER' || authSnapshot.user?.systemRole === 'ADMIN' || (authSnapshot.memberships ?? []).find((item) => item.workspaceId === authSnapshot.defaultWorkspaceId)?.role === 'MANAGER') ? 'all' : 'mine',
        authSnapshot.defaultWorkspaceId ?? undefined
      ) : Promise.resolve([] as UserTaskView[])
    ])
    setDashboardData(dash)
    setFiles(fileRows)
    setTrashFiles(trashRows)
    setTasks(taskRows)
    setProblems(problemRows)
    setUserTasks(userTaskRows.map(cloudTaskToUserTask))
    setActivity(activityRows)
    setSettings(settingRows)
    if (!uploadStorageTouchedRef.current) setUploadStorageBackend(settingRows.defaultStorageBackend)
    setPaused(!settingRows.autoSync)
  }

  useEffect(() => {
    void refreshAuth().catch((error) => setToast(errorMessage(error)))
    const unsubscribe = window.excelSync.onStateChanged(() => {
      void refreshAll().catch(() => undefined)
    })
    const unsubscribeTransfer = window.excelSync.onTransferProgress((progress) => {
      const existingTimer = transferCleanupTimersRef.current.get(progress.id)
      if (existingTimer) window.clearTimeout(existingTimer)
      setTransferProgress((current) => ({ ...current, [progress.id]: progress }))
      if (progress.phase === 'done') {
        const timer = window.setTimeout(() => {
          setTransferProgress((current) => {
            const next = { ...current }
            delete next[progress.id]
            return next
          })
          transferCleanupTimersRef.current.delete(progress.id)
        }, 1500)
        transferCleanupTimersRef.current.set(progress.id, timer)
      }
    })
    const unsubscribeAuth = window.excelSync.onAuthChanged(() => {
      void refreshAuth().catch((error) => setToast(errorMessage(error)))
    })
    const timer = window.setInterval(() => {
      if (auth.authenticated) void refreshAll().catch(() => undefined)
    }, 15_000)
    return () => {
      unsubscribe()
      unsubscribeTransfer()
      unsubscribeAuth()
      for (const timeout of transferCleanupTimersRef.current.values()) window.clearTimeout(timeout)
      transferCleanupTimersRef.current.clear()
      window.clearInterval(timer)
    }
  }, [auth.authenticated])

  useEffect(() => {
    if (!auth.authenticated) { setNotificationData(null); return }
    void refreshNotifications(notificationFilter)
    const timer = window.setInterval(() => void refreshNotifications(notificationFilter), 30_000)
    return () => window.clearInterval(timer)
  }, [auth.authenticated, notificationFilter])

  useEffect(() => {
    if (!previewTarget || !auth.authenticated) {
      setPreviewPresence(null)
      return
    }
    let active = true
    const refreshPresence = async (): Promise<void> => {
      try {
        const next = await window.excelSync.filePresence(previewTarget.id)
        if (active) setPreviewPresence(next)
      } catch {
        if (active) setPreviewPresence(null)
      }
    }
    void refreshPresence()
    const timer = window.setInterval(() => void refreshPresence(), 20_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [previewTarget?.id, auth.authenticated])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => {
      setToast('')
      setUndoTrash((current) => current?.message === toast ? null : current)
    }, 5000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const subtitle = useMemo(() => {
    if (!dashboardData) return '正在启动…'
    if (!dashboardData.health.online) return '当前离线，本地修改会保留在同步队列中'
    if (dashboardData.pending) return `${dashboardData.pending} 项修改等待同步`
    return '本地修改均已处理完成'
  }, [dashboardData])

  async function openVersions(file: LocalFileView): Promise<void> {
    try {
      setSelectedFile(file)
      setVersions(await window.excelSync.versions(file.id))
    } catch (error) {
      setToast(errorMessage(error))
      setSelectedFile(null)
    }
  }

  async function restore(version: number): Promise<void> {
    if (!selectedFile) return
    setVersionBusy(true)
    try {
      await window.excelSync.restore(selectedFile.id, version)
      setToast(`已将 V${version} 恢复并生成一个新版本。`)
      await refreshAll()
      const refreshed = files.find((file) => file.id === selectedFile.id) ?? selectedFile
      setSelectedFile(refreshed)
      setVersions(await window.excelSync.versions(selectedFile.id))
    } catch (error) {
      setToast(errorMessage(error))
    } finally {
      setVersionBusy(false)
    }
  }

  async function restoreLocalCopy(file: LocalFileView): Promise<void> {
    const taskId = startUiTask(file.logicalName, '下载到本地')
    setBusyFileId(file.id)
    try {
      await window.excelSync.restoreLocalCopy(file.id)
      updateUiTask(taskId, { status: 'done', completed: 1, detail: '本地副本已恢复' })
      await refreshAll(true)
      setToast(`已将 ${file.logicalName} 的当前云端版本恢复到本地，不会创建新版本。`)
    } catch (error) {
      updateUiTask(taskId, { status: 'error', detail: errorMessage(error) })
      setToast(errorMessage(error))
    } finally {
      setBusyFileId(null)
    }
  }

  async function trashSaasFile(file: LocalFileView): Promise<void> {
    const confirmed = window.confirm(`确定要将“${file.logicalName}”移入回收站吗？`)
    if (!confirmed) return
    const taskId = startUiTask(file.logicalName, '删除')
    setBusyFileId(file.id)
    try {
      await window.excelSync.trashFile(file.id)
      updateUiTask(taskId, { status: 'done', completed: 1, detail: '已移入回收站' })
      await refreshAll(true)
      const message = `已将 ${file.logicalName} 移入回收站。`
      setUndoTrash({ fileId: file.id, logicalName: file.logicalName, message })
      setToast(message)
    } catch (error) {
      updateUiTask(taskId, { status: 'error', detail: errorMessage(error) })
      setToast(errorMessage(error))
    } finally {
      setBusyFileId(null)
    }
  }

  async function undoTrashFile(): Promise<void> {
    const item = undoTrash
    if (!item) return
    try {
      await window.excelSync.restoreTrash(item.fileId)
      setUndoTrash(null)
      await refreshAll(true)
      setToast(`已撤销删除：${item.logicalName}`)
    } catch (error) {
      setToast(`撤销失败：${errorMessage(error)}`)
    }
  }

  async function restoreTrashFile(file: TrashFileView): Promise<void> {
    const taskId = startUiTask(file.logicalName, '恢复')
    setBusyFileId(file.id)
    try {
      await window.excelSync.restoreTrash(file.id)
      updateUiTask(taskId, { status: 'done', completed: 1, detail: '已恢复' })
      await refreshAll(true)
      setToast(`已恢复 ${file.logicalName}。如果本地没有副本，它会显示为“仅云端”。`)
    } catch (error) {
      updateUiTask(taskId, { status: 'error', detail: errorMessage(error) })
      setToast(errorMessage(error))
    } finally {
      setBusyFileId(null)
    }
  }

  async function bulkRestoreTrash(rows: TrashFileView[]): Promise<void> {
    if (!window.confirm(`恢复所选 ${rows.length} 个文件？`)) return
    const taskId = startUiTask(`${rows.length} 个文件`, '批量恢复', rows.length)
    try {
      let completed = 0
      for (const file of rows) {
        await window.excelSync.restoreTrash(file.id)
        completed += 1
        updateUiTask(taskId, { completed, detail: `${completed} / ${rows.length}` })
      }
      updateUiTask(taskId, { status: 'done', completed: rows.length, detail: '批量恢复完成' })
      await refreshAll(true)
      setToast(`已恢复 ${rows.length} 个文件。`)
    } catch (error) {
      updateUiTask(taskId, { status: 'error', detail: errorMessage(error) })
      setToast(`批量恢复中断：${errorMessage(error)}`)
      await refreshAll(true).catch(() => undefined)
    }
  }

  async function permanentlyDeleteTrashFile(file: TrashFileView): Promise<void> {
    if (!window.confirm(`永久删除“${file.logicalName}”？\n\n删除后它会从 SaaS 回收站消失且不能通过客户端恢复。底层历史存储对象仍按当前存储策略保留。`)) return
    const taskId = startUiTask(file.logicalName, '永久删除')
    setBusyFileId(file.id)
    try {
      await window.excelSync.permanentlyDelete(file.id)
      updateUiTask(taskId, { status: 'done', completed: 1, detail: '已永久移出 SaaS' })
      await refreshAll(true)
      setToast(`已从 SaaS 永久删除 ${file.logicalName}。`)
    } catch (error) {
      updateUiTask(taskId, { status: 'error', detail: errorMessage(error) })
      setToast(errorMessage(error))
    } finally {
      setBusyFileId(null)
    }
  }

  async function openSystemFile(fileId: string): Promise<void> {
    try {
      await window.excelSync.openFile(fileId)
      const openedAt = new Date().toISOString()
      setFiles((current) => current.map((file) => file.id === fileId ? { ...file, lastOpenedAt: openedAt } : file))
      void refreshAll(true).catch(() => undefined)
    } catch (error) {
      setToast(`打开失败：${errorMessage(error)}`)
    }
  }

  async function openPreview(file: LocalFileView, sheetName?: string): Promise<void> {
    const requestId = previewRequestRef.current + 1
    previewRequestRef.current = requestId
    setPreviewVersion(null)
    setPreviewTarget(file)
    setPreviewLoading(true)
    if (!sheetName) setPreviewData(null)
    try {
      const result = await window.excelSync.previewFile(file.id, sheetName)
      if (previewRequestRef.current !== requestId) return
      setPreviewData(result)
      if (!file.exists) void refreshAll(true).catch(() => undefined)
    } catch (error) {
      if (previewRequestRef.current !== requestId) return
      setToast(`预览失败：${errorMessage(error)}`)
      setPreviewData({ kind: 'unsupported', logicalName: file.logicalName, message: errorMessage(error) })
    } finally {
      if (previewRequestRef.current === requestId) setPreviewLoading(false)
    }
  }

  async function openVersionPreview(version: number, sheetName?: string): Promise<void> {
    if (!selectedFile) return
    const requestId = previewRequestRef.current + 1
    previewRequestRef.current = requestId
    setPreviewVersion(version)
    setPreviewTarget(selectedFile)
    setPreviewLoading(true)
    if (!sheetName) setPreviewData(null)
    try {
      const result = await window.excelSync.previewVersion(selectedFile.id, version, sheetName)
      if (previewRequestRef.current !== requestId) return
      setPreviewData(result)
    } catch (error) {
      if (previewRequestRef.current !== requestId) return
      setToast(`V${version} 预览失败：${errorMessage(error)}`)
      setPreviewData({ kind: 'unsupported', logicalName: selectedFile.logicalName, message: errorMessage(error) })
    } finally {
      if (previewRequestRef.current === requestId) setPreviewLoading(false)
    }
  }

  async function downloadVersion(version: number): Promise<void> {
    if (!selectedFile) return
    setVersionBusy(true)
    try {
      const path = await window.excelSync.downloadVersion(selectedFile.id, version)
      if (path) setToast(`V${version} 已下载到：${path}`)
    } catch (error) {
      setToast(errorMessage(error))
    } finally {
      setVersionBusy(false)
    }
  }

  async function openVersionCopy(version: number): Promise<void> {
    if (!selectedFile) return
    setVersionBusy(true)
    try {
      await window.excelSync.openVersionCopy(selectedFile.id, version)
      setToast(`已打开 V${version} 历史副本；它不会进入同步目录。`)
    } catch (error) {
      setToast(errorMessage(error))
    } finally {
      setVersionBusy(false)
    }
  }

  async function downloadFile(file: LocalFileView): Promise<void> {
    const taskId = startUiTask(file.logicalName, '下载副本')
    try {
      const path = await window.excelSync.downloadFile(file.id)
      if (!path) {
        updateUiTask(taskId, { status: 'done', completed: 1, detail: '已取消下载' })
        return
      }
      updateUiTask(taskId, { status: 'done', completed: 1, detail: '下载完成' })
      setToast(`已下载到：${path}`)
    } catch (error) {
      updateUiTask(taskId, { status: 'error', detail: errorMessage(error) })
      setToast(errorMessage(error))
    }
  }

  async function renameFile(file: LocalFileView): Promise<void> {
    const next = window.prompt('输入新的文件名（需要保留原扩展名）：', file.logicalName)?.trim()
    if (!next || next === file.logicalName) return
    try {
      await window.excelSync.renameFile(file.id, next)
      await refreshAll(true)
      setToast(`已重命名为 ${next}。`)
    } catch (error) {
      setToast(errorMessage(error))
    }
  }

  async function moveFile(file: LocalFileView): Promise<void> {
    const currentParent = file.relativePath.replaceAll('\\', '/').split('/').slice(0, -1).join('/')
    const folder = window.prompt('输入目标文件夹（相对于同步根目录；留空表示根目录）：', currentParent)
    if (folder === null) return
    const clean = folder.trim().replace(/^\/+|\/+$/g, '')
    try {
      await window.excelSync.moveFile(file.id, clean ? `${clean}/${file.logicalName}` : file.logicalName)
      await refreshAll(true)
      setToast(`已移动 ${file.logicalName}。`)
    } catch (error) {
      setToast(errorMessage(error))
    }
  }

  async function toggleFileFavorite(file: LocalFileView): Promise<void> {
    try {
      await window.excelSync.setFileFavorite(file.id, !file.favorite)
      await refreshAll(true)
      setToast(file.favorite ? `已取消收藏 ${file.logicalName}。` : `已收藏 ${file.logicalName}。`)
    } catch (error) {
      setToast(errorMessage(error))
    }
  }

  async function copyFile(file: LocalFileView): Promise<void> {
    const taskId = startUiTask(file.logicalName, '复制')
    try {
      await window.excelSync.copyFile(file.id)
      updateUiTask(taskId, { status: 'done', completed: 1, detail: '复制完成，等待同步' })
      await refreshAll(true)
      setToast(`已复制 ${file.logicalName}。`)
    } catch (error) {
      updateUiTask(taskId, { status: 'error', detail: errorMessage(error) })
      setToast(errorMessage(error))
    }
  }

  async function createFolder(parent: string): Promise<void> {
    const name = window.prompt('新建文件夹名称：')?.trim()
    if (!name) return
    try {
      await window.excelSync.createFolder(parent, name)
      setToast(`已新建文件夹 ${name}。`)
    } catch (error) {
      setToast(errorMessage(error))
    }
  }

  async function importDroppedFiles(dropped: File[]): Promise<void> {
    const taskId = startUiTask(`${dropped.length} 个拖放项目`, '导入')
    try {
      const imported = await window.excelSync.importDroppedFiles(dropped, uploadStorageBackend)
      if (imported.length === 0) {
        updateUiTask(taskId, { status: 'done', completed: 1, detail: '没有可导入文件' })
        setToast('拖放内容中没有可导入的支持文件。')
        return
      }
      updateUiTask(taskId, { status: 'done', completed: 1, detail: `已导入 ${imported.length} 个文件，等待同步` })
      await refreshAll(true)
      setPage('files')
      setToast(`已导入 ${imported.length} 个文件。`)
    } catch (error) {
      updateUiTask(taskId, { status: 'error', detail: errorMessage(error) })
      setToast(errorMessage(error))
    }
  }

  async function bulkDownload(rows: LocalFileView[]): Promise<void> {
    const taskId = startUiTask(`${rows.length} 个文件`, '批量下载', rows.length)
    try {
      const paths = await window.excelSync.downloadFiles(rows.map((file) => file.id))
      if (!paths) {
        updateUiTask(taskId, { status: 'done', completed: rows.length, detail: '已取消下载' })
        return
      }
      updateUiTask(taskId, { status: 'done', completed: paths.length, detail: `已下载 ${paths.length} 个文件` })
      setToast(`已批量下载 ${paths.length} 个文件。`)
    } catch (error) {
      updateUiTask(taskId, { status: 'error', detail: errorMessage(error) })
      setToast(errorMessage(error))
    }
  }

  async function bulkMove(rows: LocalFileView[]): Promise<void> {
    const folder = window.prompt(`将 ${rows.length} 个文件移动到哪个文件夹？\n输入相对于同步根目录的路径；留空表示根目录：`, '')
    if (folder === null) return
    const clean = folder.trim().replace(/^\/+|\/+$/g, '')
    const taskId = startUiTask(`${rows.length} 个文件`, '批量移动', rows.length)
    try {
      let completed = 0
      for (const file of rows) {
        await window.excelSync.moveFile(file.id, clean ? `${clean}/${file.logicalName}` : file.logicalName)
        completed += 1
        updateUiTask(taskId, { completed, detail: `${completed} / ${rows.length}` })
      }
      updateUiTask(taskId, { status: 'done', completed: rows.length, detail: '批量移动完成' })
      await refreshAll(true)
      setToast(`已移动 ${rows.length} 个文件。`)
    } catch (error) {
      updateUiTask(taskId, { status: 'error', detail: errorMessage(error) })
      setToast(`批量移动中断：${errorMessage(error)}`)
      await refreshAll(true).catch(() => undefined)
    }
  }

  async function bulkTrash(rows: LocalFileView[]): Promise<void> {
    const synced = rows.filter((file) => file.currentVersion > 0)
    if (synced.length === 0) {
      setToast('所选文件尚未上传到 SaaS，不能移入云端回收站。')
      return
    }
    if (!window.confirm(`确定将所选 ${synced.length} 个文件移入回收站吗？`)) return
    const taskId = startUiTask(`${synced.length} 个文件`, '批量删除', synced.length)
    try {
      let completed = 0
      for (const file of synced) {
        await window.excelSync.trashFile(file.id)
        completed += 1
        updateUiTask(taskId, { completed, detail: `${completed} / ${synced.length}` })
      }
      updateUiTask(taskId, { status: 'done', completed: synced.length, detail: '已全部移入回收站' })
      await refreshAll(true)
      setToast(`已将 ${synced.length} 个文件移入回收站。`)
    } catch (error) {
      updateUiTask(taskId, { status: 'error', detail: errorMessage(error) })
      setToast(`批量删除中断：${errorMessage(error)}`)
      await refreshAll(true).catch(() => undefined)
    }
  }

  async function retryTask(task: PendingView): Promise<void> {
    try {
      await window.excelSync.retryTask(task.id)
      await refreshAll(true)
      setToast(`已重新排队：${task.logicalName}`)
    } catch (error) {
      setToast(errorMessage(error))
    }
  }

  async function handleProblem(problem: ProblemView): Promise<void> {
    if (problem.action === 'RESOLVE_CONFLICT') {
      setPage('tasks')
      return
    }
    if (problem.action === 'OPEN_LOCATION') {
      await openSyncDirectory()
      return
    }
    if (problem.action === 'LOGIN') {
      await refreshAuth()
      setPage('dashboard')
      setToast('请重新登录，登录成功后等待队列会自动继续。')
      return
    }
    if (problem.action === 'RETRY') {
      const task = tasks.find((item) => item.id === problem.id)
      if (task) await retryTask(task)
    }
  }

  async function cancelTask(task: PendingView): Promise<void> {
    if (!window.confirm(`取消“${task.logicalName}”的当前任务？`)) return
    try {
      await window.excelSync.cancelTask(task.id)
      await refreshAll(true)
      setToast(`已取消任务：${task.logicalName}`)
    } catch (error) {
      setToast(errorMessage(error))
    }
  }

  async function resolveConflict(task: PendingView, choice: 'local' | 'cloud' | 'both'): Promise<void> {
    const labels = { local: '保留本地', cloud: '保留云端', both: '两个都保留' } as const
    if (!window.confirm(`处理“${task.logicalName}”的版本冲突：${labels[choice]}？`)) return
    try {
      await window.excelSync.resolveConflict(task.fileId, choice)
      await refreshAll(true)
      setToast(`冲突已处理：${labels[choice]}。`)
    } catch (error) {
      setToast(`处理冲突失败：${errorMessage(error)}`)
    }
  }

  async function createUserTask(input: Omit<UserTask, 'id' | 'createdAt' | 'updatedAt' | 'status'>): Promise<void> {
    if (!currentMembership?.workspaceId) throw new Error('WORKSPACE_REQUIRED')
    await window.excelSync.createUserTask({
      workspaceId: currentMembership.workspaceId,
      title: input.title,
      description: input.description,
      priority: input.priority.toUpperCase(),
      status: 'TODO',
      assigneeUserId: auth.user?.id ?? null,
      legacyAssigneeText: input.assignee || null,
      dueAt: input.dueDate ? new Date(`${input.dueDate}T23:59:59`).toISOString() : null,
      fileIds: input.linkedFileId ? [input.linkedFileId] : []
    })
    const rows = await window.excelSync.tasks(workspaceRole === 'MANAGER' ? 'all' : 'mine', currentMembership.workspaceId)
    setUserTasks(rows.map(cloudTaskToUserTask))
    setToast(`任务已创建：${input.title}`)
  }

  async function updateUserTask(id: string, patch: Partial<Pick<UserTask, 'status' | 'title' | 'description' | 'priority' | 'dueDate' | 'assignee'>>): Promise<void> {
    const update: Record<string, unknown> = {}
    if (patch.status !== undefined) update.status = patch.status === 'done' ? 'DONE' : patch.status === 'running' ? 'IN_PROGRESS' : 'TODO'
    if (patch.title !== undefined) update.title = patch.title
    if (patch.description !== undefined) update.description = patch.description
    if (patch.priority !== undefined) update.priority = patch.priority.toUpperCase()
    if (patch.dueDate !== undefined) update.dueAt = patch.dueDate ? new Date(`${patch.dueDate}T23:59:59`).toISOString() : null
    await window.excelSync.updateUserTask(id, update)
    const rows = await window.excelSync.tasks(workspaceRole === 'MANAGER' ? 'all' : 'mine', currentMembership?.workspaceId)
    setUserTasks(rows.map(cloudTaskToUserTask))
  }

  function createTaskForFile(file: LocalFileView): void {
    setTaskDraft({
      templateId: 'custom',
      title: `处理 ${file.logicalName}`,
      description: `围绕“${file.logicalName}”创建的关联任务。可补充具体处理要求、负责人和截止日期。`,
      linkedFileId: file.id,
      linkedResourceLabel: file.relativePath || file.logicalName
    })
    setPage('tasks')
  }

  async function deleteUserTask(id: string): Promise<void> {
    const task = userTasks.find((item) => item.id === id)
    if (task && !window.confirm(`删除任务“${task.title}”？`)) return
    await window.excelSync.deleteUserTask(id)
    setUserTasks((current) => current.filter((item) => item.id !== id))
  }

  async function runUserTask(task: UserTask): Promise<void> {
    const template = TASK_TEMPLATES.find((item) => item.id === task.templateId)
    if (!template?.runnable) {
      await updateUserTask(task.id, { status: 'running' })
      return
    }
    await updateUserTask(task.id, { status: 'running' })
    const uiTaskId = startUiTask(task.title, template.title)
    try {
      let detail = '任务已完成'
      let completed = true
      if (task.templateId === 'sync-now') {
        await window.excelSync.syncNow()
        await refreshAll()
        detail = '同步请求已执行，状态已刷新。'
      } else if (task.templateId === 'import-files') {
        const imported = await window.excelSync.importExcelFiles(uploadStorageBackend)
        if (imported.length === 0) {
          completed = false
          detail = '已取消，没有导入文件。'
        } else {
          await refreshAll()
          setPage('files')
          detail = `已导入 ${imported.length} 个文件并加入同步队列。`
        }
      } else if (task.templateId === 'import-folder') {
        const imported = await window.excelSync.importExcelFolder(uploadStorageBackend)
        if (imported.length === 0) {
          completed = false
          detail = '已取消，或文件夹中没有可同步文件。'
        } else {
          await refreshAll()
          setPage('files')
          detail = `已导入 ${imported.length} 个文件并保留目录结构。`
        }
      } else if (task.templateId === 'retry-failed') {
        const failed = tasks.filter((item) => ['ERROR', 'RETRY_WAIT'].includes(item.status))
        for (const item of failed) await window.excelSync.retryTask(item.id)
        await refreshAll(true)
        detail = failed.length > 0 ? `已重新排队 ${failed.length} 个失败任务。` : '当前没有需要重试的失败任务。'
      }
      updateUiTask(uiTaskId, { status: 'done', completed: 1, detail })
      await updateUserTask(task.id, { status: completed ? 'done' : 'todo' })
      setToast(detail)
    } catch (error) {
      const detail = errorMessage(error)
      updateUiTask(uiTaskId, { status: 'error', detail })
      await updateUserTask(task.id, { status: 'todo' }).catch(() => undefined)
      setToast(`任务执行失败：${detail}`)
    }
  }

  async function importFiles(): Promise<void> {
    await runTrackedAction('importFiles', '导入文件', async () => {
      const imported = await window.excelSync.importExcelFiles(uploadStorageBackend)
      if (imported.length === 0) return '已取消，没有导入文件。'
      await refreshAll()
      setPage('files')
      return `已导入 ${imported.length} 个文件，已进入同步队列。`
    })
  }

  async function importFolder(): Promise<void> {
    await runTrackedAction('importFolder', '导入文件夹', async () => {
      const imported = await window.excelSync.importExcelFolder(uploadStorageBackend)
      if (imported.length === 0) return '已取消，或所选文件夹中没有可同步文件。'
      await refreshAll()
      setPage('files')
      return `已导入 ${imported.length} 个文件，并保留原目录结构。`
    })
  }

  async function chooseSyncDirectory(): Promise<void> {
    await runTrackedAction('chooseFolder', '选择同步文件夹', async () => {
      const dir = await window.excelSync.selectSyncDirectory()
      if (!dir) return '已取消选择。'
      setSettings((current) => current ? { ...current, syncDirectory: dir } : current)
      await refreshAll()
      return `已设置为：${dir}`
    })
  }

  async function openSyncDirectory(): Promise<void> {
    await runTrackedAction('openFolder', '打开同步文件夹', async () => {
      await window.excelSync.openSyncDirectory()
      return '文件夹已打开。'
    })
  }

  async function syncNow(): Promise<void> {
    await runTrackedAction('syncNow', '立即同步', async () => {
      await window.excelSync.syncNow()
      await refreshAll()
      return '同步请求已执行，状态已刷新。'
    })
  }

  async function togglePause(): Promise<void> {
    const nextPaused = !paused
    await runTrackedAction('pauseSync', nextPaused ? '暂停同步' : '恢复同步', async () => {
      await window.excelSync.pauseSync(nextPaused)
      setPaused(nextPaused)
      await refreshAll()
      return nextPaused ? '自动同步已暂停。' : '自动同步已恢复。'
    })
  }

  async function saveSettings(): Promise<void> {
    if (!settings) return
    await runTrackedAction('saveSettings', '保存设置', async () => {
      const saved = await window.excelSync.updateSettings(settings)
      setSettings(saved)
      setPaused(!saved.autoSync)
      await refreshAll()
      return '设置已保存并生效。'
    })
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark small">XS</div><div><b>ExcelSync</b><span>{workspaceName}</span></div></div>
        <nav>
          {visiblePages.map((item) => (
            <button key={item} className={page === item ? 'active' : ''} onClick={() => setPage(item)} title={PAGE_LABELS[item]}>
              <span className="nav-icon">{item === 'dashboard' ? '⌂' : item === 'files' ? '▤' : item === 'favorites' ? '★' : item === 'trash' ? '⌫' : item === 'tasks' ? '⇅' : item === 'activity' ? '↻' : item === 'admin' ? '◈' : '⚙'}</span>
              <span className="nav-label">{PAGE_LABELS[item]}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          {auth.authenticated && <div className="account-summary"><span>当前账号</span><b>{auth.user?.displayName || auth.username || '已登录用户'}</b><small>{SYSTEM_ROLE_LABELS[systemRole]} · {WORKSPACE_ROLE_LABELS[workspaceRole]}</small></div>}
          <div className="mini-status"><StatusDot active={Boolean(dashboardData?.health.online)} /><span>{subtitle}</span></div>
          {auth.authenticated && <button className="text-button danger" onClick={() => void window.excelSync.logout().then(refreshAuth)}>退出登录</button>}
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div className="topbar-title"><p className="eyebrow">{workspaceName.toLocaleUpperCase('zh-CN')}</p><h1>{PAGE_LABELS[page]}</h1><span className="workspace-role-pill">{SYSTEM_ROLE_LABELS[systemRole]} · {WORKSPACE_ROLE_LABELS[workspaceRole]}</span></div>
          <div className="global-search">
            <input aria-label="统一搜索" placeholder="搜索文件、路径、任务、负责人…" value={globalSearch} onChange={(event) => setGlobalSearch(event.target.value)} />
            <button className={`advanced-search-toggle${advancedOpen ? ' active' : ''}`} onClick={() => setAdvancedOpen((value) => !value)}>筛选</button>
            {(normalizedGlobalSearch || advancedOpen) && <div className="global-search-results">
              {advancedOpen && <div className="advanced-search-panel"><div className="advanced-filter-grid"><label>类型<select value={advancedFilters.type ?? ''} onChange={(event) => setAdvancedFilters((current) => ({ ...current, type: event.target.value as AdvancedSearchInput['type'] }))}><option value="">全部</option><option>Excel</option><option>Word</option><option>PDF</option><option>CSV</option><option>ZIP</option><option>PPT</option><option>Image</option><option>EXE</option><option>Other</option></select></label><label>状态<select value={advancedFilters.state ?? ''} onChange={(event) => setAdvancedFilters((current) => ({ ...current, state: event.target.value as AdvancedSearchInput['state'] }))}><option value="">全部</option><option value="locked">已锁定</option><option value="editing">正在编辑</option><option value="trashed">回收站</option></select></label><label>路径<input value={advancedFilters.path ?? ''} onChange={(event) => setAdvancedFilters((current) => ({ ...current, path: event.target.value }))} placeholder="例如 Finance/2026" /></label><label>修改开始<input type="date" value={advancedFilters.modifiedFrom?.slice(0, 10) ?? ''} onChange={(event) => setAdvancedFilters((current) => ({ ...current, modifiedFrom: event.target.value ? new Date(`${event.target.value}T00:00:00`).toISOString() : '' }))} /></label></div><div className="advanced-filter-actions"><button className="text-button" onClick={() => { setAdvancedFilters({}); setAdvancedResults([]) }}>清除筛选</button><button className="primary" disabled={advancedBusy} onClick={() => void runAdvancedSearch()}>{advancedBusy ? '搜索中…' : '应用高级筛选'}</button></div>{advancedResults.length > 0 && <div className="global-search-section advanced-results"><span>高级筛选结果 · {advancedResults.length}</span>{advancedResults.slice(0, 30).map((row) => <button key={row.id} onClick={() => { const local = files.find((file) => file.id === row.id); if (local) void openPreview(local); else { setPage('files'); setToast('该文件当前只有云端索引，已打开文件页。') } setAdvancedOpen(false) }}><b>{row.logical_name}</b><small>{row.workspace_name} · {row.relative_path}{row.lock_owner_name ? ` · ${row.lock_owner_name} 正在编辑` : ''}</small></button>)}</div>}</div>}
              {normalizedGlobalSearch && <><div className="global-search-section"><span>文件</span>{globalFileResults.length === 0 ? <small>没有匹配文件</small> : globalFileResults.map((file) => <button key={file.id} onClick={() => { setGlobalSearch(''); void openPreview(file) }}><b>{file.logicalName}</b><small>{file.relativePath}</small></button>)}</div><div className="global-search-section"><span>任务</span>{globalTaskResults.length === 0 ? <small>没有匹配任务</small> : globalTaskResults.map((task) => <button key={task.id} onClick={() => { setGlobalSearch(''); setPage('tasks') }}><b>{task.title}</b><small>{task.assignee || auth.username || '我'}{task.linkedResourceLabel ? ` · ${task.linkedResourceLabel}` : ''}</small></button>)}</div></>}
            </div>}
          </div>
          <div className="top-actions">
            {auth.authenticated && <NotificationCenter open={notificationOpen} data={notificationData} filter={notificationFilter} onToggle={() => setNotificationOpen((value) => !value)} onFilter={(filter) => setNotificationFilter(filter)} onRead={markNotificationRead} onReadAll={markAllNotificationsRead} onOpenResource={openNotificationResource} />}
            {workspaceRole !== 'VIEWER' && <label className="storage-target-select"><span>存储到</span><select value={uploadStorageBackend} onChange={(event) => { uploadStorageTouchedRef.current = true; setUploadStorageBackend(event.target.value as SettingsView['defaultStorageBackend']) }}><option value="telegram_user_group">Telegram 私人群组</option><option value="telegram_bot">Telegram Bot</option></select></label>}
            {workspaceRole !== 'VIEWER' && <ActionButton actionKey="importFolder" label="导入文件夹" className="secondary" busyAction={busyAction} onClick={() => void importFolder()} />}
            {workspaceRole !== 'VIEWER' && <ActionButton actionKey="importFiles" label="导入文件" className="secondary" busyAction={busyAction} onClick={() => void importFiles()} />}
            <ActionButton actionKey={settings?.syncDirectory ? 'openFolder' : 'chooseFolder'} label={settings?.syncDirectory ? '打开同步文件夹' : '选择同步文件夹'} className="secondary" busyAction={busyAction} onClick={() => void (settings?.syncDirectory ? openSyncDirectory() : chooseSyncDirectory())} />
            {workspaceRole !== 'VIEWER' && <ActionButton actionKey="syncNow" label="立即同步" className="primary" busyAction={busyAction} disabled={!auth.authenticated || paused} onClick={() => void syncNow()} />}
          </div>
        </header>

        {actionFeedback && (
          <div className={`action-feedback ${actionFeedback.state}`} role="status" aria-live="polite">
            <span className="action-feedback-mark" />
            <div><b>最近操作：{actionFeedback.label}</b><span>{actionFeedback.detail}</span></div>
            <strong>{actionFeedback.state === 'running' ? '处理中' : actionFeedback.state === 'done' ? '完成' : '失败'}</strong>
          </div>
        )}

        {activeTransfers.length > 0 && (
          <div className="transfer-strip" role="status" aria-live="polite">
            {activeTransfers.slice(0, 3).map((progress) => {
              const percent = progress.totalBytes > 0 ? Math.min(100, Math.round((progress.transferredBytes / progress.totalBytes) * 100)) : 0
              const phaseLabel = progress.phase === 'verifying' ? '正在校验' : progress.phase === 'transferring' ? (progress.direction === 'upload' ? '正在上传' : '正在下载') : progress.phase === 'finalizing' ? '正在提交' : '已完成'
              const speed = progress.bytesPerSecond > 0 ? `${formatBytes(progress.bytesPerSecond)}/s` : '计算中'
              return <div className="transfer-strip-item" key={progress.id}>
                <div className="transfer-strip-head"><b>{progress.fileName}</b><span>{phaseLabel} · {percent}% · {speed}</span></div>
                <div className="task-progress"><span style={{ width: `${Math.max(progress.phase === 'done' ? 100 : 3, percent)}%` }} /></div>
                <small>{formatBytes(progress.transferredBytes)} / {formatBytes(progress.totalBytes)}</small>
              </div>
            })}
          </div>
        )}

        {!auth.authenticated && <AuthScreen auth={auth} onAuthenticated={refreshAuth} embedded />}

        {!settings?.syncDirectory && (
          <section className="panel" style={{ marginBottom: 17 }}>
            <div className="panel-header">
              <div><h3>第一次使用：先选择同步文件夹</h3><p className="muted">以后你只需要在这个文件夹里正常新建、保存、重命名或删除支持的文件，ExcelSync 会自动处理同步。</p></div>
              <ActionButton actionKey="chooseFolder" label="选择同步文件夹" className="primary" busyAction={busyAction} onClick={() => void chooseSyncDirectory()} />
            </div>
          </section>
        )}
        {page === 'dashboard' && <Dashboard data={dashboardData} files={files} problems={problems} paused={paused} cloudEnabled={auth.authenticated && workspaceRole !== 'VIEWER'} onSync={syncNow} onPause={togglePause} onOpen={openSystemFile} onPreview={openPreview} onTasks={() => setPage('tasks')} onProblem={handleProblem} busyAction={busyAction} />}
        {page === 'files' && <FilesPage files={files} readOnly={workspaceRole === 'VIEWER'} onOpen={openSystemFile} onPreview={openPreview} onVersions={openVersions} onRestoreLocal={restoreLocalCopy} onTrash={trashSaasFile} onDownload={downloadFile} onRename={renameFile} onMove={moveFile} onCopy={copyFile} onFavorite={toggleFileFavorite} onCreateTaskForFile={createTaskForFile} onCreateFolder={createFolder} onDropFiles={importDroppedFiles} onBulkDownload={bulkDownload} onBulkMove={bulkMove} onBulkTrash={bulkTrash} onImport={importFiles} onImportFolder={importFolder} busyAction={busyAction} busyFileId={busyFileId} />}
        {page === 'favorites' && <FilesPage title="收藏" files={files.filter((file) => file.favorite)} readOnly={workspaceRole === 'VIEWER'} onOpen={openSystemFile} onPreview={openPreview} onVersions={openVersions} onRestoreLocal={restoreLocalCopy} onTrash={trashSaasFile} onDownload={downloadFile} onRename={renameFile} onMove={moveFile} onCopy={copyFile} onFavorite={toggleFileFavorite} onCreateTaskForFile={createTaskForFile} onCreateFolder={createFolder} onDropFiles={importDroppedFiles} onBulkDownload={bulkDownload} onBulkMove={bulkMove} onBulkTrash={bulkTrash} onImport={importFiles} onImportFolder={importFolder} busyAction={busyAction} busyFileId={busyFileId} />}
        {page === 'trash' && <TrashPage files={trashFiles} canRestore={workspaceRole !== 'VIEWER'} canPermanentDelete={workspaceRole === 'MANAGER'} onRestore={restoreTrashFile} onPermanentDelete={permanentlyDeleteTrashFile} onBulkRestore={bulkRestoreTrash} busyFileId={busyFileId} />}
        {page === 'tasks' && <TasksPage tasks={tasks} uiTasks={uiTasks} userTasks={userTasks} currentUserName={auth.user?.displayName || auth.username || '我'} canEditFiles={workspaceRole !== 'VIEWER'} draft={taskDraft} onDraftConsumed={() => setTaskDraft(null)} onCreateUserTask={createUserTask} onUpdateUserTask={updateUserTask} onDeleteUserTask={deleteUserTask} onRunTemplate={runUserTask} onOpenLinkedFile={openSystemFile} onRetry={retryTask} onCancel={cancelTask} onResolveConflict={resolveConflict} />}
        {page === 'activity' && <div className="page-stack"><section className="panel"><div className="panel-header"><div><h2>同步记录</h2><p className="muted">这里显示最近的本地同步历史，不会记录任何密钥或密码。</p></div></div><ActivityList rows={activity} /></section>{workspaceRole !== 'VIEWER' && <RecoveryPanel workspaceId={currentMembership?.workspaceId ?? null} workspaceRole={workspaceRole} canAdmin={canAdmin} onToast={setToast} onRefresh={() => refreshAll(true)} />}</div>}
        {page === 'settings' && settings && <SettingsPage settings={settings} onChange={setSettings} onSave={saveSettings} onChooseDirectory={chooseSyncDirectory} canManageStorage={canAdmin} authenticated={auth.authenticated} onSessionInvalidated={refreshAuth} onToast={setToast} busyAction={busyAction} />}
        {page === 'admin' && canAdmin && auth.user && <EnterpriseAdminCenter systemRole={systemRole} currentUserId={auth.user.id} onToast={setToast} onSessionInvalidated={refreshAuth} />}
      </main>

      <VersionsDrawer file={selectedFile} versions={versions} busy={versionBusy} canRestore={workspaceRole !== 'VIEWER'} onClose={() => setSelectedFile(null)} onPreview={openVersionPreview} onDownload={downloadVersion} onOpenCopy={openVersionCopy} onRestore={restore} />
      <PreviewDrawer file={previewTarget} preview={previewData} presence={previewPresence} activity={activity} loading={previewLoading} canEdit={workspaceRole !== 'VIEWER'} canManageLock={workspaceRole === 'MANAGER' || canAdmin} onClose={() => { previewRequestRef.current += 1; setPreviewTarget(null); setPreviewData(null); setPreviewPresence(null); setPreviewVersion(null); setPreviewLoading(false) }} onOpen={() => previewTarget ? (previewVersion ? window.excelSync.openVersionCopy(previewTarget.id, previewVersion) : openSystemFile(previewTarget.id)) : Promise.resolve()} onSheet={(sheet) => previewTarget ? (previewVersion ? openVersionPreview(previewVersion, sheet) : openPreview(previewTarget, sheet)) : Promise.resolve()} onVersions={() => previewTarget ? openVersions(previewTarget) : Promise.resolve()} onToast={setToast} />

      {toast && <div className="toast"><span>{toast}</span>{undoTrash?.message === toast && <button onClick={() => void undoTrashFile()}>撤销</button>}</div>}
    </div>
  )
}
