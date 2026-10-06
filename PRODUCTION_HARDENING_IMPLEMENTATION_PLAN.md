# Cursor Remote Production Hardening Implementation Plan

> Status: Phase 1 audit complete; Phases 2–9 not yet implemented  
> Baseline branch at document creation: `latest-11-09`  
> Intended audience: AI coding agents and human reviewers  
> Last updated: 2026-09-12

## 1. Purpose

This document is the authoritative implementation brief for turning Cursor
Remote into a secure, reliable remote-control system for Cursor through:

- Android Chrome and other Flutter Web clients
- local network WebSocket connections
- relay-based remote connections
- Telegram
- Cursor CLI
- Cursor Agent sessions discovered through CDP

It is designed to be given directly to an AI coding agent. The agent must work
through the phases in order, verify each phase, and stop at a failed phase gate.

This is not an instruction to rewrite the application. Changes must be
incremental, reviewable, backward-aware, and supported by tests.

## 2. Non-negotiable operating contract

Every implementation agent must follow these rules.

### 2.1 Before changing code

1. Run `git branch --show-current`.
2. Run `git status --short`.
3. Do not overwrite or discard existing uncommitted changes.
4. Never commit directly to `main` or `develop`.
5. Use a `feature/*` or `bugfix/*` branch when a new branch is required.
6. Do not run `git merge`; repository Git Flow rules require the corresponding
   `git flow ... finish` operation, and only when explicitly requested.
7. Read the files affected by the phase before editing them.
8. Record the pre-phase test baseline.

### 2.2 During implementation

- Make the smallest change that satisfies the phase acceptance criteria.
- Do not perform unrelated cleanup.
- Keep security defaults restrictive.
- Preserve existing local, relay, CLI, CDP, extension, and Web UI behavior
  unless the phase explicitly replaces an unsafe behavior.
- Version protocol changes or provide a defined compatibility path.
- Never add a generic Telegram shell endpoint.
- Never expose CDP beyond loopback.
- Never log bot tokens, relay tokens, PINs, cookies, credentials, prompts, file
  contents, or environment secrets by default.
- Add tests before or alongside behavior changes.
- Do not silently catch errors or return fake success.
- Do not retry forever.

### 2.3 After each phase

The agent must provide:

1. Files changed.
2. Behavior changed.
3. Security and compatibility impact.
4. Tests added or updated.
5. Exact commands executed.
6. Pass/fail results.
7. Remaining limitations.
8. Any manual validation still required.

The agent must not start the next phase if:

- a phase acceptance criterion is unmet;
- a regression remains unexplained;
- security tests fail;
- the build is broken;
- required behavior was not actually exercised.

### 2.4 Truthful support labels

Use only:

- **SUPPORTED**: implemented and verified by automated or reproducible runtime
  evidence.
- **PARTIALLY SUPPORTED**: some behavior works, but documented restrictions or
  unverified paths remain.
- **NOT SUPPORTED**: absent, disabled, or technically unavailable.

## 3. Repository map

### 3.1 Primary components

#### `cursor-extension/`

The VS Code/Cursor extension is the current control-plane hub. It owns:

- the local WebSocket server;
- command routing;
- Cursor CLI process management;
- CDP connection and Cursor window/session discovery;
- relay connection and polling;
- Telegram Bot API integration;
- optional Telethon/MTProto fallback;
- Cloudflare quick-tunnel lifecycle;
- response fan-out to connected clients.

Important areas include:

- extension activation and command registration;
- `WebSocketServer`;
- `CommandRouter`;
- `CLIHandler`;
- `CdpManager`;
- `RelayClient`;
- Telegram bridge and Python bridge;
- Cloudflare tunnel manager.

#### `mobile-app/`

Flutter client used as:

- Flutter Web application in Android Chrome;
- local WebSocket client;
- relay polling client;
- session browser;
- chat and command UI;
- CDP Agent control UI;
- permission and plan viewer.

Current architecture is highly concentrated in `lib/main.dart`, with shared
widgets in `lib/widgets/`.

#### `relay-server/`

Vercel serverless relay API using:

- Upstash Redis, or
- Supabase

for session records, command queues, mobile queues, events, heartbeat data, and
approval records.

The relay is a store-and-forward transport. It must not become an implicit
authorization system based only on knowledge of a session ID.

#### `pc-server/`

Legacy WebSocket server still included in the root npm workspace and CI. Its
ownership and supported status must be resolved rather than left ambiguous.

#### `cursor-cli/`

Standalone client that is not currently part of the root npm workspace or
normal CI. It requires an explicit support decision.

#### `scripts/`

Contains operational scripts, including
`scripts/start-cursor-remote-stack.sh`, which launches Cursor with CDP, builds
and serves Flutter Web, locates the extension WebSocket port, and relies on
extension Telegram auto-start.

### 3.2 Current data flows

#### Local Web

```text
Flutter Web
  -> ws://<mac-lan-ip>:8766..8770
  -> extension WebSocketServer
  -> CommandRouter
  -> CLIHandler or CdpManager
  -> WebSocket response
  -> Flutter state/UI
```

#### Cloudflare quick tunnel

```text
Flutter Web / remote client
  -> wss://<quick-tunnel>.trycloudflare.com
  -> same local extension WebSocket
  -> same command surface as LAN
```

The tunnel currently adds reachability but not an authentication boundary.

#### Relay

```text
Flutter client
  -> relay HTTP API
  -> Redis or Supabase queue
  -> extension RelayClient poll
  -> CommandRouter
  -> relay response queue
  -> Flutter poll
```

#### Telegram

```text
Telegram update
  -> Bot API polling or Telethon bridge
  -> extension TelegramBridge
  -> CommandRouter / CLIHandler / CdpManager
  -> extension response fan-out
  -> Telegram sendMessage
```

#### CDP

```text
Cursor launched with --remote-debugging-port=9222
  -> CdpManager connects to 127.0.0.1:9222
  -> discovers Cursor renderer targets
  -> inspects private Cursor Agent DOM
  -> infers session/message/plan/approval state
  -> injects prompts or clicks controls
```

CDP is intrinsically fragile because it relies on private DOM structure rather
than a supported Cursor Agent API.

## 4. Verified Phase 1 baseline

### 4.1 Current support

