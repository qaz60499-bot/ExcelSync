from __future__ import annotations

import asyncio
import hashlib
import json
import mimetypes
import os
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

try:
    from telethon import TelegramClient, events, utils
    from telethon.errors import SessionPasswordNeededError
    from telethon.sessions import SQLiteSession, StringSession
except Exception as exc:  # pragma: no cover - exercised by packaged/runtime smoke
    print(f"BRIDGE_DEPENDENCY_ERROR telethon: {exc}", file=sys.stderr, flush=True)
    raise

SECRET = os.environ.get("EXCELSYNC_BRIDGE_SECRET", "")
API_ID = int(os.environ.get("EXCELSYNC_TELEGRAM_API_ID", "0") or "0")
API_HASH = os.environ.get("EXCELSYNC_TELEGRAM_API_HASH", "")
SESSION_STRING = os.environ.get("EXCELSYNC_TELEGRAM_SESSION_STRING", "")
LEGACY_SESSION = os.environ.get("EXCELSYNC_TELEGRAM_LEGACY_SESSION", "").strip()
INITIAL_CHAT_ID = os.environ.get("EXCELSYNC_TELEGRAM_CHAT_ID", "").strip()
INITIAL_CHAT_TITLE = os.environ.get("EXCELSYNC_TELEGRAM_CHAT_TITLE", "ai").strip() or "ai"
PROXY_URL = os.environ.get("EXCELSYNC_TELEGRAM_PROXY_URL", "").strip()

if not SECRET or API_ID <= 0 or not API_HASH:
    raise RuntimeError("TELEGRAM_BRIDGE_ENV_INVALID")

def parse_proxy_url(raw: str) -> dict[str, Any] | None:
    if not raw:
        return None
    parsed = urlparse(raw)
    scheme = parsed.scheme.lower()
    if scheme not in {"socks5", "socks4", "http"}:
        raise RuntimeError("TELEGRAM_PROXY_SCHEME_INVALID")
    if not parsed.hostname or not parsed.port:
        raise RuntimeError("TELEGRAM_PROXY_URL_INVALID")
    return {
        "proxy_type": scheme,
        "addr": parsed.hostname,
        "port": parsed.port,
        "rdns": True,
        "username": parsed.username,
        "password": parsed.password,
    }


loop = asyncio.new_event_loop()
session_backend = StringSession(SESSION_STRING) if SESSION_STRING else (SQLiteSession(LEGACY_SESSION) if LEGACY_SESSION else StringSession())
client = TelegramClient(
    session_backend,
    API_ID,
    API_HASH,
    loop=loop,
    proxy=parse_proxy_url(PROXY_URL),
    timeout=8,
    connection_retries=2,
    retry_delay=1,
    auto_reconnect=True,
)
listener_lock = threading.Lock()
listener_messages: dict[int, dict[str, Any]] = {}
bound_chat_id: str | None = INITIAL_CHAT_ID or None
bound_chat_title: str | None = INITIAL_CHAT_TITLE if INITIAL_CHAT_ID else None
listener_handler: Any = None
pending_phone: str | None = None
auth_state_lock = threading.Lock()
cached_authorized = bool(getattr(client.session, "auth_key", None))
auth_probe_error_code: str | None = None
auth_probe_error_message: str | None = None
transfer_lock = threading.Lock()
transfer_progress: dict[str, dict[str, Any]] = {}


def update_transfer_progress(
    operation_id: str,
    direction: str,
    file_name: str,
    phase: str,
    transferred: int,
    total: int,
    started_at: float,
) -> None:
    if not operation_id:
        return
    elapsed = max(time.monotonic() - started_at, 0.001)
    now_ms = int(time.time() * 1000)
    snapshot = {
        "id": operation_id,
        "direction": direction,
        "fileName": file_name,
        "phase": phase,
        "transferredBytes": max(0, int(transferred)),
        "totalBytes": max(0, int(total)),
        "bytesPerSecond": max(0.0, float(transferred) / elapsed),
        "updatedAt": now_ms,
    }
    with transfer_lock:
        previous = transfer_progress.get(operation_id)
        if previous and previous.get("phase") == phase and transferred < total and now_ms - int(previous.get("updatedAt", 0)) < 120:
            return
        transfer_progress[operation_id] = snapshot
        if len(transfer_progress) > 100:
            oldest = sorted(transfer_progress.items(), key=lambda item: int(item[1].get("updatedAt", 0)))[:-50]
            for key, _value in oldest:
                transfer_progress.pop(key, None)


