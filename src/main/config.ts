export const DEFAULT_WORKER_URL = ''
export const APP_NAME = 'ExcelSync'

export function normalizeWorkerUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function isAllowedWorkerUrl(value: string, packaged: boolean): boolean {
  const normalized = normalizeWorkerUrl(value)
  if (!normalized) return false
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    return false
  }
  if (parsed.username || parsed.password) return false
  if (parsed.protocol === 'https:' && parsed.hostname) return true
  return !packaged && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname)
}
