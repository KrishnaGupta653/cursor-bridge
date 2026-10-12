import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { MtprotoSendTracker, mtprotoDeleteLine, mtprotoSendLine } from "../telegram-mtproto";

// Only the editor host is faked; no Telegram API, relay or Cursor process is started.
const Module = require("node:module");
const originalLoad = Module._load;
let TelegramBridge: any;
let CommandRouter: any;
let showPairingCodeBox: any;
try {
  Module._load = function(name: string, ...args: any[]) {
    if (name === "vscode") {
      return {
        workspace: { getConfiguration: () => ({ get: (_: string, fallback: any) => fallback }) },
        ThemeIcon: class { constructor(public id: string) {} },
      };
    }
    return originalLoad.call(this, name, ...args);
  };
  ({ TelegramBridge } = require("../telegram-bridge"));
  CommandRouter = require("../command-router").CommandRouter;
  showPairingCodeBox = require("../pairing-box").showPairingCodeBox;
} finally { Module._load = originalLoad; }

const APP = "https://cursor-remote-app.vercel.app/";
const RELAY = "https://relay.test";
const link = (sid: string) => `${APP}?relay=${encodeURIComponent(RELAY)}&session=${sid}`;
const APP_ONLY = `${APP}?relay=${encodeURIComponent(RELAY)}`;

function fixture(relayState: { sessionId: string | null; connected: boolean } = { sessionId: "ABC123", connected: true }) {
  const out: string[] = [];
  const channel = { appendLine: (l: string) => out.push(l) };
  const flags = { remoteActions: true, failDelete: false };
  const router = new CommandRouter({}, { send() {} }, channel);
  router.setChatServices({ index: {}, diff: {}, watcher: {}, agents: () => null, remoteActionsEnabled: () => flags.remoteActions });
  const codes: string[] = [];
  const notified: string[] = [];
  const relay = {
    status: () => ({ ...relayState, serverUrl: RELAY }),
    createSingleUseCode: async () => {
      const code = `PAIRCODE${codes.length + 1}`.padEnd(43, "x");
      codes.push(code);
      return { code, expiresInSeconds: 300 };
    },
    onTelegramCode: (sid: string) => notified.push(sid),
  };
  const bridge = new TelegramBridge(channel, router, {}, {}, "", null, relay);
  bridge.allowed = new Set([1]);
  bridge.allowedChats = new Set([1]);
  bridge.mode = "botapi";
  const sent: Array<{ chat: number; text: string }> = [];
  bridge.sendText = async (chat: number, text: string) => { sent.push({ chat, text }); };
  const api: Array<{ method: string; body: any }> = [];
  bridge.api = async (method: string, body: any) => {
    api.push({ method, body });
    if (method === "deleteMessage" && flags.failDelete) return { ok: false, description: "message can't be deleted" };
    return method === "sendMessage" ? { ok: true, result: { message_id: 40 + api.length } } : { ok: true };
  };
  let now = 1_000_000;
  bridge.now = () => now;
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  bridge.schedule = (fn: () => void, ms: number) => {
    scheduled.push({ fn, ms });
    const t = setTimeout(() => {}, 2 ** 31 - 1);
    t.unref();
    return t;
  };
  const audit = () => out.filter((l) => l.includes("[Audit]"));
  const send = (text: string, user = 1, chat = 1) =>
    bridge.handleUpdate({ message: { from: { id: user }, chat: { id: chat, type: "private" }, text } });
  return { bridge, out, flags, codes, notified, sent, api, scheduled, audit, send, advance: (ms: number) => { now += ms; } };
}

test("Telegram /app links the web app, with the relay session when there is one, even with remote actions off", async () => {
  const f = fixture();
  f.flags.remoteActions = false;
  await f.send("/app");
  assert.deepEqual(f.sent.map((s) => s.text), [`Open Cursor Remote: ${link("ABC123")}`]);
  const none = fixture({ sessionId: null, connected: false });
  await none.send("/app");
  assert.deepEqual(none.sent.map((s) => s.text), [`Open Cursor Remote: ${APP_ONLY}`]);
});

test("Telegram /start and /help end with the app link and list /app, /relay and /pair", async () => {
  const f = fixture();
  await f.send("/start");
  await f.send("/help");
  for (const { text } of f.sent) {
    assert.ok(text.endsWith(`\nApp: ${APP_ONLY}`));
    for (const cmd of ["/app ", "/relay ", "/pair "]) assert.ok(text.includes(cmd), cmd);
  }
});