def transfer_progress_snapshot(operation_id: str) -> dict[str, Any]:
    with transfer_lock:
        snapshot = transfer_progress.get(operation_id)
        if snapshot is None:
            raise RuntimeError("TRANSFER_PROGRESS_NOT_FOUND")
        return dict(snapshot)


def sha256_file(path: str, progress_callback: Callable[[int, int], None] | None = None) -> str:
    digest = hashlib.sha256()
    total = int(Path(path).stat().st_size)
    processed = 0
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
            processed += len(block)
            if progress_callback is not None:
                progress_callback(processed, total)
    return digest.hexdigest()


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def document_metadata(message: Any) -> dict[str, Any] | None:
    if not getattr(message, "document", None):
        return None
    file_obj = getattr(message, "file", None)
    name = getattr(file_obj, "name", None) or f"telegram-{message.id}.bin"
    size = int(getattr(file_obj, "size", 0) or 0)
    mime_type = getattr(file_obj, "mime_type", None) or mimetypes.guess_type(name)[0] or "application/octet-stream"
    return {
        "chatId": str(bound_chat_id or ""),
        "messageId": int(message.id),
        "fileName": str(name),
        "size": size,
        "mimeType": str(mime_type),
        "createdAt": message.date.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if getattr(message, "date", None) else iso_now(),
    }


async def get_bound_entity() -> Any:
    if not bound_chat_id:
        raise RuntimeError("TELEGRAM_USER_GROUP_NOT_BOUND")
    await ensure_connected(15.0)
    try:
        return await client.get_entity(int(bound_chat_id))
    except ValueError:
        return await client.get_entity(bound_chat_id)


async def install_listener(entity: Any) -> None:
    global listener_handler
    if listener_handler is not None:
        client.remove_event_handler(listener_handler)

    async def on_new_message(event: Any) -> None:
        metadata = document_metadata(event.message)
        if metadata is None:
            return
        with listener_lock:
            listener_messages[int(metadata["messageId"])] = metadata
            if len(listener_messages) > 2000:
                for key in sorted(listener_messages)[:-1000]:
                    listener_messages.pop(key, None)

    listener_handler = on_new_message
    client.add_event_handler(listener_handler, events.NewMessage(chats=entity))


async def resolve_group(title: str) -> dict[str, str]:
    global bound_chat_id, bound_chat_title
    await ensure_connected(15.0)
    normalized = title.strip()
    if not normalized:
        raise RuntimeError("TELEGRAM_GROUP_TITLE_REQUIRED")

    matches: list[Any] = []
    async for dialog in client.iter_dialogs():
        if (dialog.name or "").strip() == normalized:
            matches.append(dialog)
    if not matches:
        raise RuntimeError("TELEGRAM_GROUP_NOT_FOUND")
    if len(matches) > 1:
        raise RuntimeError("TELEGRAM_GROUP_TITLE_AMBIGUOUS")

    dialog = matches[0]
    entity = dialog.entity
    peer_id = str(utils.get_peer_id(entity))
    if not peer_id:
        raise RuntimeError("TELEGRAM_GROUP_ID_INVALID")

    # Validate the authenticated user can at least resolve membership. Actual send
    # permission is also enforced by Telegram on upload; no test message is sent here.
    try:
        await client.get_permissions(entity, "me")
    except Exception as exc:
        raise RuntimeError(f"TELEGRAM_GROUP_PERMISSION_CHECK_FAILED:{type(exc).__name__}") from exc

    bound_chat_id = peer_id
    bound_chat_title = dialog.name or normalized
    await install_listener(entity)
    return {"chatId": bound_chat_id, "chatTitle": bound_chat_title}


