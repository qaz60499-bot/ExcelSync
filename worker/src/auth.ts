const PASSWORD_ALGO = 'pbkdf2-sha256'
const PASSWORD_ITERATIONS = 100_000
const PASSWORD_BYTES = 32
const SESSION_BYTES = 32

const encoder = new TextEncoder()

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(salt), iterations },
    key,
    PASSWORD_BYTES * 8
  )
  return new Uint8Array(bits)
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256) throw new Error('PASSWORD_POLICY')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const derived = await pbkdf2(password, salt, PASSWORD_ITERATIONS)
  return `${PASSWORD_ALGO}$${PASSWORD_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(derived)}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algo, iterationRaw, saltRaw, expectedRaw] = encoded.split('$')
  if (algo !== PASSWORD_ALGO || !iterationRaw || !saltRaw || !expectedRaw) return false
  const iterations = Number(iterationRaw)
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 100_000) return false
  try {
    const salt = base64UrlToBytes(saltRaw)
    const expected = base64UrlToBytes(expectedRaw)
    const actual = await pbkdf2(password, salt, iterations)
    return constantTimeEqual(actual, expected)
  } catch {
    return false
  }
}

export function newSessionToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(SESSION_BYTES)))
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return bytesToBase64Url(new Uint8Array(digest))
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(view)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function randomCode(bytes = 8): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}
