import { isAbsolute, relative, resolve, win32 } from 'node:path'

const WINDOWS_INVALID_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001F]/
const WINDOWS_RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i

function isUnsafeWindowsPathSegment(segment: string): boolean {
  return WINDOWS_INVALID_SEGMENT_CHARS.test(segment) || /[. ]$/.test(segment) || WINDOWS_RESERVED_DEVICE.test(segment)
}

export function safeRelativePath(value: string): string {
  const replaced = value.replaceAll('\\', '/')
  if (replaced !== replaced.trim()) throw new Error('PATH_REJECTED')
  const raw = replaced
  if (!raw || raw.startsWith('/') || isAbsolute(raw) || win32.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new Error('PATH_REJECTED')
  }
  const normalized = raw.replace(/\/+$/g, '')
  const segments = normalized.split('/')
  if (!normalized || segments.some((segment) => !segment || segment === '.' || segment === '..' || isUnsafeWindowsPathSegment(segment))) {
    throw new Error('PATH_REJECTED')
  }
  return normalized
}

export function isPathWithinRoot(root: string, candidatePath: string): boolean {
  const normalizedRoot = resolve(root)
  const candidate = resolve(candidatePath)
  const rel = relative(normalizedRoot, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !win32.isAbsolute(rel))
}

export function resolveWithinRoot(root: string, relativePath: string): string {
  const safe = safeRelativePath(relativePath)
  const candidate = resolve(resolve(root), safe)
  if (!isPathWithinRoot(root, candidate)) throw new Error('PATH_REJECTED')
  return candidate
}