def bridge_error_code(exc: Exception) -> str:
    name = type(exc).__name__
    mapped = {
        "PhoneCodeInvalidError": "TELEGRAM_CODE_INVALID",
        "PhoneCodeEmptyError": "TELEGRAM_CODE_INVALID",
        "PhoneCodeExpiredError": "TELEGRAM_CODE_EXPIRED",
        "PhoneNumberInvalidError": "TELEGRAM_PHONE_INVALID",
        "PhoneNumberBannedError": "TELEGRAM_PHONE_BANNED",
        "PasswordHashInvalidError": "TELEGRAM_2FA_INVALID",
        "AuthKeyUnregisteredError": "TELEGRAM_AUTHORIZATION_LOST",
        "SessionRevokedError": "TELEGRAM_AUTHORIZATION_LOST",
        "SessionExpiredError": "TELEGRAM_AUTHORIZATION_LOST",
        "UserDeactivatedError": "TELEGRAM_AUTHORIZATION_LOST",
        "FloodWaitError": "TELEGRAM_RATE_LIMITED",
    }
    if name in mapped:
        return mapped[name]
    text = str(exc).strip()
    if text.startswith("TELEGRAM_") or text.startswith("BRIDGE_"):
        return text.split(":", 1)[0]
    return name or "TELEGRAM_BRIDGE_ERROR"


def set_auth_cache(authorized: bool, error_code: str | None = None, error_message: str | None = None) -> None:
    global cached_authorized, auth_probe_error_code, auth_probe_error_message
    with auth_state_lock:
        cached_authorized = authorized
        auth_probe_error_code = error_code
        auth_probe_error_message = error_message


def health_snapshot() -> dict[str, Any]:
    with auth_state_lock:
        return {
            "authorized": cached_authorized,
            "chatId": bound_chat_id,
            "chatTitle": bound_chat_title,
            "probeErrorCode": auth_probe_error_code,
            "probeErrorMessage": auth_probe_error_message,
        }


async def ensure_connected(timeout: float = 8.0) -> None:
    if client.is_connected():
        return
    await asyncio.wait_for(client.connect(), timeout=timeout)


async def reset_revoked_authorization() -> None:
    global pending_phone
    pending_phone = None
    try:
        await asyncio.wait_for(client.disconnect(), timeout=3.0)
    except Exception:
        pass
    try:
        client.session.set_auth_key(None)
        client.session.save()
    except Exception as exc:
        raise RuntimeError(f"TELEGRAM_SESSION_RESET_FAILED:{type(exc).__name__}") from exc
    set_auth_cache(False, "TELEGRAM_AUTHORIZATION_LOST", "Telegram authorization was revoked or expired.")


async def authorization_watch_loop() -> None:
    while True:
        try:
            if getattr(client.session, "auth_key", None) is None:
                set_auth_cache(False)
            else:
                await ensure_connected(5.0)
                try:
                    me = await asyncio.wait_for(client.get_me(), timeout=5.0)
                    authorized = me is not None
                    set_auth_cache(authorized)
                    if authorized and bound_chat_id and listener_handler is None:
                        try:
                            entity = await asyncio.wait_for(get_bound_entity(), timeout=5.0)
                            await install_listener(entity)
                        except Exception:
                            pass
                except asyncio.TimeoutError:
                    with auth_state_lock:
                        existing = cached_authorized
                    set_auth_cache(existing, "TELEGRAM_AUTH_CHECK_TIMEOUT", "Telegram authorization check timed out; will retry.")
                except Exception as exc:
                    code = bridge_error_code(exc)
                    if code == "TELEGRAM_AUTHORIZATION_LOST":
                        await reset_revoked_authorization()
                    else:
                        with auth_state_lock:
                            existing = cached_authorized
                        set_auth_cache(existing, code, str(exc)[:500] or code)
        except Exception as exc:
            with auth_state_lock:
                existing = cached_authorized
            set_auth_cache(existing, bridge_error_code(exc), str(exc)[:500] or type(exc).__name__)
        await asyncio.sleep(8.0)


async def auth_start(phone: str) -> dict[str, Any]:
    global pending_phone
    normalized = phone.strip()
    if not normalized:
        raise RuntimeError("TELEGRAM_PHONE_REQUIRED")
    with auth_state_lock:
        locally_authorized = cached_authorized
    if not locally_authorized and getattr(client.session, "auth_key", None) is not None:
        await reset_revoked_authorization()
    await ensure_connected(8.0)
    await asyncio.wait_for(client.send_code_request(normalized), timeout=30.0)
    pending_phone = normalized
    return {"state": "code_sent"}


async def auth_code(code: str) -> dict[str, Any]:
    global pending_phone
    if not pending_phone:
        raise RuntimeError("TELEGRAM_CODE_SESSION_MISSING")
    await ensure_connected(15.0)
    try:
        await client.sign_in(phone=pending_phone, code=code.strip())
        pending_phone = None
        set_auth_cache(True)
        return {"state": "authorized"}
    except SessionPasswordNeededError:
        return {"state": "password_required"}


