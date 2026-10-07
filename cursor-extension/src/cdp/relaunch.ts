/**
 * Relaunch Cursor with session control (CDP) on.
 * Cursor's argv.json does not accept --remote-debugging-port, so a normal launch from the Dock
 * always starts without it. A detached helper waits for Cursor to quit, then starts it again
 * with the port bound to loopback only.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Quits are interactive (unsaved files), so the helper gives up after this long. */
const WAIT_FOR_QUIT_S = 90;

const RELAUNCH_SCRIPT = [
  'bin="$1"; port="$2"; log="$3"; name="$(basename "$bin")"; i=0',
  `while pgrep -x "$name" >/dev/null 2>&1; do i=$((i+1)); [ "$i" -gt ${WAIT_FOR_QUIT_S * 2} ] && exit 0; sleep 0.5; done`,
  "sleep 1",
  "unset ELECTRON_RUN_AS_NODE",
  'exec "$bin" --remote-debugging-address=127.0.0.1 --remote-debugging-port="$port" >"$log" 2>&1',
].join("\n");

/** The main executable of the app bundle hosting this extension, or null off macOS. */
export function cursorBinary(appRoot: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "darwin") return null;
  const bundle = path.resolve(appRoot, "..", "..", "..");
  if (!bundle.endsWith(".app")) return null;
  const bin = path.join(bundle, "Contents", "MacOS", path.basename(bundle, ".app"));
  return fs.existsSync(bin) ? bin : null;
}

/**
 * The extension host runs with ELECTRON_RUN_AS_NODE=1 and its own VSCODE_* wiring; a Cursor
 * started with those inherited runs as plain Node, rejects the flags and exits at once.
 */
export function relaunchEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k.startsWith("ELECTRON_") || k.startsWith("VSCODE_")) continue;
    clean[k] = v;
  }
  return clean;
}

export function scheduleRelaunchWithCdp(bin: string, port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid CDP port ${port}`);
  const log = path.join(os.tmpdir(), "cursor-remote-cursor.log");
  const child = spawn("/bin/sh", ["-c", RELAUNCH_SCRIPT, "cursor-remote-relaunch", bin, String(port), log], {
    detached: true,
    stdio: "ignore",
    env: relaunchEnv(),
  });
  child.unref();
}

/**
 * Every Cursor window runs this extension; only one should nag. Returns true for the first
 * caller within `windowMs`, using a marker file in the user's temp folder.
 */
export function claimOnce(name: string, windowMs: number, now: number = Date.now()): boolean {
  const marker = path.join(os.tmpdir(), `cursor-remote-${name}`);
  try {
    if (now - fs.statSync(marker).mtimeMs < windowMs) return false;
  } catch {
    // No marker yet.
  }
  try {
    fs.writeFileSync(marker, String(now), { mode: 0o600 });
  } catch {
    // Failing to write only means another window may also show the prompt.
  }
  return true;
}
