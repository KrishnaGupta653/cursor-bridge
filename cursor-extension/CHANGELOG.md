# Changelog

All notable changes to the "Cursor Remote" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-10-09

### Changed
- **Publisher**: the extension is now published by `krishnagupta653`, so the extension ID is `krishnagupta653.cursor-remote-extension`
- **Repository**: moved to [KrishnaGupta653/cursor-bridge](https://github.com/KrishnaGupta653/cursor-bridge)
- The repository, UI strings, logs and docs are now English-only

### Removed
- Legacy `pc-server` and `cursor-cli` packages
- Old root relay test scripts, which used the old relay protocol that the relay now rejects

### Upgrading
- Uninstall the old `jaloveeye.cursor-remote-extension` first (Extensions view, or `cursor --uninstall-extension jaloveeye.cursor-remote-extension`), then install `krishnagupta653.cursor-remote-extension`
- Pair the phone again and re-enter the Telegram settings, because stored credentials are tied to the extension ID

## [0.5.1] - 2026-10-09

### Added
- **Reusable pairing code (optional)**: with `cursorRemote.reusablePairingCode` on, one code pairs up to 3 devices for the whole relay session. Running Pair Relay Client again shows the same code with the remaining uses and time left. Anyone who sees the code can join until the session ends or you start a new session. Single-use codes remain the default
- **New device notification**: every time the relay pairs a device, a "A new device joined relay session …" notification is shown with a `Start New Relay Session` button
- **App**: stays logged in through page refreshes and app restarts until the session ends, and adds **Log out** to the sidebar, the top bar and settings

### Changed
- **Relay**: `POST /api/pair` accepts `{ "reusable": true }` (valid until the session expires, at most 3 uses, invalidated by a new code or by revoking the session). After every pairing the Mac receives a `device_paired` notification
- The reusable code is also cleared from the extension's storage on Start New Relay Session, Revoke Relay Session and session expiry

## [0.5.0] - 2026-10-08

### Added
- **Restart with session control**: the `Cursor Remote: Restart Cursor with Session Control` command reopens Cursor with Agents window control (CDP, 127.0.0.1 only) turned on
- **Relay auto-reconnect after Cursor restarts**: if a session is saved, exactly one window reconnects to the last session. Running a relay command in another window tells you a window is already connected
- **New relay session button**: when the relay rejects a session, polling stops and a notification with a `Start New Relay Session` button is shown
- **App**: keeps the screen when disconnected and shows a "Reconnecting…" banner; restores the typed text if sending fails

### Changed
- **Relay**: Upstash Redis only. Sessions last 24 hours, pairing codes are single-use and expire after 5 minutes (a failed connection does not consume them), tokens are stored only as hashes, messages expire after 5 minutes, replies go only to the phone that asked, and phones that have not polled for about 2 minutes are dropped from the session
- **Relay keep-alive**: the extension no longer calls `/api/heartbeat`; polling alone keeps the Mac's connection status up to date
- **Approve, reject and stop**: act only on the exact request shown on screen, can be turned off with `cursorRemote.remoteActions`, and every remote action is written to the `[Audit]` log
- **Sending prompts**: concurrent requests are processed in order so each lands in the right chat, and a prompt is rejected rather than overwriting a draft in the Mac's input box
- **Agents window**: an Agents window that opens late or is reopened is found again automatically, and CDP reconnection keeps retrying instead of giving up
- **Telegram**: every command goes through the policy, `remoteActions` and the audit log; `allowedChatIds` is required; old messages are not replayed when the Mac wakes up
- **CLI history**: stored in the extension's own storage with 0600 permissions instead of the workspace
- Local Wi-Fi commands are no longer forwarded to relay phones

### Removed
- The `Cursor Remote: Check Relay Server` command, relay session auto-discovery and debug requests
- The unauthenticated localhost `POST /hook` server and rules management
- The IDE mode that typed text straight into the editor, and the old CDP approval-click script
- The relay's Supabase storage, SSE stream (`/api/stream`), approval API and PIN access
- The app's old "Command approvals" panel

## [0.4.0] - 2026-02-03

### Added
- **Relay storage in connection info**: clicking the status bar → connection info shows the storage the relay server uses (Supabase / Upstash Redis) and the server URL
- Storage details are fetched from the relay server's `/api/store` and shown in the panel

## [0.3.8] - 2026-02-03

### Added
- **Relay session ID saved**: the relay session ID (`relaySessionId`) is saved with the chat history
- **Current session history only**: `get_chat_history` filters by `relaySessionId`, so joining a new session shows only that session's messages

### Changed
- **Message count**: the shown/total counts include only user prompts and AI replies
- **Chat document watching**: output channels are no longer treated as chat documents
- **Mobile**: keeps waiting for a reply after sending over the relay; simpler empty message area text
- **Mobile**: shown/total count and load-older-messages UI temporarily hidden

### Fixed
- A new session with one prompt and one reply now correctly shows "shown 2 / total 2"

## [0.3.7] - 2026-02-03

### Added
- **Extension-first connection enforced**: the mobile app can join a session only after the extension has connected to the relay
- **Mobile UX improvements**: alert on a wrong PIN, better deletion and reconnection of recent connections

### Changed
- **Reconnect icon**: changed to the ethernet icon for clarity
- **PIN dialog**: can be confirmed with the Enter key

### Technical Details
- `connect.ts`: added a `pcConnected` flag check; returns 403 when the PC is not connected
- `mobile-app`: alert on PIN verification failure, improved connection history management

## [0.3.6] - 2026-02-02

### Added
- **Session ID input/storage**: the extension prompts for a 6-character session ID on start and saves it in globalState for reuse
- **PC can connect first**: when the PC enters a session ID, a session with that ID is created/joined (the mobile app joins later with the same ID)
- **Heartbeat**: the PC sends a heartbeat every 30 seconds; after 2 minutes without one it is treated as disconnected (session released)
- **Session conflict prevention**: using the same session ID from another PC returns a 409 error
- **PIN security (optional)**: if the PC sets a PIN, the mobile app must know it to join
- **New commands**: `Connect to Relay by Session ID`, `Set Relay Session ID`, `Check Relay Server`

### Changed
- **Session discovery API**: `sessions-waiting-for-pc` → `sessions-with-mobile` (discovers only sessions with a mobile client connected)
- **Session ID normalization**: normalized to upper case so PC and mobile match the same key
- **Session continuity**: reconnecting with the same session ID works within the 24-hour TTL

### Technical Details
- `relay-client.ts`: signature changed to `start(sessionId, pin?)`, heartbeat interval added
- `relay-client.ts`: added `httpRequestWithStatus()` (distinguishes 404/409 status codes)
- `connect.ts`: creates the session automatically when the PC connects, stores/verifies the PIN hash, duplicate check based on `pcLastSeenAt`
- `heartbeat.ts`: new API endpoint (updates `pcLastSeenAt`)
- `types.ts`: added `pcLastSeenAt` and `pcPinHash` fields to the Session interface

## [0.3.5] - 2026-02-02

### Changed
- **Relay response: broadcast again (back to 0.3.3 behavior)**  
  Unicast (0.3.4) responses did not arrive in some environments, so relay mode responses are **broadcast** again.  
  All mobile clients in the same session receive the responses.

### Fixed
- Fixed responses not arriving after entering a prompt in relay mode (resolved by returning to broadcast)

### Technical Details
- Extension: removed merging `senderDeviceId` when forwarding relay messages (unicast path disabled)
- Relay server: PC→Mobile messages are always sent to every device queue plus the legacy queue

## [0.3.4] - 2026-02-02

### Added
- **Unicast Response Support**: Responses are now sent only to the client that made the request (not broadcast to all)
- **Multi-client Session Support**: Multiple mobile clients can connect to the same relay session
- Each client receives only responses to their own requests

### Technical Details
- Added `senderDeviceId` tracking in CLI handler
- Added `targetDeviceId` to chat_response messages
- Relay server routes responses to specific client queues based on targetDeviceId

## [0.3.3] - 2026-01-30

### Fixed
- Minor bug fixes and stability improvements

## [0.3.2] - 2026-01-30

### Added
- **Real-time Log Display**: Important CLI logs (agent mode, command execution, AI response) are now sent to mobile clients in real-time
- **Broadcast Method**: Added `broadcast()` method to WebSocketServer for sending messages to all clients including relay

### Changed
- **Log Transmission**: Key operational logs are now transmitted to clients with `sendToClient` flag
- **Relay Log Support**: Log messages are now also sent to relay server when connected

### Fixed
- IME duplicate character handling in relay mode
- Streaming buffer cleanup on process termination

### Technical Details
- `cli-handler.ts`: Added `sendToClient` parameter to `log()` and `logError()` methods
- `websocket-server.ts`: Added `broadcast()` method that sends to both local WebSocket clients and relay server
- Important logs marked with `sendToClient: true`: Agent mode selection, CLI execution start, AI response received

## [0.3.1] - 2026-01-28

### Changed
- **Extension-only architecture**: No separate PC server; Extension includes WebSocket server (8766) and RelayClient. All UI/copy updated from "PC Server" to "Extension".
- **CLI mode**: Cursor CLI accepts only `--mode plan` and `--mode ask`. Debug/agent modes no longer pass `--mode` to avoid CLI errors.
- **Status bar**: Shows "Connected" when a client is connected via local WebSocket or relay session (was "Waiting" until now in relay mode). Added `setOnSessionConnected` and status bar refresh on relay connect.
- **Status bar copy**: "Waiting" → "Ready (waiting for client)"; tooltip updated to "Extension WebSocket server".
- **Relay logs**: "waiting for mobile client session" → "waiting for mobile client to create session"; "Found session waiting for PC" → "Found session waiting for Extension".

### Fixed
- **CLI error visibility**: When CLI fails (e.g. invalid `--mode`), stderr is now sent to the user as `[CLI Error]` chat_response so the app does not stay without a response.
- **Debug mode**: Selecting Debug in the app no longer causes CLI to fail; Extension does not pass `--mode debug` to the CLI.

### Technical Details
- `RelayClient`: added `setOnSessionConnected(callback)`.
- `StatusBarManager`: added `setRelayClient()`, `refresh()`; status reflects both local clients and relay session.
- `cli-handler`: `cliMode` derived from `selectedMode` (debug → agent for CLI); stderr used as response when stdout is empty.

## [0.3.0] - 2026-01-28

### Added
- **PC Server Session Auto-Connect**: PC Server can now automatically detect and connect to sessions created by mobile clients
- **Relay Server Session Discovery API**: New API endpoint `/api/sessions-waiting-for-pc` to find sessions waiting for PC connection
- **Session List Management**: Redis Set-based session list for efficient session discovery

### Changed
- **PC Server Workflow**: PC Server can now start without session ID and automatically connect when mobile client creates a session
- **Mobile Client**: Removed PC Server IP address requirement for relay mode connections
- **Session Discovery**: PC Server polls relay server every 10 seconds to discover new sessions

### Technical Details
- Added `findSessionsWaitingForPC()` function in relay server
- Implemented session list management in Redis
- Enhanced `pollMessages()` function to include session auto-discovery
- Improved `discoverSession()` function with rate limiting (10 seconds interval)

## [0.2.0] - 2026-01-28

### Added
- **Agent Mode Detection**: Automatic detection of appropriate agent mode (agent, ask, plan, debug) based on user prompt content
- **Chat History Enhancement**: Agent mode information is now saved and displayed in chat history entries
- **Mode Display Names**: User-friendly display names for agent modes (e.g., "Agent (coding tasks)", "Ask (questions/learning)")

### Fixed
- Fixed TypeScript compilation error in `cli-handler.ts` (missing closing brace in `getChatHistory` method)
- Improved agent mode detection logic for "Plan" mode, specifically for phrases like "analyze project"

### Changed
- Enhanced chat history structure to include `agentMode` field
- Improved agent mode auto-detection algorithm with better keyword matching
- Updated chat history saving logic to properly store and update agent mode information

### Technical Details
- Added `detectAgentMode()` private method for intelligent mode selection
- Added `getModeDisplayName()` method for localized mode names
- Enhanced `ChatHistoryEntry` interface to include optional `agentMode` field
- Improved session management for chat history entries

## [0.1.1] - 2026-01-21

### Fixed
- Fixed icon display issue in Marketplace
- Converted icon to proper PNG format (128x128px)

### Changed
- Updated icon to meet VS Code Extension Marketplace requirements

## [0.1.0] - 2026-01-21

### Added
- Initial release of Cursor Remote extension
- WebSocket server for real-time communication with mobile devices
- HTTP REST API server for command execution
- Support for text insertion into Cursor editor
- Support for executing Cursor commands remotely
- AI chat response capture and forwarding
- Status bar indicator showing server status
- Auto-start option for the remote server
- Configurable port settings for WebSocket and HTTP servers
- CLI mode support for terminal-based interactions

### Features
- **Remote Control**: Control Cursor IDE from mobile devices
- **WebSocket Server**: Real-time bidirectional communication (default port: 8766)
- **HTTP API**: REST API for command execution (default port: 8767)
- **Chat Capture**: Capture and forward AI assistant responses
- **Rules Management**: Remote management of Cursor rules files

## [Unreleased]

### Planned
- Enhanced security with authentication tokens
- Connection history and logging