test("Telegram /relay shows the session and Mac status, or how to start one, and never a code", async () => {
  const f = fixture({ sessionId: "ABC123", connected: false });
  await f.send("/relay");
  assert.equal(f.sent[0].text, `Relay session ABC123\nMac: not connected\nApp: ${link("ABC123")}`);
  const none = fixture({ sessionId: null, connected: false });
  await none.send("/relay");
  assert.equal(none.sent[0].text,
    "No relay session. On the Mac run Cursor Remote: Start New Relay Session or Connect to Relay Session.");
  assert.equal(f.codes.length + none.codes.length, 0);
});

test("Telegram /pair is silent for unknown users, chats and groups", async () => {
  const f = fixture();
  for (const [user, chat, type] of [[9, 9, "private"], [1, 3, "private"], [1, -1, "group"]] as const) {
    await f.bridge.handleUpdate({ message: { from: { id: user }, chat: { id: chat, type }, text: "/pair" } });
  }
  assert.deepEqual([f.sent, f.api, f.codes, f.audit()], [[], [], [], []]);
});

test("Telegram /pair refuses when remote actions are off or the Mac is not on a relay session, and audits it", async () => {
  const off = fixture();
  off.flags.remoteActions = false;
  await off.send("/pair");
  assert.equal(off.sent[0].text, "❌ Remote actions are turned off on this Mac (cursorRemote.remoteActions)");
  assert.match(off.audit()[0], /channel=telegram action=telegram_pair chat=- result=refused disabled$/);

  const idle = fixture({ sessionId: "ABC123", connected: false });
  await idle.send("/pair");
  assert.match(idle.sent[0].text, /isn't connected to relay session ABC123/);
  assert.match(idle.audit()[0], /result=refused not-connected$/);

  const none = fixture({ sessionId: null, connected: false });
  await none.send("/pair");
  assert.match(none.sent[0].text, /^No relay session/);
  assert.deepEqual([off.codes, idle.codes, none.codes, off.api, idle.api, none.api], [[], [], [], [], [], []]);
});

test("Telegram /pair sends one single-use code message, tells the Mac, and deletes the message when the code expires", async () => {
  const f = fixture();
  await f.send("/pair");
  assert.equal(f.codes.length, 1);
  assert.deepEqual(f.sent, [], "the code goes out only in the tracked message");
  assert.equal(f.api.length, 1);
  const { method, body } = f.api[0];
  assert.equal(method, "sendMessage");
  assert.equal(body.parse_mode, "HTML");
  assert.equal(body.disable_web_page_preview, true);
  assert.equal(body.text, [
    "Relay session ABC123",
    `👉 <a href="${link("ABC123").replace(/&/g, "&amp;")}#code=${f.codes[0]}">Tap to open the app and connect</a>`,
    "Works once, expires in 5 minutes. Don't forward this message.",
    `Or enter it by hand: <code>${f.codes[0]}</code>`,
  ].join("\n"));
  assert.ok(!/\?[^#\n]*PAIRCODE/.test(body.text), "the code is never in a query string, only the fragment");
  assert.deepEqual(f.notified, ["ABC123"]);
  assert.deepEqual(f.scheduled.map((s) => s.ms), [300_000]);

  f.scheduled[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.api[1], { method: "deleteMessage", body: { chat_id: 1, message_id: 41 } });
  assert.equal(f.bridge.pairingDeletes.size, 0);
  assert.match(f.audit()[0], /action=telegram_pair chat=- result=ok$/);
  assert.ok(f.out.every((l) => !l.includes("PAIRCODE")), "the code is never logged");
});

test("Telegram /pair allows three codes per user per 15 minutes", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) { await f.send("/pair"); f.advance(60_000); }
  await f.send("/pair");
  assert.equal(f.codes.length, 3);
  assert.equal(f.sent.at(-1)!.text, "Too many pairing codes; try again in 12 minutes.");
  assert.match(f.audit().at(-1)!, /result=refused rate-limited$/);
  f.advance(12 * 60_000);
  await f.send("/pair");
  assert.equal(f.codes.length, 4);
  assert.equal(f.audit().length, 5);
  assert.ok(f.out.every((l) => !l.includes("PAIRCODE")));
});

test("stopping the bot deletes pairing messages at once; a failed delete is logged without the code", async () => {
  const f = fixture();
  await f.send("/pair");
  f.flags.failDelete = true;
  await f.bridge.stop();
  assert.deepEqual(f.api.map((a) => a.method), ["sendMessage", "deleteMessage"]);
  assert.equal(f.bridge.pairingDeletes.size, 0);
  assert.ok(f.out.some((l) => l.includes("pairing message delete failed")));
  assert.ok(f.out.every((l) => !l.includes("PAIRCODE")));
});

test("over MTProto, /pair waits for the bridge's sent reply and deletes through the bridge", async () => {
  const f = fixture();
  const lines: any[] = [];
  f.bridge.mode = "mtproto";
  f.bridge.mtprotoChild = { stdin: { writable: true, write: (l: string) => { lines.push(JSON.parse(l)); return true; } } };
  const pairing = f.send("/pair");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "send");
  assert.equal(lines[0].html, true);
  assert.equal(lines[0].no_preview, true);
  assert.ok(lines[0].text.includes(`#code=${f.codes[0]}"`));
  f.bridge.mtprotoSends.handle({ type: "sent", ref: lines[0].ref, message_id: 77 });
  await pairing;
  f.scheduled[0].fn();
  assert.deepEqual(lines[1], { type: "delete", chat_id: 1, message_id: 77 });
  assert.equal(f.api.length, 0);
});

