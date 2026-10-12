import { test } from "node:test";
import assert from "node:assert/strict";

const Module = require("node:module");
const originalLoad = Module._load;
let CommandRouter: any;
try {
  Module._load = function(name: string, ...args: any[]) {
    if (name === "vscode") return { workspace: { getConfiguration: () => ({ get: (_: string, fallback: any) => fallback }) } };
    return originalLoad.call(this, name, ...args);
  };
  CommandRouter = require("../command-router").CommandRouter;
} finally { Module._load = originalLoad; }

const row = (id: string, title: string, group: string, extra: Record<string, unknown> = {}) =>
  ({ id, title, time: "1m", group, pinned: false, status: "done", unread: false, active: false, ...extra });

function fixture() {
  const replies: any[] = [];
  const router = new CommandRouter({}, { send: (raw: string) => replies.push(JSON.parse(raw)) }, { appendLine() {} });
  router.log = () => {};
  let stored: any = null;
  const state = { attached: true, sessionControl: true };
  const sidebar = {
    ok: true,
    rows: [row("p1", "Pinned chat", "Pinned", { pinned: true, status: "running", unread: true }), row("r1", "Repo chat", "cursor-remote")],
    groups: [{ name: "Pinned", section: "pinned", expanded: true, hasMore: false }],
  };
  router.setChatServices({
    index: { list: () => ({ chats: [{ id: "t1", title: "Saved only", repoName: "cursor-remote", updatedAt: 1 }] }) },
    diff: {}, watcher: {},
    remoteActionsEnabled: () => true,
    sessionControl: () => state.sessionControl,
    agents: () => (state.attached ? { attached: true, sidebar: async () => sidebar } : null),
    sidebarCache: { load: () => stored, save: (s: any) => { stored = s; } },
  });
  const list = async () => {
    replies.length = 0;
    await router.handleCommand({ type: "list_chats", id: "l1", clientId: "relay:S1", senderDeviceId: "phone" });
    return replies.find((r) => r.type === "chats");
  };
  return { state, list, stored: () => stored };
}

test("pins and groups from the last live sidebar are kept while session control is off", async () => {
  const f = fixture();
  const live = await f.list();
  assert.equal(live.sidebar, true);
  assert.equal(live.liveOff, null);
  assert.deepEqual(f.stored().rows.map((r: any) => r.id), ["p1", "r1"]);

  f.state.attached = false;
  f.state.sessionControl = false;
  const off = await f.list();
  assert.equal(off.sidebar, false);
  assert.equal(off.liveOff, "session-control");
  assert.equal(off.sidebarSavedAt, f.stored().at);
  assert.deepEqual(off.chats.map((c: any) => [c.id, c.pinned, c.inSidebar]), [["p1", true, true], ["r1", false, true], ["t1", false, false]]);
  assert.deepEqual([off.chats[0].status, off.chats[0].unread], ["done", false], "a saved row is never shown as running");
  assert.equal(off.groups[0].name, "Pinned");
});

test("with no saved sidebar, the reason still says which part is off", async () => {
  const f = fixture();
  f.state.attached = false;
  const closed = await f.list();
  assert.deepEqual([closed.sidebar, closed.liveOff, closed.sidebarSavedAt], [false, "agents-window", null]);
  assert.deepEqual(closed.chats.map((c: any) => c.id), ["t1"]);
});
