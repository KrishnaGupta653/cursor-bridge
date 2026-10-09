# Cursor Remote 📱

[![Version](https://img.shields.io/badge/version-0.6.0-blue.svg)](https://github.com/KrishnaGupta653/cursor-bridge)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Watch and control Cursor's Agents window from your phone or Telegram**

---

Cursor Remote shows the chats in Cursor's **Agents window** on your phone, with a UI modelled on
the Agents window. From the phone you can read chats, send prompts, switch model or mode, stop the
agent and approve or reject its requests. A Telegram bot offers the same controls.

### Key Features

- 📱 **Agents window on your phone**: chat list, live replies, diffs, model and mode
- 🌍 **Any network**: same Wi-Fi, a relay server, or a Cloudflare tunnel
- 🔐 **Paired devices only**: single-use pairing codes that expire after 5 minutes
- ✅ **Request-bound approvals**: approve or reject only the exact request shown, after a confirm tap
- 🧾 **Audit log**: every remote action is written to the **Cursor Remote** output
- ✈️ **Telegram**: control the same chats from a Telegram bot

### Installation

1. Open the Extensions view in Cursor (`Cmd+Shift+X` / `Ctrl+Shift+X`), search for "Cursor Remote"
   and click **Install**. Or download the `.vsix` from
   [Releases](https://github.com/KrishnaGupta653/cursor-bridge/releases) and use
   `Extensions` → `...` → `Install from VSIX...`.
2. Optional, for CLI prompts: install and sign in to the Cursor CLI
   (`curl https://cursor.com/install -fsS | bash`, then `agent login`).

### Upgrading to 0.6.0

The extension ID changed from `jaloveeye.cursor-remote-extension` to
`krishnagupta653.cursor-remote-extension`. Uninstall the old extension first (Extensions view, or
`cursor --uninstall-extension jaloveeye.cursor-remote-extension`), then install the new one. Pair
the phone again and re-enter the Telegram settings, because stored credentials are tied to the
extension ID.

### Setup

#### 1. Turn on session control

Cursor Remote drives Cursor's own windows through the Chrome DevTools Protocol on
`127.0.0.1:9222`. It is never exposed to the network.

1. Settings → **Cursor Remote: Enable Cdp** → on (`"cursorRemote.enableCdp": true`).
2. Command Palette → **Cursor Remote: Restart Cursor with Session Control**. Cursor asks about
   unsaved files, quits and reopens with session control on.

Without session control the phone can read chats but cannot send, stop or approve. If Cursor was
opened normally, the extension offers the restart once.

#### 2a. Connect on the same Wi-Fi

1. The server starts automatically. The status bar shows `Remote :8766` (8767… for more windows).
2. Click the status bar → **Pair a device**. The single-use code is copied; it expires after 5 minutes.
3. In the app choose **Local**, enter the Mac's address and port, connect, then paste the code.

Browsers must come from an origin listed in `cursorRemote.allowedWebSocketOrigins`; Pair Client
offers to add the current one. An `https://` web app cannot open a local `ws://` connection, so
use the relay from the hosted web app.

#### 2b. Connect from any network (relay)

1. Click the status bar → **Connect to relay…** (or run **Cursor Remote: Connect to Relay by
   Session ID**) and enter a 6-character session ID. Press Enter to reuse the last one.
2. Run **Cursor Remote: Pair Relay Client**. The code is copied and shown with the session ID.
3. In the app choose **Relay**, enter the session ID, then paste the code.

How relay sessions behave:

- A session lasts **24 hours**. After that, or if the ID is already taken, the extension switches to
  a new random ID and you pair the phone again. An ID is never reused.
- Pairing codes work once and expire after **5 minutes**.
- Optional `cursorRemote.reusablePairingCode`: one code for the whole session, for up to 3 devices,
  shown again each time you run Pair Relay Client. Anyone who sees it can join until the session ends
  or you start a new one, so keep it private. You get a notification for every device that joins.
- The app stays logged in through page refreshes and restarts until the session ends or you tap
  **Log out** in the app.
- After Cursor restarts, one window reconnects to the last session on its own; the phone keeps working.
- **Cursor Remote: Start New Relay Session** revokes the current session and shows a new pairing
  code. **Cursor Remote: Revoke Relay Session** just revokes it.

#### 3. Keep the Mac awake

The Mac must stay awake and online for the phone to reach Cursor. While you are away, run this in
a terminal (Ctrl+C to stop):

```bash
caffeinate -dimsu
```

If the Mac sleeps for more than about 2 minutes, the relay treats it as offline and phones cannot
join until it is back.

#### 4. Telegram (optional)

Run **Cursor Remote: Edit Telegram Settings**. The file lives at
`~/.config/cursor-remote/telegram.json` (see `telegram.secrets.example.json`). Set `botToken`,
`allowedUserIds` and `allowedChatIds`; both lists are required. Only one Cursor window runs the bot.

### Remote actions and audit log

When `cursorRemote.remoteActions` is `enabled`, the phone and Telegram can open chats or start a
new chat, switch model or mode, stop the agent, and approve or reject its requests. Approve and
reject always need a confirm tap and only act on the exact request shown on screen. Every action is
written to the **Cursor Remote** output as an `[Audit]` line.

### Commands

| Command | What it does |
|---------|--------------|
| `Cursor Remote: Quick Actions` | The status-bar menu with every common action |
| `Cursor Remote: Restart Cursor with Session Control` | Reopen Cursor with session control on |
| `Cursor Remote: Pair Client` | One-time code for a phone on the same Wi-Fi |
| `Cursor Remote: Revoke All Paired Clients` | Sign out every local device |
| `Cursor Remote: Connect to Relay by Session ID` | Connect this Mac to a relay session |
| `Cursor Remote: Pair Relay Client` | One-time code for a phone on the relay |
| `Cursor Remote: Start New Relay Session` | Revoke the current relay session and start a new one |
| `Cursor Remote: Revoke Relay Session` | Revoke the current relay session |
| `Cursor Remote: Set Relay Session ID` | Change the saved session ID |
| `Cursor Remote: Start/Stop Cloudflare Tunnel` | Public `wss://` tunnel to the local server |
| `Cursor Remote: Start/Stop/Restart Telegram Bot` | Control the Telegram bot |
| `Cursor Remote: Show Connection Info` | Addresses, devices, Telegram, tunnel and relay status |

### Settings

| Setting | Default | Meaning |
|---------|---------|---------|
| `cursorRemote.enableCdp` | `false` | Allow session control of Cursor's windows |
| `cursorRemote.remoteActions` | `enabled` | `disabled` turns off open/new chat, model, mode, stop, approve and reject from the phone and Telegram |
| `cursorRemote.relayServerUrl` | built-in | Your own relay (`https://…`) |
| `cursorRemote.allowedWebSocketOrigins` | localhost:8080 | Browser origins allowed on the local server |
| `cursorRemote.cdpPort` | `9222` | Session-control port (always on `127.0.0.1`) |
| `cursorRemote.telegramSecretsPath` | `~/.config/cursor-remote/telegram.json` | Telegram settings file |

### Protocol

The app and the extension speak protocol v2: paired device tokens, typed commands with a deadline,
and no generic command execution. See [PROTOCOL.md](https://github.com/KrishnaGupta653/cursor-bridge/blob/main/PROTOCOL.md).

### Development

```bash
npm install
npm test                  # compile + unit tests
npx tsc --noEmit -p .     # type-check
npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license
```

### Contributing

Contributions are welcome. Fork the repository, create a `feature/*` branch, use
Conventional Commits (`feat: …`, `fix: …`) and open a Pull Request.

### License

MIT License. See [LICENSE](LICENSE).

### Contact & Support

- **Author**: Krishna Gupta (<https://github.com/KrishnaGupta653>)
- **GitHub**: <https://github.com/KrishnaGupta653/cursor-bridge>
- **Issues**: [GitHub Issues](https://github.com/KrishnaGupta653/cursor-bridge/issues)

---

Code from anywhere with **Cursor Remote**! 🚀
