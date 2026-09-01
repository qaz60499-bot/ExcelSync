import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const ROOT = 'D:/wendangcodex/ExcelSync'
const DB = 'excel-sync'
const BASE_URL = 'https://excel-sync-worker.qaz60499.workers.dev'

function wrangler(args) {
  const executable = `${ROOT}/node_modules/wrangler/bin/wrangler.js`
  const result = spawnSync(process.execPath, [executable, ...args, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`wrangler failed: ${result.error?.message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`)
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : []
}

function d1(sql) {
  const response = wrangler(['d1', 'execute', DB, '--remote', '--yes', '--command', sql])
  return response.flatMap((entry) => entry?.results ?? [])
}

function q(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

async function requestJson(path, token, init = {}) {
  const headers = new Headers(init.headers || {})
  if (token) headers.set('authorization', `Bearer ${token}`)
  const response = await fetch(`${BASE_URL}${path}`, { ...init, headers })
  let body
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body }
}

async function getJson(path, token) {
  return requestJson(path, token)
}

const owners = d1("SELECT id, username FROM users WHERE status = 'active' ORDER BY created_at LIMIT 2")
if (owners.length !== 1) throw new Error(`Expected one active owner, got ${owners.length}`)
const owner = owners[0]
const token = randomBytes(32).toString('hex')
const tokenHash = createHash('sha256').update(token).digest('base64url')
const sessionId = randomUUID()
const now = new Date().toISOString()
const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()

d1(`INSERT INTO sessions(id, token_hash, user_id, created_at, last_seen_at, expires_at)
    VALUES (${q(sessionId)}, ${q(tokenHash)}, ${q(owner.id)}, ${q(now)}, ${q(now)}, ${q(expiresAt)});`)

try {
  const [root, health, photos, trash, albums, places, storage] = await Promise.all([
    fetch(`${BASE_URL}/`).then((response) => ({ status: response.status, type: response.headers.get('content-type') })),
    getJson('/health'),
    getJson('/photos?limit=200', token),
    getJson('/photos/trash?limit=200', token),
    getJson('/photos/albums', token),
    getJson('/photos/places', token),
    getJson('/storage/status', token),
  ])

  const items = Array.isArray(photos.body?.items) ? photos.body.items : []
  const ready = items.find((item) => item?.status === 'ready')
  const detail = ready ? await getJson(`/photos/${encodeURIComponent(ready.id)}`, token) : null
  const preview = ready ? await getJson(`/photos/${encodeURIComponent(ready.id)}/preview`, token) : null
  const media = ready ? await getJson(`/photos/${encodeURIComponent(ready.id)}/media`, token) : null
  const photoProfile = Array.isArray(storage.body?.profiles)
    ? storage.body.profiles.find((profile) => profile?.purpose === 'photos')
    : null
  const duplicateCandidate = items.find((item) => item?.status === 'ready' && typeof item?.contentHash === 'string' && item.contentHash.length === 64)
  const reservePayload = photoProfile?.configured && duplicateCandidate
    ? {
        originalName: duplicateCandidate.originalName,
        mimeType: duplicateCandidate.mimeType,
        sizeBytes: duplicateCandidate.sizeBytes,
        mediaType: duplicateCandidate.mediaType,
        contentHash: duplicateCandidate.contentHash,
        fileLastModified: duplicateCandidate.takenAt,
      }
    : {
        originalName: 'smoke-do-not-create.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        mediaType: 'photo',
        contentHash: 'f'.repeat(64),
        fileLastModified: now,
      }
  const reserveSmoke = await requestJson('/photos/reserve', token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reservePayload),
  })
  const photoCountAfterReserve = d1('SELECT COUNT(*) AS count FROM photo_assets')[0]?.count ?? null

  const result = {
    root,
    healthStatus: health.status,
    photosStatus: photos.status,
    activePhotoRows: items.length,
    readyPhotoRows: items.filter((item) => item?.status === 'ready').length,
    failedHistoricalRows: items.filter((item) => item?.status === 'failed').length,
    trashStatus: trash.status,
    trashRows: Array.isArray(trash.body?.items) ? trash.body.items.length : null,
    albumsStatus: albums.status,
    albums: Array.isArray(albums.body?.items) ? albums.body.items.length : null,
    placesStatus: places.status,
    places: Array.isArray(places.body?.items) ? places.body.items.length : null,
    storageStatus: storage.status,
    storageProfiles: storage.body?.profiles ?? null,
    legacyPhotoBridgeConfigured: Boolean(storage.body?.legacyPhotoBridgeConfigured),
    previewAdvertisedRows: items.filter((item) => item?.previewAvailable).length,
    detailStatus: detail?.status ?? null,
    previewStatus: preview?.status ?? null,
    previewError: preview?.body?.error ?? null,
    mediaStatus: media?.status ?? null,
    mediaError: media?.body?.error ?? null,
    reserveSmokeMode: photoProfile?.configured ? 'configured-deduplicate' : 'unconfigured-block',
    reserveSmokeStatus: reserveSmoke.status,
    reserveSmokeError: reserveSmoke.body?.error ?? null,
    reserveSmokeDuplicate: Boolean(reserveSmoke.body?.duplicate),
    photoCountAfterReserveSmoke: photoCountAfterReserve,
  }
  console.log(JSON.stringify(result, null, 2))

  if (root.status !== 200 || health.status !== 200 || photos.status !== 200 || trash.status !== 200) process.exitCode = 2
  if (items.length !== 68 || result.readyPhotoRows !== 65 || result.failedHistoricalRows !== 3 || result.trashRows !== 10) process.exitCode = 3
  if (detail?.status !== 200 || preview?.status !== 200 || media?.status !== 200) process.exitCode = 4
  if (!result.legacyPhotoBridgeConfigured || photoCountAfterReserve !== 78) process.exitCode = 5
  if (photoProfile?.configured) {
    if (!duplicateCandidate || reserveSmoke.status !== 200 || !reserveSmoke.body?.duplicate) process.exitCode = 6
  } else if (reserveSmoke.status !== 503 || reserveSmoke.body?.error !== 'PHOTOS_TELEGRAM_SECRET_NOT_CONFIGURED') {
    process.exitCode = 7
  }
} finally {
  d1(`DELETE FROM sessions WHERE id = ${q(sessionId)} AND user_id = ${q(owner.id)};`)
}
