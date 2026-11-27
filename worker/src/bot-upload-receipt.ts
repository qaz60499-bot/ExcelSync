import { z } from 'zod'

export interface BotUploadReceipt {
  backend: 'telegram_bot'
  intentId: string
  recoveryToken: string
  sha256: string
  size: number
  fileName: string
  createdAt: string
}

export interface BotUploadReceiptClaims {
  v: 1
  kind: 'telegram_bot_upload_receipt'
  audience: string
  intentId: string
  attemptId: string
  ownerUserId: string
  organizationId: string
  fileId: string
  workspaceId: string | null
  storageConnectionId: string
  backend: 'telegram_bot'
  chatId: string
  botIdentity: string
  idempotencyKey: string
  baseVersion: number
  sha256: string
  size: number
  fileName: string
  telegramFileId: string
  telegramMessageId: number
  telegramFileUniqueId: string | null
  createdAt: string
}

export interface BotReceiptSecrets {
  STORAGE_MASTER_KEY?: string
  TELEGRAM_BOT_TOKEN?: string
}

export interface BotUploadReceiptSigner {
  keySource: 'master' | 'legacy-bot'
  key: CryptoKey
}

const DOMAIN = 'ExcelSync bot upload receipt v1'
const MAX_TOKEN_LENGTH = 12_000

const claimsSchema = z.object({
  v: z.literal(1),
  kind: z.literal('telegram_bot_upload_receipt'),
  audience: z.string().url(),
  intentId: z.string().uuid(),
  attemptId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  organizationId: z.string().uuid(),
  fileId: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
  storageConnectionId: z.string().uuid(),
  backend: z.literal('telegram_bot'),
  chatId: z.string().min(1).max(128),
  botIdentity: z.string().min(1).max(128),
  idempotencyKey: z.string().min(16).max(160),
  baseVersion: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive(),
  fileName: z.string().min(1).max(240),
  telegramFileId: z.string().min(1).max(256),
  telegramMessageId: z.number().int().positive(),
  telegramFileUniqueId: z.string().min(1).max(256).nullable(),
  createdAt: z.string().datetime()
}).strict()

type SigningKeySource = 'master' | 'legacy-bot'

function sourceSecret(secrets: BotReceiptSecrets, source: SigningKeySource): string | null {
  if (source === 'master') return secrets.STORAGE_MASTER_KEY || null
  const token = secrets.TELEGRAM_BOT_TOKEN
  return token && token !== 'UNCONFIGURED' ? token : null
}

export async function createBotUploadReceiptSigner(secrets: BotReceiptSecrets): Promise<BotUploadReceiptSigner> {
  const keySource: SigningKeySource = secrets.STORAGE_MASTER_KEY ? 'master' : 'legacy-bot'
  const secret = sourceSecret(secrets, keySource)
  if (!secret) throw new Error('BOT_UPLOAD_RECEIPT_SIGNING_KEY_UNAVAILABLE')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
  return { keySource, key }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
    const binary = atob(padded)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

function sourceMarker(source: SigningKeySource): 'm' | 'b' {
  return source === 'master' ? 'm' : 'b'
}

function parseSource(marker: string): SigningKeySource | null {
  if (marker === 'm') return 'master'
  if (marker === 'b') return 'legacy-bot'
  return null
}

function signingInput(source: SigningKeySource, payload: string): Uint8Array {
  return new TextEncoder().encode(`${DOMAIN}\n${source}\n${payload}`)
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export async function signBotUploadReceiptClaims(
  signer: BotUploadReceiptSigner,
  claims: BotUploadReceiptClaims
): Promise<string> {
  const parsed = claimsSchema.safeParse(claims)
  if (!parsed.success) throw new Error('BOT_UPLOAD_RECEIPT_CLAIMS_INVALID')
  const payloadBytes = new TextEncoder().encode(JSON.stringify(parsed.data))
  const payload = encodeBase64Url(payloadBytes)
  const signature = await crypto.subtle.sign('HMAC', signer.key, asArrayBuffer(signingInput(signer.keySource, payload)))
  const token = `v1.${sourceMarker(signer.keySource)}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`
  if (token.length > MAX_TOKEN_LENGTH) throw new Error('BOT_UPLOAD_RECEIPT_TOO_LARGE')
  return token
}

export async function verifyBotUploadReceiptToken(
  token: string,
  secrets: BotReceiptSecrets,
  expectedAudience: string
): Promise<BotUploadReceiptClaims | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') return null
  const source = parseSource(parts[1] ?? '')
  const payload = parts[2]
  const signature = decodeBase64Url(parts[3] ?? '')
  if (!source || !payload || !signature) return null
  const payloadBytes = decodeBase64Url(payload)
  if (!payloadBytes) return null

  const secret = sourceSecret(secrets, source)
  if (!secret) return null
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )
    const valid = await crypto.subtle.verify('HMAC', key, asArrayBuffer(signature), asArrayBuffer(signingInput(source, payload)))
    if (!valid) return null
  } catch {
    return null
  }

  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(payloadBytes))
  } catch {
    return null
  }
  const parsed = claimsSchema.safeParse(raw)
  if (!parsed.success || parsed.data.audience !== expectedAudience) return null
  return parsed.data
}

export async function createBotUploadReceipt(
  signer: BotUploadReceiptSigner,
  claims: BotUploadReceiptClaims
): Promise<BotUploadReceipt> {
  return {
    backend: 'telegram_bot',
    intentId: claims.intentId,
    recoveryToken: await signBotUploadReceiptClaims(signer, claims),
    sha256: claims.sha256,
    size: claims.size,
    fileName: claims.fileName,
    createdAt: claims.createdAt
  }
}
