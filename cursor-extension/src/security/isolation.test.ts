import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CHAT_CHANGED } from "../cdp/agents-window";

// Only the editor host is faked; no Telegram API or Cursor process is started.
const Module = require("node:module");
const originalLoad = Module._load;
let TelegramBridge: any;
let CLIHandler: any;
let CommandRouter: any;
let WebSocketServer: any;
try {
  Module._load = function(name: string, ...args: any[]) {
    if (name === "vscode") return { workspace: { getConfiguration: () => ({ get: (_: string, fallback: any) => fallback }) } };
    return originalLoad.call(this, name, ...args);
  };
  TelegramBridge = require("../telegram-bridge").TelegramBridge;
  WebSocketServer = require("../websocket-server").WebSocketServer;
  CLIHandler = require("../cli-handler").CLIHandler;
  CommandRouter = require("../command-router").CommandRouter;
} finally { Module._load = originalLoad; }

function fixture() {
  const sent: Array<{ chat: number; text: string }> = [];
  const bridge = new TelegramBridge({ appendLine() {} }, {}, {}, {}, "");
  bridge.allowed = new Set([1, 2]);
  bridge.allowedChats = new Set([1, 2]);
  bridge.sendText = async (chat: number, text: string) => { sent.push({ chat, text }); };
  return { bridge, sent };
}

test("Telegram rejects unknown users, unknown chats and groups before dispatch", async () => {
  const { bridge, sent } = fixture();
  let dispatched = 0;
  bridge.dispatch = async () => { dispatched++; };
  for (const [user, chat, type] of [[9, 9, "private"], [1, 3, "private"], [1, -1, "group"], [1, 2, "private"]]) {
    await bridge.handleUpdate({ message: { from: { id: user }, chat: { id: chat, type }, text: "/status" } });
  }
  assert.equal(dispatched, 0);
  assert.deepEqual(sent, []);
  await bridge.handleUpdate({ message: { from: { id: 1 }, chat: { id: 1, type: "private" }, text: "/status" } });
  assert.equal(dispatched, 1);
});

test("Telegram rate limits an authorized user before dispatch", async () => {
  const { bridge } = fixture();
  let dispatched = 0;
  bridge.dispatch = async () => { dispatched++; };
  for (let i = 0; i < 31; i++) {
    await bridge.handleUpdate({ message: { from: { id: 1 }, chat: { id: 1, type: "private" }, text: "/status" } });
  }
  assert.equal(dispatched, 30);
  await bridge.handleUpdate({ message: { from: { id: 2 }, chat: { id: 2, type: "private" }, text: "/status" } });
  assert.equal(dispatched, 31);
});

test("Telegram routes only attributed replies; sync off removes pending routing", async () => {
  const { bridge, sent } = fixture();
  const state = bridge.getState(1, 1);
  bridge.getState(2, 2);
  bridge.pendingByChat.set(1, { userId: 1 });
  bridge.pendingByChat.set(2, { userId: 2 });
  bridge.lastSyncChatId = 2;
  bridge.handleOutbound(JSON.stringify({ type: "chat_response", text: "private", clientId: "telegram:1:1" }));
  assert.deepEqual(sent.map(x => x.chat), [1]);
  assert.ok(bridge.pendingByChat.has(2));
  bridge.handleOutbound(JSON.stringify({ type: "chat_response", text: "global" }));
  assert.equal(sent.length, 1);
  await bridge.dispatch(1, 1, state, "/sync off");
  sent.length = 0;
  bridge.pendingByChat.set(1, { userId: 1 });
  bridge.lastSyncChatId = 1;
  bridge.handleOutbound(JSON.stringify({ type: "chat_response", text: "private", clientId: "telegram:1:1" }));
  assert.deepEqual(sent, []);
});

