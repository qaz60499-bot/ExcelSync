from __future__ import annotations

import asyncio
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from telegram_storage_bridge_support import find_authorized_dialog_entity, immutable_upload_snapshot


class FakeClient:
    def __init__(self, entities: list[object]) -> None:
        self.entities = entities

    async def iter_dialogs(self, limit: int | None = None):
        assert limit is None
        for entity in self.entities:
            yield SimpleNamespace(entity=entity)


class TelegramStorageBridgeSupportTests(unittest.TestCase):
    def test_upload_uses_hashed_snapshot_when_original_changes_and_cleans_it_up(self) -> None:
        original = b"snapshot bytes received by Telethon"
        expected_hash = hashlib.sha256(original).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "book.xlsx"
            source.write_bytes(original)
            snapshot_path: Path | None = None

            async def fake_telethon_upload(path: Path) -> bytes:
                await asyncio.sleep(0.01)
                return path.read_bytes()

            with immutable_upload_snapshot(source, expected_hash) as snapshot:
                snapshot_path = snapshot.path
                source.write_bytes(b"original path changed during transfer")
                uploaded = asyncio.run(fake_telethon_upload(snapshot.path))
                self.assertEqual(uploaded, original)
                self.assertEqual(snapshot.sha256, expected_hash)
                self.assertEqual(snapshot.size, len(original))

            self.assertIsNotNone(snapshot_path)
            self.assertFalse(snapshot_path.exists())

    def test_mismatched_snapshot_is_rejected_before_upload_and_cleaned(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "book.xlsx"
            source.write_bytes(b"actual bytes")
            with self.assertRaisesRegex(RuntimeError, "UPLOAD_HASH_MISMATCH"):
                with immutable_upload_snapshot(source, hashlib.sha256(b"expected bytes").hexdigest()):
                    self.fail("a mismatched snapshot must never reach the uploader")

    def test_historical_download_locator_resolves_only_an_authorized_dialog_without_rebinding(self) -> None:
        current = SimpleNamespace(chat_id=-10011)
        historical = SimpleNamespace(chat_id=-10022)
        client = FakeClient([current, historical])
        bound_chat_id = "-10011"

        resolved = asyncio.run(find_authorized_dialog_entity(client, "-10022", lambda entity: entity.chat_id))

        self.assertIs(resolved, historical)
        self.assertEqual(bound_chat_id, "-10011")
        with self.assertRaisesRegex(RuntimeError, "TELEGRAM_CHAT_NOT_AUTHORIZED"):
            asyncio.run(find_authorized_dialog_entity(client, "-10099", lambda entity: entity.chat_id))


if __name__ == "__main__":
    unittest.main()
