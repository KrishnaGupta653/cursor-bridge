#!/usr/bin/env bash
# Serve Cursor Remote Flutter web UI on http://0.0.0.0:8080 (Chrome / LAN).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/mobile-app/build/web"
PORT="${1:-8080}"

if [[ ! -f "$WEB/index.html" ]]; then
  echo "Web build missing. Building once…"
  cd "$ROOT/mobile-app"
  flutter build web --release
fi

cd "$WEB"
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)"
echo "Serving Cursor Remote web UI"
echo "  Local:   http://127.0.0.1:${PORT}"
echo "  LAN:     http://${IP}:${PORT}"
echo "In the app: Local → host ${IP} → port 8766 (or 8767)"
echo "Ctrl+C to stop."
exec python3 -m http.server "$PORT" --bind 0.0.0.0
