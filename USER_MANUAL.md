# Cursor Remote User Manual

**The complete guide to controlling Cursor IDE remotely from your phone**

---

## Table of Contents

1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Connection Modes Compared](#3-connection-modes-compared)
4. [Installing the Cursor Extension](#4-installing-the-cursor-extension)
5. [Connecting with the Local Server](#5-connecting-with-the-local-server)
6. [Connecting through the Relay Server](#6-connecting-through-the-relay-server)
7. [Mobile App Setup](#7-mobile-app-setup)
8. [Cursor 2.4 Features](#8-cursor-24-features)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Overview

### What is Cursor Remote?

Cursor Remote lets you control Cursor IDE on your PC remotely from a mobile device.

**Key features:**
- 📱 See the chat list, live responses and changed files of Cursor's **Agents window** on your phone
- 📝 Send prompts to a specific chat, change model and mode, stop the agent
- ✅ Approve or reject exactly the request shown on screen (confirmation tap required, recorded in the audit log)
- 🌍 Connect from anywhere in relay mode (no same network required)
- 🔐 Single-use 5-minute pairing codes, 24-hour relay sessions

### System Components

| Component | Description |
|-----------|-------------|
| **Cursor Extension** (`cursor-extension/`) | VS Code/Cursor extension, ID `krishnagupta653.cursor-remote-extension` |
| **Relay Server** (`relay-server/`) | Vercel + Upstash Redis, default <https://cursor-remote-rela.vercel.app> |
| **Mobile App** (`mobile-app/`) | Flutter app for Android/iOS, also deployed as the web app <https://cursor-remote-app.vercel.app> |

```
┌─────────────┐                    ┌─────────────┐                    ┌─────────────┐
│   Mobile    │◄───────────────────►│   Server    │◄───────────────────►│  Cursor IDE │
│     App     │     WebSocket       │  (Local or  │     Extension API   │  Extension  │
└─────────────┘                     │   Relay)    │                     └─────────────┘
                                    └─────────────┘
```

---

## 2. Prerequisites

### PC Environment

| Item | Requirement |
|------|-------------|
| OS | Windows, macOS, Linux |
| Cursor IDE | Latest version installed |
| Cursor CLI | Installed and authenticated (when using CLI mode) |
| Node.js | v18 or later recommended |
| npm | Installed with Node.js |

### Installing and Authenticating Cursor CLI

To use CLI mode, install and authenticate Cursor CLI.

#### Install the CLI

```bash
curl https://cursor.com/install -fsS | bash
```

This command installs Cursor CLI in the `~/.local/bin/` directory.

#### Configure PATH

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

#### Verify the installation

```bash
which agent
# or
agent --version
```

#### Authenticate (required)

```bash
agent login
```

A browser opens and you log in with your Cursor account. Authentication is saved, so you only need to log in once.

#### Check authentication status

```bash
agent status
```

When authenticated you will see:
```
✅ Authenticated as: your-email@example.com
```

#### Test the CLI

```bash
agent -p --output-format json --force 'Hello, world!'
```

If a JSON response is printed, the CLI is set up.

### Mobile Environment

| Item | Requirement |
|------|-------------|
| Android | 5.0 or later |
| iOS | 12.0 or later |
| Network | Wi-Fi or mobile data |

### Network Requirements

| Connection mode | Network condition |
|-----------------|-------------------|
| Local server | PC and phone on the **same Wi-Fi** network |
| Relay server | Only an internet connection is needed (any network) |

---

## 3. Connection Modes Compared

Cursor Remote supports two connection modes.

### Local Server vs Relay Server

| Property | Local server | Relay server |
|----------|--------------|--------------|
| **Network** | Same Wi-Fi required | Connect from anywhere |
| **Response speed** | ⚡ Very fast | 🔄 Slight delay |
| **Setup difficulty** | Easy | Slightly more involved |
| **Security** | Stays on the local network | Internet traffic (encrypted) |
| **Server management** | Runs directly on the PC | Uses Vercel cloud |
| **Access from outside** | ❌ Not possible | ✅ Possible |

### Which one should I choose?

**Local server is recommended when:**
- You are on the same Wi-Fi at home or in the office
- Fast responses matter
- You want the simplest setup

**Relay server is recommended when:**
- You need to reach your PC from outside
- You are on mobile data
- The phone and PC are on different networks

---

## 4. Installing the Cursor Extension

> ⚠️ **Important**: The extension is **always required**, for both the local server and the relay server.

> 📝 **Upgrading from 0.5.x**: the extension ID is now `krishnagupta653.cursor-remote-extension`.
> Uninstall the old extension first, then pair your phone and enter the Telegram settings again.
> See "Upgrading to 0.6.0" in the [README](./README.md#upgrading-to-060).

### Step 1: Download the source code

```bash
# Clone the project
git clone https://github.com/KrishnaGupta653/cursor-bridge.git
cd cursor-bridge
```

### Step 2: Compile the extension

```bash
cd cursor-extension
npm install
npm run compile
```

### Step 3: Load the extension in Cursor IDE

**Option A: Load in developer mode (recommended)**

1. Launch Cursor IDE
2. `Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Windows/Linux)
3. Search for and select "Developer: Install Extension from Location..."
4. Select the `cursor-extension` folder

**Option B: Run the development host with F5**

1. Open the `cursor-extension` folder in VS Code/Cursor
2. Press `F5` to launch the Extension Development Host
3. A new window opens with the extension active

### Step 4: Verify the extension is active

When the extension is active, the status bar (bottom right) shows:

| Status | Meaning |
|--------|---------|
| 📡 **Remote :8766** | Server running (port shown), no devices connected. A `●` means the Telegram bot is running in this window |
| 📡 **Remote · 1 device** | Device connected (shows `relay <session ID>` when connected through the relay) |
| 🚫 **Remote off** | Server stopped |

Click the status bar item to open the menu with every action: device pairing, Telegram, tunnel, logs, and more.

**If the status bar item is missing:**
- Run "Cursor Remote: Start Server" from the Command Palette (`Cmd+Shift+P`)

### Cursor IDE Settings

#### Open settings

**Fastest way:**
- `Cmd + ,` (Mac) / `Ctrl + ,` (Windows/Linux)

**Or from the menu:**
- Menu bar → Cursor → Settings → Settings

**Or from the Command Palette:**
- `Cmd+Shift+P` → "Preferences: Open Settings"

#### Find the Cursor Remote settings

Type `Cursor Remote` or `cursorRemote` in the settings search box.

**Main settings:**
- **Cursor Remote: Enable Cdp** (`cursorRemote.enableCdp`) - allow session control (required to control the Agents window)
- **Cursor Remote: Remote Actions** (`cursorRemote.remoteActions`) - `disabled` turns off opening chats/new chats, model and mode changes, stop, and approve/reject from the phone and Telegram
- **Cursor Remote: Relay Server Url** (`cursorRemote.relayServerUrl`) - set only when you use your own relay deployment
- **Cursor Remote: Allowed Web Socket Origins** (`cursorRemote.allowedWebSocketOrigins`) - browser origins allowed in local mode

#### Turn on session control (required)

The extension controls Cursor's Agents window through the Chrome DevTools Protocol on `127.0.0.1:9222`.
This port is never exposed to the network.

1. Turn on **Cursor Remote: Enable Cdp** in settings:

   ```json
   {
     "cursorRemote.enableCdp": true
   }
   ```

2. `Cmd+Shift+P` → **Cursor Remote: Restart Cursor with Session Control**. Cursor asks about unsaved
   files, quits, and reopens with session control on.

Without session control the phone can read chats but cannot send, stop or approve. If Cursor was opened
normally, the extension offers the restart once.

---

## 5. Connecting with the Local Server

### Architecture

```
Phone / Web app  ⇄  WebSocket ws://<Mac IP>:8766  ⇄  Cursor Extension  ⇄  CDP 127.0.0.1:9222  ⇄  Agents window

* Default port is 8766; with several Cursor windows, 8767–8776 are used
* The PC and phone must be on the same Wi-Fi network
```

### Step 1: Check the extension is running

1. Launch Cursor IDE
2. Look for "Remote :8766" or "Remote · 1 device" in the status bar
3. If missing: `Cmd+Shift+P` → "Cursor Remote: Start Server"

### Step 2: Pair the device

1. Click the status bar → **Pair a device** (or `Cmd+Shift+P` → **Cursor Remote: Pair Client**)
2. A single-use code is copied to the clipboard, shown together with the address and port to enter
3. The code works **once** and expires after **5 minutes**

### Step 3: Connect the mobile app

1. Choose **Local** in the app
2. **Mac address**: IP of the Mac running Cursor (e.g. `192.168.0.10`; on macOS use `ipconfig getifaddr en0`)
3. **Port**: the extension's actual port (default `8766`)
4. **Connect** → paste the pairing code

A paired device reconnects without a code for 24 hours. **Cursor Remote: Revoke All Paired Clients**
signs out every device.

> 📝 When connecting from a browser, the web app's origin must be in `cursorRemote.allowedWebSocketOrigins`
> (Pair Client offers to add the current origin). An `https://` web app cannot open a local `ws://`
> connection, so use the relay instead.

### Step 4: Confirm the connection

- Mobile app: the Agents sidebar (chat list) appears
- Cursor status bar: "Remote · 1 device"
- Output panel: `Client connected` log line

### Port Information

| Port | Protocol | Purpose |
|------|----------|---------|
| 8766 | WebSocket | Mobile app ↔ Extension (default port; 8767–8776 with several Cursor windows) |
| 9222 | CDP (127.0.0.1 only) | Extension ↔ Cursor windows |

---

## 6. Connecting through the Relay Server

### Architecture

```
Phone / Web app  ⇄  HTTPS polling  ⇄  Vercel relay (Upstash Redis)  ⇄  HTTPS polling  ⇄  Cursor Extension

* Works even when the PC and phone are on different networks
* Default relay: https://cursor-remote-rela.vercel.app
```

### Step 1: Connect the Mac to a session

1. Click the status bar → **Connect to relay…** (or `Cmd+Shift+P` → **Cursor Remote: Connect to Relay by Session ID**)
2. Enter a 6-character alphanumeric session ID (e.g. `ABC123`). Pressing Enter alone reuses the last session ID
3. Once connected, a "connected to relay session" notification appears

### Step 2: Pair the phone

1. `Cmd+Shift+P` → **Cursor Remote: Pair Relay Client**
2. The pairing code is copied and shown with the session ID. The code works **once** and expires after **5 minutes**
3. In the app choose **Relay** → enter the session ID → paste the pairing code

### Staying logged in and logging out

- The app stores its login on the device until the session ends (the browser's localStorage on the web).
  Refreshing the page or restarting the app shows "Connecting…" and reconnects without a code
- **Log out**: at the bottom of the Agents sidebar, the top-bar logout button, or Settings. After you confirm,
  it revokes this phone's login on the relay and deletes the stored login. If the relay cannot be reached,
  the login is still deleted on the phone, and the relay's copy expires when the session ends
- When the session ends (24 hours, **Start New Relay Session**, **Revoke Relay Session**) the app says
  "This relay session ended…" and asks for a new pairing code. On network errors or when the Mac is not
  connected (409) the app keeps the login and retries
- Always log out after using a shared device. The stored login can be read by anyone with access to this app
  (on the web, the same site) and the device

### Reusable pairing code (optional)

Turn on `cursorRemote.reusablePairingCode` to use one pairing code for the whole session.

- Up to **3 devices** can pair, and the code expires when the session ends. Running Pair Relay Client again shows
  the same code with the remaining uses and time
- **Risk**: anyone who sees the code can join until the session ends or you start a new session. Do not share it
- Every time a device joins, an "A new device joined relay session …" notification appears. If you don't recognise
  the device, press **Start New Relay Session** in the notification to revoke all devices and the code
- After all 3 uses the app shows "This pairing code was used on 3 devices…", and Pair Relay Client creates a new code
- Turning the setting off does not cancel a code already shown. To cancel it, run **Start New Relay Session**
- If the relay does not support reusable codes, a single-use code is issued

### Session Rules

| Item | Behaviour |
|------|-----------|
| Session lifetime | **24 hours**. Afterwards, or if the ID is already taken, the extension switches to a new random ID and you pair the phone again. An ID is never reused. |
| Pairing codes | Single use, expire after 5 minutes (with the reusable code on, up to 3 devices per session). A failed join does not use up the code |
| Credentials | 256-bit capability tokens, stored only as hashes on the relay |
| Messages | Expire after 5 minutes; replies go only to the phone that asked |
| Mac liveness | Refreshed on every extension poll (every 2 seconds while a phone is active, 25 seconds when idle). If there is no poll for more than 2 minutes, phones cannot join |
| Phones | Phones that stop polling for about 2 minutes are removed from the session |
| Cursor restart | One window reconnects to the last session automatically. Running a relay command in another window tells you a different window is already connected |

### Commands

| Command | Description |
|---------|-------------|
| `Cursor Remote: Connect to Relay by Session ID` | Connect this Mac to a relay session |
| `Cursor Remote: Pair Relay Client` | Pairing code for the phone (single use, or the session's reusable code when enabled) |
| `Cursor Remote: Start New Relay Session` | Revoke the current session and start a new one (pair phones again) |
| `Cursor Remote: Revoke Relay Session` | Revoke the current session |
| `Cursor Remote: Set Relay Session ID` | Change the saved session ID |

### Keep the Mac awake

The phone can only reach Cursor while the Mac is awake and online. While you are away, run this in a
terminal (Ctrl+C to stop):

```bash
caffeinate -dimsu
```

### Deploying your own relay (optional)

To use your own relay instead of the default one, follow [relay-server/README.md](./relay-server/README.md)
(Upstash Redis + Vercel, environment variables `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`) and
deploy from `relay-server` with `vercel --prod`. Then change `cursorRemote.relayServerUrl` in the Cursor
settings and the relay URL in the app.

---

## 7. Mobile App Setup

### Build and install the app

```bash
cd mobile-app
flutter pub get
flutter build apk        # Android
flutter build ios        # iOS
```

### Web app

A hosted web app is available at <https://cursor-remote-app.vercel.app>. To deploy your own, build locally
(Vercel cannot build Flutter) and deploy from `mobile-app/build/web`:

```bash
cd mobile-app
flutter build web --release
cp vercel-build-output.json build/web/vercel.json
cd build/web
vercel --prod
```

### Connection screen

| Item | Local | Relay |
|------|-------|-------|
| Input | Mac IP + port (default 8766) | Session ID (6 characters) |
| Pairing | **Pair Client** code | **Pair Relay Client** code |
| Web app (https) | Not available | Available |

### Basic usage

1. **Pick a chat**: open a chat from the Agents sidebar. New responses appear in real time
2. **Send a prompt**: type in the input box and send. If something is already being typed in the Mac's input box, the prompt is rejected instead of overwriting it
3. **Change model/mode, stop**: use the menus at the top of the chat screen and in the input box
4. **Approve/reject**: a card appears when the agent is waiting on a request. After a confirmation step, the decision applies only to that request
5. Every remote action is recorded as an `[Audit]` line in Cursor's **Cursor Remote** output

---

## 8. Cursor 2.4 Features

Cursor Remote is fully compatible with the new features of Cursor 2.4.

### Compatibility verified

| Feature | Status | Notes |
|---------|--------|-------|
| **Subagents** | ✅ Supported automatically | The CLI uses subagents on its own |
| **Skills (SKILL.md)** | ✅ Supported automatically | Applied automatically when the workspace has a SKILL.md |
| **Clarification Questions** | ✅ Supported | Agent asks → you answer on mobile → session continues |
| **Image Generation** | ⚠️ Partially supported | Results are saved in `assets/` |

### Subagents

Cursor 2.4 subagents **work automatically**. Send a prompt from mobile without any extra setup and the CLI
uses subagents as needed.

**Highlights:**
- Codebase research, terminal work and more are handled in parallel
- Better response quality
- No additional setup

### Skills (SKILL.md)

Add a `SKILL.md` file to the workspace to define custom commands or procedures.

**How to use:**
1. Create `SKILL.md` in the project root or the `.cursor/` folder
2. Define custom commands, scripts and procedures
3. They are applied automatically when you send prompts from mobile

**Example (SKILL.md):**
```markdown
# Project build skill

## build
Build the project:
1. Run npm install
2. Run npm run build
3. Check the build output
```

### Clarification Questions

When the agent needs more information while working, it can ask a question. Cursor Remote fully supports this flow.

**How it works:**
1. Send a prompt from mobile
2. The agent replies with a question (e.g. "Which feature should I add?")
3. Type your answer on mobile
4. The conversation continues in the **same session** (`--resume` is used automatically)

**Technical details:**
- Agent questions arrive as `assistant` type messages
- The `session_id` is kept, so the conversation context is preserved
- The extension manages sessions automatically

### Image Generation

> ⚠️ Whether the CLI supports image generation depends on your Cursor version.

Images generated by the agent are saved in the `assets/` folder by default.

**Notes:**
- The response to an image generation request includes the file path
- Generated images can be viewed in the workspace on the PC

### CLI options reference

CLI options used by the Cursor Remote extension:

```bash
agent \
  --resume <session_id> \      # resume a session
  --mode <plan|ask> \          # choose a mode
  -p \
  --output-format stream-json \
  --stream-partial-output \
  -- "<prompt>"
```

| Option | Description |
|--------|-------------|
| `-p` | Non-interactive mode (for scripts) |
| `--resume` | Resume a previous session |
| `--mode` | plan or ask mode |
| `--output-format` | Output format (stream-json) |
| `--stream-partial-output` | Stream partial output as it is generated |

The extension does not pass `--force`, so the CLI's own permission checks stay on.

---

## 9. Troubleshooting

### Quick error reference

| Error message | Cause | Fix |
|---------------|-------|-----|
| `EADDRINUSE` | Port already in use | [Port conflict](#port-conflict-eaddrinuse) |
| `EPERM: operation not permitted` | Network permission problem | [Permission problem](#port-permission-problem-eperm) |
| `Cursor CLI (agent) is not installed` | CLI not installed | [Install the CLI](#cli-not-installed) |
| `Could not reach the relay server` | Relay server connection failed | [Relay connection problem](#relay-server-connection-failed) |
| `Relay session ... expired` / refused | Session expired or refused | [Session problem](#session-expired-or-refused) |
| `No active editor` | No editor open | Open a file in Cursor |
| `WebSocket connection failed` | WebSocket connection failed | [WebSocket problem](#websocket-connection-failed) |

---

### Extension

#### The extension does not activate

**Symptom:** Cursor Remote does not appear in the status bar

**Fix:**
```bash
# Recompile
cd cursor-extension
npm install
npm run compile
```

1. Restart Cursor IDE
2. Run "Developer: Reload Window" from the Command Palette
3. If it still fails: `Cmd+Shift+P` → "Cursor Remote: Start Server"

#### The status bar item is missing

1. `Cmd+Shift+P` → run "Cursor Remote: Start Server"
2. Check the Output panel: `View` → `Output` → select "Cursor Remote"
3. If there is an error message, see the matching section

---

### Ports

#### Port conflict (EADDRINUSE)

**Symptom:**
```
Error: listen EADDRINUSE: address already in use :::8766
```

**Fix:**
```bash
# 1. Check what is using the port
lsof -i :8766

# 2. Stop that process
kill -9 <PID>

# 3. Restart Cursor IDE
```

> 💡 If port 8766 is in use, the extension automatically tries 8767–8776. Set the same port number in the mobile app.

#### Port permission problem (EPERM)

**Symptom:**
```
EPERM: operation not permitted
connect EPERM ::1:8766
connect EPERM 127.0.0.1:8766
```

**Fix:**

**macOS:**
1. System Settings → Privacy & Security → Firewall
2. Firewall Options → add Cursor as allowed
3. Or temporarily turn the firewall off and test

**Windows:**
1. Windows Defender Firewall → Allow an app
2. Add Cursor IDE as allowed

**Both:**
1. Quit Cursor IDE completely and restart it
2. Reboot the computer

---

### CLI

#### CLI not installed

**Symptom:**
```
Cursor CLI (agent) is not installed. Install it from https://cursor.com/cli
```

**Fix:**
```bash
# 1. Install the CLI
curl https://cursor.com/install -fsS | bash

# 2. Configure PATH (zsh)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# 3. Verify the installation
which agent
agent --version

# 4. Authenticate
agent login
```

#### CLI fails to run

**Symptom:**
```
spawn agent ENOENT
Failed to send CLI prompt
```

**Fix:**
```bash
# 1. Check PATH
echo $PATH | grep -o '.local/bin'

# 2. Check agent can run
which agent
agent status

# 3. Check authentication status
agent status
# Should show: ✅ Authenticated as: your-email@example.com

# 4. Test
agent -p --output-format json --force 'test'
```

#### CLI response is empty

**Symptom:** no AI response arrives, or only `[CLI Error]` is shown

**Fix:**
1. Check that Cursor IDE is running
2. Check CLI authentication: `agent status`
3. Check the detailed logs in the Output panel
4. Test directly without `--force`: `agent -p 'test prompt'`

---

### Relay Server

#### Relay server connection failed

**Symptom:**
```
Could not reach the relay server ... retrying.
Relay request failed (HTTP ...)
```

**Fix:**
```bash
# 1. Check the server status
curl https://cursor-remote-rela.vercel.app/api/health
# Healthy response: {"success":true,"data":{"status":"healthy"},...}
```

2. Behind a corporate proxy (Zscaler etc.), check that Node trusts the root certificate
3. Check the HTTP status code in the Output panel

#### Session expired or refused

**Symptom:**
```
Relay session ABC123 expired (sessions last 24 hours). Starting new session ...
the relay refused session ABC123 ... and stopped trying
```

**Fix:**
1. On expiry the extension switches to a new session ID automatically. Pair the phone again with **Pair Relay Client**
2. Press **Start New Relay Session** in the refusal notification to create a new session and pairing code
3. If the phone gets `PC_MUST_CONNECT_FIRST`, the Mac is asleep or Cursor is closed

---

### WebSocket

#### WebSocket connection failed

**Symptom:**
```
WebSocket connection failed
WebSocket error: ...
```

**Fix:**
1. Check the extension server is running (status bar)
2. Check the port: `lsof -i :8766`
3. Check the firewall settings
4. Restart Cursor IDE

---

### Local Server

#### The mobile app does not connect

**Checklist:**

1. **Same Wi-Fi network?**
   - The PC and phone must be on the same network

2. **Check the IP address**
   ```bash
   # Mac/Linux
   ifconfig | grep "inet " | grep -v 127.0.0.1
   
   # Windows
   ipconfig | findstr IPv4
   ```

3. **Check the firewall**
   - Mac: System Settings → Privacy & Security → Firewall
   - Windows: Windows Defender Firewall → Allow an app

4. **Test port access** (from another device)
   ```bash
   nc -zv <PC_IP> 8766
   ```

---

### Common Problems

#### Messages are not delivered

**Debugging order:**
1. Check the extension status (status bar: "Remote · 1 device" or "Remote off")
2. Check the Output panel logs (`View` → `Output` → "Cursor Remote")
3. Check the mobile app's connection status
4. Check the network connection

#### The connection is unstable

1. Check Wi-Fi signal strength
2. Restart the router
3. Use the relay server instead of the local server (or the other way round)
4. If you use a VPN, turn it off and test

---

### Checking Logs

#### Extension logs
1. In Cursor IDE, `View` → `Output` (or `Cmd+Shift+U`)
2. Select "Cursor Remote" in the dropdown
3. Check error messages and status logs

#### Log levels
| Level | Meaning |
|-------|---------|
| `INFO` | General information |
| `WARN` | Warning (does not affect operation) |
| `ERROR` | Error (feature does not work) |

---

### FAQ

**Q: The extension does not start automatically**
> A: `Cmd+Shift+P` → run "Cursor Remote: Start Server"

**Q: Where do I find the session ID?**
> A: In the status bar text (`relay <session ID>`), the **Show Connection Info** panel, or the title of the **Pair Relay Client** window.

**Q: Should I use local mode or relay mode?**
> A: Local mode on the same Wi-Fi (faster); relay mode on a different network

**Q: What is the difference between Agents window control and CLI mode?**
> A: Agents window control (session control) sends prompts to a chat already open in Cursor. CLI mode runs a separate conversation with the `agent` command. The IDE mode that inserted text directly into the editor has been removed.

---

## Appendix: Quick Reference

### Local server quick start

```text
1. Install the extension → turn on cursorRemote.enableCdp in settings
2. Cursor Remote: Restart Cursor with Session Control
3. Status bar → Pair a device (code is copied)
4. App: Local → Mac IP + port (default 8766) → Connect → paste the code
```

### Relay server quick start

```text
1. Install the extension → turn on cursorRemote.enableCdp in settings
2. Cursor Remote: Restart Cursor with Session Control
3. Status bar → Connect to relay… → 6-character session ID
4. Cursor Remote: Pair Relay Client (code is copied)
5. App: Relay → session ID → paste the code
6. When you step away: caffeinate -dimsu
```

### Port summary

| Port | Purpose | When used |
|------|---------|-----------|
| 8766 | Extension WebSocket | Always |
| 8767–8776 | Extension WebSocket fallback ports | When 8766 is taken |
| 443 | HTTPS (relay server) | Relay mode only |

---

**Written**: January 21, 2026  
**Last updated**: October 9, 2026 (0.6.0: new extension ID `krishnagupta653.cursor-remote-extension`; 0.5.0: session control, pairing codes, 24-hour relay sessions, protocol v2)
