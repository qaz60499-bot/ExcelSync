const API_BASE_URL = (import.meta.env.VITE_EXCELSYNC_API_URL ?? 'https://saaas.guessyy.ccwu.cc').trim().replace(/\/+$/, '')
const CLIENT_VERSION = '1.4.1'
const API_VERSION = '2026-08-31'
const SESSION_KEY = 'excel-sync-mobile-session'
const DEVICE_KEY = 'excel-sync-mobile-device-id'

export interface AuthUser {
  id: string
  username: string
  displayName?: string
  systemRole?: 'ADMIN' | 'MEMBER'
}

export interface SessionPayload {
  token: string
  expiresAt: string
  deviceId: string | null
  user: AuthUser
  memberships: Array<{ workspaceId: string; role: 'MANAGER' | 'EDITOR' | 'VIEWER' }>
  defaultWorkspaceId: string | null
}

export interface CloudFile {
  id: string
  logical_name: string
  relative_path: string
  current_version: number
  current_hash: string | null
  current_storage_backend: 'telegram_user_group' | 'telegram_bot' | null
  current_storage_locator: string | null
  updated_at: string
  status: string
}

export interface Workspace {
  id: string
  name: string
  type: 'PERSONAL' | 'TEAM' | 'PROJECT'
  status: string
  role?: 'MANAGER' | 'EDITOR' | 'VIEWER'
}

export interface VersionRow {
  version: number
  hash: string
  size: number
  created_at: string
  storage_backend?: 'telegram_user_group' | 'telegram_bot' | null
  status?: string
}

export class MobileApiError extends Error {
  constructor(readonly code: string, readonly status: number, message = code, readonly detail?: unknown) {
    super(message)
  }
}

function currentToken(): string | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    return (JSON.parse(raw) as SessionPayload).token || null
  } catch {
    return null
  }
}

function saveSession(session: SessionPayload): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function loadSession(): SessionPayload | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const session = JSON.parse(raw) as SessionPayload
    if (!session.token || !session.expiresAt || Date.parse(session.expiresAt) <= Date.now()) {
      sessionStorage.removeItem(SESSION_KEY)
      return null
    }
    return session
  } catch {
    sessionStorage.removeItem(SESSION_KEY)
    return null
  }
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY)
}

function stableDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_KEY)
  if (existing) return existing
  const created = crypto.randomUUID()
  localStorage.setItem(DEVICE_KEY, created)
  return created
}

function baseHeaders(auth = true): Headers {
  const headers = new Headers()
  headers.set('x-excelsync-client-version', CLIENT_VERSION)
  headers.set('x-excelsync-api-version', API_VERSION)
  if (auth) {
    const token = currentToken()
    if (!token) throw new MobileApiError('AUTH_REQUIRED', 401, '请先登录')
    headers.set('authorization', `Bearer ${token}`)
  }
  return headers
}

async function parseError(response: Response): Promise<MobileApiError> {
  let payload: { error?: { code?: string; message?: string; detail?: unknown } } = {}
  try {
    payload = await response.clone().json() as typeof payload
  } catch {
    // Keep HTTP status fallback.
  }
  const code = payload.error?.code ?? `HTTP_${response.status}`
  if (response.status === 401) clearSession()
  return new MobileApiError(code, response.status, payload.error?.message ?? code, payload.error?.detail)
}

async function raw(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
  const headers = baseHeaders(auth)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers })
  if (!response.ok) throw await parseError(response)
  return response
}

async function json<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  const response = await raw(path, init, auth)
  return await response.json() as T
}

export async function health(): Promise<{ ok: boolean }> {
  return json('/health', { method: 'GET' }, false)
}

export async function login(username: string, password: string): Promise<SessionPayload> {
  const session = await json<SessionPayload>('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      device: {
        stableDeviceId: stableDeviceId(),
        deviceName: 'iPhone',
        osName: 'iOS',
        osVersion: navigator.userAgent.slice(0, 120),
        clientVersion: CLIENT_VERSION
      }
    })
  }, false)
  saveSession(session)
  return session
}

export async function logout(): Promise<void> {
  try {
    await json('/auth/logout', { method: 'POST' })
  } finally {
    clearSession()
  }
}

export async function filesList(): Promise<CloudFile[]> {
  const result = await json<{ files: CloudFile[] }>('/files/list?include=all')
  return result.files
}

export async function workspaces(): Promise<{ workspaces: Workspace[]; defaultWorkspaceId: string | null }> {
  return json('/workspaces')
}

export async function versions(fileId: string): Promise<VersionRow[]> {
  const result = await json<{ versions: VersionRow[] }>(`/versions/${encodeURIComponent(fileId)}`)
  return result.versions
}

export async function downloadBotFile(fileId: string): Promise<{ blob: Blob; version: number }> {
  const response = await raw(`/files/${encodeURIComponent(fileId)}/download`, { method: 'GET' })
  return {
    blob: await response.blob(),
    version: Number(response.headers.get('x-excelsync-version') ?? 0)
  }
}

async function sha256(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function uploadExcel(file: File): Promise<{ fileId: string; version?: number; deduplicated?: boolean }> {
  if (file.size <= 0) throw new MobileApiError('EMPTY_FILE', 400, '不能上传空文件')
  const hash = await sha256(file)
  const preflight = await json<
    | { action: 'noop'; fileId: string; currentVersion: number }
    | { action: 'conflict'; fileId: string; currentVersion: number }
    | { action: 'committed'; fileId: string; currentVersion: number }
    | { action: 'commit_required'; fileId: string; intentId: string }
    | { action: 'upload_required'; fileId: string; intentId: string }
  >('/sync/preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      logicalName: file.name,
      relativePath: `Mobile Uploads/${file.name}`,
      hash,
      size: file.size,
      baseVersion: 0,
      idempotencyKey: `${stableDeviceId()}:${hash}`,
      storageBackend: 'telegram_bot'
    })
  })

  if (preflight.action === 'noop') return { fileId: preflight.fileId, version: preflight.currentVersion, deduplicated: true }
  if (preflight.action === 'committed') return { fileId: preflight.fileId, version: preflight.currentVersion, deduplicated: true }
  if (preflight.action === 'conflict') throw new MobileApiError('BASE_VERSION_CONFLICT', 409, '云端已存在同路径文件，请在桌面端处理冲突')

  if (preflight.action === 'upload_required') {
    const form = new FormData()
    form.set('intentId', preflight.intentId)
    form.set('file', file, file.name)
    await json('/sync/upload', { method: 'POST', body: form })
  }

  const committed = await json<{ fileId: string; version: number }>('/sync/commit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intentId: preflight.intentId })
  })
  return committed
}

export function apiBaseUrl(): string {
  return API_BASE_URL
}
