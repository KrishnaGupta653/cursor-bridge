import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkRelay } from "../setup/relay-check";
import { botApi, checkBotToken, savedMtprotoCredentials, waitForFirstMessage, writeTelegramFile } from "../setup/telegram-setup";
import { LOGIN_ITEM_LABEL, cursorAppPath, findLoginItem, installLoginItem, loginItemPlist } from "../setup/login-item";
import { qrSvg } from "../setup/qr";

const Module = require("node:module");
const originalLoad = Module._load;
let wizard: any;
try {
  Module._load = function(name: string, ...args: any[]) {
    if (name === "vscode") return { workspace: { getConfiguration: () => ({ get: (_: string, d: any) => d }) } };
    return originalLoad.call(this, name, ...args);
  };
  wizard = require("../setup/wizard");
} finally { Module._load = originalLoad; }

const TOKEN = "123456789:AAH" + "x".repeat(32);

function healthFetch(status: number, body: unknown) {
  const urls: string[] = [];
  const impl = async (url: string) => {
    urls.push(url);
    return { status, json: async () => { if (body === undefined) throw new Error("not json"); return body; } };
  };
  return { urls, impl };
}

test("the relay check names the exact problem and what to do", async () => {
  const ok = healthFetch(200, { success: true, data: { status: "healthy", redis: "ok", protocolVersion: 2 } });
  const good = await checkRelay(" https://Mine.vercel.app/ ", ok.impl);
  assert.deepEqual([good.ok, good.url, ok.urls], [true, "https://mine.vercel.app", ["https://mine.vercel.app/api/health"]]);

  const cases: Array<[number, unknown, RegExp]> = [
    [503, { data: { redis: "not_configured", protocolVersion: 2 } }, /connect Upstash Redis/],
    [503, { data: { redis: "unreachable", protocolVersion: 2 } }, /can't reach Redis/],
    [404, undefined, /doesn't look like a Cursor Remote relay/],
    [401, undefined, /Deployment Protection/],
    [200, { data: { redis: "ok", protocolVersion: 1 } }, /older version/],
  ];
  for (const [status, body, message] of cases) {
    const r = await checkRelay("https://mine.vercel.app", healthFetch(status, body).impl);
    assert.equal(r.ok, false);
    assert.match(r.message, message);
  }
  const down = await checkRelay("https://mine.vercel.app", async () => { throw new Error("ENOTFOUND"); });
  assert.match(down.message, /Couldn't reach/);
  const bad = await checkRelay("http://mine.vercel.app", ok.impl);
  assert.deepEqual([bad.ok, bad.url], [false, null]);
});

function fakeTelegram(script: Array<{ ok: boolean; result?: any; error_code?: number; description?: string }>) {
  const calls: Array<{ method: string; body: any }> = [];
  const api = async (method: string, body?: any) => {
    calls.push({ method, body });
    return script.shift() ?? { ok: true, result: [] };
  };
  return { api, calls };
}

test("a bot token is checked with getMe, and a blocked network is told apart from a bad token", async () => {
  assert.match((await checkBotToken("nope", fakeTelegram([]).api)).message, /isn't a bot token/);
  assert.deepEqual(await checkBotToken(TOKEN, fakeTelegram([{ ok: true, result: { is_bot: true, username: "my_bot" } }]).api),
    { ok: true, username: "my_bot", message: "Bot @my_bot found." });
  assert.match((await checkBotToken(TOKEN, fakeTelegram([{ ok: false, error_code: 401 }]).api)).message, /rejected this token/);
  const blocked = await checkBotToken(TOKEN, async () => ({ ok: false, unreachable: true }));
  assert.equal(blocked.unreachable, true);
});

test("the Bot API caller never puts the token in an error", async () => {
  const api = botApi(TOKEN, (async (url: string) => { throw new Error(`connect failed for ${url}`); }) as any);
  const res = await api("getMe");
  assert.equal(res.unreachable, true);
  assert.ok(!res.description!.includes(TOKEN));
  const proxy = botApi(TOKEN, (async () => ({ status: 403, text: async () => "<html>blocked</html>" })) as any);
  assert.equal((await proxy("getMe")).unreachable, true);
});

test("the owner is the first private, human message sent after setup starts", async () => {
  const msg = (id: number, from: any, chat: any) => ({ update_id: id, message: { from, chat, text: "/start" } });
  const t = fakeTelegram([
    { ok: true, result: [msg(10, { id: 666, first_name: "Earlier" }, { id: 666, type: "private" })] },
    { ok: true, result: [
      msg(11, { id: 7, first_name: "Group" }, { id: -5, type: "group" }),
      msg(12, { id: 8, first_name: "Bot", is_bot: true }, { id: 8, type: "private" }),
      msg(13, { id: 42, first_name: "Krishna", username: "kg" }, { id: 42, type: "private" }),
    ] },
  ]);
  const owner = await waitForFirstMessage(t.api, { deadline: Date.now() + 60_000, cancelled: () => false });
  assert.deepEqual(owner, { userId: 42, chatId: 42, name: "Krishna (@kg)" });
  assert.deepEqual(t.calls.map((c) => c.body.offset), [-1, 11, 14], "the earlier stranger is skipped and the owner's update acknowledged");

  const busy = fakeTelegram([{ ok: false, error_code: 409, description: "Conflict" }]);
  assert.match((await waitForFirstMessage(busy.api, { deadline: Date.now() + 1000, cancelled: () => false }) as any).error, /Another program/);

  let now = 0;
  const idle = fakeTelegram([]);
  const none = await waitForFirstMessage(async (m, b) => { now += 30_000; return idle.api(m, b); },
    { deadline: 60_000, cancelled: () => false, now: () => now });
  assert.equal(none, null);
});

test("telegram.json is written atomically and readable only by the user, keeping saved MTProto keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-setup-"));
  const file = path.join(dir, "nested", "telegram.json");
  writeTelegramFile(file, { botToken: TOKEN, allowedUserIds: [42], allowedChatIds: [42], apiId: 1234, apiHash: "a".repeat(32) });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    enabled: true, botToken: TOKEN, allowedUserIds: [42], allowedChatIds: [42], apiId: 1234, apiHash: "a".repeat(32), transport: "auto",
  });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["telegram.json"], "no temp file left behind");
  assert.deepEqual(savedMtprotoCredentials(file), { apiId: 1234, apiHash: "a".repeat(32) });
  assert.deepEqual(savedMtprotoCredentials(path.join(dir, "missing.json")), {});
});

