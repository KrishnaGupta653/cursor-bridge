# Cursor Remote 📱

> Protocol v2: every device pairs with a single-use code, commands are typed and audited, and
> there is no remote shell. Older clients and examples are rejected; see [PROTOCOL.md](PROTOCOL.md)
> and the [security migration guide](SECURITY_MIGRATION.md).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-♥-ea4aaa?logo=github)](https://github.com/sponsors/jaloveeye)
[![Version](https://img.shields.io/badge/version-0.5.0-blue.svg)](https://github.com/jaloveeye/cursor-remote)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![Flutter](https://img.shields.io/badge/Flutter-3.0+-blue)](https://flutter.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org/)

**Control Cursor AI from Your Mobile Device**

> Use Cursor AI right from your smartphone or tablet! Code anywhere, anytime with Cursor CLI.

이 프로젝트가 도움이 되었다면 [GitHub Sponsors](https://github.com/sponsors/jaloveeye)로 후원해 주세요 ♥

---

## 🇺🇸 English

**Control Cursor AI from Your Mobile Device!**

Cursor Remote is an open-source system that allows you to remotely control Cursor AI from your mobile devices. Send commands to your PC's Cursor CLI through a Flutter app and check AI responses and work results in real-time. Code anywhere, anytime using Cursor CLI from your smartphone or tablet!

If this project helps you, consider [sponsoring](https://github.com/sponsors/jaloveeye) ♥

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
| **Local Mode** | App connects directly to Extension WebSocket (port 8766) | Same network |
| **Relay Mode** | App and Extension connect via relay server (session ID) | Internet connection |

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
├── mobile-app/         # Mobile app (Flutter)
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

```
Mobile App ⇄ Relay Server (Vercel + Upstash Redis) ⇄ Extension (RelayClient) ⇄ Cursor
```

| Rule | Behaviour |
|------|-----------|
| **Session lifetime** | 24 hours. Afterwards, or if the ID is taken, the extension switches to a new random ID and you pair again. An ID is never reused. |
| **Pairing codes** | Single use, expire after 5 minutes |
| **Credentials** | 256-bit capability tokens, stored hashed on the relay |
| **Messages** | Expire after 5 minutes; replies go only to the phone that asked |
| **Liveness** | The extension's polls keep the Mac "connected"; phones that stop polling for about 2 minutes are pruned |
| **Restart** | After Cursor restarts, one window reconnects to the last session on its own |

| Command | Description |
|---------|-------------|
| `Cursor Remote: Connect to Relay by Session ID` | Connect this Mac to a relay session |
| `Cursor Remote: Pair Relay Client` | One-time code for the phone |
| `Cursor Remote: Start New Relay Session` | Revoke the current session and start a new one |
| `Cursor Remote: Revoke Relay Session` | Revoke the current session |
| `Cursor Remote: Set Relay Session ID` | Change the saved session ID |

### Keep the Mac awake

The phone can only reach Cursor while the Mac is awake and online. While you are away, run
`caffeinate -dimsu` in a terminal (Ctrl+C to stop). If the Mac sleeps for more than about 2 minutes,
the relay treats it as offline and phones cannot join until it is back.

---

## Usage

### Basic Usage

1. **Send Prompt**: Enter text in mobile app input field and send
2. **Check AI Response**: Check AI response in real-time from mobile app
3. **Check File Changes**: Check file contents modified by AI

### How CLI Mode Works

When you send a prompt:

1. **Extension executes `agent` command**:

   ```bash
   agent -p --output-format json --force "prompt"
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
[CLI] sendPrompt called - textLength: XX, execute: true
[CLI] Using CLI command: /Users/xxx/.local/bin/agent
[CLI] Executing: /Users/xxx/.local/bin/agent -p --output-format json --force "prompt"
[CLI] CLI stdout: {...}
[CLI] CLI process exited with code 0
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
- Allow port 8766 in PC firewall
- Verify PC IP address is correct (same network)

---

## Tech Stack

- **Cursor Extension**: TypeScript, VSCode Extension API, WebSocket (8766), RelayClient
- **Mobile App**: Flutter, Dart
- **Relay Server** (optional): Vercel, Redis (Upstash)

---

## Documentation

- [PROTOCOL.md](./PROTOCOL.md) - WebSocket message format and protocol
- [USER_MANUAL.md](./USER_MANUAL.md) - Installation, setup, and usage
- [cursor-extension/README.md](./cursor-extension/README.md) - Extension setup and publishing
- [relay-server/README.md](./relay-server/README.md) - Relay server deployment

---

## Development Roadmap

### Phase 1: Basic Communication Infrastructure

- [ ] Cursor Extension development (WebSocket server)
- [ ] PC server development (bridge)
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

- **Author**: 김형진 (<jaloveeye@gmail.com>)
- **Website**: <https://jaloveeye.com>
- **GitHub**: <https://github.com/jaloveeye/cursor-remote>
- **Issues**: [GitHub Issues](https://github.com/jaloveeye/cursor-remote/issues)

---

## 🇰🇷 한국어

**모바일 기기에서 Cursor AI를 제어하세요!**

Cursor Remote는 모바일 기기에서 Cursor AI를 원격으로 제어할 수 있게 해주는 오픈소스 시스템입니다. Flutter 앱을 통해 PC의 Cursor CLI에 명령을 전송하고, AI 응답과 작업 결과를 실시간으로 확인할 수 있습니다. 스마트폰이나 태블릿에서 어디서든 Cursor CLI를 사용하여 코딩하세요!

### 주요 특징

- 📱 **모바일 제어**: 스마트폰이나 태블릿에서 Cursor AI 제어
- ⚡ **실시간 통신**: WebSocket 기반 양방향 실시간 통신
- 🤖 **CLI 통합**: Cursor CLI(`agent`)를 통한 AI 상호작용
- 🔄 **자동 동기화**: 모바일에서 입력한 내용이 PC에 실시간 반영
- 🌐 **크로스 플랫폼**: Android, iOS, Web 지원
- 🔒 **오픈소스**: MIT 라이선스, 자유롭게 사용 및 수정 가능
- 💬 **AI 채팅**: 모바일에서 Cursor AI와 실시간 대화
- 📝 **코드 편집**: 모바일에서 코드 작성 및 편집
- 🌍 **릴레이 모드**: 같은 네트워크가 아니어도 릴레이 서버를 통해 연결
- 🔐 **페어링된 기기만**: 5분짜리 일회용 페어링 코드, 24시간 릴레이 세션, 요청 단위 승인

### 왜 Cursor Remote인가?

#### 해결하는 문제

- 🏠 **집에서 편안하게**: 소파에 누워서도 모바일로 코드를 작성하고 AI와 대화
- 🚇 **이동 중에도**: 지하철이나 버스에서도 모바일로 간단한 코드 수정이나 AI 질문
- 💻 **PC 없이도**: Cursor CLI 모드를 사용하면 PC에 Cursor IDE가 실행되지 않아도 AI와 상호작용
- 🔄 **실시간 동기화**: 모바일에서 입력한 내용이 PC의 Cursor CLI에 실시간 반영
- 🤖 **AI 응답 확인**: Cursor AI의 응답을 모바일에서 실시간으로 확인

#### 사용 사례

- **원격 개발**: 집이나 카페에서 모바일로 코드 작성 및 AI 질문
- **빠른 수정**: 외출 중에도 긴급한 코드 수정이나 버그 확인
- **AI 상호작용**: 모바일에서 Cursor AI와 대화하며 아이디어 구상
- **자동화**: CLI 모드를 통한 스크립트 및 CI/CD 통합
- **프레젠테이션**: 모바일에서 코드를 보여주며 설명

### 주요 기능

- 📝 **원격 코드 편집**: 모바일에서 Cursor AI에게 코드 작성 요청
- ⚡ **명령 실행**: Cursor CLI 명령을 모바일에서 실행
- 🤖 **AI 응답 확인**: Cursor AI의 응답을 모바일에서 실시간 확인
- 📊 **작업 결과 표시**: 파일 편집, 빌드 결과 등을 모바일에서 확인
- 🔐 **권한 관리**: 파일 접근, 명령 실행 등에 대한 권한 요청 및 응답
- 🔄 **실시간 통신**: WebSocket 기반 양방향 실시간 통신
- 🖥️ **CLI 모드**: Cursor CLI(`agent` 명령어)를 통해 AI와 통신

### 아키텍처

**로컬 모드**: 모바일/웹 앱이 Extension WebSocket(8766)에 직접 연결.

**릴레이 모드**: 앱 ↔ 릴레이 서버 ↔ Extension(RelayClient). PC 서버는 사용하지 않습니다. Mac이 세션(24시간 유효)을 만들고, 휴대폰은 일회용 페어링 코드로 참여합니다.

#### 연결 모드

| 모드 | 설명 | 네트워크 요구사항 |
|------|------|------------------|
| **로컬 모드** | PC와 모바일이 같은 Wi-Fi에 연결 | 동일 네트워크 |
| **릴레이 서버 모드** | 릴레이 서버를 통한 외부 접속 | 인터넷 연결 |

### 프로젝트 구조

```
cursor-remote/
├── cursor-extension/    # Cursor Extension (TypeScript)
│   ├── src/
│   │   ├── extension.ts
│   │   ├── websocket-server.ts
│   │   ├── command-handler.ts
│   │   └── cli-handler.ts      # CLI 모드 핸들러
│   ├── package.json
│   └── README.md
├── relay-server/       # 릴레이 서버 (Vercel, 원격 모드용)
├── mobile-app/         # 모바일 앱 (Flutter)
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

## 설치 및 설정

### 사전 요구사항

| 구성 요소 | 요구사항 |
|-----------|----------|
| **PC** | Node.js 18+ |
| **모바일** | Android 또는 iOS 기기 |
| **Cursor CLI** | 설치 및 인증 필수 |

### Step 1: Cursor CLI 설치 및 인증

CLI 모드를 사용하기 위해 먼저 Cursor CLI를 설치하고 인증해야 합니다.

#### 1.1 CLI 설치

```bash
curl https://cursor.com/install -fsS | bash
```

이 명령어는 `~/.local/bin/` 디렉토리에 CLI를 설치합니다.

#### 1.2 PATH 설정

**Zsh 사용자 (macOS 기본):**

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**Bash 사용자:**

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

#### 1.3 설치 확인

```bash
which agent
# 또는
agent --version
```

#### 1.4 인증 (필수)

**방법 1: 브라우저 로그인 (권장)**

```bash
agent login
```

브라우저가 열리면 Cursor 계정으로 로그인합니다. 인증 정보는 저장되므로 한 번만 로그인하면 됩니다.

**방법 2: API 키 사용 (자동화/CI용)**

```bash
# Cursor 웹사이트에서 API 키 생성 후
export CURSOR_API_KEY=your_api_key_here

# 영구 설정 (선택사항)
echo 'export CURSOR_API_KEY=your_api_key_here' >> ~/.zshrc
source ~/.zshrc
```

#### 1.5 인증 상태 확인

```bash
agent status
```

인증이 완료되면:

```
✅ Authenticated as: your-email@example.com
```

#### 1.6 CLI 테스트

```bash
agent -p --output-format json --force 'Hello, world!'
```

정상적으로 JSON 응답이 출력되면 CLI 설정 완료입니다.

---

### Step 2: Cursor Extension 설치

#### 2.1 Extension 빌드

```bash
cd cursor-extension
npm install
npm run compile
```

#### 2.2 Cursor IDE에서 Extension 활성화

1. **Cursor IDE 실행**
2. **Extension 자동 활성화** (상태 표시줄에 구름 아이콘 확인)
3. **또는 수동 시작**: 명령 팔레트 (`Cmd+Shift+P` / `Ctrl+Shift+P`) → "Cursor Remote: Start Server"

#### 2.3 활성화 확인

- 상태 표시줄에 "Remote :8766" (준비됨) 또는 "Remote · 1 device" (연결됨) 표시 확인
- Output 패널에서 "Cursor Remote extension is now active!" 메시지 확인

---

### Step 3: 모바일 앱 설치

#### 3.1 빌드 및 설치

**Android:**

```bash
cd mobile-app
flutter pub get
flutter build apk --release
# 생성된 APK 파일을 Android 기기에 설치
```

**iOS:**

```bash
cd mobile-app
flutter pub get
cd ios && export LANG=en_US.UTF-8 && pod install && cd ..
flutter build ios
# Xcode에서 실행 또는 TestFlight 배포
```

**개발 중 테스트:**

```bash
# USB로 연결된 기기에서 직접 실행
flutter run
```

---

## 연결 설정

### 세션 제어 켜기

Extension은 `127.0.0.1:9222`의 Chrome DevTools Protocol로 Cursor Agents 창을 제어합니다 (네트워크에
노출되지 않음).

1. 설정 → **Cursor Remote: Enable Cdp** 켜기 (`"cursorRemote.enableCdp": true`)
2. 명령 팔레트 → **Cursor Remote: Restart Cursor with Session Control**. 저장하지 않은 파일을 확인한 뒤
   Cursor가 종료되고 세션 제어가 켜진 상태로 다시 열립니다.

세션 제어가 꺼져 있으면 휴대폰에서 채팅은 읽을 수 있지만 전송·중지·승인은 할 수 없습니다.

### 로컬 모드 (동일 Wi-Fi 네트워크)

1. Extension이 포트 **8766**(창이 여러 개면 8767…)에서 서버를 시작하고 상태줄에 `Remote :8766`이 표시됩니다.
2. 상태줄 클릭 → **Pair a device** (**Cursor Remote: Pair Client**). 코드가 복사되며 한 번만 쓸 수 있고
   5분 후 만료됩니다.
3. 앱에서 **Local** → Mac IP와 포트 입력 → 연결 → 코드 붙여넣기.

브라우저 출처는 `cursorRemote.allowedWebSocketOrigins`에 있어야 합니다. `https://` 웹 앱에서는 로컬
`ws://` 연결이 막히므로 릴레이를 사용하세요. Mac 방화벽에서 포트를 허용하세요.

### 릴레이 모드 (다른 네트워크)

1. 상태줄 클릭 → **Connect to relay…** (**Cursor Remote: Connect to Relay by Session ID**) → 6자리 세션
   ID 입력 (Enter를 누르면 마지막 ID 재사용).
2. **Cursor Remote: Pair Relay Client** 실행. 코드가 복사되고 세션 ID와 함께 표시됩니다.
3. 앱에서 **Relay** → 세션 ID 입력 → 코드 붙여넣기.

| 항목 | 동작 |
|------|------|
| **세션 유효기간** | 24시간. 만료되거나 이미 사용된 ID이면 새 ID로 바뀌고 다시 페어링합니다. 한 번 쓴 ID는 재사용할 수 없습니다. |
| **페어링 코드** | 일회용, 5분 후 만료 |
| **자격 증명** | 256비트 capability 토큰, 릴레이에는 해시만 저장 |
| **메시지** | 5분 후 만료, 응답은 요청한 휴대폰에만 전달 |
| **연결 상태** | Extension의 폴링으로 Mac이 "연결됨"으로 유지되고, 약 2분간 폴링하지 않은 휴대폰은 세션에서 제외 |
| **재시작** | Cursor를 다시 시작하면 한 창이 마지막 세션에 자동으로 다시 연결 |

| 명령어 | 설명 |
|--------|------|
| `Cursor Remote: Connect to Relay by Session ID` | 이 Mac을 릴레이 세션에 연결 |
| `Cursor Remote: Pair Relay Client` | 휴대폰용 일회용 코드 |
| `Cursor Remote: Start New Relay Session` | 현재 세션을 폐기하고 새 세션 시작 |
| `Cursor Remote: Revoke Relay Session` | 현재 세션 폐기 |
| `Cursor Remote: Set Relay Session ID` | 저장된 세션 ID 변경 |

### Mac 깨어 있게 하기

Mac이 깨어 있고 온라인일 때만 휴대폰이 Cursor에 접근할 수 있습니다. 자리를 비울 때는 터미널에서
`caffeinate -dimsu`를 실행하세요 (Ctrl+C로 종료). Mac이 약 2분 이상 잠들면 릴레이는 Mac을 오프라인으로
봅니다.

---

## 사용 방법

### 기본 사용

1. **프롬프트 전송**: 모바일 앱의 입력창에 텍스트 입력 후 전송
2. **AI 응답 확인**: 모바일 앱에서 실시간으로 AI 응답 확인
3. **파일 변경 확인**: AI가 수정한 파일 내용 확인

### CLI 모드 작동 방식

프롬프트를 전송하면:

1. **Extension이 `agent` 명령어 실행**:

   ```bash
   agent -p --output-format json --force "프롬프트"
   ```

2. **CLI가 응답 생성**
3. **Extension이 응답 파싱 후 모바일 앱으로 전송**
4. **프로세스 종료**

### CLI 로그 확인

Cursor IDE의 Output 패널에서 "Cursor Remote" 채널을 선택하면 다음과 같은 로그를 확인할 수 있습니다:

```
[CLI] sendPrompt called - textLength: XX, execute: true
[CLI] Using CLI command: /Users/xxx/.local/bin/agent
[CLI] Executing: /Users/xxx/.local/bin/agent -p --output-format json --force "프롬프트"
[CLI] CLI stdout: {...}
[CLI] CLI process exited with code 0
```

---

## 통신 프로토콜

앱, 릴레이, Extension은 프로토콜 v2를 사용합니다: 페어링된 기기 토큰, `id`와 `deadline`이 있는 타입별
명령, 일반 명령 실행 없음. 자세한 내용은 [PROTOCOL.md](./PROTOCOL.md)를 참고하세요.

| 포트 | 프로토콜 | 용도 |
|------|----------|------|
| 8766+ | WebSocket | 모바일/웹 앱 ↔ Extension (로컬 모드) |
| 9222 | CDP (loopback 전용) | Extension ↔ Cursor 창 |

---

## 문제 해결

### CLI 관련 문제

#### "command not found: agent" 오류

```bash
# 1. PATH 확인
echo $PATH | grep local

# 2. 직접 경로로 실행
~/.local/bin/agent --version

# 3. 심볼릭 링크 생성 (선택사항)
sudo ln -s ~/.local/bin/agent /usr/local/bin/agent
```

#### 인증 오류

```bash
# 로그아웃 후 다시 로그인
agent logout
agent login
```

### Extension 관련 문제

#### Extension이 시작되지 않는 경우

- Cursor IDE 재시작
- `npm run compile` 다시 실행
- Output 패널에서 에러 메시지 확인

### 서버 관련 문제

#### 모바일 앱이 Extension에 연결되지 않는 경우 (로컬 모드)

```bash
# 포트 8766 충돌 확인
lsof -i :8766
```

### 모바일 앱 관련 문제

#### 연결되지 않는 경우

- PC와 모바일이 같은 Wi-Fi 네트워크에 있는지 확인
- PC 방화벽에서 WebSocket 포트 허용 (기본 8766, 충돌 시 8767~8776)
- PC IP 주소가 올바른지 확인 (동일 네트워크)
- 모바일 앱의 로컬 포트 입력값이 Extension 실제 포트와 같은지 확인

---

## 기술 스택

- **Cursor Extension**: TypeScript, VSCode Extension API, WebSocket (8766), RelayClient
- **Mobile App**: Flutter, Dart
- **Relay Server** (optional): Vercel, Redis (Upstash)

---

## 문서

- [PROTOCOL.md](./PROTOCOL.md) - 통신 프로토콜
- [USER_MANUAL.md](./USER_MANUAL.md) - 사용자 매뉴얼
- [cursor-extension/README.md](./cursor-extension/README.md) - Extension 가이드
- [relay-server/README.md](./relay-server/README.md) - Relay 서버 가이드
- [relay-server/TEST_PLAN.md](./relay-server/TEST_PLAN.md) - Relay 테스트 계획
- [relay-server/MAINTENANCE.md](./relay-server/MAINTENANCE.md) - Relay 운영 점검
- [mobile-app/README.md](./mobile-app/README.md) - Mobile 앱 가이드

---

## 개발 계획

### Phase 1: 기본 통신 인프라

- [ ] Cursor Extension 개발 (WebSocket 서버)
- [ ] Extension 중심 로컬/릴레이 연결 안정화
- [ ] 모바일 앱 기본 UI
- [ ] 기본 명령 전송 (텍스트 삽입)

### Phase 2: 고급 기능

- [ ] AI 응답 스트리밍
- [ ] 파일 편집 기능
- [ ] 작업 결과 표시
- [ ] 권한 요청 시스템

### Phase 3: UX 개선

- [ ] 실시간 로그 표시
- [ ] 에러 처리 및 재시도
- [ ] 연결 상태 관리
- [ ] 대화 히스토리

---

## 기여하기

기여를 환영합니다! 버그 리포트, 기능 제안, Pull Request 모두 환영합니다.

1. 이 저장소를 Fork합니다
2. 기능 브랜치를 생성합니다 (`git checkout -b feature/amazing-feature`)
3. 변경사항을 커밋합니다 (`git commit -m 'feat: Add amazing feature'`)
4. 브랜치에 푸시합니다 (`git push origin feature/amazing-feature`)
5. Pull Request를 엽니다

### 기여 가이드라인

- 코드 스타일을 유지해주세요
- 의미 있는 커밋 메시지를 작성해주세요
- 새로운 기능은 테스트를 포함해주세요
- 문서를 업데이트해주세요

## 라이선스

이 프로젝트는 MIT 라이선스 하에 배포됩니다. 자세한 내용은 [LICENSE](LICENSE) 파일을 참조하세요.

## 문의 및 지원

- **Author**: 김형진 (<jaloveeye@gmail.com>)
- **Website**: <https://jaloveeye.com>
- **GitHub**: <https://github.com/jaloveeye/cursor-remote>
- **Issues**: [GitHub Issues](https://github.com/jaloveeye/cursor-remote/issues)

---

**Made with ❤️ by [jaloveeye](https://jaloveeye.com)**

**작성 시간**: 2026년 1월 21일  
**최종 수정**: 2026년 10월 8일 (0.5.0: 세션 제어, 페어링 코드, 24시간 릴레이 세션, 프로토콜 v2)
