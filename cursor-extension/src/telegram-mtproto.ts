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