- Local WebSocket control: **SUPPORTED but insecure**
- Relay transport: **SUPPORTED but insecure**
- Cursor CLI prompts and responses: **SUPPORTED**
- Multiple CDP target discovery: **PARTIALLY SUPPORTED**
- CDP prompt submission: **PARTIALLY SUPPORTED**
- CDP plans and activity: **PARTIALLY SUPPORTED**
- Reliable CDP stop: **NOT SUPPORTED**
- Reliable changed-file/diff extraction: **NOT SUPPORTED**
- Telegram prompt and basic status: **SUPPORTED**
- Telegram session switching: **PARTIALLY SUPPORTED**
- Telegram approval/rejection: **PARTIALLY SUPPORTED and unsafe**
- Telegram inline buttons: **NOT SUPPORTED**
- Unified health registry: **NOT SUPPORTED**
- Canonical shared state machine: **NOT SUPPORTED**
- Ordered, deduplicated event model: **NOT SUPPORTED**

### 4.2 Critical findings

1. **Unauthenticated WebSocket control**
   - The extension binds its server to `0.0.0.0`.
   - There is no client authentication or Origin validation.
   - LAN and Cloudflare clients can reach powerful command paths.

2. **Arbitrary command execution**
   - Generic VS Code command IDs can be forwarded.
   - Terminal text execution is remotely reachable.
   - Cursor CLI is invoked using forceful behavior.

3. **Relay authorization is absent**
   - Session ID and device ID values are caller-provided.
   - Command, response, poll, approval, and discovery paths do not prove
     session membership.
   - PIN verification happens only during initial connection.

4. **Telegram cross-chat and cross-user leakage**
   - Responses can be broadcast to sync-enabled chats, the last chat, and
     pending chats.
   - `/sync off` does not provide reliable isolation.
   - Telegram users share a single logical `clientId`.
   - CLI history and processes are shared.

5. **Command policy bypass**
   - Relay policy inspects an exact `execute_command` message type.
   - Equivalent terminal execution through text insertion is not governed by
     the same policy.

### 4.3 High-risk findings

- Approval request IDs are not deterministically mapped to UI controls.
- Broad page-text matching can create false permission requests.
- Approve/reject actions can click generic page-wide buttons.
- Commands are not consistently serialized or awaited.
- One user can interrupt another user's global CLI process.
- Relay failure can leave the extension falsely marked connected.
- Flutter can mark relay connected from a non-null session ID alone.
- Relay reconnect does not reliably restore PIN credentials.
- CDP session selection can default to the first map entry.
- Relay IDs use low-entropy `Math.random()` generation.
- PIN storage uses unsalted SHA-256 and lacks attempt throttling.
- Telegram lacks allowed-chat enforcement, roles, confirmations, and rate
  limiting.
- Startup cleanup can kill unrelated listeners on ports 8766–8770 and 8080.
- Retry behavior is inconsistent; some paths retry forever and others stop
  permanently.

### 4.4 Reliability findings

- No universal event ID or command idempotency key.
- No sequence-based out-of-order handling.
- Redis queue consumption can lose data after destructive dequeue.
- Supabase select-then-delete is non-atomic.
- Duplicate response queue writes are possible.
- No public relay disconnect endpoint.
- Some event stores are unbounded.
- Telegram retries use fixed delays without jitter or a ceiling.
- MTProto child-process recovery is incomplete.
- Initial Bot API requests may lack a bounded timeout.
- CDP permanently stops reconnecting after its retry ceiling.
- Mobile message history is unbounded.
- Relay polling errors can be swallowed.

### 4.5 UX and architecture findings

- Flutter `main.dart` is approximately 5,900 lines.
- Transport, domain state, persistence, and UI concerns are coupled.
- State mutations occur during widget build paths.
- Nested `setState` behavior exists.
- Any first WebSocket frame may be treated as a successful handshake.
- Pairing and auto-connect surfaces are incompletely wired.
- Relay protocol payloads can appear in user-visible chat.
- Loading, empty, reconnect, and error states are inconsistent.
- Accessibility labels, focus order, and touch semantics are incomplete.

### 4.6 Testing baseline

At audit time:

- Extension compile and tests: **PASS, 12/12**
- Relay typecheck and existing schema/policy checks: **PASS**
- Flutter analyze: **5 findings**
- Flutter tests: **3 pass, 2 fail**
- `pc-server` build: **FAIL**
- `cursor-cli` build: **FAIL**
- CI compiles/typechecks/analyzes but does not run all unit tests.

This baseline must be reconfirmed before implementation because the working tree
may have changed.

## 5. Target architecture

### 5.1 Extension as authoritative local control plane

The extension should remain the source of truth while Cursor is running.

Introduce these bounded responsibilities:

```text
Authenticated adapters
  - LocalWebSocketAdapter
  - RelayAdapter
  - TelegramAdapter
          |
          v
Authorization + CommandBus
          |
          v
SessionRegistry <-> EventStore
          |
          +--> CliAgentBackend
          +--> CdpAgentBackend
          +--> Workspace/File metadata
          |
          v
Typed session snapshots and events
```

Do not create a second independent state machine in Telegram or Flutter.

### 5.2 Canonical session record

Every session should expose a serializable snapshot similar to:

```ts
interface SessionSnapshot {
  schemaVersion: 2;
  sessionId: string;
  stableKey: string;
  backend: "cli" | "cdp";
  workspaceId?: string;
  workspacePath?: string;
  cursorWindowId?: string;
  title?: string;
  state: AgentState;
  activeTask?: TaskSummary;
  latestMessage?: MessageSummary;
  pendingApproval?: ApprovalSummary;
  plan?: PlanSummary;
  changedFiles: ChangedFileSummary[];
  errors: SessionError[];
  connection: ConnectionSummary;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  revision: number;
}
```

`stableKey` must be derived from durable attributes where available. CDP target
IDs alone are not stable across Cursor restarts.

### 5.3 Canonical state machine

Required states:

```ts
type AgentState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "IDLE"
  | "RUNNING"
  | "WAITING_FOR_INPUT"
  | "WAITING_FOR_PERMISSION"
  | "COMPLETED"
  | "ERROR"
  | "STOPPING"
  | "RECONNECTING";
```

Every transition must:

