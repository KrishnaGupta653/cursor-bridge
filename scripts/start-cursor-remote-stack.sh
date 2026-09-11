#!/usr/bin/env bash
# Start the full Cursor Remote stack for Chrome + Telegram (every time).
#
# What this does:
#   1. Restarts Cursor with CDP (--remote-debugging-port=9222)
#   2. Builds Flutter web if needed, serves it on :8080
#   3. Prints Local WS port + Chrome URL
#   4. Telegram bot auto-starts from the extension when secrets are valid
#
# Usage:
#   ./scripts/start-cursor-remote-stack.sh
#   ./scripts/start-cursor-remote-stack.sh --no-rebuild
#   ./scripts/start-cursor-remote-stack.sh --no-quit   # don't quit Cursor first

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE="$ROOT/mobile-app"
WEB_DIR="$MOBILE/build/web"
CURSOR_BIN="${CURSOR_BIN:-/Applications/Cursor.app/Contents/MacOS/Cursor}"
WEB_PORT="${WEB_PORT:-8080}"
CDP_PORT="${CDP_PORT:-9222}"
WS_PORT_DEFAULT=8766

NO_REBUILD=0
NO_QUIT=0
for arg in "$@"; do
  case "$arg" in
    --no-rebuild) NO_REBUILD=1 ;;
    --no-quit) NO_QUIT=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
  esac
done

log() { printf '[cursor-remote] %s\n' "$*"; }
die() { printf '[cursor-remote] ERROR: %s\n' "$*" >&2; exit 1; }

# --- IP for Chrome / phone ---
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [[ -z "${LAN_IP}" ]]; then
  LAN_IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi
if [[ -z "${LAN_IP}" ]]; then
  LAN_IP="$(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" {print $2; exit}')"
fi
LAN_IP="${LAN_IP:-127.0.0.1}"

# --- 1) Cursor + CDP ---
[[ -x "$CURSOR_BIN" ]] || die "Cursor not found at $CURSOR_BIN"

if [[ "$NO_QUIT" -eq 0 ]]; then
  log "Quitting Cursor..."
  osascript -e 'quit app "Cursor"' >/dev/null 2>&1 || true
  # wait until old process is gone (max ~15s)
  for _ in $(seq 1 30); do
    if ! pgrep -xq Cursor; then
      break
    fi
    sleep 0.5
  done
  sleep 1
fi

log "Starting Cursor with CDP on :${CDP_PORT}..."
# Prefer direct binary launch (reliable for --remote-debugging-port)
nohup "$CURSOR_BIN" --remote-debugging-port="$CDP_PORT" \
  >/tmp/cursor-remote-cursor.log 2>&1 &
disown || true
sleep 2

# --- 2) Flutter web build ---
if [[ "$NO_REBUILD" -eq 0 ]] || [[ ! -f "$WEB_DIR/index.html" ]]; then
  command -v flutter >/dev/null 2>&1 || die "flutter not found in PATH"
  log "Building Flutter web (release)..."
  (
    cd "$MOBILE"
    flutter build web --release
  )
else
  log "Using existing web build (--no-rebuild)"
fi

[[ -f "$WEB_DIR/index.html" ]] || die "Missing $WEB_DIR/index.html — build failed"

# --- 3) Free / start :8080 ---
if lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  log "Port ${WEB_PORT} busy — stopping old listener..."
  PIDS="$(lsof -nP -tiTCP:"$WEB_PORT" -sTCP:LISTEN || true)"
  if [[ -n "${PIDS}" ]]; then
    # shellcheck disable=SC2086
    kill $PIDS >/dev/null 2>&1 || true
    sleep 1
  fi
fi

log "Serving Chrome app at http://${LAN_IP}:${WEB_PORT} ..."
cd "$WEB_DIR"
# background PID file so we can find it later
PID_FILE="${TMPDIR:-/tmp}/cursor-remote-web-${WEB_PORT}.pid"
python3 -m http.server "$WEB_PORT" --bind 0.0.0.0 >/tmp/cursor-remote-web-8080.log 2>&1 &
echo $! >"$PID_FILE"

# --- 4) Wait for WS port ---
WS_PORT=""
for _ in $(seq 1 40); do
  if lsof -nP -iTCP:"$WS_PORT_DEFAULT" -sTCP:LISTEN >/dev/null 2>&1; then
    WS_PORT="$WS_PORT_DEFAULT"
    break
  fi
  if lsof -nP -iTCP:8767 -sTCP:LISTEN >/dev/null 2>&1; then
    WS_PORT=8767
    break
  fi
  sleep 0.5
done
WS_PORT="${WS_PORT:-$WS_PORT_DEFAULT}"

# --- Summary ---
cat <<EOF

========================================
 Cursor Remote — ready
========================================
 Chrome UI:   http://${LAN_IP}:${WEB_PORT}
              http://127.0.0.1:${WEB_PORT}

 In the app (Local connect):
   Host: ${LAN_IP}
   Port: ${WS_PORT}

 CDP:         127.0.0.1:${CDP_PORT}
 Telegram:    auto-starts if ~/.config/cursor-remote/telegram.json is valid
              Cmd+Shift+P → "Cursor Remote: Start Telegram Bot"
              then message your bot → /help

 Web server log: /tmp/cursor-remote-web-8080.log
 Stop web only:  kill \$(cat ${PID_FILE})
========================================

EOF

# Keep script attached to web server so Ctrl+C stops it (Cursor stays running)
log "Web server running in foreground (Ctrl+C stops Chrome UI only)."
wait "$(cat "$PID_FILE")"
