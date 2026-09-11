#!/usr/bin/env python3
"""
Cursor Remote — Telegram MTProto bridge (Telethon).

Uses the same DC path as telegcli, so it works when api.telegram.org (Bot HTTP API)
is blocked by corporate proxies.

Protocol (stdin/stdout, one JSON object per line):
  out: {"type":"ready","username":"...","id":123}
  out: {"type":"message","chat_id":1,"user_id":2,"text":"..."}
  out: {"type":"error","error":"..."}
  out: {"type":"log","message":"..."}
  in:  {"type":"send","chat_id":1,"text":"..."}
  in:  {"type":"stop"}
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_secrets(path: str) -> dict:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    token = str(data.get("botToken") or "").strip()
    api_id = data.get("apiId") or data.get("api_id")
    api_hash = str(data.get("apiHash") or data.get("api_hash") or "").strip()
    if not token or "PASTE_BOT_TOKEN" in token:
        raise SystemExit("botToken missing")
    if not api_id or not api_hash or "PASTE" in api_hash:
        raise SystemExit(
            "apiId/apiHash missing — get them at https://my.telegram.org "
            "(same credentials telegcli uses) and add to telegram.json"
        )
    return {
        "botToken": token,
        "apiId": int(api_id),
        "apiHash": api_hash,
        "allowedUserIds": [
            int(x)
            for x in (data.get("allowedUserIds") or [])
            if str(x).strip().lstrip("-").isdigit()
        ],
    }


async def stdin_loop(client, queue: asyncio.Queue) -> None:
    loop = asyncio.get_event_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            await queue.put({"type": "stop"})
            return
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            emit({"type": "error", "error": f"bad stdin json: {line[:80]}"})
            continue
        await queue.put(msg)


async def main() -> None:
    if len(sys.argv) < 2:
        emit({"type": "error", "error": "usage: telegram-mtproto-bridge.py <secrets.json>"})
        raise SystemExit(2)

    secrets_path = sys.argv[1]
    try:
        secrets = load_secrets(secrets_path)
    except SystemExit as e:
        emit({"type": "error", "error": str(e)})
        raise

    try:
        from telethon import TelegramClient, events
    except ImportError:
        emit(
            {
                "type": "error",
                "error": "telethon not installed in this Python. Extension should pip-install it into the venv.",
            }
        )
        raise SystemExit(1)

    session_dir = Path.home() / ".config" / "cursor-remote"
    session_dir.mkdir(parents=True, exist_ok=True)
    session_path = str(session_dir / "telegram-bot")

    client = TelegramClient(
        session_path,
        secrets["apiId"],
        secrets["apiHash"],
    )

    allowed = set(secrets["allowedUserIds"])

    @client.on(events.NewMessage(incoming=True))
    async def on_message(event):  # type: ignore[no-untyped-def]
        try:
            if not event.message or event.message.out:
                return
            text = (event.raw_text or "").strip()
            if not text:
                return
            sender = await event.get_sender()
            user_id = int(getattr(sender, "id", 0) or 0)
            chat_id = int(event.chat_id)
            # Always forward; extension enforces allowlist (also needed for /whoami bootstrap)
            emit(
                {
                    "type": "message",
                    "chat_id": chat_id,
                    "user_id": user_id,
                    "text": text,
                    "allowed_hint": (not allowed) or (user_id in allowed),
                }
            )
        except Exception as e:  # noqa: BLE001
            emit({"type": "error", "error": f"handler: {e}"})

    emit({"type": "log", "message": "Connecting via MTProto (Telethon)…"})
    await client.start(bot_token=secrets["botToken"])
    me = await client.get_me()
    emit(
        {
            "type": "ready",
            "username": getattr(me, "username", None),
            "id": int(getattr(me, "id", 0) or 0),
        }
    )

    queue: asyncio.Queue = asyncio.Queue()
    stdin_task = asyncio.create_task(stdin_loop(client, queue))

    try:
        while True:
            msg = await queue.get()
            mtype = msg.get("type")
            if mtype == "stop":
                break
            if mtype == "send":
                chat_id = msg.get("chat_id")
                text = msg.get("text") or ""
                if chat_id is None or not text:
                    continue
                # Telegram hard limit ~4096
                chunk = text
                while chunk:
                    part, chunk = chunk[:3900], chunk[3900:]
                    await client.send_message(int(chat_id), part)
            else:
                emit({"type": "log", "message": f"ignored stdin type={mtype}"})
    finally:
        stdin_task.cancel()
        await client.disconnect()
        emit({"type": "log", "message": "MTProto bridge stopped"})


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "error": str(e)})
        raise SystemExit(1)
