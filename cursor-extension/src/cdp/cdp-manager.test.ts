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
