# scripts

프로젝트 보조 스크립트 모음.

## Everyday stack (Chrome UI + CDP + Telegram)

From repo root, typical three-terminal setup:

1. **Cursor with CDP:** `./scripts/start-cursor-cdp.sh`  
   Then in Cursor: Output → Cursor Remote (WebSocket on `:8766`), and **Cmd+Shift+P → Cursor Remote: Start Telegram Bot** if it did not auto-start.
2. **Web UI:** `./scripts/rebuild-web-ui.sh` (when needed) then `./scripts/start-web-ui.sh` → `http://YOUR_MAC_IP:8080`
3. **Optional tunnel:** `./scripts/start-cloudflare-tunnel.sh 8766`

Or use `./scripts/start-cursor-remote-stack.sh` when you want the combined helper.

## Telegram Bot + MTProto

Drive Cursor Remote from Telegram (same command path as the phone app).

- Secrets: `~/.config/cursor-remote/telegram.json` (see `cursor-extension/telegram.secrets.example.json`)
  - `botToken`, `allowedUserIds`, `apiId` / `apiHash` (from https://my.telegram.org — same as telegcli), `transport: "auto"`
- Commands in Cursor: Open / Start / Stop / Restart Telegram Bot
- When `api.telegram.org` is blocked (corporate proxy), `transport: auto` falls back to MTProto via Telethon:
  - Bridge script: `scripts/telegram-mtproto-bridge.py` (also bundled as `cursor-extension/python/telegram-mtproto-bridge.py`)
  - Venv: `~/.config/cursor-remote/venv` (created by the extension on first MTProto start)

Message your bot with `/help`, `/ask`, `/status`, `/whoami`, etc.

## Git Flow 가드 훅

Git Flow 규칙([.cursor/rules/git_flow.mdc](../.cursor/rules/git_flow.mdc))을 **로컬에서 자동 적용**하려면:

```bash
./scripts/install-git-flow-hooks.sh
```

- **pre-commit**: `main` / `develop` 에서의 커밋 차단
- **commit-msg**: Conventional Commits 형식 검사 (`feat:`, `fix:` 등)

새로 클론한 뒤에는 위 설치를 한 번 더 실행해야 합니다.