- specify allowed source states;
- identify the event causing the transition;
- update `updatedAt`, `lastActivityAt`, and `revision`;
- reject or explicitly reconcile stale transitions;
- retain a bounded transition history for diagnostics.

No interface may independently invent state from UI labels after Phase 3.

### 5.4 Typed event envelope

Required minimum event fields:

```ts
interface AgentEvent<TType extends string, TPayload> {
  schemaVersion: 2;
  eventId: string;
  sessionId: string;
  correlationId: string;
  commandId?: string;
  sequence: number;
  occurredAt: string;
  source: "cli" | "cdp" | "web" | "relay" | "telegram" | "extension";
  type: TType;
  payload: TPayload;
}
```

Required events:

- `session_discovered`
- `session_removed`
- `session_selected`
- `agent_started`
- `agent_message`
- `agent_message_delta`
- `agent_state_changed`
- `agent_plan_changed`
- `permission_requested`
- `permission_resolved`
- `file_changed`
- `command_started`
- `command_completed`
- `agent_completed`
- `agent_failed`
- `connection_lost`
- `connection_restored`
- `health_changed`

Consumers must deduplicate by `eventId` and reject or buffer invalid sequence
transitions within a bounded window.

### 5.5 Command envelope

Commands require:

- `commandId`
- `correlationId`
- authenticated principal
- target `sessionId`
- command type
- typed payload
- creation timestamp
- deadline
- idempotency key
- risk classification
- optional confirmation proof

Command handlers must return explicit:

- accepted;
- rejected;
- expired;
- duplicate;
- unauthorized;
- completed;
- failed;
- unsupported.

## 6. Security invariants

These invariants apply to every phase.

1. CDP binds and connects only to loopback.
2. WebSocket control requires authenticated pairing.
3. Relay session IDs are identifiers, not credentials.
4. Every relay operation proves membership and capability.
5. Unknown Telegram users and chats receive no control data.
6. Telegram authorization occurs before command parsing or session lookup.
7. Dangerous actions require short-lived, action-bound confirmation.
8. Approval tokens bind user, chat, session, request, action, and expiry.
9. No remote generic shell or generic VS Code command endpoint.
10. Paths are normalized and checked against allowed workspace roots.
11. Secrets never appear in logs, errors, health reports, UI, or Telegram.
12. Authentication comparison uses constant-time methods where applicable.
13. Replayable commands have idempotency protection.
14. Rate limits apply per identity and globally.
15. Errors sent remotely are sanitized but retain a correlation ID.

## 7. Configuration model

Configuration must be centralized and validated at startup.

Required logical fields:

```text
ENABLE_TELEGRAM
TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_USERS
TELEGRAM_ALLOWED_CHATS
TELEGRAM_ADMIN_USERS
TELEGRAM_READ_ONLY_USERS
ENABLE_CDP
CDP_HOST
CDP_PORT
WS_HOST
WS_PORT
RELAY_URL
LOG_LEVEL
RECONNECT_LIMIT
CONNECT_TIMEOUT_MS
COMMAND_TIMEOUT_MS
HEARTBEAT_INTERVAL_MS
STALE_SESSION_TIMEOUT_MS
MAX_QUEUE_DEPTH
```

Requirements:

- Existing Cursor settings and `telegram.json` remain supported during a
  documented migration period.
- Secrets remain outside source control.
- A checked-in example may contain placeholders only.
- Startup reports all invalid fields at once where safe.
- Missing optional integration credentials disable that integration cleanly.
- Missing required security fields must not silently start an insecure mode.
- Token validation errors must show only a fingerprint or redacted suffix.

Recommended local secret path:

```text
~/.config/cursor-remote/telegram.json
```

Production configuration must not depend on runtime installation of unpinned
Python packages.

---

# Phase 1 — Audit and baseline

## Objective

Understand the complete system before changing implementation and establish a
reproducible baseline.

## Architecture work

- Map component ownership and data flows.
- Identify trust boundaries.
- Inventory protocols, queues, state stores, background processes, timers,
  listeners, and child processes.
- Classify supported, partial, and unsupported functionality.

## Security work

- Identify externally reachable surfaces.
- Trace every route capable of terminal, VS Code, file, approval, or Agent
  control.
- Verify CDP host restrictions.
- Inspect secret storage and logging.
- Review Telegram identity boundaries.

## Reliability work

- Enumerate reconnect, timeout, retry, cleanup, heartbeat, and persistence
  behavior.
- Identify unbounded stores and non-atomic queue operations.
- Identify shared mutable state and process-global handlers.

## Testing and validation

- Run all existing safe compile, analyze, and test commands.
- Do not run integration scripts that default to production services without
  explicit safe configuration.
- Record failing tests without hiding pre-existing failures.

## Deliverables

- Architecture map.
- Risk register.
- Support matrix.
- Validation baseline.
- Prioritized phases.

## Known limitations

- Static analysis cannot prove live Cursor DOM compatibility.
- Real Telegram/relay tests require separately authorized staging credentials.

## Acceptance criteria

- Repository source/config/test/documentation paths reviewed.
- Critical trust boundaries documented.
- Existing test results recorded.
- No source behavior changed.

## Phase status

**COMPLETE**

---

# Phase 2 — Critical security containment

## Objective

Prevent unauthenticated or incorrectly authorized callers from reaching
powerful Cursor operations. This phase takes priority over feature work.

## Architecture requirements

### Local WebSocket authentication

- Introduce protocol negotiation before accepting control commands.
- Generate a high-entropy pairing secret using a cryptographic RNG.
- Store only an appropriately protected verifier where possible.
- Issue scoped client credentials after successful pairing.
- Authenticate every new connection.
- Reject application messages before authentication.
- Validate allowed WebSocket Origins where browser behavior permits.
- Include credential rotation and revocation.
- Use timing-safe comparisons.
- Add a compatibility mode only if explicitly enabled and visibly marked
  insecure.

### Relay authorization

- Replace knowledge-based access with cryptographic device/session credentials.
- Separate:
  - human-readable session identifier;
  - mobile capability token;
  - extension capability token;
  - optional recovery credential.
- Authenticate every send, poll, heartbeat, approval, disconnect, and discovery
  operation.
- Default-deny public session discovery.
- Bind approval operations to authenticated session membership.
- Rotate or invalidate credentials on disconnect/reset.

