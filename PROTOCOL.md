# Cursor Remote Protocol (v2)

This document describes how the phone/web app, the relay server and the Cursor
extension talk to each other. Every message is JSON. Version 1 clients
(unauthenticated WebSocket, PIN or session-ID-only relay access, SSE stream,
relay approval endpoints) are rejected.

## Architecture

### Local mode (same Wi-Fi)

```
Phone / Web app  ⇄  WebSocket ws://<Mac IP>:8766  ⇄  Cursor extension  ⇄  CDP 127.0.0.1:9222  ⇄  Cursor Agents window
```

- The extension listens on port 8766 (8767, 8768… for more Cursor windows).
- CDP (Chrome DevTools Protocol) stays on `127.0.0.1`. The app never talks to CDP.

### Relay mode (any network)

```
Phone / Web app  ⇄  HTTPS relay (Vercel + Upstash Redis)  ⇄  Cursor extension (RelayClient)
```

- Both sides poll the relay over HTTPS. There is no SSE stream and no WebSocket at the relay.
- The Mac creates the session; phones join it with a pairing code.

## Local WebSocket handshake

1. On connect the extension sends `{"type": "auth_required", "protocolVersion": 2}`.
2. The first message from the app must authenticate, or the socket is closed (code 4001).
   - First pairing, with the one-time code from **Cursor Remote: Pair Client** (single use, expires after 5 minutes):

     ```json
     { "type": "pair", "protocolVersion": 2, "secret": "<pairing code>" }
     ```

   - Reconnect with the saved device token:

     ```json
     { "type": "authenticate", "protocolVersion": 2, "token": "<device token>" }
     ```

3. The extension answers `{"type": "authenticated", "protocolVersion": 2, "scope": "control", "clientId": "...", "expiresAt": <ms>, "token": "..."}`.
   `token` is present only after `pair`. Device tokens last 24 hours and are stored hashed on the Mac.
   **Cursor Remote: Revoke All Paired Clients** signs every device out.
4. `{"type": "ping"}` is answered with `{"type": "pong"}` and is not a command.

Browsers must also come from an origin listed in `cursorRemote.allowedWebSocketOrigins`.
Each connection is rate-limited (120 messages per minute).

## Command envelope

Every command, local or relayed, carries:

| Field | Meaning |
|-------|---------|
| `type` | One of the allowed commands below. Anything else fails closed. |
| `id` | Unique per device token (max 128 characters). A repeated `id` is rejected as `duplicate`. |
| `deadline` | Expiry as epoch milliseconds, at most 5 minutes ahead. Expired commands are dropped. |

The extension replies with a `command_result` for the same `id`:

```json
{ "type": "command_result", "id": "c-42", "command_type": "get_chat", "success": true, "duration_ms": 31 }
{ "type": "command_result", "id": "c-43", "command_type": "agent_prompt", "success": false, "error": "Open a chat first: prompts need a chatId or newChat" }
```

Replies and live updates carry the `clientId` (and, over the relay, the `targetDeviceId`) of the
device that asked. Nothing is broadcast to other devices.

## Allowed commands

### Reading chats (Agents window)

