#!/usr/bin/env bash
# Health check for the whole Cursor Remote stack. Read-only: never kills or edits anything,
# never prints secrets.
#
# Usage: ./scripts/check-cursor-remote.sh

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_PORT="${WEB_PORT:-8080}"
CDP_PORT="${CDP_PORT:-9222}"
WS_PORT="${WS_PORT:-8766}"
TG_DIR="$HOME/.config/cursor-remote"
SETTINGS="$HOME/Library/Application Support/Cursor/User/settings.json"

FAILS=0
WARNS=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; WARNS=$((WARNS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }
section() { printf '\n%s\n' "$*"; }

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"

section "Cursor"
if ps -axo comm= | grep '/Cursor.app/Contents/MacOS/Cursor$' >/dev/null; then pass "Cursor is running"; else fail "Cursor is not running (run ./scripts/start-cursor-remote-stack.sh)"; fi
EXT="$(ls -d "$HOME"/.cursor/extensions/krishnagupta653.cursor-remote-extension-* 2>/dev/null | tail -1)"
if [[ -n "$EXT" ]]; then
  pass "Extension installed: $(basename "$EXT") (built $(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$EXT/out/extension.js" 2>/dev/null || echo '?'))"
else
  fail "Cursor Remote extension not installed"
fi

section "CDP (agent session control)"
CDP_BIND="$(lsof -nP -iTCP:"$CDP_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}' | head -1)"
if [[ -z "$CDP_BIND" ]]; then
  fail "Nothing on :$CDP_PORT — in Cursor run \"Cursor Remote: Restart Cursor with Session Control\" (or start-cursor-remote-stack.sh)"
elif [[ "$CDP_BIND" == 127.0.0.1:* ]]; then
  pass "CDP listening on $CDP_BIND (localhost only)"
else
  fail "CDP bound to $CDP_BIND — must be 127.0.0.1 only"
fi
if [[ -n "$CDP_BIND" ]]; then
  TARGETS="$(curl -s --max-time 3 "http://127.0.0.1:$CDP_PORT/json/list" | python3 -c 'import json,sys; print(sum(1 for t in json.load(sys.stdin) if t.get("type")=="page"))' 2>/dev/null || echo 0)"
  if [[ "$TARGETS" -gt 0 ]]; then pass "$TARGETS Cursor window(s) visible to CDP"; else warn "CDP has no page targets"; fi
fi

section "WebSocket ports (8766-8775)"
for p in $(seq 8766 8775); do
  pid="$(lsof -nP -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null | head -1)"
  [[ -z "$pid" ]] && continue
  ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  cmd="$(ps -o command= -p "$pid" 2>/dev/null | cut -c1-70)"
  if [[ "$ppid" == "1" && "$cmd" == *extension-host* ]]; then
    warn ":$p pid $pid ORPHANED ($cmd) — cleared automatically on next Reload Window"
  else
    pass ":$p pid $pid ($cmd)"
  fi
done
HANDSHAKE="$(cd "$ROOT/cursor-extension" 2>/dev/null && node -e "
const ws = new (require('ws'))('ws://127.0.0.1:$WS_PORT');
const t = setTimeout(() => { console.log('timeout'); process.exit(0); }, 3000);
ws.on('message', (m) => { try { console.log(JSON.parse(m).type); } catch { console.log('bad'); } clearTimeout(t); ws.close(); process.exit(0); });
ws.on('error', (e) => { console.log('error ' + e.message); process.exit(0); });
" 2>/dev/null)"
if [[ "$HANDSHAKE" == "auth_required" ]]; then
  pass "ws://127.0.0.1:$WS_PORT answers auth_required (pairing works)"
else
  fail "ws://127.0.0.1:$WS_PORT handshake: ${HANDSHAKE:-no response}"
fi

section "Web app (:$WEB_PORT)"
if [[ -f "$ROOT/mobile-app/build/web/index.html" ]]; then
  pass "Flutter web build present ($(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$ROOT/mobile-app/build/web/main.dart.js" 2>/dev/null || echo '?'))"
else
  fail "No Flutter web build — run: cd mobile-app && flutter build web --release"
fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$WEB_PORT/")"
if [[ "$CODE" == "200" ]]; then pass "http://127.0.0.1:$WEB_PORT serves the app"; else fail "http://127.0.0.1:$WEB_PORT returned ${CODE:-nothing}"; fi
if [[ -n "$LAN_IP" ]]; then
  if python3 - "$SETTINGS" "http://$LAN_IP:$WEB_PORT" <<'PY' 2>/dev/null; then
