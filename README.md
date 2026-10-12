# Cursor Remote 📱

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.7.0-blue.svg)](https://github.com/KrishnaGupta653/cursor-bridge/releases)
[![CI](https://github.com/KrishnaGupta653/cursor-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/KrishnaGupta653/cursor-bridge/actions/workflows/ci.yml)

**Control Cursor's agents from your phone, from anywhere.** Read the chats in Cursor's Agents window,
send prompts, stop runs and approve commands, from a web app or a Telegram bot.

**→ [Set it up in about 15 minutes: SETUP.md](SETUP.md)**

## What you get

- 📱 **Web app** ([cursor-remote-app.vercel.app](https://cursor-remote-app.vercel.app)): Cursor's Agents
  sidebar and chats on your phone, with live replies, approvals and model switching. Add it to your home
  screen.
- 💬 **Telegram bot**: `/chats`, prompts, `/stop`, approval alerts with confirm-to-approve, and `/pair`
  for one-tap phone sign-in.
- 🌍 **Your own relay** (Vercel + Upstash Redis, free tiers): works from any network. One Deploy
  button, no shared server.
- 🧙 **Cursor Remote: Set Up** checks the relay, creates the Telegram settings (it finds your Telegram ID
  for you), shows a QR code for the phone, and turns on session control. **Cursor Remote: Diagnose**
  checks every part.
- 🔐 **Paired devices only**: single-use 5-minute pairing codes, 24-hour sessions, hashed capability
  tokens, request-bound approvals, an audit log, and no remote shell.

## How it works

```
Phone (web app or Telegram)  ⇄  your relay (Vercel + Upstash)  ⇄  extension in Cursor  ⇄  Agents window (CDP on 127.0.0.1)
```

| Part | Folder | What it is |
|------|--------|-----------|
| Extension | [`cursor-extension/`](cursor-extension/) | `krishnagupta653.cursor-remote-extension`: relay client, local WebSocket server (same Wi-Fi), Telegram bot, session control |
| Relay | [`relay-server/`](relay-server/) | Vercel functions + Upstash Redis; messages expire after 5 minutes |
| App | [`mobile-app/`](mobile-app/) | Flutter, deployed as the web app; also builds for Android and iOS |

Session control drives Cursor's own Agents window through the Chrome DevTools Protocol on
`127.0.0.1:9222`, never exposed to the network. Without it the phone can read but not send or approve.
Reading chats relies on Cursor's UI, which can change between releases; what can't be read is reported
as unavailable, never made up, and approvals are never automatic.

## Documentation

| Doc | For |
|-----|-----|
| [SETUP.md](SETUP.md) | Step-by-step setup with links, troubleshooting, reset |
| [USER_MANUAL.md](USER_MANUAL.md) | Every feature and setting, same-Wi-Fi mode, CLI mode |
| [SECURITY.md](SECURITY.md) | Threat model and how to report a vulnerability |
| [PROTOCOL.md](PROTOCOL.md) | Protocol v2 message format |
| [relay-server/README.md](relay-server/README.md) | Relay API and deployment |
| [docs/self-host-app.md](docs/self-host-app.md) | Hosting the web app yourself |
| [cursor-extension/PUBLISHING.md](cursor-extension/PUBLISHING.md) | Releasing the extension |

## Develop

```bash
git clone https://github.com/KrishnaGupta653/cursor-bridge.git && cd cursor-bridge
npm ci
npm --workspace cursor-extension test           # extension
(cd relay-server && npm ci && npm test)          # relay
(cd mobile-app && flutter pub get && flutter test)  # app
```

Run the app against a local relay with `flutter run -d chrome --dart-define=RELAY_URL=http://localhost:3000`.
Branches follow Git Flow (`feature/*` from `develop`) with [Conventional Commits](https://www.conventionalcommits.org);
install the hooks with `./scripts/install-git-flow-hooks.sh`. Issues and pull requests are welcome.

## License

MIT, see [LICENSE](LICENSE). By [Krishna Gupta](https://github.com/KrishnaGupta653).