test("a new relay device is announced to authorized chats with sync on, without codes or tokens", async () => {
  const f = fixture();
  f.bridge.allowed = new Set([1, 2, 3]);
  f.bridge.allowedChats = new Set([1, 2]);
  f.bridge.getState(2, 2).sync = false;
  f.bridge.notifyDevicePaired("ABC123");
  assert.deepEqual(f.sent, [], "nothing while the bot is stopped");
  f.bridge.running = true;
  f.bridge.notifyDevicePaired("ABC123");
  assert.deepEqual(f.sent, [{ chat: 1, text: "📱 A new device joined relay session ABC123." }]);
});

test("the MTProto send tracker resolves on the sent reply, times out cleanly, and clears on exit", async () => {
  assert.deepEqual(JSON.parse(mtprotoSendLine(5, "hi")), { type: "send", chat_id: 5, text: "hi" });
  assert.deepEqual(JSON.parse(mtprotoSendLine(5, "<b>x</b>", { ref: "r1", html: true })),
    { type: "send", chat_id: 5, text: "<b>x</b>", ref: "r1", html: true });
  assert.deepEqual(JSON.parse(mtprotoDeleteLine(5, 9)), { type: "delete", chat_id: 5, message_id: 9 });

  const tracker = new MtprotoSendTracker(30);
  const ok = tracker.track("a");
  assert.equal(tracker.handle({ type: "log", message: "x" }), false);
  assert.equal(tracker.handle({ type: "sent", ref: "a", message_id: 12 }), true);
  assert.equal(await ok, 12);
  const failed = tracker.track("b");
  tracker.handle({ type: "sent", ref: "b", message_id: null });
  assert.equal(await failed, null);
  const started = Date.now();
  assert.equal(await tracker.track("c"), null);
  assert.ok(Date.now() - started < 1000);
  const gone = tracker.track("d");
  tracker.clear();
  assert.equal(await gone, null);
});

test("the Pair Relay Client box keeps the code, and its Copy button copies again and says so briefly", async () => {
  const handlers: Record<string, () => any> = {};
  const box: any = {
    shown: false, disposed: false,
    onDidTriggerButton: (h: () => any) => { handlers.button = h; },
    onDidAccept: (h: () => any) => { handlers.accept = h; },
    onDidHide: (h: () => any) => { handlers.hide = h; },
    show() { this.shown = true; },
    hide() { handlers.hide(); },
    dispose() { this.disposed = true; },
  };
  const copies: string[] = [];
  const closed = showPairingCodeBox(() => box, async (t: string) => { copies.push(t); },
    { title: "Relay session ABC123 — pairing code copied", code: "CODE", prompt: "Keep the code private." }, 20);
  assert.equal(box.shown, true);
  assert.deepEqual([box.title, box.value, box.prompt, box.ignoreFocusOut], ["Relay session ABC123 — pairing code copied", "CODE", "Keep the code private.", true]);
  assert.equal(box.buttons[0].iconPath.id, "copy");
  assert.equal(box.buttons[0].tooltip, "Copy pairing code");
  box.value = "edited";
  await handlers.button();
  assert.deepEqual(copies, ["CODE"]);
  assert.equal(box.prompt, "Copied");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(box.prompt, "Keep the code private.");
  handlers.accept();
  await closed;
  assert.equal(box.disposed, true);
});

