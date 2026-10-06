#!/usr/bin/env bash
# Start the full Cursor Remote stack for Chrome + Telegram (every time).
#
# What this does:
#   1. Quits Cursor, preserves occupied WS ports (8766–8770)
#   2. Restarts Cursor with CDP (--remote-debugging-port=9222)
#   3. Builds Flutter web if needed, serves it on :8080
#   4. Probes WebSocket handshake and prints the working Local port
#   5. Telegram bot auto-starts from the extension when secrets are valid
#
# Usage:
#   ./scripts/start-cursor-remote-stack.sh
#   ./scripts/start-cursor-remote-stack.sh --no-rebuild
#   ./scripts/start-cursor-remote-stack.sh --no-quit   # don't quit Cursor first
#   ./scripts/start-cursor-remote-stack.sh --no-cleanup  # skip WS port cleanup

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE="$ROOT/mobile-app"
WEB_DIR="$MOBILE/build/web"
CURSOR_BIN="${CURSOR_BIN:-/Applications/Cursor.app/Contents/MacOS/Cursor}"
WEB_PORT="${WEB_PORT:-8080}"
CDP_PORT="${CDP_PORT:-9222}"
WS_PORT_DEFAULT=8766
WS_PORT_MAX=8770

NO_REBUILD=0
NO_QUIT=0
NO_CLEANUP=0
for arg in "$@"; do
  case "$arg" in
    --no-rebuild) NO_REBUILD=1 ;;
    --no-quit) NO_QUIT=1 ;;
    --no-cleanup) NO_CLEANUP=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
  esac
done

log() { printf '[cursor-remote] %s\n' "$*"; }
die() { printf '[cursor-remote] ERROR: %s\n' "$*" >&2; exit 1; }

# A listening port is not proof that this script owns the process.
# The extension chooses another available WS port; unknown listeners stay alive.
cleanup_ws_ports() {
  local p
  for p in $(seq "$WS_PORT_DEFAULT" "$WS_PORT_MAX"); do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      log "Port $p already occupied; preserving existing listener."
    fi
  done
}

# Returns 0 if WebSocket handshake to ws://127.0.0.1:$1 succeeds quickly.
ws_handshake_ok() {
  local port="$1"
  local ws_js="$ROOT/cursor-extension/node_modules/ws"
  if [[ ! -d "$ws_js" ]]; then
    # Fallback: TCP listen only (weaker)
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  (
    cd "$ROOT/cursor-extension"
    node -e "
const WebSocket = require('ws');
const port = process.argv[1];
const ws = new WebSocket('ws://127.0.0.1:' + port);
const t = setTimeout(() => { try { ws.terminate(); } catch {} process.exit(2); }, 2500);
ws.on('open', () => {});
ws.on('message', () => { clearTimeout(t); try { ws.close(); } catch {}; process.exit(0); });
ws.on('error', () => { clearTimeout(t); process.exit(3); });
" "$port"
  ) >/dev/null 2>&1
}

find_working_ws_port() {
  local p
  local tried=0
  while [[ "$tried" -lt 50 ]]; do
    for p in $(seq "$WS_PORT_DEFAULT" "$WS_PORT_MAX"); do
      if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
        if ws_handshake_ok "$p"; then
          echo "$p"
          return 0
        fi
      fi
    done
    tried=$((tried + 1))
    sleep 0.4
  done
  return 1
}

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
    if ! ps -axo comm= | grep -q '/Cursor.app/Contents/MacOS/Cursor$'; then
      break
    fi
    sleep 0.5
  done
  sleep 1
fi

# Default: clear zombie WS listeners (e.g. TCP-open but handshake-dead :8766)
if [[ "$NO_CLEANUP" -eq 0 ]]; then
  cleanup_ws_ports
fi

log "Starting Cursor with CDP on :${CDP_PORT}..."
# Prefer direct binary launch (reliable for --remote-debugging-port)
nohup "$CURSOR_BIN" --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CDP_PORT" \
  >/tmp/cursor-remote-cursor.log 2>&1 &
CURSOR_CHILD_PID=$!
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
  die "Port ${WEB_PORT} is occupied. Stop its owner yourself or choose WEB_PORT; no process was terminated."
fi

log "Serving Chrome app at http://${LAN_IP}:${WEB_PORT} ..."
cd "$WEB_DIR"
# background PID file so we can find it later
PID_FILE="${TMPDIR:-/tmp}/cursor-remote-web-${WEB_PORT}.pid"
python3 -m http.server "$WEB_PORT" --bind 0.0.0.0 >/tmp/cursor-remote-web-8080.log 2>&1 &
WEB_CHILD_PID=$!
umask 077
printf '%s\n' "$WEB_CHILD_PID" >"$PID_FILE"
cleanup_owned_web() {
  # Only terminate the live child launched by this invocation. A saved PID alone
  # is insufficient: PID reuse must never authorize termination.
  local parent command
  parent="$(ps -p "$WEB_CHILD_PID" -o ppid= 2>/dev/null | tr -d ' ' || true)"
  command="$(ps -p "$WEB_CHILD_PID" -o command= 2>/dev/null || true)"
  if [[ "$parent" == "$$" && "$command" == *" -m http.server $WEB_PORT --bind 0.0.0.0" ]]; then
    kill -TERM "$WEB_CHILD_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}
trap cleanup_owned_web EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- 4) Wait for a WS port that actually handshakes ---
log "Waiting for a healthy Cursor Remote WebSocket..."
WS_PORT=""
if WS_PORT="$(find_working_ws_port)"; then
  log "Healthy WebSocket on port ${WS_PORT}"
else
  # Last resort: first listening port (may still be stale)
  for p in $(seq "$WS_PORT_DEFAULT" "$WS_PORT_MAX"); do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      WS_PORT="$p"
      break
    fi
  done
  WS_PORT="${WS_PORT:-$WS_PORT_DEFAULT}"
  log "WARNING: no healthy WS handshake yet — printing port ${WS_PORT} (try Retry in app, or Cmd+Shift+P → Cursor Remote: Restart Server)"
fi

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

 Health check: ./scripts/check-cursor-remote.sh
 Web server log: /tmp/cursor-remote-web-8080.log
 Stop web only:  Ctrl+C in this terminal
========================================

EOF

# Keep script attached to web server so Ctrl+C stops it (Cursor stays running)
log "Web server running in foreground (Ctrl+C stops Chrome UI only)."
wait "$WEB_CHILD_PID"