async def auth_password(password: str) -> dict[str, Any]:
    await ensure_connected(15.0)
    await client.sign_in(password=password)
    set_auth_cache(True)
    return {"state": "authorized"}


def export_session() -> dict[str, str]:
    value = StringSession.save(client.session)
    if not isinstance(value, str) or not value:
        raise RuntimeError("TELEGRAM_SESSION_EXPORT_FAILED")
    return {"session": value}


async def upload(path: str, chat_id: str, expected_sha256: str, operation_id: str) -> dict[str, Any]:
    local = Path(path)
    if not local.is_file():
        raise RuntimeError("LOCAL_FILE_MISSING")
    entity = await get_bound_entity()
    if str(utils.get_peer_id(entity)) != str(chat_id):
        raise RuntimeError("TELEGRAM_GROUP_ID_MISMATCH")
    size = int(local.stat().st_size)
    started_at = time.monotonic()
    update_transfer_progress(operation_id, "upload", local.name, "verifying", 0, size, started_at)
    actual_hash = sha256_file(
        str(local),
        lambda current, total: update_transfer_progress(operation_id, "upload", local.name, "verifying", current, total, started_at),
    )
    if expected_sha256 and actual_hash.lower() != expected_sha256.lower():
        raise RuntimeError("UPLOAD_HASH_MISMATCH")

    transfer_started_at = time.monotonic()
    update_transfer_progress(operation_id, "upload", local.name, "transferring", 0, size, transfer_started_at)
    message = await client.send_file(
        entity,
        str(local),
        force_document=True,
        caption=f"ExcelSync sha256={actual_hash[:16]}",
        progress_callback=lambda current, total: update_transfer_progress(
            operation_id, "upload", local.name, "transferring", int(current), int(total or size), transfer_started_at
        ),
    )
    update_transfer_progress(operation_id, "upload", local.name, "finalizing", size, size, transfer_started_at)
    metadata = document_metadata(message)
    if metadata is None:
        raise RuntimeError("TELEGRAM_UPLOAD_DOCUMENT_MISSING")
    return {
        "backend": "telegram_user_group",
        "chatId": str(chat_id),
        "messageId": int(message.id),
        "fileName": local.name,
        "size": size,
        "sha256": actual_hash,
        "mimeType": metadata["mimeType"],
        "createdAt": iso_now(),
    }


async def download(chat_id: str, message_id: int, destination: str, operation_id: str) -> dict[str, Any]:
    entity = await get_bound_entity()
    if str(utils.get_peer_id(entity)) != str(chat_id):
        raise RuntimeError("TELEGRAM_GROUP_ID_MISMATCH")
    message = await client.get_messages(entity, ids=int(message_id))
    if not message or not getattr(message, "document", None):
        raise RuntimeError("TELEGRAM_MESSAGE_DOCUMENT_NOT_FOUND")
    destination_path = Path(destination)
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    file_name = getattr(getattr(message, "file", None), "name", None) or destination_path.name
    expected_size = int(getattr(getattr(message, "file", None), "size", 0) or 0)
    transfer_started_at = time.monotonic()
    update_transfer_progress(operation_id, "download", str(file_name), "transferring", 0, expected_size, transfer_started_at)
    result = await message.download_media(
        file=str(destination_path),
        progress_callback=lambda current, total: update_transfer_progress(
            operation_id, "download", str(file_name), "transferring", int(current), int(total or expected_size), transfer_started_at
        ),
    )
    if not result or not destination_path.is_file():
        raise RuntimeError("TELEGRAM_DOWNLOAD_FAILED")
    size = int(destination_path.stat().st_size)
    verify_started_at = time.monotonic()
    update_transfer_progress(operation_id, "download", str(file_name), "verifying", 0, size, verify_started_at)
    actual_hash = sha256_file(
        str(destination_path),
        lambda current, total: update_transfer_progress(operation_id, "download", str(file_name), "verifying", current, total, verify_started_at),
    )
    update_transfer_progress(operation_id, "download", str(file_name), "finalizing", size, size, verify_started_at)
    return {
        "path": str(destination_path),
        "size": size,
        "sha256": actual_hash,
    }