### Command capability policy

- Replace generic command execution with typed commands.
- Define a default-deny allowlist.
- Eliminate policy differences between equivalent local, relay, Web, and
  Telegram command forms.
- Disable arbitrary terminal and VS Code command execution remotely.
- If advanced terminal control remains, require:
  - explicit local opt-in;
  - restricted command definitions;
  - dangerous-action confirmation;
  - audit records;
  - no free-form shell text.

## Telegram requirements

- Generate a distinct principal and client identity per Telegram user/chat.
- Enforce allowed user IDs and allowed chat IDs before command processing.
- Default to private chats only.
- Stop all global response broadcasting.
- Route replies through `(chatId, userId, sessionId, correlationId)`.
- Make `/sync off` remove every routing path for that chat.
- Prevent one Telegram user from stopping another user's CLI process.
- Sanitize command errors before sending them to Telegram.

## Session-management requirements

- Require explicit session targeting for powerful actions.
- Reject commands for missing or stale sessions.
- Do not fall back to an arbitrary CDP session.
- Scope pending commands and approvals to a principal and session.

## Startup script requirements

- Replace broad port killing with ownership-aware cleanup.
- Record child PIDs started by the script.
- Verify command path/process identity before termination.
- Never send `SIGKILL` to an unknown process.
- If a port is held by another process, fail clearly or choose a safe port.
- Preserve `--no-cleanup`.

## Reliability requirements

- Bound authentication and pairing timeouts.
- Add per-principal and global rate limits.
- Reject expired commands.
- Add command idempotency keys.
- Return explicit authorization and compatibility errors.

## Testing requirements

Add automated tests for:

- unauthenticated WS rejection;
- invalid and expired credentials;
- credential rotation/revocation;
- Origin behavior;
- unknown Telegram user/chat;
- cross-chat isolation;
- cross-user CLI isolation;
- relay membership enforcement;
- approval authorization;
- command policy equivalence;
- free-form execution rejection;
- replayed command handling;
- rate limiting;
- safe port cleanup.

## Validation

At minimum:

```bash
npm --prefix cursor-extension test
npm --prefix relay-server run type-check
npm --prefix relay-server run test:command-policy
cd mobile-app && flutter analyze && flutter test
```

Also run a local integration test proving:

1. unauthenticated clients cannot list sessions;
2. authenticated clients retain normal supported behavior;
3. Telegram chat A cannot observe or control chat B;
4. relay credentials cannot access another session;
5. CDP remains bound to `127.0.0.1`.

## Known limitations

- Existing clients may require a pairing migration.
- Cloudflare quick tunnels remain non-production infrastructure even after
  adding application authentication.

## Acceptance criteria

- No unauthenticated remote control path remains.
- No generic shell or generic VS Code command path remains remotely reachable.
- Relay operations require authenticated membership.
- Telegram output is session- and chat-scoped.
- Unknown Telegram identities receive no sensitive data.
- Startup cleanup cannot kill unrelated processes.
- All Phase 2 security tests pass.

---

# Phase 3 — Canonical state machine and event architecture

## Objective

Create one authoritative, typed session model shared by Web, relay, Telegram,
CLI, and CDP.

## Architecture requirements

- Implement `SessionRegistry`.
- Implement explicit `AgentState` transitions.
- Implement typed event and command envelopes.
- Add protocol schema versioning.
- Add bounded in-memory event history.
- Persist only the minimal state required for restoration.
- Add a serialized per-session `CommandBus`.
- Separate transport adapters from domain state.

Do not introduce a distributed broker unless measurements demonstrate that the
extension-local event bus is insufficient.

## Functional requirements

Each session snapshot must expose:

- stable identity;
- backend;
- workspace/window association;
- state;
- active task;
- latest message;
- pending approval;
- plan;
- changed files when available;
- recent errors;
- connection health;
- timestamps and revision.

Web and Telegram must query the same snapshots.

## Reliability requirements

- Deduplicate events by `eventId`.
- Deduplicate commands by idempotency key.
- Serialize commands per session.
- Support parallel commands only across independent sessions where safe.
- Handle out-of-order events using sequence/revision rules.
- Bound event history.
- Restore last-known snapshots after extension restart without presenting stale
  state as live.
- Mark restored sessions disconnected until rediscovered.

## Security requirements

- Carry authenticated principal information through the CommandBus.
- Reauthorize at execution time, not only at transport ingress.
- Ensure event subscriptions are filtered by authorized session scope.
- Redact private fields in transport-specific projections.

## Telegram requirements

- Telegram handlers become command producers and event/snapshot consumers.
- Remove direct use of global WebSocket response listeners.
- Every Telegram command requires explicit or safely stored per-chat session
  selection.
- Session selection must expire or reconcile if the target disappears.

## Web requirements

- Flutter consumes versioned snapshots/events.
- UI state must not infer Agent state from message text.
- Add compatibility parsing for the existing protocol during migration.

## Testing requirements

Add table-driven tests for:

- every allowed state transition;
- invalid transitions;
- duplicate events;
- duplicate commands;
- out-of-order events;
- stale snapshot restoration;
- per-session command serialization;
- independent multi-session execution;
- session removal and rediscovery;
- protocol v1/v2 compatibility.

## Validation

- Existing local and relay clients continue to operate through the documented
  compatibility path.
- Web and Telegram display the same session state and revision.
- A duplicate approval command resolves at most once.
- An event for session A never mutates session B.

## Known limitations

- CDP-derived fields may remain partial.
- Changed-file data may be unavailable until a supported source is implemented.

## Acceptance criteria

- One canonical state enum is used across domain behavior.
- One `SessionRegistry` owns authoritative snapshots.
- All commands and events carry correlation and session identity.
- Duplicate and out-of-order tests pass.
- Cross-session isolation tests pass.

---

# Phase 4 — Telegram as a first-class control interface

## Objective

Provide secure, ergonomic, session-scoped remote control from Telegram.

## Command requirements

Implement and document:

```text
/help
/sessions
/select
/status
/chat
/continue
/plan
/changes
/activity
/approve
/reject
/stop
/reconnect
/health
/alerts
/whoami
```

Behavior:

