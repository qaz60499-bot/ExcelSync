# ExcelSync iOS client

This directory is an additive mobile client for the existing ExcelSync 1.4.1 SaaS. It does not replace the Windows Electron client or its local sync engine.

## Architecture

- React + Vite mobile UI.
- Capacitor 8 native iOS container.
- Existing Cloudflare Worker/D1 API is reused.
- CapacitorHttp patches fetch on iOS so the app can call the Worker without weakening the Worker's browser CORS boundary.
- Session tokens live in `sessionStorage` and therefore are not persisted across a full WebView process restart. The stable non-secret device UUID is persisted in local storage.

## Current mobile capabilities

- Login/logout against the existing account system.
- Cloud file list and search.
- Workspace list.
- Version metadata.
- Telegram Bot-backed file download/share.
- File picker upload using the existing `preflight -> upload -> commit` transaction chain.
- Mobile uploads deliberately target `telegram_bot`.

## Intentional limitation

`telegram_user_group` file bytes are owned by the Windows Telegram user-session bridge. The Worker has metadata but cannot fetch those bytes itself. The iOS client therefore shows those files and their metadata but does not pretend it can download them. Full private-group byte access would require a separate iOS Telegram/MTProto implementation or a storage architecture change.

## Local checks

```sh
npm install
npm run check
```

The native iOS project is generated on macOS with:

```sh
npm run build
npx cap add ios
npx cap sync ios
```

## GitHub Actions

`.github/workflows/ios-build.yml` runs on `macos-26`.

Without Apple signing secrets, it still compiles an unsigned iOS Simulator `.app` artifact. With all signing secrets present, it additionally archives and exports a signed `.ipa`.

Required repository secrets for a signed IPA:

- `APPLE_TEAM_ID`
- `IOS_P12_BASE64`
- `IOS_P12_PASSWORD`
- `IOS_PROVISION_PROFILE_BASE64`
- `IOS_EXPORT_METHOD` (optional; defaults to `debugging`; use `release-testing` for registered-device release builds or `app-store-connect` for App Store/TestFlight export)

The provisioning profile must cover bundle ID `com.excelsync.ios`.

Pushing an `ios-v*` tag with signing configured publishes the resulting IPA to the matching GitHub Release.
