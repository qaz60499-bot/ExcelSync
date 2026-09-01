const encoder = new TextEncoder()
const decoder = new TextDecoder()
const AAD = encoder.encode('excel-sync-storage-credential-v1')

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

async function masterKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error('STORAGE_MASTER_KEY_NOT_CONFIGURED')
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptCredential(secret: string, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  if (!plaintext) throw new Error('STORAGE_CREDENTIAL_EMPTY')
  const key = await masterKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(AAD), tagLength: 128 },
    key,
    encoder.encode(plaintext)
  )
  return { ciphertext: bytesToBase64Url(new Uint8Array(encrypted)), iv: bytesToBase64Url(iv) }
}

export async function decryptCredential(secret: string, ciphertext: string, iv: string): Promise<string> {
  if (!ciphertext || !iv) throw new Error('STORAGE_CREDENTIAL_MISSING')
  const key = await masterKey(secret)
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(base64UrlToBytes(iv)),
        additionalData: toArrayBuffer(AAD),
        tagLength: 128
      },
      key,
      toArrayBuffer(base64UrlToBytes(ciphertext))
    )
    return decoder.decode(plain)
  } catch {
    throw new Error('STORAGE_CREDENTIAL_DECRYPT_FAILED')
  }
}