test("the login item opens this Cursor with session control on localhost only, at the next login", () => {
  assert.equal(cursorAppPath("/Applications/Cursor.app/Contents/Resources/app"), "/Applications/Cursor.app");
  assert.equal(cursorAppPath("/usr/share/cursor"), null);
  const plist = loginItemPlist("/Applications/Cursor & Co.app", 9222);
  assert.ok(plist.includes(`<string>${LOGIN_ITEM_LABEL}</string>`));
  assert.ok(plist.includes("<string>/Applications/Cursor &amp; Co.app</string>"));
  assert.ok(plist.includes("<string>--remote-debugging-address=127.0.0.1</string>"));
  assert.ok(plist.includes("<string>--remote-debugging-port=9222</string>"));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-agents-"));
  assert.equal(findLoginItem(dir), null);
  fs.writeFileSync(path.join(dir, "other.plist"), "<plist>Spotify</plist>");
  assert.equal(findLoginItem(dir), null);
  const file = installLoginItem("/Applications/Cursor.app", 9222, dir);
  assert.equal(findLoginItem(dir), file);
  assert.equal(findLoginItem(path.join(dir, "missing")), null);
});

test("the phone QR is a script-free SVG and its page escapes what it shows", () => {
  const svg = qrSvg("https://cursor-remote-app.vercel.app/?relay=https%3A%2F%2Fmine.vercel.app&session=ABC123#code=" + "c".repeat(43));
  assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
  assert.ok(!/<script/i.test(svg));
  const html = wizard.phoneLinkHtml(svg, "ABC<1", 5, "https://app/?a=1&b=<2>");
  assert.ok(html.includes("ABC&lt;1"));
  assert.ok(html.includes("https://app/?a=1&amp;b=&lt;2&gt;"));
  assert.ok(html.includes("default-src 'none'"));
});

test("the Deploy button clones only the relay folder and asks for Upstash", () => {
  const url = new URL(wizard.RELAY_DEPLOY_URL);
  assert.equal(url.origin + url.pathname, "https://vercel.com/new/clone");
  assert.equal(url.searchParams.get("repository-url"), "https://github.com/KrishnaGupta653/cursor-bridge/tree/main/relay-server");
  assert.deepEqual(JSON.parse(url.searchParams.get("stores")!),
    [{ type: "integration", integrationSlug: "upstash", productSlug: "upstash-kv", protocol: "storage" }]);
});
