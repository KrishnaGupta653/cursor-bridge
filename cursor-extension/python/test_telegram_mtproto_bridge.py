"""Unit tests for the MTProto bridge's stdin commands, with a fake Telethon client (no network)."""

import asyncio
import contextlib
import importlib.util
import io
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "bridge", Path(__file__).with_name("telegram-mtproto-bridge.py")
)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class FakeMessage:
    def __init__(self, id):
        self.id = id


class FakeClient:
    def __init__(self, fail_send=False, fail_delete=False):
        self.sent = []
        self.deleted = []
        self.fail_send = fail_send
        self.fail_delete = fail_delete

    async def send_message(self, chat_id, text, **kwargs):
        if self.fail_send:
            raise RuntimeError("boom")
        self.sent.append((chat_id, text, kwargs))
        return FakeMessage(100 + len(self.sent))

    async def delete_messages(self, chat_id, ids):
        if self.fail_delete:
            raise PermissionError("nope")
        self.deleted.append((chat_id, ids))


def run(client, msg):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        keep = asyncio.run(bridge.handle_command(client, msg))
    return keep, [json.loads(line) for line in out.getvalue().splitlines()]


class HandleCommandTest(unittest.TestCase):
    def test_plain_send_is_unchanged_and_silent(self):
        client = FakeClient()
        keep, out = run(client, {"type": "send", "chat_id": 1, "text": "hi"})
        self.assertTrue(keep)
        self.assertEqual(client.sent, [(1, "hi", {})])
        self.assertEqual(out, [])

    def test_send_with_ref_reports_message_id_and_html(self):
        client = FakeClient()
        _, out = run(client, {"type": "send", "chat_id": 1, "text": "<code>SECRET</code>", "ref": "r1", "html": True})
        self.assertEqual(client.sent, [(1, "<code>SECRET</code>", {"parse_mode": "html"})])
        self.assertEqual(out, [{"type": "sent", "ref": "r1", "message_id": 101}])

    def test_failed_send_with_ref_reports_null_and_never_the_text(self):
        _, out = run(FakeClient(fail_send=True), {"type": "send", "chat_id": 1, "text": "SECRET", "ref": "r2"})
        self.assertEqual(out[-1], {"type": "sent", "ref": "r2", "message_id": None})
        self.assertNotIn("SECRET", json.dumps(out))

    def test_delete_calls_telethon_and_logs_only_failures(self):
        client = FakeClient()
        _, out = run(client, {"type": "delete", "chat_id": 1, "message_id": 7})
        self.assertEqual(client.deleted, [(1, [7])])
        self.assertEqual(out, [])
        _, out = run(FakeClient(fail_delete=True), {"type": "delete", "chat_id": 1, "message_id": 7})
        self.assertEqual(out, [{"type": "log", "message": "delete failed: PermissionError"}])

    def test_stop_ends_the_loop(self):
        keep, _ = run(FakeClient(), {"type": "stop"})
        self.assertFalse(keep)


if __name__ == "__main__":
    unittest.main()
