import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CdpManager } from "./cdp-manager";
import { CdpTargetInfo } from "./cdp-types";
import { CursorSession } from "./cursor-session";
import { CdpHttpClient, isAllowedDebuggerUrl } from "./cdp-client";
import { rankTargets } from "./cursor-target";

/**
 * Unit tests with mocked HTTP layer via subclass / dependency injection isn't
 * built into CdpHttpClient — we test manager status + reconnect caps through
 * public API with enabled=false and by inspecting getStatus defaults.
 */

describe("CdpManager status & lifecycle", () => {
  it("reports disabled when ENABLE_CDP is false", async () => {
    const broadcasts: Record<string, unknown>[] = [];
    const manager = new CdpManager({
      host: "127.0.0.1",
      port: 9222,
      enabled: false,
      log: () => undefined,
      logError: () => undefined,
      broadcast: (p) => broadcasts.push(p),
    });
    await manager.start();
    const status = manager.getStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.connected, false);
    assert.equal(status.host, "127.0.0.1");
    assert.equal(status.port, 9222);
    assert.deepEqual(status.targets, []);
    await manager.stop();
  });

  it("rejects non-attached session selection", () => {
    const manager = new CdpManager({
      host: "127.0.0.1",
      port: 9222,
      enabled: true,
      log: () => undefined,
      logError: () => undefined,
      broadcast: () => undefined,
    });
    assert.equal(manager.selectSession("missing"), false);
    assert.equal(manager.listSessions().length, 0);
  });

  it("returns error when sending prompt with no session", async () => {
    const manager = new CdpManager({
      host: "127.0.0.1",
      port: 9222,
      enabled: true,
      log: () => undefined,
      logError: () => undefined,
      broadcast: () => undefined,
    });
    const result = await manager.sendAgentPrompt("hello");
    assert.equal(result.ok, false);
    assert.match(result.error || "", /No active Cursor session/i);
  });

  it("returns null agent state when no sessions", async () => {
    const manager = new CdpManager({
      host: "127.0.0.1",
      port: 9222,
      enabled: true,
      log: () => undefined,
      logError: () => undefined,
      broadcast: () => undefined,
    });
    assert.equal(await manager.getAgentState(), null);
  });

  it("approve/reject fail gracefully without session", async () => {
    const manager = new CdpManager({
      host: "127.0.0.1",
      port: 9222,
      enabled: true,
      log: () => undefined,
      logError: () => undefined,
      broadcast: () => undefined,
    });
    const a = await manager.approveAction("x");
    const r = await manager.rejectAction("x");
    assert.equal(a.ok, false);
    assert.equal(r.ok, false);
  });

  it("schedules limited reconnect when CDP unavailable", async () => {
    const logs: string[] = [];
    const manager = new CdpManager({
      host: "127.0.0.1",
      port: 1, // nothing listening
      enabled: true,
      pollIntervalMs: 50,
      log: (m) => logs.push(m),
      logError: (m) => logs.push(m),
      broadcast: () => undefined,
    });
    await manager.start();
    // Give reconnect scheduler a tick
    await new Promise((r) => setTimeout(r, 50));
    const status = manager.getStatus();
    assert.equal(status.connected, false);
    assert.ok(status.error);
    assert.ok(logs.some((l) => /Connecting|Connection failed|Reconnecting/i.test(l)));
    await manager.stop();
  });
});

