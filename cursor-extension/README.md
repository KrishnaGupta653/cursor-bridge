# Cursor Remote 📱

[![Version](https://img.shields.io/badge/version-0.5.0-blue.svg)](https://github.com/jaloveeye/cursor-remote)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Watch and control Cursor's Agents window from your phone or Telegram**

---

## 🇺🇸 English

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
   [Releases](https://github.com/jaloveeye/cursor-remote/releases) and use
   `Extensions` → `...` → `Install from VSIX...`.
2. Optional, for CLI prompts: install and sign in to the Cursor CLI
   (`curl https://cursor.com/install -fsS | bash`, then `agent login`).

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
and no generic command execution. See [PROTOCOL.md](https://github.com/jaloveeye/cursor-remote/blob/main/PROTOCOL.md).

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

- **Author**: 김형진 (<jaloveeye@gmail.com>)
- **Website**: <https://jaloveeye.com>
- **GitHub**: <https://github.com/jaloveeye/cursor-remote>
- **Issues**: [GitHub Issues](https://github.com/jaloveeye/cursor-remote/issues)

---

## 🇰🇷 한국어

Cursor Remote는 Cursor **Agents 창**의 채팅을 휴대폰에서 Agents 창과 비슷한 화면으로 보여줍니다.
휴대폰에서 채팅을 읽고, 프롬프트를 보내고, 모델·모드를 바꾸고, 에이전트를 멈추고, 요청을 승인·거절할
수 있습니다. 텔레그램 봇으로도 같은 기능을 쓸 수 있습니다.

### 설치

1. Cursor 확장 탭(`Cmd+Shift+X`)에서 "Cursor Remote"를 검색해 설치합니다. 또는
   [Releases](https://github.com/jaloveeye/cursor-remote/releases)의 `.vsix`를
   `확장` → `...` → `VSIX에서 설치...`로 설치합니다.
2. CLI 프롬프트를 쓰려면 Cursor CLI를 설치하고 로그인합니다 (`agent login`).

### 설정

#### 1. 세션 제어 켜기

Cursor Remote는 `127.0.0.1:9222`의 Chrome DevTools Protocol로 Cursor 창을 제어합니다. 이 포트는
네트워크에 노출되지 않습니다.

1. 설정 → **Cursor Remote: Enable Cdp** 켜기 (`"cursorRemote.enableCdp": true`)
2. 명령 팔레트 → **Cursor Remote: Restart Cursor with Session Control**. 저장하지 않은 파일을 확인한
   뒤 Cursor가 종료되고 세션 제어가 켜진 상태로 다시 열립니다.

세션 제어가 꺼져 있으면 휴대폰에서 채팅은 읽을 수 있지만 전송·중지·승인은 할 수 없습니다.

#### 2a. 같은 Wi-Fi에서 연결

1. 서버는 자동으로 시작되고 상태줄에 `Remote :8766`이 표시됩니다.
2. 상태줄 클릭 → **Pair a device**. 일회용 코드가 복사되며 5분 후 만료됩니다.
3. 앱에서 **Local** → Mac 주소와 포트 입력 → 연결 → 코드 붙여넣기.

`https://` 웹 앱에서는 로컬 `ws://` 연결이 막히므로 릴레이를 사용하세요.

#### 2b. 다른 네트워크에서 연결 (릴레이)

1. 상태줄 클릭 → **Connect to relay…** (또는 **Cursor Remote: Connect to Relay by Session ID**) →
   6자리 세션 ID 입력 (Enter를 누르면 마지막 ID 재사용).
2. **Cursor Remote: Pair Relay Client** 실행. 코드가 복사되고 세션 ID와 함께 표시됩니다.
3. 앱에서 **Relay** → 세션 ID 입력 → 코드 붙여넣기.

- 세션은 **24시간** 유지됩니다. 만료되거나 이미 사용된 ID이면 새 ID로 바뀌고 휴대폰을 다시
  페어링합니다. 한 번 쓴 ID는 다시 쓸 수 없습니다.
- 페어링 코드는 한 번만 쓸 수 있고 **5분** 후 만료됩니다.
- 선택 설정 `cursorRemote.reusablePairingCode`: 세션 전체에 코드 하나(최대 3대), Pair Relay Client를 다시
  실행하면 같은 코드를 보여 줍니다. 코드를 본 사람은 세션이 끝나거나 새 세션을 시작할 때까지 접속할 수
  있으니 공유하지 마세요. 기기가 참여할 때마다 알림이 뜹니다.
- 앱은 세션이 끝나거나 앱에서 **Log out**할 때까지 새로 고침·재시작 후에도 로그인을 유지합니다.
- Cursor를 다시 시작하면 한 창이 마지막 세션에 자동으로 다시 연결됩니다.
- **Start New Relay Session**은 현재 세션을 폐기하고 새 코드를 보여주고, **Revoke Relay Session**은
  폐기만 합니다.

#### 3. Mac 깨어 있게 하기

자리를 비울 때는 터미널에서 다음을 실행하세요 (Ctrl+C로 종료):

```bash
caffeinate -dimsu
```

Mac이 약 2분 이상 잠들면 릴레이는 Mac을 오프라인으로 보고 휴대폰이 접속할 수 없습니다.

#### 4. 텔레그램 (선택)

**Cursor Remote: Edit Telegram Settings**로 `~/.config/cursor-remote/telegram.json`을 엽니다.
`botToken`, `allowedUserIds`, `allowedChatIds`를 설정하세요 (두 목록 모두 필수).

### 원격 작업과 감사 로그

`cursorRemote.remoteActions`가 `enabled`이면 휴대폰·텔레그램에서 채팅 열기/새 채팅, 모델·모드 변경,
중지, 승인·거절을 할 수 있습니다. 승인·거절은 항상 확인 탭이 필요하고 화면에 표시된 바로 그 요청에만
적용됩니다. 모든 작업은 **Cursor Remote** 출력에 `[Audit]` 줄로 기록됩니다.

### 라이선스

MIT License. [LICENSE](LICENSE) 참고.

---

**Cursor Remote**로 어디서든 코딩하세요! 🚀