- `/help`: role-aware command list and examples.
- `/sessions`: paginated sessions with state, workspace, backend, and age.
- `/select`: session selection through buttons or explicit stable identifier.
- `/status`: canonical selected-session snapshot.
- `/chat`: send prompt to selected session.
- `/continue`: continue selected session only when backend supports it.
- `/plan`: current plan or explicit unavailable state.
- `/changes`: changed-file summary, never fabricated.
- `/activity`: bounded recent event list.
- `/approve` and `/reject`: request-specific operation.
- `/stop`: backend-aware stop with explicit support result.
- `/reconnect`: reconnect an integration, not arbitrary process execution.
- `/health`: sanitized component health.
- `/alerts`: per-chat notification preferences and quiet mode.
- `/whoami`: Telegram identity and assigned role, without secrets.

## Inline interaction requirements

Use inline keyboards for:

- session selection;
- pagination;
- permission approval/rejection;
- dangerous-action confirmation;
- refresh status;
- stop confirmation;
- alert preference selection.

Callback data must not contain secrets or untrusted free-form commands. Use a
short server-side action reference with:

- action ID;
- expected user/chat;
- session ID;
- request ID;
- action;
- expiry;
- one-time-use state.

## Authorization model

Minimum roles:

- `owner`: configuration and all permitted operations;
- `admin`: session control and user-approved dangerous actions;
- `operator`: prompts, selection, safe approvals, status;
- `read_only`: sessions, status, plan, changes, activity, health.

Requirements:

- Role checks occur per command and callback.
- Chat and user allowlists both apply when configured.
- Group chats are disabled by default.
- Bot privacy behavior is documented.
- Configuration changes are local-only unless a future secure management
  design is approved.

## Reliability requirements

- Persist Telegram update offsets safely.
- Deduplicate update IDs and callback action IDs.
- Use exponential backoff with jitter and retry ceilings.
- Apply per-request HTTP timeouts.
- Add a circuit breaker for sustained Telegram API failures.
- Use a bounded outbound queue.
- Categorize retryable and permanent API errors.
- Send long messages as safe chunks respecting Telegram limits.
- Escape Markdown/HTML correctly.
- Restart the MTProto child process with bounded policy if fallback remains.
- Pin Python dependencies or remove runtime package installation.

## Notification requirements

Support opt-in notifications for:

- permission requested;
- Agent completed;
- Agent failed;
- connection lost;
- connection restored;
- session removed;
- prolonged running task;
- health degradation.

Notifications must be:

- deduplicated;
- session-scoped;
- rate-limited;
- configurable per chat;
- suppressible through quiet mode;
- correlated with a session and timestamp.

## Security requirements

- Never send tokens, raw environment values, cookies, or stack traces.
- Never display another principal's private prompt/history without explicit
  authorization.
- Prompt and response logging is disabled or redacted by default.
- Dangerous commands use two-step confirmation.
- Approval callbacks are short-lived and one-time.
- No arbitrary callback payload execution.

## Session-management requirements

- Store selected session per authorized chat/user.
- Reconcile stale selections.
- Use stable labels and shortened IDs for presentation.
- Include workspace and backend to disambiguate similar sessions.
- Never auto-select a different session for a destructive action.

## Testing requirements

Use mocked Telegram API responses. Normal tests must not require a real token.

Test:

- every command;
- every role;
- unknown users/chats;
- group-chat default denial;
- callback tampering;
- callback expiry and replay;
- session selection;
- stale selection;
- approval and rejection;
- stop supported/unsupported;
- long-message chunking;
- Telegram 429 handling;
- transient 5xx handling;
- malformed updates;
- duplicate updates;
- restart with persisted offset;
- outbound queue overflow;
- notification preferences;
- quiet mode;
- secret redaction.

## Validation

Perform an authorized staging smoke test:

1. Start the bot.
2. Confirm `/whoami`.
3. List multiple sessions.
4. Select a session.
5. Send a prompt.
6. Receive state updates.
7. Receive a permission request.
8. Approve from an inline button.
9. Observe Web UI update.
10. Receive completion.
11. Restart the extension.
12. Confirm safe recovery without duplicate actions.

## Known limitations

- Telegram cannot provide streaming-token UX identical to the Web UI.
- Telegram API outages can delay notifications.
- CDP-derived approval and plan behavior remains constrained by Cursor DOM
  compatibility.

## Acceptance criteria

- All documented commands are role-aware and session-scoped.
- Inline approval buttons are request-specific and replay-safe.
- Cross-chat leakage tests pass.
- Telegram restarts without replaying completed actions.
- API outages do not cause infinite retry loops.
- `/help` accurately reflects supported commands and role.

---

# Phase 5 — Session and transport reliability

## Objective

Recover predictably from Cursor, extension, browser, network, relay, Telegram,
and CDP interruptions.

## Session-management requirements

- Create stable session matching rules using backend, workspace, Cursor window,
  and backend-specific durable identifiers.
- Distinguish:
  - temporary transport disconnect;
  - backend session removal;
  - Cursor restart;
  - extension restart;
  - stale last-known session.
- Use explicit session leases or last-seen timestamps.
- Remove stale sessions after a configurable period.
- Preserve archived diagnostic summaries separately from active sessions.
- Never route commands to a last-known session that is not live.

## WebSocket requirements

- Authenticated handshake with protocol negotiation.
- Heartbeats and bounded disconnect detection.
- Exponential reconnect with jitter and ceiling.
- Clear terminal state after retry exhaustion.
- Resume token or fresh pairing as defined by security policy.
- Bounded send queue.
- Explicit ACK for commands requiring delivery guarantees.
- No assumption that receiving any frame completes application handshake.

## Relay requirements

- Add authenticated disconnect/revoke behavior.
- Implement atomic queue claim/ACK semantics.
- Use visibility timeouts or leases for in-flight messages.
- Move permanently failed items to a bounded dead-letter store.
- Define retention and cleanup for sessions, events, approvals, commands, and
  responses.
- Remove dual queue writes that can duplicate delivery.
- Track queue depth and oldest-item age.
- Reconnect with backoff, jitter, and circuit breaking.
- Clear or downgrade connected state on heartbeat/poll failure.

## CDP requirements

- Keep CDP host enforcement at loopback.
- Use bounded retries with a visible degraded state.
- Continue low-rate health probes after retry exhaustion or provide manual
  recovery.