import json, sys
origins = json.load(open(sys.argv[1])).get("cursorRemote.allowedWebSocketOrigins", [])
sys.exit(0 if sys.argv[2] in origins else 1)
PY
    pass "Origin http://$LAN_IP:$WEB_PORT is allowed (phone on same Wi-Fi)"
  else
    fail "Add \"http://$LAN_IP:$WEB_PORT\" to cursorRemote.allowedWebSocketOrigins (or run Pair Client → Allow it); applies immediately"
  fi
else
  warn "No LAN IP found (Wi-Fi off?) — phone access unavailable"
fi

section "Telegram"
TG="$TG_DIR/telegram.json"
if [[ ! -f "$TG" ]]; then
  fail "$TG missing"
else
  perms="$(stat -f '%Lp' "$TG")"
  [[ "$perms" == "600" ]] && pass "telegram.json permissions 600" || warn "telegram.json permissions $perms (run: chmod 600 $TG)"
  python3 - "$TG" <<'PY'
import json, re, sys
try:
    c = json.load(open(sys.argv[1]))
except Exception as e:
    print("  \033[31mFAIL\033[0m telegram.json is not valid JSON"); sys.exit(1)
failed = []
ok = lambda m: print("  \033[32mPASS\033[0m " + m)
bad = lambda m: (failed.append(m), print("  \033[31mFAIL\033[0m " + m))
(ok if c.get("enabled") else bad)("enabled: " + str(bool(c.get("enabled"))))
(ok if re.fullmatch(r"\d{6,12}:[A-Za-z0-9_-]{30,40}", str(c.get("botToken", ""))) else bad)("botToken format")
(ok if c.get("allowedUserIds") else bad)(f"allowedUserIds: {len(c.get('allowedUserIds') or [])} user(s)")
(ok if c.get("allowedChatIds") else bad)(f"allowedChatIds: {len(c.get('allowedChatIds') or [])} chat(s)")
(ok if c.get("apiId") and c.get("apiHash") else bad)("apiId/apiHash present (needed for MTProto)")
print(f"         transport: {c.get('transport', 'auto')}")
sys.exit(1 if failed else 0)
PY
  [[ $? -eq 0 ]] || FAILS=$((FAILS + 1))
fi
VENV_PY="$TG_DIR/venv/bin/python"
if [[ -x "$VENV_PY" ]] && "$VENV_PY" -c 'import telethon' 2>/dev/null; then
  pass "Telethon venv ready (MTProto fallback)"
else
  warn "Telethon venv missing — needed when api.telegram.org is blocked"
fi
if [[ -f "$TG_DIR/telegram.lock" ]]; then
  owner="$(cat "$TG_DIR/telegram.lock")"
  if kill -0 "$owner" 2>/dev/null; then
    pass "Bot owned by one window (pid $owner) — other windows stay quiet"
  else
    warn "Stale telegram.lock (pid $owner gone) — next window start will take over"
  fi
else
  warn "No telegram.lock — bot not running (Cmd+Shift+P → Cursor Remote: Start Telegram Bot)"
fi
BRIDGES="$(ps -axo command= | grep -c '[t]elegram-mtproto-bridge.py')"
if [[ "$BRIDGES" -le 1 ]]; then pass "$BRIDGES MTProto bridge process(es)"; else warn "$BRIDGES MTProto bridges running — duplicate bot replies likely (Reload the other windows)"; fi

section "Summary"
echo "  Phone/Chrome: http://${LAN_IP:-127.0.0.1}:$WEB_PORT  →  Local host ${LAN_IP:-127.0.0.1}, port $WS_PORT"
echo "  Pairing: Cmd+Shift+P → Cursor Remote: Pair Client (code auto-copied)"
echo "  Telegram: /sessions · /use 1 · /to 2 <text> · /state 2 · /history · /open 1"
if [[ "$FAILS" -eq 0 ]]; then
  printf '  \033[32mAll critical checks passed\033[0m (%d warning(s))\n\n' "$WARNS"
else
  printf '  \033[31m%d failure(s)\033[0m, %d warning(s)\n\n' "$FAILS" "$WARNS"
  exit 1
fi