test("Telegram approve codes are bound to one request, need a confirm from the same user, and expire", async () => {
  const { bridge, sent } = fixture();
  const routed: any[] = [];
  bridge.commandRouter = { handleCommand: async (c: any) => { routed.push(c); } };
  const state = bridge.getState(1, 1);
  for (const command of ["/approve", "/reject", "/confirm", "/approve_abcdef", "/confirm_abcdef"]) {
    await bridge.dispatch(1, 1, state, command);
  }
  assert.equal(routed.length, 0);

  sent.length = 0;
  bridge.onComposerState({ chatId: "chat-1", title: "T", pending: { id: "req-abc", command: "npm test", detail: "" } });
  bridge.onComposerState({ chatId: "chat-1", title: "T", pending: { id: "req-abc", command: "npm test", detail: "" } });
  assert.deepEqual(sent.map(x => x.chat), [1, 2]);
  const code = sent[0].text.match(/\/approve_([a-f0-9]{6})/)![1];
  assert.equal(sent[1].text.match(/\/approve_([a-f0-9]{6})/)![1], code);

  await bridge.dispatch(1, 1, state, `/approve_${code}`);
  assert.equal(routed.length, 0);
  await bridge.dispatch(2, 2, bridge.getState(2, 2), `/confirm_${code}`);
  assert.equal(routed.length, 0);
  await bridge.dispatch(1, 1, state, `/confirm_${code}`);
  assert.equal(routed.length, 1);
  assert.deepEqual(
    { type: routed[0].type, chatId: routed[0].chatId, requestId: routed[0].requestId, confirmed: routed[0].confirmed, clientId: routed[0].clientId },
    { type: "approve_action", chatId: "chat-1", requestId: "req-abc", confirmed: true, clientId: "telegram:1:1" }
  );
  await bridge.dispatch(1, 1, state, `/confirm_${code}`);
  assert.equal(routed.length, 1);

  sent.length = 0;
  bridge.onComposerState({ chatId: "chat-1", title: "T", pending: null });
  bridge.onComposerState({ chatId: "chat-1", title: "T", pending: { id: "req-def", command: "ls", detail: "" } });
  const code2 = sent[0].text.match(/\/reject_([a-f0-9]{6})/)![1];
  bridge.approvalCodes.get(code2).expiresAt = Date.now() - 1;
  await bridge.dispatch(1, 1, state, `/reject_${code2}`);
  await bridge.dispatch(1, 1, state, `/confirm_${code2}`);
  assert.equal(routed.length, 1);
  assert.match(sent.at(-2)!.text, /expired/);
});

test("Telegram /stop, /model and /newchat go through the command router", async () => {
  const { bridge } = fixture();
  const routed: any[] = [];
  bridge.commandRouter = { handleCommand: async (c: any) => { routed.push(c); } };
  const state = bridge.getState(1, 1);
  state.backend = "cdp";
  await bridge.dispatch(1, 1, state, "/stop");
  await bridge.dispatch(1, 1, state, "/model GPT-5");
  await bridge.dispatch(1, 1, state, "/newchat");
  assert.deepEqual(routed.map(c => [c.type, c.model, c.clientId]), [
    ["agent_stop", undefined, "telegram:1:1"],
    ["set_model", "GPT-5", "telegram:1:1"],
    ["new_chat", undefined, "telegram:1:1"],
  ]);
});

