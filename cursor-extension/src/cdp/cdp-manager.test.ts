import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CdpManager } from "./cdp-manager";
import { CdpTargetInfo } from "./cdp-types";

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
