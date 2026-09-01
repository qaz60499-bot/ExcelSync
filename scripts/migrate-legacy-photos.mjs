import { spawnSync } from 'node:child_process'

const LEGACY_ROOT = 'D:/wendangcodex/Codex2/telegram-private-media-vault'
const NEW_ROOT = 'D:/wendangcodex/ExcelSync'
const LEGACY_DB = 'private-archive-db'
const NEW_DB = 'excel-sync'
const APPLY = process.argv.includes('--apply')

function wrangler(cwd, args) {
  const executable = `${cwd}/node_modules/wrangler/bin/wrangler.js`
  const result = spawnSync(process.execPath, [executable, ...args, '--json'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`wrangler failed (${cwd}, status=${String(result.status)}, signal=${String(result.signal)}): ${result.error?.message ?? ''}\nSTDERR: ${result.stderr ?? ''}\nSTDOUT: ${result.stdout ?? ''}`)
  }
  const raw = result.stdout.trim()
  if (!raw) return []
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : [parsed]
}

function query(cwd, db, sql) {
  const response = wrangler(cwd, ['d1', 'execute', db, '--remote', '--command', sql])
  return response.flatMap((entry) => entry?.results ?? [])
}

function executeNew(sql) {
  return wrangler(NEW_ROOT, ['d1', 'execute', NEW_DB, '--remote', '--yes', '--command', sql])
}

function q(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  return `'${String(value).replaceAll("'", "''")}'`
}