describe("CdpManager reply delivery", () => {
  type Msg = { id: string; role: string; text: string };
  function setup(initial: Msg[]) {
    const broadcasts: Record<string, unknown>[] = [];
    const view = { messages: initial, state: "IDLE" };
    const fakeSession = {
      id: "s1",
      connected: true,
      getSnapshot: () => ({ messages: view.messages, state: view.state }),
      refresh: async () => ({ snapshot: { messages: view.messages, state: view.state } }),
      sendPrompt: async () => ({ ok: true }),
      detach: async () => undefined,
    };
    const manager = new CdpManager({
      host: "127.0.0.1",
      port: 9222,
      enabled: true,
      pollIntervalMs: 60_000,
      log: () => undefined,
      logError: () => undefined,
      broadcast: (p) => broadcasts.push(p),
    });
    const internals = manager as unknown as {
      sessions: Map<string, unknown>;
      connected: boolean;
      pollOnce: () => Promise<void>;
    };
    internals.sessions.set("s1", fakeSession);
    internals.connected = true;
    const replies = () => broadcasts.filter((b) => b.type === "chat_response");
    return { manager, view, poll: () => internals.pollOnce(), replies };
  }

  it("delivers only the new assistant reply to the sender once it settles", async () => {
    const { manager, view, poll, replies } = setup([{ id: "old", role: "assistant", text: "earlier answer" }]);
    const sent = await manager.sendAgentPrompt("hi", "s1", { clientId: "tg-1", targetDeviceId: "dev" });
    assert.equal(sent.ok, true);

    view.state = "RUNNING";
    view.messages = [...view.messages, { id: "new", role: "assistant", text: "Hello" }];
    for (let i = 0; i < 4; i++) await poll();
    assert.equal(replies().length, 0, "must not deliver while the agent is still running");

    view.state = "IDLE";
    view.messages = [view.messages[0], { id: "new", role: "assistant", text: "Hello there" }];
    await poll();
    await poll();
    await poll();
    assert.equal(replies().length, 1);
    const reply = replies()[0];
    assert.equal(reply.clientId, "tg-1");
    assert.equal(reply.targetDeviceId, "dev");
    assert.equal(reply.text, "Hello there");

    await poll();
    assert.equal(replies().length, 1, "a reply is delivered exactly once");
    await manager.stop();
  });

  it("tells the previous sender when a newer prompt takes over the session", async () => {
    const { manager, replies } = setup([]);
    await manager.sendAgentPrompt("one", "s1", { clientId: "a" });
    await manager.sendAgentPrompt("two", "s1", { clientId: "b" });
    assert.equal(replies().length, 1);
    assert.equal(replies()[0].clientId, "a");
    assert.match(String(replies()[0].text), /newer sender/);
    await manager.stop();
  });

  it("reports a closed session instead of waiting forever", async () => {
    const { manager, poll, replies } = setup([]);
    await manager.sendAgentPrompt("hi", "s1", { clientId: "a" });
    const internals = manager as unknown as { sessions: Map<string, { connected: boolean }> };
    internals.sessions.get("s1")!.connected = false;
    await poll();
    assert.equal(replies().length, 1);
    assert.match(String(replies()[0].text), /closed/);
    await manager.stop();
  });
});

describe("CdpManager Agents-window lifetime", () => {
  function manager(logs: string[] = []) {
    return new CdpManager({
      host: "127.0.0.1",
      port: 1,
      enabled: true,
      log: (m) => logs.push(m),
      logError: (m) => logs.push(m),
      broadcast: () => undefined,
    });
  }

  it("rediscovers at most every 5 s while no Agents window is attached", async () => {
    const m = manager();
    const internals = m as unknown as { connected: boolean; lastRediscoverAt: number; rediscover: () => Promise<unknown> };
    internals.connected = true;
    let calls = 0;
    internals.rediscover = async () => { calls++; return []; };
    assert.equal(m.agents.attached, false);
    await new Promise((r) => setImmediate(r));
    assert.equal(m.agents.attached, false);
    assert.equal(calls, 1);
    internals.lastRediscoverAt -= 6000;
    assert.equal(m.agents.attached, false);
    assert.equal(calls, 2);
    await m.stop();
  });

  it("keeps reconnecting past 8 attempts, capped at 30 s", async () => {
    const logs: string[] = [];
    const m = manager(logs);
    const internals = m as unknown as { reconnectAttempts: number; reconnectTimer: NodeJS.Timeout | null; scheduleReconnect: () => void };
    internals.reconnectAttempts = 40;
    internals.scheduleReconnect();
    assert.ok(internals.reconnectTimer);
    assert.ok(logs.some((l) => /Reconnecting in 30000ms \(attempt 41\)/.test(l)));
    await m.stop();
  });

  it("a closed Agents-window socket marks the session disconnected and, with no windows left, reconnects", async () => {
    const { WebSocketServer } = await import("ws");
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => wss.once("listening", r));
    wss.on("connection", (ws) => ws.on("message", (raw) => ws.send(JSON.stringify({ id: JSON.parse(String(raw)).id, result: {} }))));
    const port = (wss.address() as { port: number }).port;
    const logs: string[] = [];
    const m = manager(logs);
    const internals = m as unknown as { sessions: Map<string, CursorSession>; connected: boolean; onSessionClosed: () => void };
    const session = new CursorSession(
      { id: "t1", title: "Cursor Agents", url: "", type: "page", attached: false },
      () => undefined, () => undefined, () => internals.onSessionClosed()
    );
    internals.sessions.set(session.id, session);
    internals.connected = true;
    try {
      await session.attach(`ws://127.0.0.1:${port}/devtools/page/t1`);
      assert.equal(m.agents.attached, true);
      for (const c of wss.clients) c.terminate();
      for (let i = 0; i < 50 && session.connected; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(session.connected, false);
      assert.equal(m.getStatus().connected, false);
      assert.ok(logs.some((l) => /Reconnecting in/.test(l)));
    } finally {
      await m.stop();
      wss.close();
    }
  });
});