test("only one Cursor window may own the Telegram bot", () => {
  const { acquireTelegramLock, releaseTelegramLock } = require("../telegram-bridge");
  const { mkdtempSync, writeFileSync, existsSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const lock = resolve(mkdtempSync(resolve(tmpdir(), "cr-tg-")), "telegram.lock");
  assert.deepEqual(acquireTelegramLock(lock, process.pid), { ok: true });
  assert.deepEqual(acquireTelegramLock(lock, process.pid), { ok: true });
  assert.deepEqual(acquireTelegramLock(lock, 424242), { ok: false, ownerPid: process.pid });
  releaseTelegramLock(lock, 424242);
  assert.ok(existsSync(lock));
  releaseTelegramLock(lock, process.pid);
  assert.ok(!existsSync(lock));
  writeFileSync(lock, "999999");
  assert.deepEqual(acquireTelegramLock(lock, process.pid), { ok: true });
});

test("Telegram legacy window-session commands are gone and never reach Cursor", async () => {
  const commands: any[] = [];
  const sent: string[] = [];
  const router = { handleCommand: async (c: any) => { commands.push(c); } };
  const bridge = new TelegramBridge({ appendLine() {} }, router, {}, {}, "");
  bridge.sendText = async (_: number, text: string) => { sent.push(text); };
  const state = bridge.getState(1, 1);
  for (const text of ["/sessions", "/use 2", "/use_2", "/to 2 run the tests", "/history", "/open 3", "/state", "/plan", "/messages"]) {
    await bridge.dispatch(1, 1, state, text);
  }
  assert.deepEqual(commands, []);
  assert.equal(sent.length, 9);
  assert.ok(sent.every((t) => /\/chats/.test(t)), sent.join("\n"));
  sent.length = 0;
  state.backend = "cdp";
  await bridge.dispatch(1, 1, state, "run the tests");
  await bridge.dispatch(1, 1, state, "/last");
  assert.deepEqual(commands, []);
  assert.ok(sent.every((t) => /\/chats/.test(t)), sent.join("\n"));
});

test("Telegram drops messages queued for more than two minutes", async () => {
  const { bridge } = fixture();
  let dispatched = 0;
  bridge.dispatch = async () => { dispatched++; };
  const now = Math.floor(Date.now() / 1000);
  await bridge.handleUpdate({ message: { date: now - 600, from: { id: 1 }, chat: { id: 1, type: "private" }, text: "/status" } });
  assert.equal(dispatched, 0);
  await bridge.handleUpdate({ message: { date: now - 5, from: { id: 1 }, chat: { id: 1, type: "private" }, text: "/status" } });
  assert.equal(dispatched, 1);
});

test("Telegram never leaves a prompt hanging: CLI errors and empty replies are reported", () => {
  const { bridge, sent } = fixture();
  bridge.getState(1, 1);
  bridge.pendingByChat.set(1, { userId: 1 });
  bridge.handleOutbound(JSON.stringify({ type: "error", message: "The CLI returned no result.", clientId: "telegram:1:1" }));
  assert.equal(bridge.pendingByChat.has(1), false);
  assert.match(sent[0].text, /CLI returned no result/);
  bridge.handleOutbound(JSON.stringify({ type: "chat_response", text: "  ", clientId: "telegram:1:1" }));
  assert.match(sent[1].text, /without a reply/);
  bridge.handleOutbound(JSON.stringify({ type: "error", message: "x", clientId: "telegram:2:2" }));
  assert.equal(sent.length, 2);
});

test("Telegram lock fails closed when the lock file cannot be created", () => {
  const { acquireTelegramLock } = require("../telegram-bridge");
  assert.deepEqual(acquireTelegramLock("/nonexistent-dir-cr/telegram.lock", process.pid), { ok: false, ownerPid: -1 });
});

test("a new CLI prompt cannot replace another user's running or preparing process", async () => {
  const cli = new CLIHandler();
  cli.currentProcess = { kill() { assert.fail("must not interrupt existing process"); } };
  await assert.rejects(cli.sendPrompt("other user", true, "telegram:2:2"), /busy/);
  cli.currentProcess = null;
  let finish: () => void = () => {};
  cli.sendPromptInternal = () => new Promise<void>(resolve => { finish = resolve; });
  const first = cli.sendPrompt("first", true, "telegram:1:1");
  await assert.rejects(cli.sendPrompt("second", true, "telegram:2:2"), /busy/);
  finish();
  await first;
  assert.equal(cli.preparingPrompt, false);
});

test("the production router never dispatches generic execution or terminal aliases", async () => {
  let executions = 0;
  const results: any[] = [];
  const backend = {
    executeCommand() { executions++; }, insertToTerminal() { executions++; },
    executeAction() { executions++; },
  };
  const router = new CommandRouter(backend, { send: (raw: string) => results.push(JSON.parse(raw)) }, { appendLine() {} });
  router.log = () => {};
  router.logError = () => {};
  for (const command of [
    { type: "execute_command", command: "workbench.action.terminal.new" },
    { type: "execute_action", action: "terminal" },
    { type: "insert_text", terminal: true, execute: true, text: "echo unsafe" },
  ]) await router.handleCommand(command);
  assert.equal(executions, 0);
  assert.equal(results.length, 3);
  assert.ok(results.every(result => result.success === false));
});

test("startup cleanup preserves unowned listeners and checks child identity", () => {
  const script = readFileSync(resolve(__dirname, "../../../scripts/start-cursor-remote-stack.sh"), "utf8");
  const wsCleanup = script.match(/cleanup_ws_ports\(\) \{[\s\S]*?\n\}/)?.[0];
  const webCleanup = script.match(/cleanup_owned_web\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(wsCleanup && webCleanup);
  const fixture = `
set -eu
WS_PORT_DEFAULT=8766
WS_PORT_MAX=8770
WEB_CHILD_PID=12345
WEB_PORT=8080
PID_FILE=/unused-test-path
log() { :; }
lsof() { return 0; }
kill() { echo "killed $*"; }
rm() { :; }
ps() { case "$*" in *ppid=*) echo 999999;; *) echo 'python3 -m http.server 8080 --bind 0.0.0.0';; esac; }
${wsCleanup}
${webCleanup}
cleanup_ws_ports
cleanup_owned_web
ps() { case "$*" in *ppid=*) echo $$;; *) echo 'unrelated-process';; esac; }
cleanup_owned_web
ps() { case "$*" in *ppid=*) echo $$;; *) echo 'python3 -m http.server 8080 --bind 0.0.0.0';; esac; }
cleanup_owned_web
`;
  const result = spawnSync("bash", ["-c", fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "killed -TERM 12345");
});

test("port takeover only targets orphaned extension hosts of the same user", () => {
  const { isOrphanedExtensionHost } = require("../websocket-server");
  const { mkdtempSync, writeFileSync, chmodSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const dir = mkdtempSync(resolve(tmpdir(), "cr-ps-"));
  const uid = process.getuid!();
  const rows: Record<string, string> = {
    "101": `1 ${uid} Cursor Helper (Plugin): extension-host (user) ppsl [1-3]`,
    "102": `4242 ${uid} Cursor Helper (Plugin): extension-host (user) ppsl [1-8]`,
    "103": `1 ${uid} python3 -m http.server 8766`,
    "104": `1 ${uid + 1} Cursor Helper (Plugin): extension-host (user) x`,
  };
  const cases = Object.entries(rows).map(([pid, row]) => `${pid}) echo '${row}';;`).join(" ");
  writeFileSync(resolve(dir, "ps"), `#!/bin/sh\npid="$4"\ncase "$pid" in ${cases} *) exit 1;; esac\n`);
  chmodSync(resolve(dir, "ps"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    assert.equal(isOrphanedExtensionHost(101), true);
    assert.equal(isOrphanedExtensionHost(102), false);
    assert.equal(isOrphanedExtensionHost(103), false);
    assert.equal(isOrphanedExtensionHost(104), false);
    assert.equal(isOrphanedExtensionHost(999), false);
  } finally {
    process.env.PATH = oldPath;
  }
});


test("a user Stop is not undone by the watchdog, and Start works again", async () => {
  const server = new WebSocketServer(47766);
  await server.start({ preferFreePreferredPort: false, quiet: true });
  try {
    assert.equal(server.isRunning(), true);
    server.stop();
    assert.equal(await server.ensureListening({ onlyIfWanted: true }), false);
    assert.equal(server.isRunning(), false);
    await server.start({ preferFreePreferredPort: false, quiet: true });
    assert.equal(server.isRunning(), true);
    assert.equal(await server.ensureListening({ onlyIfWanted: true }), true);
  } finally {
    server.stop();
  }
});

test("outbound replies never cross local, Telegram, and relay principals", () => {
  const server = new WebSocketServer(0);
  const localA: string[] = [], localB: string[] = [], relay: string[] = [];
  server.wss = {};
  server.clients = new Set([
    {readyState: 1, clientId: "a", send: (raw: string) => localA.push(raw)},
    {readyState: 1, clientId: "b", send: (raw: string) => localB.push(raw)},
  ]);
  server.setRelayClient({isConnectedToSession: () => true,
    sendMessage: async (raw: string) => { relay.push(raw); }});
  const send = (payload: any) => server.send(JSON.stringify(payload));
  send({type: "chat_response", text: "private", clientId: "a"});
  assert.equal(localA.length, 1); assert.equal(localB.length, 0); assert.equal(relay.length, 0);
  send({type: "chat_response", clientId: "telegram:1:1"});
  send({type: "chat_response", clientId: "relay:S:mobile", targetDeviceId: "mobile"});
  assert.equal(relay.length, 1);
  send({type: "chat_response", text: "unattributed"});
  server.broadcast(JSON.stringify({type: "log", clientId: "a", message: "secret"}));
  server.send("malformed");
  assert.equal(localA.length, 1); assert.equal(localB.length, 0); assert.equal(relay.length, 1);
});

test("CLI output failures are attributed errors and never expose stderr", () => {
  const cli = Object.create(CLIHandler.prototype);
  const sent: any[] = [];
  cli.wsServer = {send: (raw: string) => sent.push(JSON.parse(raw))};
  cli.log = () => {};
  cli.lastStreamedText = new Map();
  cli.currentSenderDeviceId = "mobile";
  cli.checkAndProcessOutput("", "secret-token=private", "relay:S:mobile");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "error");
  assert.equal(sent[0].clientId, "relay:S:mobile");
  assert.equal(sent[0].targetDeviceId, "mobile");
  assert.ok(!JSON.stringify(sent).includes("private"));
  cli.checkAndProcessOutput("", "private", undefined);
  assert.equal(sent.length, 1);
});


test("router responses preserve each concurrent request's recipient", async () => {
  const results: any[] = [];
  const router = new CommandRouter({getCdpStatus: async () => ({type: "cdp_status"})},
    {send: (raw: string) => results.push(JSON.parse(raw))}, {appendLine() {}});
  router.log = () => {};
  await Promise.all(["a", "b"].map(clientId => router.handleCommand({
    type: "get_cdp_status", id: clientId, clientId, senderDeviceId: `device-${clientId}`,
  })));
  assert.equal(results.length, 4);
  for (const reply of results) {
    assert.equal(reply.correlationId, reply.clientId);
    assert.equal(reply.targetDeviceId, `device-${reply.clientId}`);
  }
});

test("remote approve/reject is bound to the open chat's exact request, confirmed, gated and audited", async () => {
  const CHAT = "aaaaaaaa-1111-2222-3333-444444444444";
  const audit: string[] = [];
  const resolved: Array<[string, boolean]> = [];
  let enabled = true;
  const replies: any[] = [];
  const router = new CommandRouter({}, {send: (raw: string) => replies.push(JSON.parse(raw))},
    {appendLine: (l: string) => audit.push(l)});
  router.log = () => {};
  router.setChatServices({
    index: {}, diff: {}, watcher: {},
    remoteActionsEnabled: () => enabled,
    agents: () => ({
      attached: true,
      composerState: async () => ({ok: true, state: {chatId: CHAT}}),
      resolve: async (requestId: string, approve: boolean, chatId: string) => {
        if (chatId !== CHAT) return {ok: false, error: CHAT_CHANGED};
        resolved.push([requestId, approve]);
        return requestId === "req-abc123" ? {ok: true, label: "Run"} : {ok: false, error: "That request is no longer pending"};
      },
    }),
  });
  const send = async (extra: Record<string, unknown>) => {
    await router.handleCommand({
      type: "approve_action", id: "c1", clientId: "relay:S1", senderDeviceId: "phone",
      chatId: CHAT, requestId: "req-abc123", confirmed: true, ...extra,
    });
    return replies.filter((r) => r.type === "command_result").at(-1);
  };

  assert.equal((await send({confirmed: undefined})).success, false);
  assert.equal((await send({requestId: undefined})).success, false);
  assert.equal((await send({requestId: "Allow"})).success, false);
  assert.equal((await send({chatId: "bbbbbbbb-1111-2222-3333-444444444444"})).success, false);
  assert.deepEqual(resolved, []);

  assert.equal((await send({requestId: "req-stale1"})).success, false);
  assert.equal((await send({type: "reject_action"})).success, true);
  assert.equal((await send({})).success, true);
  assert.deepEqual(resolved, [["req-stale1", true], ["req-abc123", false], ["req-abc123", true]]);

  enabled = false;
  assert.equal((await send({})).success, false);
  assert.equal(resolved.length, 3);

  const lines = audit.filter((l) => l.includes("[Audit]"));
  assert.equal(lines.length, 8);
  assert.ok(lines.every((l) => l.includes("channel=relay") && !l.includes("phone")));
  assert.ok(lines.at(-1)!.includes("result=refused disabled"));
});

test("CLI stop is a typed, gated and audited remote action", async () => {
  let stops = 0;
  let enabled = true;
  const audit: string[] = [];
  const replies: any[] = [];
  const router = new CommandRouter({ stopPrompt: async () => { stops++; return { success: true }; } },
    {send: (raw: string) => replies.push(JSON.parse(raw))}, {appendLine: (l: string) => audit.push(l)});
  router.log = () => {};
  router.setChatServices({ index: {}, diff: {}, watcher: {}, remoteActionsEnabled: () => enabled, agents: () => null });
  const stop = async () => {
    await router.handleCommand({ type: "stop_prompt", id: "s1", clientId: "telegram:1:1" });
    return replies.filter((r) => r.type === "command_result").at(-1);
  };
  assert.equal((await stop()).success, true);
  enabled = false;
  assert.equal((await stop()).success, false);
  assert.equal(stops, 1);
  const lines = audit.filter((l) => l.includes("[Audit]"));
  assert.equal(lines.length, 2);
  assert.ok(lines.at(-1)!.includes("result=refused disabled"));
});

test("Telegram /status, /file and /save go through the router, never the handler directly", async () => {
  const commands: any[] = [];
  const router = { handleCommand: async (c: any) => { commands.push(c); } };
  const handler = new Proxy({}, { get: () => { throw new Error("handler called directly"); } });
  const bridge = new TelegramBridge({ appendLine() {} }, router, handler, { getActualPort: () => 8766, isRunning: () => true }, "");
  bridge.sendText = async () => {};
  const state = bridge.getState(1, 1);
  for (const text of ["/status", "/file", "/save"]) await bridge.dispatch(1, 1, state, text);
  assert.deepEqual(commands.map((c) => c.type), ["get_cdp_status", "get_session_info", "get_active_file", "save_file"]);
  assert.ok(commands.every((c) => c.clientId === "telegram:1:1"));
});
