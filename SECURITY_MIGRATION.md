# Phase 2 containment migration

This guide records the migration from the pre-v2 clients. For the current
protocol see [PROTOCOL.md](PROTOCOL.md). Since 0.5.0 the relay runs on Upstash
Redis only (the Supabase backend, SSE stream and approval endpoints were removed),
and stop, approve and reject are available again as request-bound remote actions
behind `cursorRemote.remoteActions`.

## Local WebSocket and tunnel pairing

1. Compile the extension: `npm --prefix cursor-extension run vscode:prepublish`.
   Load the resulting extension through your usual development/install workflow.
2. In Cursor settings, set `cursorRemote.allowedWebSocketOrigins` to the exact
   origin serving your Web UI, for example `http://192.168.1.10:8080`.
   The defaults are `http://localhost:8080` and `http://127.0.0.1:8080`.
   Origins include scheme and port, with no path or trailing slash. Restart the
   local server after changing this setting. Wildcards and `null` are rejected.
3. Run **Cursor Remote: Pair Client** in the command palette. Copy the masked
   secret from the local input box. It expires after five minutes and works once.
4. Connect using the updated Flutter Web client and enter that secret in its
   pairing dialog within two minutes of opening the connection.
5. **Cursor Remote: Revoke All Paired Clients** disconnects every local client
   and invalidates all pairing windows and tokens. Pair again afterward.

Credentials last 24 hours or until revocation/extension restart. Only hashed
verifiers are retained by the extension. The Web client retains credentials in
memory per endpoint; refreshing the page requires pairing again. Credentials
must not be put into URLs, logs, or connection history. Use a trusted LAN for
unencrypted `ws://`; use `wss://` for tunnel connections. Origin restrictions
do not replace authentication or transport encryption.

Native clients may omit Origin, but must implement the v2 handshake below.
Older clients, including the standalone CLI, have no insecure compatibility
bypass and need migration. The legacy `pc-server` and `cursor-cli` were removed
from the repository in 0.6.0.

## WebSocket protocol v2

The extension first sends:

```json
{"type":"auth_required","protocolVersion":2}
```

Pair or reconnect with one of these messages (placeholders are not credentials):

```json
{"type":"pair","protocolVersion":2,"secret":"<one-time-secret>"}
{"type":"authenticate","protocolVersion":2,"token":"<issued-token>"}
```

Only an `authenticated` response with `protocolVersion: 2` and `scope: "control"`
establishes a connection. It includes `clientId` and `expiresAt` (Unix milliseconds),
and includes `token` on initial pairing. The server derives client identity and
source; caller-supplied identity fields cannot impersonate another adapter.

Every subsequent command needs a nonempty `id` of at most 128 characters and
`deadline` in Unix milliseconds, in the future and at most five minutes away.
Existing typed command payload fields remain in the same object.

```json
{"type":"get_sessions","id":"<unique-command-id>","deadline":1900000000000}
```

Replace that illustrative deadline with the current time plus, for example,
60 seconds. IDs are remembered for the credential lifetime across reconnects.
A repeated ID returns `command_result`, `success: false`, `status: "duplicate"`
without redispatch. This is suppression, not cached-result replay or durable
exactly-once execution. A command without a valid deadline returns
`invalid_or_expired_command`. At 4,096 remembered commands, re-pair to obtain a
new credential. Storage is bounded to 256 credentials and 256 live connections.

Limits: 60 authentication attempts/minute globally, 120 commands/minute per
connection and principal, and 600 commands/minute globally. Authentication
failure, expiry and revocation use close code 4001; malformed input uses 4002;
rate/capacity limits use 4008. Frames are capped at 64 KiB.

## Command and CLI changes

Generic VS Code commands, `execute_action`, terminal input (including equivalent
`insert_text` forms), and editor insertion are denied by the remote router.
Unknown commands default to denial. Prompt insertion remains available; CDP
prompts require an explicit session ID. The relay applies equivalent typed
command checks, including outer/inner message-type consistency.

Remote stop, approvals, rejections, and history-opening actions are disabled
until ownership and exact request-bound authorization exist. Use Cursor locally
for these actions. Sending a new CLI prompt while another is running or being
prepared returns busy instead of interrupting it. CLI invocation no longer
passes `--force`. CLI permission-interaction behavior still needs live validation.

## Relay protocol v2

The relay stores everything in Upstash Redis (`UPSTASH_REDIS_REST_URL`,
`UPSTASH_REDIS_REST_TOKEN`). Security records use separate `security:v2:*` keys
and atomic SET-NX/Lua operations. No database migration is needed. The relay
must be deployed together with compatible clients.

Create/connect the session **from Cursor first**. An unused session ID creates
an owner credential; an existing v2 session requires its saved credential.
Existing legacy sessions cannot be claimed with a PIN or by waiting for a stale
heartbeat. Choose a new ID. The extension stores its token and assigned PC
identity in VS Code SecretStorage, scoped by relay URL and session ID.