describe("CDP endpoint validation", () => {
  it("accepts only page sockets on 127.0.0.1 at the configured port", () => {
    assert.equal(isAllowedDebuggerUrl("ws://127.0.0.1:9222/devtools/page/ABC-123", 9222), true);
    for (const url of [
      "ws://127.0.0.1:9223/devtools/page/ABC", "ws://localhost:9222/devtools/page/ABC",
      "ws://192.168.1.5:9222/devtools/page/ABC", "wss://127.0.0.1:9222/devtools/page/ABC",
      "ws://127.0.0.1:9222/devtools/browser/ABC", "ws://127.0.0.1:9222/devtools/page/ABC?x=1",
      "ws://user@127.0.0.1:9222/devtools/page/ABC", "ws://evil.example/devtools/page/ABC", "not a url", undefined,
    ]) assert.equal(isAllowedDebuggerUrl(url, 9222), false, String(url));
  });

  it("refuses an endpoint that is not Cursor and drops foreign socket URLs from the target list", async () => {
    const { createServer } = await import("node:http");
    let ua = "Mozilla/5.0 Chrome/1 Safari/537.36";
    let port = 0;
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/json/version") return res.end(JSON.stringify({ Browser: "Chrome/1", "User-Agent": ua }));
      res.end(JSON.stringify([
        { id: "a", type: "page", title: "Cursor Agents", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/a` },
        { id: "b", type: "page", title: "Cursor", webSocketDebuggerUrl: "ws://203.0.113.9:9222/devtools/page/b" },
      ]));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    const client = new CdpHttpClient({ host: "127.0.0.1", port, log: () => undefined, logError: () => undefined });
    try {
      await assert.rejects(client.getVersion(), /not Cursor/);
      ua = "Mozilla/5.0 Cursor/1.7.0 Chrome/132.0 Electron/34.3.0 Safari/537.36";
      assert.equal((await client.getVersion())["User-Agent"], ua);
      const targets = await client.listTargets();
      assert.equal(targets.find((t) => t.id === "a")?.webSocketDebuggerUrl, `ws://127.0.0.1:${port}/devtools/page/a`);
      assert.equal(targets.find((t) => t.id === "b")?.webSocketDebuggerUrl, undefined);
      assert.deepEqual(rankTargets(targets).map((t) => t.id), ["a"]);
    } finally {
      server.close();
    }
  });
});

describe("CdpTargetInfo shape", () => {
  it("supports multiple window descriptors", () => {
    const windows: CdpTargetInfo[] = [
      {
        id: "1",
        title: "Cursor Project A",
        url: "vscode-file://workbench",
        type: "page",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1",
        attached: false,
      },
      {
        id: "2",
        title: "Cursor Project B",
        url: "vscode-file://workbench",
        type: "page",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/2",
        attached: false,
      },
    ];
    assert.equal(windows.length, 2);
    assert.notEqual(windows[0].id, windows[1].id);
  });
});