- Rediscover targets after Cursor restart.
- Cancel timers and listeners when targets disappear.
- Avoid duplicate target listeners.
- Use focused incremental DOM observation where possible.
- Isolate selectors and behavior behind a tested adapter.
- Capture sanitized selector failure diagnostics.

## CLI requirements

- Replace the single unscoped process with per-session execution ownership.
- Define whether concurrent CLI sessions are supported.
- If not supported, queue or reject with a clear reason.
- Bind stop operations to the owning session and principal.
- Add command timeout and graceful termination before forceful termination.
- Bound stdout/stderr capture.
- Persist only required, redacted history.

## Browser/mobile requirements

- Reconnect after visibility changes and mobile sleep.
- Do not report connected from persisted identifiers alone.
- Restore credentials without restoring false live state.
- Bound chat and event stores.
- Separate transport connection from Agent session state.
- Surface retry count, last success, and retry exhaustion.

## Testing requirements

Add deterministic fake-clock/fake-network tests for:

- Wi-Fi interruption;
- browser sleep/resume;
- extension restart;
- Cursor restart;
- CDP target disappearance;
- relay 5xx/timeouts;
- Telegram interruption;
- duplicate and delayed relay delivery;
- atomic queue claim;
- visibility timeout redelivery;
- dead-letter behavior;
- command timeout;
- stale session cleanup;
- bounded queue overflow;
- concurrent CLI commands;
- stop ownership.

## Integration scenario

Automate:

1. Start extension and fake backends.
2. Discover multiple sessions.
3. Connect Web and Telegram adapters.
4. Start a task.
5. Interrupt relay or WebSocket.
6. Restore network.
7. Confirm one command execution and consistent snapshots.
8. Restart Cursor/CDP fixture.
9. Rediscover the intended session.
10. Confirm stale sessions are not actionable.

## Known limitations

- Quick tunnels provide no uptime guarantee.
- CDP session matching may be approximate when Cursor exposes no stable
  conversation identifier.

## Acceptance criteria

- No infinite reconnect path.
- Retry exhaustion is visible and recoverable.
- Relay queue operations are atomic and acknowledged.
- Duplicate delivery does not duplicate command execution.
- Browser sleep recovery is verified.
- Cursor and extension restart scenarios preserve safe state.
- Cross-session process ownership tests pass.

---

# Phase 6 — Production-quality Web UI

## Objective

Make Flutter Web a clear, responsive, accessible remote Cursor client backed by
the canonical session model.

## Architecture requirements

Incrementally extract from `main.dart`:

- configuration and persistence;
- authenticated local WS transport;
- relay transport;
- protocol codec;
- session repository/controller;
- health controller;
- chat controller;
- permission controller;
- notification presentation.

Use dependency injection only where needed for testability. Do not adopt a new
state-management framework unless the existing architecture cannot meet the
phase requirements with smaller changes.

## Functional requirements

- Session list grouped by workspace.
- Explicit selected-session header.
- Backend and connection badges.
- State indicator from canonical state.
- Current task and elapsed duration.
- Latest response.
- Pending permission panel.
- Plan view.
- Changed-file summary.
- Activity feed.
- Health panel.
- Clear reconnect controls.
- Sticky prompt input.
- Bounded, performant chat history.

## UX requirements

- Mobile-first Android Chrome layout.
- No horizontal overflow at supported breakpoints.
- Touch targets of at least 44 logical pixels where practical.
- Sticky input that remains usable with the soft keyboard.
- Predictable scroll-to-latest behavior.
- User-controlled pause when reading older messages.
- Clear loading, empty, offline, stale, reconnecting, and error states.
- Never display raw relay envelopes as chat messages.
- Confirmation UI for dangerous actions.
- Preserve dark-mode consistency.

## Accessibility requirements

- Semantic labels on icon-only controls.
- Logical focus order.
- Keyboard operation for desktop Web.
- Sufficient contrast using theme tokens.
- Screen-reader announcements for meaningful state changes.
- Do not rely on color alone.
- Respect text scaling.

## Reliability requirements

- UI renders snapshots by revision.
- Stale events cannot overwrite newer snapshots.
- Reconnect status is transport-specific.
- Selected session disappearance is handled explicitly.
- Errors include a safe reason and correlation ID.
- Message and activity stores have retention limits.

## Security requirements

- Pairing secrets use secure input controls.
- Credentials are not included in URLs or browser logs.
- Sensitive values are not persisted unless required and protected by the
  platform's available storage capabilities.
- The UI clearly distinguishes LAN, tunnel, and relay risk.

## Testing requirements

Add widget and controller tests for:

- responsive breakpoints;
- session switching;
- state badges;
- permissions;
- plans;
- changed files unavailable/available;
- reconnect states;
- stale session removal;
- browser resume;
- bounded message history;
- accessibility semantics;
- text scaling;
- keyboard navigation;
- protocol compatibility;
- error presentation.

Update stale widget tests to assert intended current behavior, not merely to
silence failures.

## Validation

```bash
cd mobile-app
dart format --set-exit-if-changed .
flutter analyze
flutter test
flutter build web --release
```

Perform manual checks on:

- Android Chrome;
- narrow mobile viewport;
- desktop Chrome;
- local WebSocket;
- relay;
- offline/resume;
- soft keyboard.

## Known limitations

- Flutter Web cannot provide OS-level background execution guarantees.
- Android support in this repository is currently browser-based unless an
  Android project is intentionally added later.

## Acceptance criteria

- Flutter analyze and tests pass.
- Release Web build succeeds.
- Existing local and relay workflows remain functional.
- Required loading/error/offline states are visible and accurate.
- Accessibility tests cover primary controls.
- Raw protocol data never appears as user chat.

---

# Phase 7 — Test architecture and CI gates

## Objective

Make regressions and security failures difficult to merge.

## Test architecture

Create reusable fakes for:

- Cursor CLI process;
- CDP endpoint and DOM adapter;
- local authenticated WebSocket client;
- relay store contract;
- Telegram Bot API;
- clocks and timers;
- network failure injection;
- session registry;
- event and command streams.

Normal tests must not require:

- a real Telegram token;
- a real Cursor installation;
- production relay access;
- Cloudflare;
- personal credentials.