Then run **Cursor Remote: Pair Relay Client**. Paste the generated single-use
43-character code into the Web client's relay pairing dialog, along with the
session ID. Codes expire in five minutes. Short numeric PINs are no longer
accepted. Each pairing generates a new server-assigned mobile device identity;
knowing another device's ID cannot impersonate it. The Web client retains its
credential and device identity per session in memory. A page refresh requires
pairing again.

**Cursor Remote: Revoke Relay Session** invalidates every credential and pending
invitation for that session before deleting session data. The Web client's
Disconnect requests revocation of its own credential. A network failure is
reported as unconfirmed server revocation, not fake success. Closing the
extension transport without revoking it preserves its saved reconnect credential.
Credentials/session security expire 24 hours after creation; create a new session
at expiry. To replace credentials sooner, revoke the session and create/pair again.

All data/control endpoints require `Authorization: Bearer <capability>`. Do not
place capabilities in query strings or logs. Tokens are opaque 256-bit random
values; only SHA-256 verifiers and bound identity/role records are stored server-side.
Only session creation and mobile invitation redemption are enrollment exceptions.
They are globally and per-address rate-limited. CORS preflight and the existing
sanitized health endpoint remain public.

Protocol outline (placeholders only):

- `POST /api/session`: `{ "deviceType": "pc", "deviceId": "<pc-id>",
  "sessionId": "<unused-id>" }`. The ID is optional; the server generates one
  cryptographically if absent. Returns a PC token under `data.token`.
- `POST /api/pair`, with PC Bearer token: creates `data.pairingCode`.
- `POST /api/connect`: mobile enrollment includes `sessionId`, a device ID,
  `deviceType: "mobile"`, and `pairingCode`. Returns `data.token` and the
  authoritative `data.deviceId`. Reconnect uses Bearer authentication instead
  of another pairing code. Responses include `protocolVersion: 2`.
- Send, poll, session reads, pairing and disconnect verify membership before
  touching queues. Contradictory session,
  device or role fields are rejected. Heartbeat and invitation issuance require
  the PC role. Targeted sends must target a member of the same session.
- Public discovery/debug enumeration returns `PUBLIC_DISCOVERY_DISABLED`.
  Old remote approval dispatch remains disabled even for authenticated callers.
- Mobile commands require unique `data.id` and future `data.deadline` (maximum
  five minutes). Atomic claims suppress duplicate sends across server instances;
  the extension also refuses expired queued commands. Limits apply per principal
  and globally; command claims are capped at 4,096 per device/session epoch.

Command claiming and queue insertion are still separate operations. If storage
fails after a claim, the command can be lost; blindly retrying does not redispatch
it. This is **not** transactional acknowledged delivery or durable exactly-once
execution. Phase 5's queue work remains required. In-flight operations authorized
before revocation are not cancelled retroactively.

The legacy `pc-server` relay integration never implemented v2; it (and `cursor-cli`)
were removed from the repository in 0.6.0.
Deploy/release these changes in a coordinated migration; do not point old clients
at the updated relay expecting PIN-based compatibility.

## Telegram

Add both allowlists to your existing private `telegram.json`:

```json
{
  "enabled": true,
  "botToken": "<your-existing-secret>",
  "allowedUserIds": [123456789],
  "allowedChatIds": [123456789],
  "transport": "botapi"
}
```

Both lists must be nonempty. Only private chats whose chat ID equals the
allowlisted sender's ID are accepted. Unknown users/chats receive no bootstrap
response. Existing API/MTProto fields remain supported; no credentials need to
be pasted into this repository.

Each private chat/user gets a distinct client identity. Only replies attributed
to that identity are mirrored. `/sync off` excludes the chat even if pending
work exists. Unattributed global CDP events are not mirrored; exact CDP
session/correlation subscriptions are still outstanding. CLI history is requested
with the caller's distinct identity. `/stop`, `/approve`, `/reject`, and `/open`
are disabled explicitly. Commands are capped at 30/minute per authorized user
and 180/minute globally.

## Startup and validation

The startup script preserves occupied WS ports and refuses an occupied Web port.
Choose another Web port with `WEB_PORT=8081` if needed, and update the allowed
Origin accordingly. `--no-cleanup` remains accepted. On exit, the script checks
parent PID and command identity before terminating its own Web-server child.
It never kills an unknown listener. CDP launch explicitly requests loopback.

Automated containment checks:

```bash
npm --prefix cursor-extension test
npm --prefix relay-server run type-check
npm --prefix relay-server run validate:command-event
npm --prefix relay-server test
# Optional local Redis integration; requires redis-server and redis-cli:
npm --prefix relay-server run test:redis
bash -n scripts/start-cursor-remote-stack.sh
```

Still required: Flutter analyze/tests/release build, actual browser pairing and
reconnect, live Cursor/CLI/CDP behavior, and live deployment validation for relay capabilities on the chosen backend. See the execution report for the phase gate.


## Response delivery containment

Replies are delivered only to their authenticated requesting client. Global
CDP push updates and unattributed hook payloads are suppressed until explicit
session subscriptions are implemented; clients can request session state.
Diagnostic logs are local and are no longer broadcast to mobile or relay peers.
CLI failures return a generic attributed error, without raw stderr.
