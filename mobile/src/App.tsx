import { useEffect, useMemo, useState } from 'react'
import {
  apiBaseUrl,
  downloadBotFile,
  filesList,
  health,
  loadSession,
  login,
  logout,
  uploadExcel,
  versions,
  workspaces,
  type CloudFile,
  type SessionPayload,
  type VersionRow,
  type Workspace
} from './api'

type Tab = 'files' | 'upload' | 'workspaces' | 'account'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatTime(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed)
}

function storageLabel(file: CloudFile): string {
  return file.current_storage_backend === 'telegram_user_group' ? 'Telegram 私人群组' : 'Telegram Bot'
}

function LoginScreen({ onLogin }: { onLogin: (session: SessionPayload) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      onLogin(await login(username, password))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return <main className="login-screen">
    <section className="login-card">
      <div className="app-mark">X</div>
      <h1>ExcelSync</h1>
      <p>iPhone 客户端</p>
      <form onSubmit={submit}>
        <label>用户名<input autoCapitalize="none" autoCorrect="off" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
        <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        {error && <div className="error-box">{error}</div>}
        <button className="primary" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
      </form>
      <small>{apiBaseUrl()}</small>
    </section>
  </main>
}

export default function App() {
  const [session, setSession] = useState<SessionPayload | null>(() => loadSession())
  const [tab, setTab] = useState<Tab>('files')
  const [files, setFiles] = useState<CloudFile[]>([])
  const [workspaceRows, setWorkspaceRows] = useState<Workspace[]>([])
  const [defaultWorkspaceId, setDefaultWorkspaceId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [selectedFile, setSelectedFile] = useState<CloudFile | null>(null)
  const [versionRows, setVersionRows] = useState<VersionRow[]>([])
  const [uploadRows, setUploadRows] = useState<Array<{ name: string; state: string }>>([])

  const visibleFiles = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return files
    return files.filter((file) => `${file.logical_name} ${file.relative_path}`.toLowerCase().includes(q))
  }, [files, search])

  async function refresh() {
    if (!session) return
    setBusy(true)
    setMessage('')
    try {
      const [nextFiles, nextWorkspaces] = await Promise.all([filesList(), workspaces()])
      setFiles(nextFiles)
      setWorkspaceRows(nextWorkspaces.workspaces)
      setDefaultWorkspaceId(nextWorkspaces.defaultWorkspaceId)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (session) void refresh()
  }, [session])

  async function showVersions(file: CloudFile) {
    setSelectedFile(file)
    setVersionRows([])
    try {
      setVersionRows(await versions(file.id))
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  async function shareDownload(file: CloudFile) {
    if (file.current_storage_backend === 'telegram_user_group') {
      setMessage('该文件存于 Telegram 私人群组，当前 iOS 构建只能读取元数据；文件字节仍需桌面 Telegram Bridge。')
      return
    }
    setBusy(true)
    setMessage('')
    try {
      const downloaded = await downloadBotFile(file.id)
      const sharedFile = new File([downloaded.blob], file.logical_name, { type: downloaded.blob.type || 'application/octet-stream' })
      if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [sharedFile] }))) {
        await navigator.share({ title: file.logical_name, files: [sharedFile] })
      } else {
        const url = URL.createObjectURL(sharedFile)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = file.logical_name
        anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 5_000)
      }
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function uploadSelection(list: FileList | null) {
    if (!list?.length) return
    const selected = Array.from(list)
    setUploadRows(selected.map((file) => ({ name: file.name, state: '等待上传' })))
    for (let index = 0; index < selected.length; index += 1) {
      const file = selected[index]
      setUploadRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, state: '正在校验并上传…' } : row))
      try {
        const result = await uploadExcel(file)
        setUploadRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, state: result.deduplicated ? '云端已有相同内容' : `完成 · V${result.version ?? '?'}` } : row))
      } catch (error) {
        setUploadRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, state: `失败 · ${errorMessage(error)}` } : row))
      }
    }
    await refresh()
  }

  async function signOut() {
    try {
      await logout()
    } catch {
      // Local logout remains authoritative for the client UX.
    }
    setSession(null)
    setFiles([])
    setWorkspaceRows([])
  }

  if (!session) return <LoginScreen onLogin={setSession} />

  return <div className="shell">
    <header className="topbar">
      <div><strong>ExcelSync</strong><small>{session.user.displayName || session.user.username}</small></div>
      <button className="icon-button" onClick={() => void refresh()} disabled={busy}>↻</button>
    </header>

    <main className="content">
      {message && <div className="notice">{message}<button onClick={() => setMessage('')}>×</button></div>}

      {tab === 'files' && <section>
        <div className="section-head"><div><h2>文件</h2><p>{files.length} 个云端文件</p></div></div>
        <input className="search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件名或路径" />
        <div className="file-list">
          {visibleFiles.map((file) => <article className="file-row" key={file.id}>
            <button className="file-main" onClick={() => void showVersions(file)}>
              <span className="file-icon">X</span>
              <span><b>{file.logical_name}</b><small>{file.relative_path} · V{file.current_version}</small><small>{storageLabel(file)} · {formatTime(file.updated_at)}</small></span>
            </button>
            <button className="more" onClick={() => void shareDownload(file)} disabled={busy}>{file.current_storage_backend === 'telegram_user_group' ? '仅查看' : '下载'}</button>
          </article>)}
          {!busy && visibleFiles.length === 0 && <div className="empty">没有匹配文件</div>}
        </div>
      </section>}

      {tab === 'upload' && <section>
        <div className="section-head"><div><h2>上传</h2><p>从“文件”App 选择 Excel 文件</p></div></div>
        <label className="upload-zone">
          <span>选择 Excel 文件</span>
          <small>.xlsx / .xls / .xlsm / .xlsb / .csv</small>
          <input type="file" multiple accept=".xlsx,.xls,.xlsm,.xlsb,.csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void uploadSelection(event.currentTarget.files)} />
        </label>
        <div className="callout"><b>当前 iOS 上传目标：Telegram Bot</b><span>私人群组后端依赖 Windows Telegram Bridge，不会在手机端假装可用。</span></div>
        <div className="upload-list">{uploadRows.map((row, index) => <div key={`${row.name}-${index}`}><b>{row.name}</b><span>{row.state}</span></div>)}</div>
      </section>}

      {tab === 'workspaces' && <section>
        <div className="section-head"><div><h2>Workspace</h2><p>与桌面端共用 Cloudflare D1 权限</p></div></div>
        <div className="workspace-list">{workspaceRows.map((workspace) => <article key={workspace.id}><div><b>{workspace.name}</b><small>{workspace.type} · {workspace.status}{workspace.role ? ` · ${workspace.role}` : ''}</small></div>{workspace.id === defaultWorkspaceId && <span>默认</span>}</article>)}</div>
      </section>}

      {tab === 'account' && <section>
        <div className="section-head"><div><h2>账户</h2><p>移动客户端 1.4.1</p></div></div>
        <div className="account-card"><b>{session.user.displayName || session.user.username}</b><span>@{session.user.username}</span><small>会话到期：{formatTime(session.expiresAt)}</small><small>API：{apiBaseUrl()}</small></div>
        <button className="secondary full" onClick={() => void health().then(() => setMessage('Worker 连接正常')).catch((error) => setMessage(errorMessage(error)))}>检查连接</button>
        <button className="danger full" onClick={() => void signOut()}>退出登录</button>
      </section>}
    </main>

    <nav className="tabbar">
      <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}><span>▤</span>文件</button>
      <button className={tab === 'upload' ? 'active' : ''} onClick={() => setTab('upload')}><span>＋</span>上传</button>
      <button className={tab === 'workspaces' ? 'active' : ''} onClick={() => setTab('workspaces')}><span>▦</span>空间</button>
      <button className={tab === 'account' ? 'active' : ''} onClick={() => setTab('account')}><span>●</span>账户</button>
    </nav>

    {selectedFile && <div className="sheet-backdrop" onClick={() => setSelectedFile(null)}>
      <section className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-title"><div><h3>{selectedFile.logical_name}</h3><p>{selectedFile.relative_path}</p></div><button onClick={() => setSelectedFile(null)}>完成</button></div>
        <div className="version-list">{versionRows.map((version) => <div key={version.version}><b>V{version.version}</b><span>{version.size ? `${Math.round(version.size / 1024)} KB` : ''}</span><small>{formatTime(version.created_at)}</small></div>)}{versionRows.length === 0 && <div className="empty">正在读取版本…</div>}</div>
      </section>
    </div>}
  </div>
}
