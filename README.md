# ExcelSync

ExcelSync is a Windows desktop utility that keeps ordinary local files synchronized through a Cloudflare Worker, Cloudflare D1 metadata, and a Telegram Bot storage adapter. The original Excel workflow remains supported, while V1.1 adds common documents, archives, structured data, presentations, and images.

## V1 architecture

```text
Normal local files (.xlsx/.pdf/.docx/.zip/.csv/...)
              |
              v
Windows Electron Client
  React renderer -> narrow preload IPC -> Electron main
              |
              | HTTPS
              v
Cloudflare Worker
  auth / version checks / idempotency / conflict control
       |                         |
       v                         v
Cloudflare D1              StorageProvider
 metadata + index               |
                               v
                         TelegramStorage
```

The Electron renderer never receives the Telegram Bot token, never connects directly to Telegram, and never connects directly to D1.

## Product boundary

ExcelSync is the file synchronization product. Image formats such as `.jpg`, `.png`, and `.webp` are supported **as ordinary files** and can use the generic file preview flow. A dedicated photo-library product (timeline, albums, places, photo backup, or a separate photo Telegram storage profile) belongs to the standalone personal media SaaS and is intentionally not routed, published, or shown by ExcelSync.

## Local behavior

- The user selects an ordinary Windows folder such as `D:\ExcelSyncData`.
- Supported spreadsheet formats: `.xlsx`, `.xlsm`, `.xls`, `.xlsb`, `.csv`, `.tsv`.
- Supported document formats: `.pdf`, `.docx`, `.txt`, `.md`, `.rtf`.
- Supported archives: `.zip`.
- Supported structured data: `.json`, `.jsonl`, `.xml`, `.yaml`, `.yml`.
- Supported presentations: `.pptx`.
- Supported images: `.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`, `.tif`, `.tiff`.
- Files are logically partitioned by extension-derived category in the desktop UI without forcing the user's existing directory layout to change.
- MIME types are derived from the shared registry and known binary formats are checked against their file signatures before upload/import.
- `.xlsm` files are stored and restored as opaque files; ExcelSync never executes VBA macros.
- Office lock/temp files such as `~$book.xlsx` and partial download files are ignored.
- File events are debounced, then checked for size/mtime stability and readable state before hashing.
- SHA-256 content hashes prevent duplicate uploads.
- Local SQLite persists file state, pending jobs, retry state, local version metadata, and activity.
- A network failure never prevents Excel from saving locally.
- Pending jobs survive an application restart.
- Deleting a local copy never deletes the SaaS copy. A previously uploaded file becomes **cloud-only** and remains active in D1/Telegram.
- Background sync does not automatically re-download a cloud-only file that this client already knows was removed locally; use **Restore to local** explicitly.
- The file page and recycle bin include filename/path search.
- **Delete from SaaS** is an explicit UI action that moves the logical file to D1 status `trashed`; Telegram payloads are retained in this release.
- Restoring from the recycle bin changes `trashed -> active` without creating a new version or automatically downloading the file.

## Sync states

Local queue states remain `SYNCED`, `PENDING`, `UPLOADING`, `RETRY_WAIT`, `CONFLICT`, `ERROR`. The UI additionally distinguishes `已同步` from `仅云端` based on whether the local copy exists.

## Consistency model

A new cloud version is not created by changing the D1 current pointer first.

```text
local pending
 -> Worker preflight checks base_version
 -> Telegram upload succeeds
 -> Telegram file_id/message_id captured
 -> D1 batch inserts file_version and advances files.current_version
 -> client marks local job SYNCED
```

If Telegram fails, D1 `current_version` does not advance. If Telegram succeeds but commit fails, the upload intent remains recoverable and retry does not re-upload the same content.

## Versioning

Telegram objects are immutable version payloads. D1 is the business index.

- V1 -> Telegram object A
- V2 -> Telegram object B
- V3 -> Telegram object C

Restoring an old version creates a new version. Restoring V7 while current is V10 produces V11 with `restored_from_version = 7`; the timeline never moves backwards.

Default visible retention is 20 versions. Older versions are marked `expired` in D1; V1 does not physically delete old Telegram objects.

## Conflict handling

Every update includes `base_version`. If the cloud version has advanced, ExcelSync does not overwrite it and does not attempt cell-level merging. The client writes a local conflict copy such as:

`book (conflict 2026-08-30 123456).xlsx`

and restores the current cloud version to the canonical path.

## Telegram V1 file limit

ExcelSync currently limits each managed file to 20 MiB. Telegram `sendDocument` can accept larger files, but the storage contract intentionally uses the lower download ceiling so every accepted backup remains restorable through the same Worker path.

## Authentication

- Username/password authentication is handled by the Worker.
- Passwords are PBKDF2-SHA256 with a random salt. Cloudflare Workers currently caps the WebCrypto PBKDF2 iteration count at 100,000, so V1 uses that platform maximum.
- Sessions use random opaque tokens. Only a SHA-256 token hash is stored in D1.
- Electron persists session material through Electron `safeStorage` on Windows.
- First-account creation requires a one-time setup code. D1 stores only the code hash and deletes it after successful bootstrap.

## Telegram secret

The production bot token must exist only as the Wrangler secret `TELEGRAM_BOT_TOKEN`.

Check it with:

```powershell
npx wrangler secret list
```

Do not place the token in `.env`, source files, Renderer code, D1, or committed scripts.

## Development

```powershell
npm install
npm run typecheck
npm test
npm run dev
```

Worker checks:

```powershell
npm run worker:types
npm run worker:deploy:dry
npm run worker:deploy
```

D1 migration:

```powershell
npm run d1:migrate:remote
```

## Windows build

```powershell
npm run build
npm run package:win
```

On this machine the reliable builder invocation uses the already installed Electron runtime:

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npm exec electron-builder -- --win nsis portable --publish never -c.electronDist=node_modules/electron/dist
```

Expected artifacts:

- `dist-release-1.1.2-final\ExcelSync-Setup-1.1.2-x64.exe`
- `dist-release-1.1.2-final\ExcelSync-Portable-1.1.2-x64.exe`
- `dist-release-1.1.2-final\win-unpacked\ExcelSync.exe`

## Production resources

- Worker: `https://excel-sync-worker.qaz60499.workers.dev`
- D1 database: `excel-sync`
- D1 database ID: `0e0b96a7-c297-4cab-8e6d-9b5ed240eb5d`
- Telegram bot: `@ggggggsaasssss_bot`

The local Windows system proxy on the build machine is `127.0.0.1:10808`. Direct command-line access to `workers.dev` can time out on the current network, while requests through the system proxy succeed. Electron follows the Windows proxy path.
