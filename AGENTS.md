# ExcelSync project rules

This project is the Windows Electron Excel Sync SaaS Client requested on 2026-08-30.

## Product boundaries
- Desktop: Electron + TypeScript + React + local SQLite, Windows installer/EXE.
- Cloud: Cloudflare Worker + D1 + Wrangler.
- File storage: StorageProvider abstraction; first provider TelegramStorage, future R2Storage without rewriting sync engine.
- Users edit ordinary local .xlsx files using Microsoft Excel/default app. Do not embed or reimplement Excel.
- First release is single-user in operation but data/API boundaries must preserve future multi-user support.

## Security boundaries
- Never place TELEGRAM_BOT_TOKEN or any real secret in source, renderer, D1, Git, build artifacts, normal logs, .env, or committed dev vars.
- Electron renderer never talks directly to Telegram or D1 and never receives backend secrets.
- Worker secrets are Wrangler secrets.
- contextIsolation=true, nodeIntegration=false, narrow preload IPC bridge only.
- Passwords are strongly hashed; persisted session material on Windows uses OS-protected storage where practical.

## Sync correctness
- Local SQLite persists files, file state, pending queue, history, base versions and retry state.
- Filter Excel temp/lock files such as ~$*.xlsx.
- Debounce + file stability + readable/unlocked check + SHA-256 before queuing/uploading.
- Same hash is a no-op. File-system duplicate events must not produce duplicate cloud versions.
- Upload ordering: pending -> Worker base-version check -> Telegram upload success -> D1 atomic/batched version/current pointer update -> client SYNCED.
- Telegram failure must not advance D1 current_version.
- Upload success followed by commit failure must remain safely retryable/idempotent.
- Conflicts use base_version and create local conflict copies; do not cell-merge Excel.
- Restore creates a new version pointing to/restored from an older version; never move current_version backwards.
- D1 stores metadata/index only, never Excel bytes.

## Version retention
- Current version always active. Recent-version retention configurable (default 20). Older D1 versions become expired logically; do not physically delete Telegram files in V1.

## Local process lifecycle
- Packaged ExcelSync uses Electron single-instance locking. Closing the window hides it to the Windows tray by design; that one tray-backed Electron process is not a stale duplicate. Use the tray `退出` action / graceful quit path when the application itself should terminate.
- Local detached Wrangler runtime workers must be started through `npm run runtime-worker:start` and stopped through `npm run runtime-worker:stop`. The start command reuses an already-owned worker on the same project/port instead of creating another detached Node/Wrangler tree; the stop command matches only this project and port and kills that owned tree.
- Do not use global `taskkill node.exe`, `taskkill workerd.exe`, or equivalent cleanup. This machine intentionally runs OCR, DevSpace, other SaaS projects, and background services at the same time.

## Engineering rules
- Prefer small dependencies and production-stable primitives.
- Do not add CRDT, realtime collaboration, Redis, queues, microservices, AI, Kubernetes, or giant observability stacks.
- Tests must exercise first upload, update, dedupe, temp-file ignore, offline persistence/restart retry, provider failures, commit failure recovery, conflicts, restore, authentication boundaries, renderer secret isolation, shutdown/restart, and Windows packaging smoke checks.
- Do not claim deployment or end-to-end success unless actually verified.
