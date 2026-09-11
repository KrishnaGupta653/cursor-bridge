#!/usr/bin/env bash
# Start a Cloudflare quick tunnel to the Cursor Remote local WebSocket server.
# Usage:
#   ./scripts/start-cloudflare-tunnel.sh [port]
# Default port: 8766
#
# Prints the wss:// URL, copies it to the clipboard when possible, and writes
# it to /tmp/cursor-remote-tunnel-url.txt. Ctrl+C stops the tunnel.

set -euo pipefail

PORT="${1:-8766}"
URL_FILE="${CURSOR_REMOTE_TUNNEL_URL_FILE:-/tmp/cursor-remote-tunnel-url.txt}"
LOG_FILE="${CURSOR_REMOTE_TUNNEL_LOG:-/tmp/cursor-remote-tunnel.log}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "error: cloudflared not found. Install with: brew install cloudflared" >&2
  exit 1
fi

# Quick check that something is listening (best-effort)
if command -v nc >/dev/null 2>&1; then
  if ! nc -z -G 1 127.0.0.1 "$PORT" 2>/dev/null; then
    echo "warning: nothing listening on 127.0.0.1:${PORT}" >&2
    echo "         Start Cursor with the Cursor Remote extension first." >&2
  fi
fi

rm -f "$URL_FILE"
: >"$LOG_FILE"

echo "Starting Cloudflare Tunnel → http://127.0.0.1:${PORT} (protocol=http2)"
echo "Log: $LOG_FILE"
echo "Waiting for public URL…"

# http2 avoids QUIC timeouts common behind corporate proxies (Zscaler)
cloudflared tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate --protocol http2 2>&1 | tee "$LOG_FILE" | while IFS= read -r line; do
  echo "$line"
  if echo "$line" | grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' >/dev/null 2>&1; then
    HTTPS=$(echo "$line" | grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' | tail -1)
    WSS="${HTTPS/https:/wss:}"
    if [[ ! -f "$URL_FILE" ]]; then
      echo "$WSS" >"$URL_FILE"
      echo
      echo "============================================"
      echo "  Tunnel ready"
      echo "  Phone Local host: $WSS"
      echo "  (saved to $URL_FILE)"
      echo "============================================"
      echo
      if command -v pbcopy >/dev/null 2>&1; then
        printf '%s' "$WSS" | pbcopy
        echo "Copied wss URL to clipboard."
      elif command -v wl-copy >/dev/null 2>&1; then
        printf '%s' "$WSS" | wl-copy
        echo "Copied wss URL to clipboard."
      elif command -v xclip >/dev/null 2>&1; then
        printf '%s' "$WSS" | xclip -selection clipboard
        echo "Copied wss URL to clipboard."
      fi
      echo "In the mobile app: Connection → Tunnel → paste URL → Connect"
      echo "Keep this terminal open. Ctrl+C to stop."
    fi
  fi
done
