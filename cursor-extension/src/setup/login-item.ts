import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const LOGIN_ITEM_LABEL = "com.cursor-remote.session-control";

export function launchAgentsDir(home = os.homedir()): string {
  return path.join(home, "Library", "LaunchAgents");
}

/** /Applications/Cursor.app from the editor's appRoot (…/Cursor.app/Contents/Resources/app). */
export function cursorAppPath(appRoot: string): string | null {
  const match = /^(.*?\.app)(?:\/|$)/.exec(appRoot);
  return match ? match[1] : null;
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A LaunchAgent that opens Cursor at login with session control on, listening on localhost only. */
export function loginItemPlist(appPath: string, port: number): string {
  const args = ["/usr/bin/open", "-a", appPath, "--args", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${LOGIN_ITEM_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args.map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** A LaunchAgent (ours or hand-made) that already opens Cursor with a debugging port. */
export function findLoginItem(dir = launchAgentsDir()): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".plist"));
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const body = fs.readFileSync(path.join(dir, name), "utf8");
      if (/Cursor/.test(body) && body.includes("--remote-debugging-port")) return path.join(dir, name);
    } catch {
      // Unreadable plist: not ours.
    }
  }
  return null;
}

/** Takes effect at the next login; nothing is launched now. */
export function installLoginItem(appPath: string, port: number, dir = launchAgentsDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${LOGIN_ITEM_LABEL}.plist`);
  fs.writeFileSync(file, loginItemPlist(appPath, port), { mode: 0o644 });
  return file;
}
