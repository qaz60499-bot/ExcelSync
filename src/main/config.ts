export const DEFAULT_WORKER_URL = 'https://saaas.guessyy.ccwu.cc'
export const LEGACY_WORKER_URLS = [
  'https://excel-sync-worker.qaz60499.workers.dev',
  'https://joye.cc.cd'
] as const
export const APP_NAME = 'ExcelSync'

export function normalizeWorkerUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function isAllowedWorkerUrl(value: string, packaged: boolean): boolean {
  const normalized = normalizeWorkerUrl(value)
  if (!normalized) return false
  if (normalized === DEFAULT_WORKER_URL) return true
  if (packaged) return false
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(normalized) || /^https:\/\//i.test(normalized)
}
