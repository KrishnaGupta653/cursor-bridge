import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/** Messages older than this (e.g. queued while Cursor was closed) are dropped instead of run. */
export const TELEGRAM_MAX_MESSAGE_AGE_S = 120;

/** Owner-only atomic write; best effort, never throws. */
export function writePrivateFile(file: string, data: string): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return false;
  }
}

/** CLI chat history lives in extension storage, keyed by workspace, never inside the repo. */
export function cliHistoryFile(storageDir: string, workspaceRoot: string): string {
  const key = crypto.createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
  return path.join(storageDir, "cli-history", `${key}.json`);
}

export function readTelegramOffset(file: string): number {
  try {
    const n = parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeTelegramOffset(file: string, offset: number): void {
  writePrivateFile(file, String(offset));
}

/** Telegram `message.date` is Unix seconds; a missing date (MTProto relay) is treated as fresh. */
export function isStaleTelegramMessage(date: unknown, nowMs: number = Date.now()): boolean {
  return typeof date === "number" && nowMs / 1000 - date > TELEGRAM_MAX_MESSAGE_AGE_S;
}