function chunk(items, size) {
  const chunks = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

const owners = query(NEW_ROOT, NEW_DB, "SELECT id, username FROM users WHERE status = 'active' ORDER BY created_at LIMIT 2")
if (owners.length !== 1) throw new Error(`Expected exactly one active ExcelSync owner, found ${owners.length}`)
const ownerId = owners[0].id

const existing = query(NEW_ROOT, NEW_DB, 'SELECT COUNT(*) AS count FROM photo_assets')[0]?.count ?? 0
if (existing > 0 && !process.argv.includes('--allow-existing')) {
  throw new Error(`New photo_assets already contains ${existing} row(s). Refusing ambiguous merge without --allow-existing.`)
}

const assets = query(LEGACY_ROOT, LEGACY_DB, `SELECT
  id, storage_provider, storage_chat_id, storage_message_id, storage_file_id, storage_file_unique_id,
  preview_file_id, source, media_type, mime_type, original_name, size_bytes, content_hash,
  width, height, duration_ms, taken_at, uploaded_at, latitude, longitude, place_id,
  primary_category, category_override, person_count, scene, favorite, status, analysis_status,
  created_at, updated_at
FROM assets ORDER BY id`)
const tags = query(LEGACY_ROOT, LEGACY_DB, 'SELECT id, slug, name, kind FROM tags ORDER BY id')
const assetTags = query(LEGACY_ROOT, LEGACY_DB, 'SELECT asset_id, tag_id, confidence, source FROM asset_tags ORDER BY asset_id, tag_id')
const places = query(LEGACY_ROOT, LEGACY_DB, 'SELECT id, country, region, city, district, label, latitude, longitude, source FROM places ORDER BY id')
const albums = query(LEGACY_ROOT, LEGACY_DB, 'SELECT id, name, cover_asset_id, created_at, updated_at FROM albums ORDER BY id')
const albumAssets = query(LEGACY_ROOT, LEGACY_DB, 'SELECT album_id, asset_id, sort_order FROM album_assets ORDER BY album_id, sort_order, asset_id')

const chatIds = [...new Set(assets.map((asset) => asset.storage_chat_id).filter(Boolean))]
if (chatIds.length > 1) throw new Error(`Legacy assets use multiple Telegram chats: ${chatIds.join(', ')}`)
const legacyChatId = chatIds[0] ?? null

const summary = {
  owner: owners[0].username,
  legacyAssets: assets.length,
  telegramBacked: assets.filter((asset) => asset.storage_file_id).length,
  hashed: assets.filter((asset) => asset.content_hash).length,
  ready: assets.filter((asset) => asset.status === 'ready').length,
  trashed: assets.filter((asset) => asset.status === 'trashed').length,
  pendingWithoutOriginal: assets.filter((asset) => !asset.storage_file_id && asset.status !== 'trashed').length,
  tags: tags.length,
  assetTags: assetTags.length,
  places: places.length,
  albums: albums.length,
  albumAssets: albumAssets.length,
  legacyChatDetected: Boolean(legacyChatId),
  mode: APPLY ? 'apply' : 'dry-run',
}
console.log(JSON.stringify(summary, null, 2))

if (!APPLY) process.exit(0)

for (const rows of chunk(places, 25)) {
  const statements = rows.map((place) => `INSERT OR IGNORE INTO photo_places(
    id, owner_user_id, country, region, city, district, label, latitude, longitude, source, created_at, updated_at
  ) VALUES (${q(place.id)}, ${q(ownerId)}, ${q(place.country)}, ${q(place.region)}, ${q(place.city)}, ${q(place.district)}, ${q(place.label)}, ${q(place.latitude)}, ${q(place.longitude)}, ${q(`legacy:${place.source}`)}, ${q(new Date().toISOString())}, ${q(new Date().toISOString())});`)
  if (statements.length) executeNew(statements.join('\n'))
}

for (const rows of chunk(assets, 3)) {
  const statements = []
  for (const asset of rows) {
    if (!['photo', 'video'].includes(asset.media_type)) throw new Error(`Unsupported legacy media type ${asset.media_type} for ${asset.id}`)
    const mappedStatus = asset.status === 'trashed' ? 'trashed' : asset.storage_file_id ? 'ready' : 'failed'
    const trashedAt = asset.status === 'trashed' ? asset.updated_at : null
    statements.push(`INSERT OR IGNORE INTO photo_assets(
      id, owner_user_id, source, media_type, original_name, mime_type, size_bytes, content_hash, plaintext_content_hash,
      width, height, duration_ms, taken_at, taken_at_source, uploaded_at, latitude, longitude, place_id,
      favorite, status, trashed_at, storage_profile, storage_provider, storage_chat_id, storage_message_id,
      storage_file_id, storage_file_unique_id, preview_storage_file_id, encrypted, created_at, updated_at,
      legacy_primary_category, legacy_category_override, legacy_person_count, legacy_scene, legacy_analysis_status
    ) VALUES (
      ${q(asset.id)}, ${q(ownerId)}, 'legacy', ${q(asset.media_type)}, ${q(asset.original_name)}, ${q(asset.mime_type)}, ${q(asset.size_bytes)},
      ${q(asset.content_hash)}, ${q(asset.content_hash)}, ${q(asset.width)}, ${q(asset.height)}, ${q(asset.duration_ms)},
      ${q(asset.taken_at)}, 'legacy_taken_at', ${q(asset.uploaded_at)}, ${q(asset.latitude)}, ${q(asset.longitude)}, ${q(asset.place_id)},
      ${q(Boolean(asset.favorite))}, ${q(mappedStatus)}, ${q(trashedAt)}, 'photos-private', ${q(asset.storage_provider || 'telegram')},
      ${q(asset.storage_chat_id)}, ${q(asset.storage_message_id)}, ${q(asset.storage_file_id)}, ${q(asset.storage_file_unique_id)},
      ${q(asset.preview_file_id)}, 0, ${q(asset.created_at)}, ${q(asset.updated_at)}, ${q(asset.primary_category)}, ${q(asset.category_override)},
      ${q(asset.person_count)}, ${q(asset.scene)}, ${q(asset.analysis_status)}
    );`)
    statements.push(`INSERT OR IGNORE INTO photo_legacy_imports(source_asset_id, owner_user_id, new_asset_id, imported_at, source_status)
      VALUES (${q(asset.id)}, ${q(ownerId)}, ${q(asset.id)}, ${q(new Date().toISOString())}, ${q(asset.status)});`)
  }
  executeNew(statements.join('\n'))
}

for (const rows of chunk(tags, 25)) {
  const statements = rows.map((tag) => `INSERT OR IGNORE INTO photo_tags(id, owner_user_id, slug, name, created_at)
    VALUES (${q(tag.id)}, ${q(ownerId)}, ${q(tag.slug)}, ${q(tag.name)}, ${q(new Date().toISOString())});`)
  if (statements.length) executeNew(statements.join('\n'))
}

for (const rows of chunk(assetTags, 30)) {
  const statements = rows.map((link) => `INSERT OR IGNORE INTO photo_asset_tags(asset_id, tag_id, source, confidence)
    VALUES (${q(link.asset_id)}, ${q(link.tag_id)}, ${q(link.source)}, ${q(link.confidence)});`)
  if (statements.length) executeNew(statements.join('\n'))
}

for (const rows of chunk(albums, 25)) {
  const statements = rows.map((album) => `INSERT OR IGNORE INTO photo_albums(id, owner_user_id, name, cover_asset_id, created_at, updated_at)
    VALUES (${q(album.id)}, ${q(ownerId)}, ${q(album.name)}, ${q(album.cover_asset_id)}, ${q(album.created_at)}, ${q(album.updated_at)});`)
  if (statements.length) executeNew(statements.join('\n'))
}

for (const rows of chunk(albumAssets, 30)) {
  const statements = rows.map((link) => `INSERT OR IGNORE INTO photo_album_assets(album_id, asset_id, sort_order, added_at)
    VALUES (${q(link.album_id)}, ${q(link.asset_id)}, ${q(link.sort_order ?? 0)}, ${q(new Date().toISOString())});`)
  if (statements.length) executeNew(statements.join('\n'))
}

if (legacyChatId) {
  executeNew(`UPDATE storage_profiles SET chat_id = ${q(legacyChatId)}, connected_by = ${q(ownerId)}, connected_at = ${q(new Date().toISOString())}
    WHERE profile = 'photos-private' AND purpose = 'photos';`)
}

const verification = query(NEW_ROOT, NEW_DB, `SELECT
  COUNT(*) AS total_assets,
  SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_assets,
  SUM(CASE WHEN status = 'trashed' THEN 1 ELSE 0 END) AS trashed_assets,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_assets,
  SUM(CASE WHEN storage_file_id IS NOT NULL THEN 1 ELSE 0 END) AS telegram_backed,
  SUM(CASE WHEN plaintext_content_hash IS NOT NULL THEN 1 ELSE 0 END) AS hashed_assets
FROM photo_assets WHERE owner_user_id = ${q(ownerId)};
SELECT COUNT(*) AS tag_links FROM photo_asset_tags;
SELECT COUNT(*) AS legacy_links FROM photo_legacy_imports WHERE owner_user_id = ${q(ownerId)};`)
console.log(JSON.stringify({ applied: true, verification }, null, 2))