test("the MTProto bridge's send-with-ref and delete commands (Python, fake client)", (t) => {
  const python = spawnSync("python3", ["--version"]);
  if (python.status !== 0) return t.skip("python3 not available");
  const result = spawnSync("python3", ["-B", "-m", "unittest", "-q", "test_telegram_mtproto_bridge"], {
    cwd: resolve(__dirname, "../../python"),
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
});

function startFixture(relayState = { sessionId: "ABC123" as string | null, connected: true }) {
  const f = fixture(relayState);
  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "cr-start-"));
  f.bridge.secretsPath = require("node:path").join(dir, "telegram.json");
  f.bridge.running = true;
  const waits: number[] = [];
  f.bridge.wait = async (ms: number) => { waits.push(ms); f.advance(ms); };
  const messages = () => f.api.filter((a) => a.method === "sendMessage").map((a) => a.body);
  return { ...f, relayState, waits, messages };
}

test("on start the bot announces itself with a tap-to-open session link and no pairing code", async () => {
  const f = startFixture();
  await f.bridge.announceStarted();
  const [msg, ...rest] = f.messages();
  assert.equal(rest.length, 0);
  assert.equal(msg.chat_id, 1);
  assert.equal(msg.parse_mode, "HTML");
  assert.equal(msg.disable_web_page_preview, true);
  assert.match(msg.text, /^🟢 Cursor Remote started on .+\nRelay session ABC123, Mac connected\.\n/);
  assert.ok(msg.text.includes(`<a href="${link("ABC123").replace(/&/g, "&amp;")}">Tap to open the session</a>`));
  assert.ok(msg.text.endsWith("Not signed in on this phone? Send /pair."));
  assert.ok(!msg.text.includes("#code="));
  assert.equal(f.codes.length, 0, "no pairing code is minted at start");
  assert.deepEqual(f.waits, []);
});

test("the start notice waits for the relay to connect, and says so when there is no session", async () => {
  const late = startFixture({ sessionId: null, connected: false });
  late.bridge.wait = async (ms: number) => {
    late.waits.push(ms);
    late.advance(ms);
    if (late.waits.length === 3) Object.assign(late.relayState, { sessionId: "XYZ789", connected: true });
  };
  await late.bridge.announceStarted();
  assert.equal(late.waits.length, 3);
  assert.ok(late.messages()[0].text.includes(link("XYZ789").replace(/&/g, "&amp;")));

  const none = startFixture({ sessionId: null, connected: false });
  await none.bridge.announceStarted();
  assert.equal(none.waits.length, 30, "gives up after a minute");
  assert.match(none.messages()[0].text, /No relay session yet\. On the Mac run Cursor Remote: Start New Relay Session, then send \/relay\.\nApp: https:\/\/cursor-remote-app\.vercel\.app\/\?relay=https%3A%2F%2Frelay\.test$/);
});

test("the start notice is sent at most once per 2 minutes, and not after the bot stops", async () => {
  const f = startFixture();
  await f.bridge.announceStarted();
  f.advance(60_000);
  await f.bridge.announceStarted();
  assert.equal(f.messages().length, 1, "a quick window reload stays quiet");
  f.advance(61_000);
  await f.bridge.announceStarted();
  assert.equal(f.messages().length, 2);

  const stopped = startFixture({ sessionId: null, connected: false });
  stopped.bridge.wait = async () => { stopped.bridge.stopCount++; };
  await stopped.bridge.announceStarted();
  assert.equal(stopped.messages().length, 0);
});

test("a window that quits while waiting for the relay doesn't silence the next window's notice", async () => {
  const quitting = startFixture({ sessionId: null, connected: false });
  quitting.bridge.wait = async () => { quitting.bridge.stopCount++; };
  await quitting.bridge.announceStarted();
  assert.equal(quitting.messages().length, 0);

  const next = startFixture();
  next.bridge.secretsPath = quitting.bridge.secretsPath;
  await next.bridge.announceStarted();
  assert.equal(next.messages().length, 1, "the restarted window still announces itself");
});
