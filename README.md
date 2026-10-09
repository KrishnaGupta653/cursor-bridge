# Cursor Remote 📱

> Protocol v2: every device pairs with a single-use code, commands are typed and audited, and
> there is no remote shell. Older clients and examples are rejected; see [PROTOCOL.md](PROTOCOL.md)
> and the [security migration guide](SECURITY_MIGRATION.md).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.6.0-blue.svg)](https://github.com/KrishnaGupta653/cursor-bridge/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![Flutter](https://img.shields.io/badge/Flutter-3.0+-blue)](https://flutter.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org/)

**Control Cursor AI from Your Mobile Device!**

Cursor Remote is an open-source system that allows you to remotely control Cursor AI from your mobile devices. Send commands to your PC's Cursor through a Flutter app and check AI responses and work results in real-time. Code anywhere, anytime from your smartphone or tablet!

- **Web app**: <https://cursor-remote-app.vercel.app>
- **Relay server**: <https://cursor-remote-rela.vercel.app>

### Key Features

- 📱 **Mobile Control**: Control Cursor AI from your smartphone or tablet
- ⚡ **Real-time Communication**: WebSocket-based bidirectional real-time communication
- 🤖 **CLI Integration**: AI interaction through Cursor CLI (`agent`)
- 🔄 **Auto Sync**: Real-time synchronization of mobile input to PC
- 🌐 **Cross Platform**: Android, iOS, and Web support
- 🔒 **Open Source**: MIT License, free to use and modify
- 💬 **AI Chat**: Real-time conversation with Cursor AI from mobile
- 📝 **Code Editing**: Write and edit code from your mobile device
- 🌍 **Relay Mode**: Connect from anywhere via relay server (no same network required)
- 🔐 **Paired devices only**: single-use 5-minute pairing codes, 24-hour relay sessions, request-bound approvals

### Why Cursor Remote?

#### Problems We Solve

- 🏠 **Code from Home**: Write code and chat with AI from your mobile device while relaxing on the couch
- 🚇 **On the Go**: Make quick code edits or ask AI questions while commuting on the subway or bus
- 💻 **No PC Required**: Use Cursor CLI mode to interact with AI even when Cursor IDE isn't running on your PC
- 🔄 **Real-time Sync**: Mobile input is synchronized in real-time to your PC's Cursor CLI
- 🤖 **AI Response**: Check Cursor AI responses in real-time from your mobile device

#### Use Cases

- **Remote Development**: Write code and ask AI questions from your mobile device at home or cafes
- **Quick Fixes**: Make urgent code edits or check bugs while away from your PC
- **AI Interaction**: Chat with Cursor AI from mobile to brainstorm ideas
- **Automation**: Script and CI/CD integration through CLI mode
- **Presentations**: Show and explain code from your mobile device

### Features

- 📝 **Remote Code Editing**: Request code generation from Cursor AI via mobile
- ⚡ **Command Execution**: Execute Cursor CLI commands from mobile
- 🤖 **AI Response**: Check Cursor AI responses in real-time from mobile
- 📊 **Work Results**: View file edits, build results, etc. from mobile
- 🔐 **Permission Management**: Request and respond to permissions for file access and command execution
- 🔄 **Real-time Communication**: WebSocket-based bidirectional real-time communication
- 🖥️ **CLI Mode**: Communicate with AI through Cursor CLI (`agent` command)

### Architecture

The system has three components:

| Component | Folder | Description |
|-----------|--------|-------------|
| **Cursor Extension** | `cursor-extension/` | VS Code/Cursor extension (`krishnagupta653.cursor-remote-extension`): local WebSocket server, relay client, CLI and CDP handlers |
| **Relay Server** | `relay-server/` | Vercel functions + Upstash Redis, used only in relay mode |
| **Mobile App** | `mobile-app/` | Flutter app for Android and iOS, also deployed as the web app |

**Local mode** (same network):

```
┌─────────────┐     WebSocket      ┌─────────────┐
│   Mobile/   │◄──────────────────►│  Extension  │
│   Web App   │     Port 8766       │ (CLI Mode) │
└─────────────┘                    └──────┬──────┘
                                          │
                                   ┌──────┴──────┐
                                   │ Cursor CLI  │
                                   │   (agent)   │
                                   └─────────────┘
```

**Relay mode** (remote, 0.3.6+):

```
Mobile/Web App  ←→  Relay Server  ←→  Extension (RelayClient)
     │                   │                    │
     └───── Session ID ──┴──── Session ID ────┘
           (e.g. ABC123)
```

No separate PC server is required. The extension includes the relay client and the WebSocket server.
The Mac creates a relay session (valid 24 hours) and phones join it with a single-use pairing code.

#### Connection Modes

| Mode | Description | Network Requirements |
|------|-------------|---------------------|
| **Local Mode** | App connects directly to Extension WebSocket (port 8766); PC and mobile on the same Wi-Fi | Same network |
| **Relay Mode** | App and Extension connect via relay server (session ID) for access from outside | Internet connection |

### Project Structure

```
cursor-remote/
├── cursor-extension/    # Cursor Extension (TypeScript)
│   ├── src/
│   │   ├── extension.ts
│   │   ├── websocket-server.ts
│   │   ├── command-handler.ts
│   │   └── cli-handler.ts      # CLI mode handler
│   ├── package.json
│   └── README.md
├── relay-server/       # Relay server (Vercel, optional for remote mode)
├── mobile-app/         # Mobile app (Flutter, also built as the web app)
│   ├── lib/
│   │   ├── main.dart
│   │   ├── models/
│   │   ├── services/
│   │   └── widgets/
│   ├── pubspec.yaml
│   └── README.md
├── README.md
└── package.json
```

---

## Installation & Setup

### Prerequisites

| Component | Requirements |
|-----------|-------------|
| **PC** | Node.js 18+ |
| **Mobile** | Android or iOS device |
| **Cursor CLI** | Installation and authentication required |

### Step 1: Cursor CLI Installation & Authentication

To use CLI mode, you must first install and authenticate Cursor CLI.

#### 1.1 Install CLI

```bash
curl https://cursor.com/install -fsS | bash
```

This command installs the CLI in the `~/.local/bin/` directory.

#### 1.2 Configure PATH

**Zsh users (macOS default):**

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**Bash users:**

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

#### 1.3 Verify Installation

```bash
which agent
# or
agent --version
```

#### 1.4 Authentication (Required)

**Method 1: Browser Login (Recommended)**

```bash
agent login
```

A browser will open for you to log in with your Cursor account. Authentication is saved, so you only need to log in once.

**Method 2: API Key (For automation/CI)**

```bash
# After generating API key from Cursor website
export CURSOR_API_KEY=your_api_key_here

# Permanent setup (optional)
echo 'export CURSOR_API_KEY=your_api_key_here' >> ~/.zshrc
source ~/.zshrc
```

#### 1.5 Verify Authentication Status

```bash
agent status
```

When authenticated, you'll see:

```
✅ Authenticated as: your-email@example.com
```

#### 1.6 Test CLI

```bash
agent -p --output-format json --force 'Hello, world!'
```

If JSON response is output correctly, CLI setup is complete.

---

### Step 2: Cursor Extension Installation

The extension ID is `krishnagupta653.cursor-remote-extension` (publisher `krishnagupta653`).

#### 2.1 Build Extension

```bash
cd cursor-extension
npm install
npm run compile
```

#### 2.2 Activate Extension in Cursor IDE

1. **Launch Cursor IDE**
2. **Extension auto-activates** (check for cloud icon in status bar)
3. **Or manually start**: Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) → "Cursor Remote: Start Server"

