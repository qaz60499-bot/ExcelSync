from __future__ import annotations

import hashlib
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator


@dataclass(frozen=True)
class UploadSnapshot:
    path: Path
    sha256: str
    size: int


@contextmanager
def immutable_upload_snapshot(
    source_path: str | Path,
    expected_sha256: str,
    progress_callback: Callable[[int, int], None] | None = None,
) -> Iterator[UploadSnapshot]:
    source = Path(source_path)
    if not source.is_file():
        raise RuntimeError("LOCAL_FILE_MISSING")
    if len(expected_sha256) != 64 or any(character not in "0123456789abcdefABCDEF" for character in expected_sha256):
        raise RuntimeError("UPLOAD_HASH_REQUIRED")

    total = int(source.stat().st_size)
    digest = hashlib.sha256()
    processed = 0
    with tempfile.TemporaryDirectory(prefix="excelsync-telegram-upload-") as directory:
        snapshot_path = Path(directory) / source.name
        with source.open("rb") as source_file, snapshot_path.open("xb") as snapshot_file:
            for block in iter(lambda: source_file.read(1024 * 1024), b""):
                written = snapshot_file.write(block)
                if written != len(block):
                    raise OSError("UPLOAD_SNAPSHOT_WRITE_INCOMPLETE")
                digest.update(block)
                processed += len(block)
                if progress_callback is not None:
                    progress_callback(processed, total)

        actual_sha256 = digest.hexdigest()
        if actual_sha256.lower() != expected_sha256.lower():
            raise RuntimeError("UPLOAD_HASH_MISMATCH")

        yield UploadSnapshot(path=snapshot_path, sha256=actual_sha256, size=processed)


async def find_authorized_dialog_entity(client: object, chat_id: str, get_peer_id: Callable[[object], int]) -> object:
    try:
        requested_id = str(int(chat_id))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("TELEGRAM_CHAT_ID_INVALID") from exc
    if requested_id == "0":
        raise RuntimeError("TELEGRAM_CHAT_ID_INVALID")

    async for dialog in client.iter_dialogs(limit=None):  # type: ignore[attr-defined]
        entity = dialog.entity
        if str(get_peer_id(entity)) == requested_id:
            return entity
    raise RuntimeError("TELEGRAM_CHAT_NOT_AUTHORIZED")