async def imports(chat_id: str, after_message_id: int) -> dict[str, Any]:
    entity = await get_bound_entity()
    if str(utils.get_peer_id(entity)) != str(chat_id):
        raise RuntimeError("TELEGRAM_GROUP_ID_MISMATCH")
    after = max(0, int(after_message_id))
    merged: dict[int, dict[str, Any]] = {}

    with listener_lock:
        for message_id, metadata in listener_messages.items():
            if message_id > after:
                merged[message_id] = dict(metadata)

    async for message in client.iter_messages(entity, min_id=after, reverse=True, limit=500):
        metadata = document_metadata(message)
        if metadata is not None:
            merged[int(message.id)] = metadata

    return {"messages": [merged[key] for key in sorted(merged)]}


def run_loop() -> None:
    asyncio.set_event_loop(loop)
    loop.create_task(authorization_watch_loop())
    loop.run_forever()


loop_thread = threading.Thread(target=run_loop, name="ExcelSyncTelegramLoop", daemon=True)
loop_thread.start()


def run_coro(coro: Any, timeout: float = 300.0) -> Any:
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    return future.result(timeout=timeout)


class Handler(BaseHTTPRequestHandler):
    server_version = "ExcelSyncTelegramBridge/1.0"

    def log_message(self, _format: str, *args: Any) -> None:
        return

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        return self.headers.get("x-excelsync-bridge-secret", "") == SECRET

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0") or "0")
        if length <= 0:
            return {}
        if length > 1024 * 1024:
            raise RuntimeError("BRIDGE_REQUEST_TOO_LARGE")
        raw = self.rfile.read(length)
        parsed = json.loads(raw.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise RuntimeError("BRIDGE_JSON_OBJECT_REQUIRED")
        return parsed

    def _dispatch(self, method: str) -> None:
        if not self._authorized():
            self._send(403, {"ok": False, "error": {"code": "BRIDGE_FORBIDDEN", "message": "BRIDGE_FORBIDDEN"}})
            return
        try:
            body = self._body() if method == "POST" else {}
            parsed_url = urlparse(self.path)
            path = parsed_url.path
            query = parse_qs(parsed_url.query)
            if method == "GET" and path == "/health":
                result = health_snapshot()
            elif method == "GET" and path == "/progress":
                result = transfer_progress_snapshot(str((query.get("id") or [""])[0]))
            elif method == "POST" and path == "/auth/start":
                result = run_coro(auth_start(str(body.get("phone", ""))), 60)
            elif method == "POST" and path == "/auth/code":
                result = run_coro(auth_code(str(body.get("code", ""))), 60)
            elif method == "POST" and path == "/auth/password":
                result = run_coro(auth_password(str(body.get("password", ""))), 60)
            elif method == "POST" and path == "/group/resolve":
                result = run_coro(resolve_group(str(body.get("title", "ai"))), 60)
            elif method == "GET" and path == "/session/export":
                result = export_session()
            elif method == "POST" and path == "/upload":
                result = run_coro(upload(
                    str(body.get("path", "")),
                    str(body.get("chatId", "")),
                    str(body.get("expectedSha256", "")),
                    str(body.get("operationId", "")),
                ), 7200)
            elif method == "POST" and path == "/download":
                result = run_coro(download(
                    str(body.get("chatId", "")),
                    int(body.get("messageId", 0)),
                    str(body.get("destination", "")),
                    str(body.get("operationId", "")),
                ), 7200)
            elif method == "POST" and path == "/imports":
                result = run_coro(imports(str(body.get("chatId", "")), int(body.get("afterMessageId", 0))), 180)
            elif method == "POST" and path == "/shutdown":
                result = {"stopping": True}
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            else:
                self._send(404, {"ok": False, "error": {"code": "BRIDGE_ROUTE_NOT_FOUND", "message": "BRIDGE_ROUTE_NOT_FOUND"}})
                return
            self._send(200, {"ok": True, "result": result})
        except Exception as exc:
            code = bridge_error_code(exc)
            self._send(409, {"ok": False, "error": {"code": code, "message": str(exc)[:1000] or code}})

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(f"READY {server.server_address[1]}", flush=True)
try:
    server.serve_forever(poll_interval=0.2)
finally:
    try:
        run_coro(client.disconnect(), 10)
    except Exception:
        pass
    loop.call_soon_threadsafe(loop.stop)
    loop_thread.join(timeout=5)
    server.server_close()