| Type | Fields | Reply |
|------|--------|-------|
| `list_chats` | — | `chats` |
| `get_chat` | `chatId` | `chat` (paged items) |
| `watch_chat` | `chatId`, `fromTotal` | live `chat_delta` and `composer_state` |
| `unwatch_chat` | — | — |
| `get_composer_state` | — | `composer_state` |
| `list_models` | — | `models` |
| `get_file_diff` | `chatId`, `path` | `file_diff` (read-only, contained to the chat's repository) |

A watch lapses after 10 minutes unless the app sends `watch_chat` again; the app renews it while
the chat is open. A `chat_delta` carries `fromSeq` and `total`; on a gap the app reloads the chat once.

### Prompting

| Type | Fields | Notes |
|------|--------|-------|
| `agent_prompt` | `text`, `chatId` or `newChat: true` | Types into that exact Agents-window chat and presses Enter. Refused if the Mac's composer already has a draft. |
| `cli_prompt` / `insert_text` (`prompt: true`) | `text` | Runs the Cursor CLI (`agent`) instead of the Agents window. |

When the agent finishes, the asking device gets one `chat_response` with the final answer
(`correlationId` and `chatId` included).

### Remote actions

`open_chat`, `new_chat`, `set_model` (`model`), `set_mode` (`mode`: Agent, Ask, Plan, Debug,
Multitask), `agent_stop`, `stop_prompt`, `approve_action` and `reject_action`.

- All of them are turned off when `cursorRemote.remoteActions` is `disabled`.
- Every attempt, allowed or refused, is written to the **Cursor Remote** output as an `[Audit]` line.
- `approve_action` / `reject_action` need the `chatId`, the exact pending `requestId`
  (`req-…`, taken from that chat's `composer_state`) and `confirmed: true`, which the app sets
  only after the user confirms on the phone.

### Not allowed

`execute_command`, terminal input, editor insertion, window-level `sessionId` prompts and any raw
CDP method are rejected with a `command_result` error.

## Relay API

Base URL: `https://cursor-remote-rela.vercel.app` (or your own deployment). All endpoints answer
`{ "success": bool, "data": …, "error": …, "timestamp": ms }`; session endpoints add `"protocolVersion": 2`.
Authenticated calls send `Authorization: Bearer <capability token>`.

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `POST /api/session` | Mac, no token | Create session `{ sessionId, deviceId, deviceType: "pc" }`. Returns the Mac's token. `409` if the ID was ever used. |
| `POST /api/connect` | Mac with token, or phone with pairing code | Reconnect, or join with `{ sessionId, deviceId, deviceType: "mobile", pairingCode }`. A phone can join only while the Mac is polling. |
| `POST /api/pair` | Mac | Create a pairing code: single use for 5 minutes, or with `{ "reusable": true }` the session's reusable code (see below). |
| `POST /api/send` | both | Queue `{ sessionId, deviceId, deviceType, type, data }`. Bodies over 256 KB from a phone (4 MB from the Mac) get `413`. |
| `GET /api/poll` | both | Fetch queued messages. Each poll also marks the device as seen. |
| `POST /api/disconnect` | both | Revoke this device's token. From the Mac it ends the session for everyone. |
| `GET /api/session` | both | Session record. |
| `GET /api/health` | anyone | `{ "status": "healthy" }` only. |
| `GET /api/store` | both | Storage label (always Upstash Redis). |

Rules the relay enforces:

- Sessions last 24 hours. A session ID can never be claimed again; recovery always uses a new ID.
- Capability tokens are 256-bit random values; the relay stores only their hashes.
- Pairing codes are single use and expire after 5 minutes, unless the Mac asked for a reusable code.
  A failed join (e.g. `409 PC_MUST_CONNECT_FIRST`) does not use up the code.
- Queued messages expire after 5 minutes. A reply with `targetDeviceId` goes only to that phone.
- A phone that has not polled for about 2 minutes stops receiving messages and is pruned.
- The Mac counts as connected while it keeps polling (the extension polls every 2 s while a phone
  is active and every 25 s when idle; the relay allows 2 minutes).
- Failed authentication is rate-limited per client IP.

### Pairing codes

`POST /api/pair` (Mac token) with `{ "sessionId": "ABC123" }` returns a single-use code:

```json
{ "success": true, "data": { "pairingCode": "<43 characters>", "expiresInSeconds": 300 } }
```

With `{ "sessionId": "ABC123", "reusable": true }` (opt-in, `cursorRemote.reusablePairingCode`):

```json
{ "success": true, "data": { "pairingCode": "<43 characters>", "expiresInSeconds": 86012, "reusable": true, "usesLeft": 3 } }
```

- A reusable code enrolls at most **3** devices (`PAIRING_CODE_USED_UP` after that) and expires with
  the session's credentials. Uses are counted atomically; a refused join does not count.
- A session has at most one reusable code: minting a new one invalidates the previous one.
- Revoking the session (`/api/disconnect` from the Mac, **Start New Relay Session**) or a new session
  epoch invalidates it.
- Every redeem enrolls a new server-generated device ID, so a phone that pairs again uses another slot.
  Reconnecting with a saved token never uses one.
- Relays without reusable-code support ignore `reusable` and answer with a single-use code; the extension then
  treats it as single use.

A phone joins with `POST /api/connect` `{ sessionId, deviceId, deviceType: "mobile", pairingCode }`.
The reply carries `token`, `deviceId` and `credentialExpiresAt`, plus `"pairing": { "reusable": true, "usesLeft": n }`
when a reusable code was used. Join errors:

| Status | `errorCode` | Meaning |
|--------|-------------|---------|
| 403 | `PAIRING_CODE_REQUIRED` | No code (and no token) was sent |
| 403 | `PAIRING_CODE_INVALID_OR_EXPIRED` | Wrong session, expired, replaced, revoked or already used (single use) |
| 403 | `PAIRING_CODE_USED_UP` | The reusable code already enrolled 3 devices |
| 409 | `PC_MUST_CONNECT_FIRST` | The Mac is not polling; the code is kept |
| 401 | `CREDENTIAL_INVALID_OR_EXPIRED` / `CREDENTIAL_REVOKED` | A saved token no longer works; pair again |

### `device_paired` (relay → Mac)

After every successful pairing (single use or reusable) the relay queues a notice in the Mac's poll queue:

```json
{ "id": "…", "type": "device_paired", "from": "relay", "to": "pc", "senderDeviceId": "mobile-…",
  "data": { "type": "device_paired", "deviceId": "mobile-…", "at": 1760000000000, "reusable": true, "usesLeft": 2 } }
```

`from: "relay"` cannot be produced through `/api/send` (the relay stamps the sender's role there), so the
extension only trusts notices with that marker. It never contains a code or token. Extensions older
than 0.5.1 drop it as an unversioned command (no `deadline`), with one log line.

### App login

The app saves `{ sessionId, deviceId, token, credentialExpiresAt }` for the latest relay session in local
storage (localStorage on the web) and reconnects with the token after a refresh or restart. It deletes it
on `401`/`403`, when `credentialExpiresAt` has passed, and on **Log out** (`POST /api/disconnect`,
which revokes the token; if that fails the token still lapses when the session ends). Network errors,
`409` and `429` keep it.

`/api/heartbeat`, `/api/sessions-with-mobile` and `/api/debug-sessions` remain only for extensions
older than 0.5.0: heartbeat is no longer needed, and discovery/debug always answer `403`.

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 8766+ | WebSocket | App ⇄ extension in local mode |
| 9222 | CDP (loopback only) | Extension ⇄ Cursor's own windows |