## Required unit suites

- state transition reducer;
- session registry;
- event deduplication and ordering;
- command authorization and idempotency;
- Telegram parser and callback handler;
- role policy;
- secret redaction;
- retry/backoff policy;
- relay store contract;
- protocol codecs;
- path and command policy.

## Required integration suites

### Permission flow

1. Discover session.
2. Start Agent.
3. Publish permission request.
4. Receive Telegram notification.
5. Approve exact request.
6. Update Web immediately.
7. Continue Agent.
8. Complete once.

### Cursor restart

1. Discover multiple sessions.
2. Persist last-known snapshots.
3. Simulate Cursor loss.
4. Mark sessions disconnected.
5. Rediscover replacement targets.
6. Reconcile stable sessions.
7. Reject commands for unreconciled stale sessions.

### Network interruption

1. Send idempotent command.
2. Drop response/ACK.
3. Redeliver.
4. Execute once.
5. Restore consistent Web and Telegram state.

### Multi-user isolation

1. Configure owner, operator, read-only, and unknown users.
2. Exercise every command.
3. Confirm role policy.
4. Confirm no cross-chat events or history.

## CI requirements

CI must run, at minimum:

- root dependency installation;
- extension compile and tests;
- relay typecheck and tests;
- `pc-server` build/tests if still supported;
- `cursor-cli` build/tests if supported;
- Flutter format check;
- Flutter analyze;
- Flutter tests;
- Flutter Web release build;
- secret scanning;
- dependency audit or equivalent documented checks.

CI must:

- use staging/fake endpoints;
- never default to production relay;
- fail on skipped required test groups;
- archive useful sanitized logs;
- cache dependencies safely;
- pin runtime/toolchain versions where practical.

## Repository ownership decision

Explicitly classify:

- `pc-server`: supported, deprecated-with-removal-date, or removed in a separate
  approved change.
- `cursor-cli`: supported and added to CI, or experimental and documented as
  such.
- duplicate Python Telegram bridge copies: one canonical implementation or
  generated artifact with enforced parity.

Do not silently delete legacy components.

## Validation

Run the same commands locally that CI executes. Verify a deliberate failing
security test causes CI failure.

## Known limitations

- End-to-end tests against real Cursor should remain a separate optional suite
  because private DOM behavior varies by release.

## Acceptance criteria

- All critical command, authorization, state, and reconnect behavior has
  automated coverage.
- CI runs tests rather than compile-only checks.
- Tests do not contact production services.
- Component support status is explicit.
- A failing security invariant blocks CI.

---

# Phase 8 — Performance and observability

## Objective

Reduce unnecessary work and make failures diagnosable without leaking sensitive
data.

## Structured logging requirements

Use structured fields:

```text
timestamp
level
component
event
sessionId
principalIdHash
correlationId
commandId
durationMs
status
errorCategory
retryCount
```

Never log:

- Telegram token;
- relay capability token;
- PIN;
- cookies;
- authentication headers;
- API keys;
- full prompts/responses by default;
- private file contents;
- raw environment values.

Add centralized redaction and tests.

## Health model

Track:

- extension activation;
- local WebSocket listener and authenticated client count;
- CDP connection and target count;
- CLI backend availability;
- relay connection and last heartbeat;
- Telegram update and send health;
- Cloudflare process status;
- active/live/stale session counts;
- queue depths and oldest-item age;
- reconnect counts;
- error counts by category;
- last successful event/command timestamps.

Expose:

- sanitized Telegram `/health`;
- Web UI health panel;
- local diagnostic command;
- optional authenticated machine-readable health snapshot.

Health must distinguish:

- healthy;
- degraded;
- unavailable;
- disabled;
- unknown.

## Performance requirements

- Measure before optimizing.
- Profile CDP scan duration and frequency.
- Replace full DOM polling with incremental observation where safe.
- Avoid duplicate target scans.
- Batch high-frequency message deltas.
- Bound Flutter rebuild scope.
- Bound chat, activity, error, and event histories.
- Avoid repeated JSON encoding/decoding.
- Avoid unnecessary Telegram edit/send calls.
- Apply log-level filtering before expensive formatting.

## Reliability observability

Record:

- retry exhaustion;
- circuit-breaker transitions;
- dead-letter additions;
- stale-session cleanup;
- duplicate suppression;
- out-of-order rejection;
- authorization rejection;
- timeout category;
- backend unsupported results.

## Testing requirements

- Redaction snapshot tests.
- Health transition tests.
- Queue metrics tests.
- Logging disabled/level tests.
- CDP scan benchmark fixture.
- Event throughput benchmark.
- Flutter rebuild/profile checks for key screens.
- Memory retention test for bounded histories.

## Validation

Compare pre/post measurements:

- idle extension CPU;
- CDP scan time;
- memory after long chat/event history;
- WebSocket messages per common workflow;
- relay requests per minute;
- Telegram API calls per task;
- Flutter frame/rebuild behavior.

Do not claim an optimization without measured evidence.

## Known limitations

- Health cannot guarantee third-party uptime.
- Metrics may remain local unless a separate telemetry design is approved.

## Acceptance criteria

- Structured redacted logging is used by primary components.
- `/health` and Web health panel share the canonical model.
- Histories and queues are bounded.
- Performance changes include reproducible measurements.
- No secret appears in representative logs or error responses.

---

# Phase 9 — Final production hardening and release validation

## Objective

Validate the complete system under realistic failures and publish an honest
production-readiness assessment.

## Security validation

- Re-audit exposed ports.
- Confirm CDP is loopback-only.
- Confirm local WS authentication.
- Confirm relay capability enforcement.
- Confirm Telegram allowlists and roles.
- Attempt replay and cross-session attacks.
- Attempt callback tampering.
- Attempt path traversal and command injection.
- Scan repository and artifacts for secrets.
- Review dependency vulnerabilities.
- Confirm secret-safe logs.

## Reliability validation

Run failure-injection scenarios for:

- Cursor restart;
- extension restart;
- machine restart;
- local WS disconnect;
- Wi-Fi interruption;
- browser sleep/resume;
- relay timeout/5xx;
- Redis/Supabase transient failure;
- Telegram API timeout/429/5xx;
- MTProto child failure if retained;
- CDP disconnect;
- session disappearance;
- duplicate and out-of-order events;
- stale commands;
- command timeout;
- partially executed command;
- queue overflow;
- retry exhaustion.

