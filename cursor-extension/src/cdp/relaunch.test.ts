import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { claimOnce, cursorBinary, relaunchEnv, scheduleRelaunchWithCdp } from "./relaunch";

test("the relaunched Cursor does not inherit the extension host's Node mode", () => {
  const env = relaunchEnv({
    HOME: "/Users/me",
    PATH: "/usr/bin",
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    VSCODE_IPC_HOOK: "/tmp/x.sock",
    VSCODE_PID: "123",
  });
  assert.deepEqual(env, { HOME: "/Users/me", PATH: "/usr/bin" });
});

test("cursorBinary resolves the bundle executable from appRoot on macOS only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relaunch-"));
  const appRoot = path.join(root, "Cursor.app", "Contents", "Resources", "app");
  const bin = path.join(root, "Cursor.app", "Contents", "MacOS", "Cursor");
  fs.mkdirSync(appRoot, { recursive: true });
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  try {
    assert.equal(cursorBinary(appRoot, "darwin"), null, "missing executable");
    fs.writeFileSync(bin, "");
    assert.equal(cursorBinary(appRoot, "darwin"), bin);
    assert.equal(cursorBinary(appRoot, "linux"), null);
    assert.equal(cursorBinary(path.join(root, "a", "b", "c"), "darwin"), null, "not inside an .app bundle");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("claimOnce lets only the first window prompt within the window", () => {
  const name = `test-${process.pid}-${Date.now()}`;
  const marker = path.join(os.tmpdir(), `cursor-remote-${name}`);
  try {
    const now = Date.now();
    assert.equal(claimOnce(name, 60_000, now), true);
    assert.equal(claimOnce(name, 60_000, now + 1_000), false);
    assert.equal(claimOnce(name, 60_000, now + 61_000), true);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test("scheduleRelaunchWithCdp rejects ports outside the unprivileged range", () => {
  assert.throws(() => scheduleRelaunchWithCdp("/nonexistent/Cursor", 80));
  assert.throws(() => scheduleRelaunchWithCdp("/nonexistent/Cursor", 9222.5));
});