#### 2.3 Verify Activation

- Check status bar for "Remote :8766" (ready) or "Remote · 1 device" (connected); click it for all actions
- Check Output panel for "Cursor Remote extension is now active!" message

### Upgrading to 0.6.0

The extension ID changed from `jaloveeye.cursor-remote-extension` to
`krishnagupta653.cursor-remote-extension`.

1. Uninstall the old extension first: in the Extensions view, or run
   `cursor --uninstall-extension jaloveeye.cursor-remote-extension`.
2. Install the new extension (`krishnagupta653.cursor-remote-extension`).
3. Pair the phone again and re-enter the Telegram settings (**Cursor Remote: Edit Telegram Settings**),
   because stored credentials are tied to the extension ID.

---

### Step 3: Mobile App Installation

#### 3.1 Build and Install

**Android:**

```bash
cd mobile-app
flutter pub get
flutter build apk --release
# Install the generated APK file on your Android device
```

**iOS:**

```bash
cd mobile-app
flutter pub get
cd ios && export LANG=en_US.UTF-8 && pod install && cd ..
flutter build ios
# Run in Xcode or deploy via TestFlight
```

**Development Testing:**

```bash
# Run directly on USB-connected device
flutter run
```

**Web app:** a hosted build is available at <https://cursor-remote-app.vercel.app>. See
[Deployment](#deployment) to build and deploy your own.

---

## Connection Setup

### Turn on session control

The extension drives Cursor's Agents window through the Chrome DevTools Protocol on
`127.0.0.1:9222` (never exposed to the network).

1. Settings → **Cursor Remote: Enable Cdp** → on (`"cursorRemote.enableCdp": true`).
2. Command Palette → **Cursor Remote: Restart Cursor with Session Control**. Cursor asks about unsaved
   files, quits and reopens with session control on.

Without it the phone can read chats but cannot send, stop or approve. If Cursor was opened normally,
the extension offers the restart once.

### Local Mode (Same Wi-Fi Network)

1. The extension starts its server on port **8766** (8767… for more Cursor windows); the status bar
   shows `Remote :8766`.
2. Click the status bar → **Pair a device** (**Cursor Remote: Pair Client**). The code is copied; it
   works once and expires after 5 minutes.
3. In the app choose **Local**, enter the Mac's IP address and port, connect, then paste the code.

Browsers must come from an origin in `cursorRemote.allowedWebSocketOrigins` (Pair Client offers to
add it). An `https://` web app cannot open a local `ws://` connection; use the relay there.
Allow the port in the Mac's firewall. Find the IP with `ipconfig getifaddr en0` (macOS),
`ipconfig` (Windows) or `hostname -I` (Linux).

### Relay Mode (Any Network)

1. Click the status bar → **Connect to relay…** (**Cursor Remote: Connect to Relay by Session ID**)
   and enter a 6-character session ID. Press Enter to reuse the last one.
2. Run **Cursor Remote: Pair Relay Client**. The code is copied and shown with the session ID.
3. In the app choose **Relay**, enter the session ID, then paste the code.

The default relay is <https://cursor-remote-rela.vercel.app>. Set `cursorRemote.relayServerUrl` only
if you deploy your own.

The app stays logged in for the rest of the session: refreshing the page or restarting the app
reconnects without a new code. **Log out** (bottom of the Agents sidebar, the top-bar button or
Settings) signs this phone out and revokes its login on the relay. When the session ends (24 hours,
Start New Relay Session or Revoke) the app says so and asks for a new pairing code.

```
Mobile App ⇄ Relay Server (Vercel + Upstash Redis) ⇄ Extension (RelayClient) ⇄ Cursor
```

| Rule | Behaviour |
|------|-----------|
| **Session lifetime** | 24 hours. Afterwards, or if the ID is taken, the extension switches to a new random ID and you pair again. An ID is never reused. |
| **Pairing codes** | Single use, expire after 5 minutes. Opt-in `cursorRemote.reusablePairingCode`: one code for the whole session, up to 3 devices; anyone who sees it can join until the session ends or you start a new one. The Mac is notified of every device that joins. |
| **Credentials** | 256-bit capability tokens, stored hashed on the relay. The app keeps its login in local storage (the browser's localStorage on the web) until the session ends or you log out |
| **Messages** | Expire after 5 minutes; replies go only to the phone that asked |
| **Liveness** | The extension's polls keep the Mac "connected"; phones that stop polling for about 2 minutes are pruned |
| **Restart** | After Cursor restarts, one window reconnects to the last session on its own |

| Command | Description |
|---------|-------------|
| `Cursor Remote: Connect to Relay by Session ID` | Connect this Mac to a relay session |
| `Cursor Remote: Pair Relay Client` | Pairing code for the phone (single use, or the session's reusable code) |
| `Cursor Remote: Start New Relay Session` | Revoke the current session and start a new one |
| `Cursor Remote: Revoke Relay Session` | Revoke the current session |
| `Cursor Remote: Set Relay Session ID` | Change the saved session ID |

### Keep the Mac awake

The phone can only reach Cursor while the Mac is awake and online. While you are away, run
`caffeinate -dimsu` in a terminal (Ctrl+C to stop). If the Mac sleeps for more than about 2 minutes,
the relay treats it as offline and phones cannot join until it is back.

---

## Deployment

**Relay server** (Vercel + Upstash Redis; see [relay-server/README.md](./relay-server/README.md)):

```bash
cd relay-server
vercel --prod
```

**Web app** (Vercel cannot build Flutter, so build locally and deploy the output; see
[mobile-app/DEPLOY_INSTRUCTIONS.md](./mobile-app/DEPLOY_INSTRUCTIONS.md)):

```bash
cd mobile-app
flutter build web --release
cp vercel-build-output.json build/web/vercel.json
cd build/web
vercel --prod
```

---

## Usage

### Basic Usage

1. **Send Prompt**: Enter text in mobile app input field and send
2. **Check AI Response**: Check AI response in real-time from mobile app
3. **Check File Changes**: Check file contents modified by AI

### How CLI Mode Works

When you send a prompt:

1. **Extension executes the `agent` command** (`--resume` continues the device's previous chat,
   `--mode` is passed for plan/ask):

   ```bash
   agent [--resume <chat-id>] [--mode plan|ask] -p --output-format stream-json --stream-partial-output -- "prompt"
   ```

2. **CLI generates response**
3. **Extension parses response and sends to mobile app**
4. **Process terminates**

CLI mode starts a **new** Cursor CLI interaction. It does **not** attach to the Agent chat already open in the Cursor IDE.

### Existing Agent mode (CDP)

Attach to an **already-running** Cursor IDE Agent session via Chrome DevTools Protocol (localhost only).

```
Android Chrome → Flutter Web → Extension WS :8766 → CDP 127.0.0.1:9222 → Cursor IDE Agent
```

| Mode | What it controls |
|------|------------------|
| **CLI Agent** | New `agent` CLI process (fallback; always available) |
| **Existing Agent (CDP)** | Same Agent session already open in Cursor IDE |

#### Mobile control center

When **Existing Agent** is selected, the Flutter Web UI becomes a Cursor-like control center:

1. **Dashboard** — status summary (Working / Waiting / Idle / Error) and a card per Cursor window/session
2. **Session screen** — Chat · Plan · Changes · Activity tabs
3. **Permissions** — Approve / Reject never auto-approved
4. **Multi-session** — each session keeps its own conversation, plan, activity, and pending permission

Prompts from the session composer use `agent_prompt` and inject into the **selected existing** Cursor Agent UI via CDP — they do **not** run `agent -p`.

#### 1. Start Cursor with CDP (macOS)

Run **Cursor Remote: Restart Cursor with Session Control**. To do it by hand, quit Cursor completely,
then:

```bash
open -a Cursor --args --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
```

#### 2. Verify CDP (localhost only)

```bash
curl http://127.0.0.1:9222/json
curl http://127.0.0.1:9222/json/version
```

Do **not** bind CDP to `0.0.0.0`. It must stay on loopback.

#### 3. Enable CDP in the extension

- Settings → **Cursor Remote: Enable Cdp** = `true`, or
- Env: `ENABLE_CDP=true`
- Optional: `CDP_HOST=127.0.0.1` (loopback only), `CDP_PORT=9222`

#### 4. Connect the Flutter Web / Android UI

1. Start the Cursor Remote extension (WebSocket `:8766`)
2. Open the Flutter Web UI and connect (local or relay)
3. Choose **Existing Agent** backend
4. Select a Cursor window/session from the control center
5. Send prompts, approve/reject permissions, monitor plan/activity

#### CDP WebSocket API (allowlisted — not a raw CDP proxy)

| Type | Direction | Description |
|------|-----------|-------------|
| `cdp_status` | both | CDP connection status + targets + summary |
| `cdp_targets` | Server→App | Discovered targets |
| `get_sessions` / `sessions` | both | Live Cursor window sessions |
| `get_agent_history` / `agent_history` | both | Agents sidebar history/pinned (DOM scrape) |
| `select_session` | App→Server | Set active remote-control target |
| `get_agent_state` / `agent_state` | both | Conversation + state snapshot |
| `agent_prompt` | App→Server | Prompt → **existing** IDE Agent |
| `cli_prompt` | App→Server | Prompt → CLI (explicit) |
| `approve_action` / `reject_action` | App→Server | Exact pending `requestId` + `chatId`, confirmed on the phone, gated by `cursorRemote.remoteActions` and audited |
| `get_plan` / `get_agent_plan` / `agent_plan` | both | Plan steps when detectable |
| `list_chats` / `get_chat` / `watch_chat` | App→Server | Agents-window chats; a watch streams `chat_delta` and `composer_state` to the asking device |
| `chat_response` | Server→App | Final answer to a prompt, sent only to the device that asked |

#### Security

- Android talks **only** to WebSocket `:8766`
- Extension talks to CDP at `127.0.0.1:9222`
- Non-loopback CDP hosts are rejected
- No generic `{ "method": "...", "params": ... }` CDP proxy

#### Capability honesty (do not fake)

| Capability | Level | Notes |
|------------|-------|-------|
| Session discovery | PARTIALLY_SUPPORTED | Via `/json` targets + scoring |
| Agents history / pinned list | PARTIALLY_SUPPORTED | Scraped from Cursor Agents sidebar DOM (visible rows only) |
| Open history item | PARTIALLY_SUPPORTED | Best-effort click in Agents sidebar |
| Conversation read | PARTIALLY_SUPPORTED | DOM heuristics; may miss nested webviews |
| Prompt inject | PARTIALLY_SUPPORTED | Composer textarea/contenteditable + Enter |
| Permissions | PARTIALLY_SUPPORTED | Button label heuristics; never auto-approve |
| Plan | PARTIALLY_SUPPORTED / NOT_CURRENTLY_ACCESSIBLE | When plan UI not in DOM |
| File changes / diffs | NOT_CURRENTLY_ACCESSIBLE often | SCM list heuristics only when visible |
| Full Agents storage / offline history API | NOT_CURRENTLY_ACCESSIBLE | No private Cursor store access |

#### Known limitations

- Conversation/plan/permission extraction uses best-effort DOM heuristics; Cursor Electron UI can change
- History list reflects only currently visible Agents sidebar rows — not a full offline archive
- Nested webviews may not always expose full Agent internals
- Unavailable data is reported as unavailable — never fabricated
- Approvals are **never** automatic

### View CLI Logs

Select "Cursor Remote" channel in Cursor IDE's Output panel to see logs like:

```
[CLI] sendPrompt called - textLength: XX, execute: true, ...
[CLI] Using CLI command: /Users/xxx/.local/bin/agent
[CLI] Executing CLI command...
[CLI] CLI process exited with code 0, signal: none
```

CDP logs use the `[CDP]` prefix (connect, targets, session state, permissions, reconnect).

---

## Communication Protocol

The app, the relay and the extension speak protocol v2: paired device tokens, typed commands with an
`id` and a `deadline`, and no generic command execution. See [PROTOCOL.md](./PROTOCOL.md).

| Port | Protocol | Purpose |
|------|----------|---------|
| 8766+ | WebSocket | Mobile/Web app ↔ Extension (local mode) |
| 9222 | CDP (loopback only) | Extension ↔ Cursor's own windows |

---

## Troubleshooting

### CDP / Existing Agent Issues

#### `curl http://127.0.0.1:9222/json` fails

- Run **Cursor Remote: Restart Cursor with Session Control**, or quit Cursor and relaunch with `--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222`
- Confirm nothing else is using 9222: `lsof -i :9222`
- Enable `cursorRemote.enableCdp` in settings

#### Sessions list empty

- CDP must be enabled and Cursor must expose `/json` targets
- Click refresh in the Existing Agent panel
- Check Output → Cursor Remote for `[CDP]` logs

#### Prompt does not reach the IDE Agent

- Confirm backend is **Existing Agent** (not CLI)
- Select the correct Cursor window/session
- Composer DOM may have changed — check `[CDP]` extraction notes

### CLI Issues

#### "command not found: agent" Error

```bash
# 1. Check PATH
echo $PATH | grep local

# 2. Run with direct path
~/.local/bin/agent --version

# 3. Create symbolic link (optional)
sudo ln -s ~/.local/bin/agent /usr/local/bin/agent
```

#### Authentication Error

```bash
# Logout and login again
agent logout
agent login
```

### Extension Issues

#### Extension Not Starting

- Restart Cursor IDE
- Run `npm run compile` again
- Check error messages in Output panel

### Server Issues

#### App Not Connecting to Extension (Local Mode)

```bash
# Check port 8766 conflict
lsof -i :8766
```

### Mobile App Issues

#### Cannot Connect

- Verify PC and mobile are on same Wi-Fi network
- Allow the WebSocket port in PC firewall (default 8766; 8767–8776 if 8766 is taken)
- Verify PC IP address is correct (same network)
- Verify the local port entered in the mobile app matches the extension's actual port

---

## Tech Stack

- **Cursor Extension**: TypeScript, VSCode Extension API, WebSocket (8766), RelayClient
- **Mobile App**: Flutter, Dart (Android, iOS, Web)
- **Relay Server** (optional): Vercel, Redis (Upstash)

---

## Documentation

- [PROTOCOL.md](./PROTOCOL.md) - WebSocket message format and protocol
- [USER_MANUAL.md](./USER_MANUAL.md) - Installation, setup, and usage
- [cursor-extension/README.md](./cursor-extension/README.md) - Extension setup and publishing
- [relay-server/README.md](./relay-server/README.md) - Relay server deployment
- [relay-server/TEST_PLAN.md](./relay-server/TEST_PLAN.md) - Relay test plan
- [relay-server/MAINTENANCE.md](./relay-server/MAINTENANCE.md) - Relay operations checklist
- [mobile-app/README.md](./mobile-app/README.md) - Mobile app guide

---

## Development Roadmap

### Phase 1: Basic Communication Infrastructure

- [ ] Cursor Extension development (WebSocket server)
- [ ] Stabilize extension-centric local/relay connections
- [ ] Mobile app basic UI
- [ ] Basic command sending (text insertion)

### Phase 2: Advanced Features

- [ ] AI response streaming
- [ ] File editing features
- [ ] Work result display
- [ ] Permission request system

### Phase 3: UX Improvements

- [ ] Real-time log display
- [ ] Error handling and retry
- [ ] Connection status management
- [ ] Conversation history

---

## Contributing

Contributions are welcome! Bug reports, feature suggestions, and Pull Requests are all welcome.

1. Fork this repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Contribution Guidelines

- Maintain code style
- Write meaningful commit messages
- Include tests for new features
- Update documentation

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Contact & Support

- **Author**: Krishna Gupta (<https://github.com/KrishnaGupta653>)
- **GitHub**: <https://github.com/KrishnaGupta653/cursor-bridge>
- **Issues**: [GitHub Issues](https://github.com/KrishnaGupta653/cursor-bridge/issues)
- **Releases**: [GitHub Releases](https://github.com/KrishnaGupta653/cursor-bridge/releases)

---

**Written**: January 21, 2026  
**Last updated**: October 9, 2026 (0.6.0: new extension ID `krishnagupta653.cursor-remote-extension`; 0.5.0: session control, pairing codes, 24-hour relay sessions, protocol v2)