## Full end-to-end scenario

1. Start the system.
2. Authenticate Web and Telegram clients.
3. Detect multiple Cursor sessions.
4. Select the same session from both interfaces.
5. Start an Agent task from Web.
6. Observe state from Telegram.
7. Receive an exact permission request.
8. Approve it from Telegram.
9. Observe immediate Web update.
10. Continue Agent execution.
11. Receive completion once.
12. Inspect plan, activity, changed files, and health.
13. Restart Cursor.
14. Reconcile or safely invalidate sessions.
15. Restore Web and Telegram connections.
16. Confirm no stale command executes.
17. Repeat with a rejected permission.
18. Repeat with network interruption.

## Final validation commands

Use repository scripts when they have been made authoritative. At minimum:

```bash
# Extension
npm --prefix cursor-extension run compile
npm --prefix cursor-extension test
npm --prefix cursor-extension run vscode:prepublish

# Relay
npm --prefix relay-server run type-check
npm --prefix relay-server run validate:command-event
npm --prefix relay-server run test:command-policy
# Run newly added relay unit/integration test scripts.

# Legacy/standalone components, according to final support decision
npm --prefix pc-server run build
npm --prefix cursor-cli run build

# Flutter
cd mobile-app
dart format --set-exit-if-changed .
flutter analyze
flutter test
flutter build web --release
```

Also:

- run secret scanning;
- run dependency audits;
- inspect sanitized runtime logs;
- run staging integration suites;
- verify CI from a clean checkout;
- verify installation/startup documentation.

## Documentation requirements

Update:

- root README;
- extension README;
- mobile/Web instructions;
- relay deployment instructions;
- protocol specification;
- Telegram setup and security guide;
- configuration reference;
- troubleshooting guide;
- support matrix;
- migration guide;
- operational runbook.

Remove or label outdated instructions. Align package and documentation versions.

## Release acceptance criteria

Production-ready may be declared only when:

- all critical and high security findings are closed or explicitly accepted by
  the owner with documented mitigations;
- all required automated tests pass;
- CI passes from a clean checkout;
- Web and Telegram share canonical state;
- cross-user and cross-session isolation is verified;
- no generic remote execution endpoint exists;
- relay delivery is idempotent and acknowledged;
- retry loops are bounded;
- health reporting is accurate;
- Android Chrome runtime scenarios pass;
- startup and recovery documentation is reproducible;
- runtime logs contain no secrets;
- remaining limitations are clearly labeled.

## Known unavoidable limitations

- Cursor CDP integration depends on private UI/DOM behavior and may break after
  Cursor upgrades.
- Cloudflare quick tunnels have no production uptime guarantee.
- Telegram delivery depends on Telegram availability.
- Flutter Web background behavior depends on browser/OS lifecycle constraints.

If these limitations are unacceptable, supported upstream APIs and production
tunnel/hosting infrastructure are required.

---

# 8. Cross-phase acceptance matrix

| Area | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 | Phase 7 | Phase 8 | Phase 9 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Authenticated WS | Required | Preserve | Preserve | Recovery | UX | CI | Health | Re-audit |
| Relay authorization | Required | Integrate | Preserve | Delivery | UX | CI | Metrics | Re-audit |
| Telegram isolation | Required | Integrate | Complete | Recovery | Sync | CI | Health | Re-audit |
| State machine | — | Required | Consume | Recovery | Consume | CI | Metrics | Validate |
| Typed events | — | Required | Consume | Delivery | Consume | CI | Metrics | Validate |
| Session recovery | Reject stale | Model | UX | Required | UX | CI | Metrics | Validate |
| Inline approvals | Safe base | Model | Required | Recovery | Sync | CI | Metrics | Validate |
| Web production UX | Security messaging | Protocol | Sync | Recovery | Required | CI | Profile | Validate |
| Test coverage | Security tests | Domain tests | Telegram tests | Failure tests | Widget tests | Full gates | Perf tests | Full run |

# 9. Required final report format

After Phase 9, produce a final report containing:

1. Complete architecture overview.
2. Trust boundaries.
3. Problems found.
4. Bugs fixed.
5. Security issues fixed.
6. Reliability improvements.
7. Telegram architecture and command list.
8. Session-management architecture.
9. State-machine design.
10. Event and command models.
11. Web UI improvements.
12. Performance measurements.
13. Observability and health behavior.
14. New functionality.
15. Tests added.
16. Exact test results.
17. Remaining limitations.
18. Remaining risks.
19. Deferred features and rationale.
20. Files changed.
21. Exact installation/run commands.
22. Upgrade/migration requirements.
23. Rollback instructions.
24. Production-readiness verdict.

# 10. Agent phase execution template

The implementing agent should use this structure for every phase:

```md
## Phase N execution report

### Assumptions
- ...

### Pre-change baseline
- Command:
- Result:

### Implementation
- File:
- Change:
- Reason:

### Security impact
- ...

### Compatibility impact
- ...

### Tests added
- ...

### Validation results
- PASS/FAIL:

### Acceptance criteria
- [x] ...
- [ ] ...

### Remaining limitations
- ...

### Decision
- READY FOR NEXT PHASE
or
- BLOCKED: <specific reason>
```

# 11. Deferred feature ideas

These features are useful but should not delay security and state correctness:

- session pinning;
- favorite sessions;
- human-readable session labels;
- session search and workspace grouping;
- session archives;
- Agent timeline;
- notification schedules and quiet mode;
- command audit viewer;
- manual session recovery;
- retry failed task;
- task duration;
- current tool display;
- token/context usage when reliably available;
- richer diff summary;
- secure pairing QR code;
- read-only observer role.

Implement these only after Phase 9 or when a phase explicitly needs the
underlying capability.

# 12. Final instruction to the coding agent

Start by re-running the Phase 1 baseline and comparing it to this document.
Then begin Phase 2 only.

Do not implement all phases in one unreviewable change. Complete the current
phase, run its acceptance tests, report results, and proceed only after the gate
is satisfied.

Security containment comes before feature expansion. A seamless interface is
not production-ready if session identity, authorization, command execution, or
message routing is ambiguous.
