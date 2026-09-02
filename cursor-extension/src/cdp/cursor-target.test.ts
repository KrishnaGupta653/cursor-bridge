import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankTargets, scoreCursorTarget } from "./cursor-target";
import { CdpTargetInfo } from "./cdp-types";

function target(partial: Partial<CdpTargetInfo>): CdpTargetInfo {
  return {
    id: partial.id || "t1",
    title: partial.title || "",
    url: partial.url || "",
    type: partial.type || "page",
    webSocketDebuggerUrl: partial.webSocketDebuggerUrl,
    attached: partial.attached ?? false,
  };
}

describe("scoreCursorTarget", () => {
  it("scores Cursor workbench pages highly", () => {
    const score = scoreCursorTarget(
      target({
        title: "Cursor — my-project",
        url: "vscode-file://vscode-app/out/vs/code/electron-sandbox/workbench/workbench.html",
        type: "page",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1",
      })
    );
    assert.ok(score > 40);
  });

  it("penalizes workers and missing debugger URL", () => {
    const worker = scoreCursorTarget(
      target({
        type: "service_worker",
        title: "sw",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/2",
      })
    );
    const noWs = scoreCursorTarget(
      target({
        type: "page",
        title: "Cursor",
        url: "vscode-file://workbench",
      })
    );
    assert.ok(worker < 0);
    assert.ok(noWs < 0);
  });

  it("penalizes blank and devtools pages", () => {
    const blank = scoreCursorTarget(
      target({
        title: "about:blank",
        url: "about:blank",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/3",
      })
    );
    const devtools = scoreCursorTarget(
      target({
        title: "DevTools",
        url: "devtools://devtools/bundled/inspector.html",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/4",
      })
    );
    assert.ok(blank < 20);
    assert.ok(devtools < 0);
  });
});

describe("rankTargets", () => {
  it("orders candidates and drops invalid ones", () => {
    const ranked = rankTargets([
      target({
        id: "blank",
        title: "about:blank",
        url: "about:blank",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/a",
      }),
      target({
        id: "cursor",
        title: "Cursor Agent chat",
        url: "vscode-file://vscode-app/workbench.html",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/b",
      }),
      target({
        id: "no-ws",
        title: "Cursor",
        url: "vscode-file://workbench",
      }),
    ]);
    assert.equal(ranked[0]?.id, "cursor");
    assert.ok(!ranked.some((t) => t.id === "no-ws"));
  });

  it("handles empty / invalid target lists", () => {
    assert.deepEqual(rankTargets([]), []);
  });
});
