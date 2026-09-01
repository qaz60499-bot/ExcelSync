# ExcelSync V1 Architecture and Data Flow

## Trust boundaries

### Renderer
React is presentation only. It can call only the explicit methods exposed by the preload bridge. `nodeIntegration` is disabled and `contextIsolation` is enabled. The Renderer has no D1 or Telegram credentials and no arbitrary filesystem API.

### Electron Main
Owns Windows filesystem access, watcher lifecycle, SHA-256 hashing, local SQLite, retry scheduling, tray integration, safeStorage session persistence, and HTTPS calls to the Worker.

### Cloudflare Worker
The Worker is the authoritative security and consistency boundary. It authenticates requests, validates input, enforces ownership and `base_version`, manages upload intents, calls the active `StorageProvider`, and changes D1 current-version pointers only after storage succeeds.

### D1
D1 contains structured business state only: users, sessions, files, version metadata, upload intents, settings and bounded sync events. Workbook bytes are never stored in D1.

### TelegramStorage
`TelegramStorage` implements `StorageProvider`. Worker business logic depends on the provider interface rather than Telegram API calls. A future `R2Storage` can implement the same interface without replacing the local sync engine or version model.

## Local SQLite

The client persists:

- `files`: stable local file identity and last known cloud version/hash.
- `local_file_state`: size, mtime, last hash, existence state.
- `pending_sync`: persistent UPSERT/RENAME/DELETE jobs, base version, idempotency key, retry state.
- `sync_history`: bounded local activity history.
- `local_versions`: synchronized version metadata used for local state reconstruction.
- `settings`: sync directory, Worker URL, auto-sync, startup and retry preferences.

`UPLOADING` jobs are recovered to `PENDING` when the application restarts, so an interrupted upload never disappears from memory-only state.

## File watcher pipeline

```text
chokidar add/change
 -> ignore unsupported or Excel temporary file
 -> debounce
 -> wait for stable size + mtime
 -> verify file is readable
 -> enforce 20 MiB V1 ceiling
 -> SHA-256
 -> compare current/pending hashes
 -> persistent pending job
 -> sync worker
```

Rename detection reuses a recently missing local identity when the same content hash reappears, then synchronizes the logical name as metadata rather than creating a duplicate file version for unchanged bytes.

## Cloud upload state machine

### Preflight
The client sends:

- file id when known
- logical name
- SHA-256
- size
- `base_version`
- idempotency key

The Worker can return:

- `noop`: current cloud hash already equals the submitted hash.
- `conflict`: cloud version advanced beyond `base_version`.
- `committed`: the same idempotent operation already completed.
- `commit_required`: Telegram upload already succeeded; only D1 commit remains.
- `upload_required`: storage upload is required.

### Upload and commit

```text
upload_intent: reserved
 -> Telegram sendDocument
 -> intent: uploaded + Telegram identifiers
 -> D1 batch:
      INSERT file_versions Vn
      UPDATE files current pointer to Vn
      UPDATE intent committed
      INSERT bounded sync event
      expire versions outside retention
```

The D1 current pointer cannot advance before Telegram has returned a durable `file_id` / `message_id`.

## Idempotency

The local UPSERT key is derived from file id, base version and content hash. Worker upload intents are unique per owner and idempotency key.

This specifically protects the failure window:

```text
Telegram upload succeeded
 -> network / D1 failure before commit response
 -> client retries
 -> preflight finds uploaded intent
 -> commit_required
 -> no second Telegram upload
```

## Conflict model

V1 deliberately does not parse or merge Excel cells. When the submitted `base_version` is stale:

1. Preserve the user's local bytes as a conflict copy.
2. Download the current cloud version to the canonical path.
3. Mark local state `CONFLICT`.
4. Treat the conflict copy as another ordinary local workbook that can later be synchronized intentionally.

## Restore model

Restore never assigns `files.current_version` to an old integer. The selected historical Telegram `file_id` is cloned through the storage adapter and committed as a new version.

Example:

```text
V1 V2 ... V7 ... V10
restore V7
V11 (restored_from_version = 7)
```

## Authentication

First owner creation is allowed only while no users exist and a valid one-time setup-code hash is present in `app_settings`. Successful bootstrap deletes that hash.

Passwords use PBKDF2-SHA256, random 128-bit salt, 32-byte output, and the Cloudflare Workers WebCrypto maximum supported iteration count of 100,000.

Login creates a random opaque session token. D1 stores only its SHA-256 hash. Electron stores the raw session token using Windows-backed Electron `safeStorage`.

## Telegram pairing

The normal UI pairing flow creates a random deep-link payload and stores only its hash with an expiry. The user opens the bot deep link; `pair/confirm` checks Bot updates for the matching `/start <payload>` message and writes the resulting private `chat_id` into `storage_config`.

D1 remains the only business index. Users never need to locate workbook versions manually in Telegram.

## Current V1 non-goals

- No embedded Excel editor.
- No CRDT or real-time collaboration.
- No cell-level merge.
- No Redis or external queue cluster.
- No microservice split.
- No AI agent.
- No physical deletion of old Telegram versions.
