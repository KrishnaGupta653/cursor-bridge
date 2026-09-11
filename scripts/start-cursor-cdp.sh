#!/usr/bin/env bash
# Restart Cursor with CDP (remote debugging) so Chrome UI + Telegram can use IDE Agent sessions.
set -euo pipefail

echo "Quitting Cursor…"
osascript -e 'quit app "Cursor"' >/dev/null 2>&1 || true
sleep 3

CURSOR_BIN="/Applications/Cursor.app/Contents/MacOS/Cursor"
if [[ ! -x "$CURSOR_BIN" ]]; then
  echo "Cursor not found at $CURSOR_BIN"
  exit 1
fi

echo "Starting Cursor with --remote-debugging-port=9222…"
exec "$CURSOR_BIN" --remote-debugging-port=9222
