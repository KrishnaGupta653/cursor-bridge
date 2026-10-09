/**
 * Ensure a local Telethon venv and locate the MTProto bridge script.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export function mtprotoVenvPython(): string {
  return path.join(
    os.homedir(),
    ".config",
    "cursor-remote",
    "venv",
    "bin",
    "python3"
  );
}

export function mtprotoVenvDir(): string {
  return path.join(os.homedir(), ".config", "cursor-remote", "venv");
}

export function resolveMtprotoScript(extensionPath: string): string | null {
  const candidates = [
    path.join(extensionPath, "python", "telegram-mtproto-bridge.py"),
    path.join(extensionPath, "..", "scripts", "telegram-mtproto-bridge.py"),
    path.join(__dirname, "..", "python", "telegram-mtproto-bridge.py"),
    path.join(__dirname, "..", "..", "scripts", "telegram-mtproto-bridge.py"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        return c;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function ensureTelethonVenv(
  log: (msg: string) => void
): Promise<{ ok: true; python: string } | { ok: false; error: string }> {
  const venv = mtprotoVenvDir();
  const python = mtprotoVenvPython();
  const marker = path.join(venv, ".telethon-ok");

  const systemPython = await findSystemPython();
  if (!systemPython) {
    return {
      ok: false,
      error: "Python 3 not found. Install Python 3 to use MTProto Telegram bridge.",
    };
  }

  try {
    if (!fs.existsSync(python)) {
      log(`Creating Telethon venv at ${venv}…`);
      fs.mkdirSync(path.dirname(venv), { recursive: true });
      await execFileAsync(systemPython, ["-m", "venv", venv], {
        timeout: 120000,
      });
    }

    if (!fs.existsSync(marker)) {
      log("Installing telethon into Cursor Remote venv (one-time)…");
      await execFileAsync(
        python,
        ["-m", "pip", "install", "--upgrade", "pip", "telethon"],
        { timeout: 300000 }
      );
      fs.writeFileSync(marker, new Date().toISOString() + "\n");
    }

    // sanity import
    await execFileAsync(python, ["-c", "import telethon"], { timeout: 30000 });
    return { ok: true, python };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function findSystemPython(): Promise<string | null> {
  for (const bin of ["python3", "python"]) {
    try {
      const { stdout } = await execFileAsync(bin, ["-c", "import sys; print(sys.executable)"], {
        timeout: 10000,
      });
      const p = stdout.trim();
      if (p) return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** A stdin line for the bridge. With a ref, the bridge answers {"type":"sent","ref","message_id"}. */
export function mtprotoSendLine(chatId: number, text: string, opts: { ref?: string; html?: boolean; noPreview?: boolean } = {}): string {
  return JSON.stringify({
    type: "send", chat_id: chatId, text,
    ...(opts.ref ? { ref: opts.ref } : {}),
    ...(opts.html ? { html: true } : {}),
    ...(opts.noPreview ? { no_preview: true } : {}),
  }) + "\n";
}

export function mtprotoDeleteLine(chatId: number, messageId: number): string {
  return JSON.stringify({ type: "delete", chat_id: chatId, message_id: messageId }) + "\n";
}

/** Matches "sent" replies to sends by ref; a reply that never comes resolves null after the timeout. */
export class MtprotoSendTracker {
  private pending = new Map<string, { resolve: (id: number | null) => void; timer: NodeJS.Timeout }>();

  constructor(private timeoutMs = 10_000) {}

  track(ref: string): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(ref, null), this.timeoutMs);
      timer.unref?.();
      this.pending.set(ref, { resolve, timer });
    });
  }

  /** True when `msg` was a "sent" reply (handled here). */
  handle(msg: any): boolean {
    if (msg?.type !== "sent") return false;
    if (typeof msg.ref === "string") {
      this.finish(msg.ref, Number.isSafeInteger(msg.message_id) && msg.message_id > 0 ? msg.message_id : null);
    }
    return true;
  }

  /** Bridge gone: nothing more will arrive. */
  clear(): void {
    for (const ref of [...this.pending.keys()]) this.finish(ref, null);
  }

  private finish(ref: string, id: number | null): void {
    const entry = this.pending.get(ref);
    if (!entry) return;
    this.pending.delete(ref);
    clearTimeout(entry.timer);
    entry.resolve(id);
  }
}

/** Merge apiId/apiHash from telegcli config if present and secrets lack them. */
export function loadTelegcliApiCredentials(): {
  apiId?: number;
  apiHash?: string;
} {
  const candidates = [
    path.join(os.homedir(), ".config", "telegcli", "config.json"),
    path.join(os.homedir(), ".telegcli", "config.json"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const apiId = raw.api_id ?? raw.apiId;
      const apiHash = raw.api_hash ?? raw.apiHash;
      if (apiId && apiHash) {
        return { apiId: Number(apiId), apiHash: String(apiHash) };
      }
    } catch {
      /* ignore */
    }
  }
  return {};
}
