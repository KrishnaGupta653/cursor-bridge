import * as fs from "fs";
import * as path from "path";

export const BOT_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;
export const API_HASH = /^[0-9a-f]{32}$/i;

export type TelegramApi = (method: string, body?: Record<string, unknown>) => Promise<{
  ok: boolean;
  result?: any;
  description?: string;
  error_code?: number;
  /** True when Telegram could not be reached at all (blocked network, proxy page, timeout). */
  unreachable?: boolean;
}>;

/** A Bot API caller for one token. Errors never contain the token. */
export function botApi(token: string, fetchImpl: typeof fetch = fetch, timeoutMs = 35_000): TelegramApi {
  const scrub = (s: string) => s.split(token).join("<token>");
  return async (method, body) => {
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = (await res.text()).trim();
      try {
        return JSON.parse(raw);
      } catch {
        return { ok: false, unreachable: true, description: `HTTP ${res.status} from a network proxy, not Telegram` };
      }
    } catch (e) {
      return { ok: false, unreachable: true, description: scrub(e instanceof Error ? e.message : String(e)) };
    }
  };
}

export interface BotIdentity {
  ok: boolean;
  username?: string;
  /** Telegram is blocked on this network: fall back to MTProto. */
  unreachable?: boolean;
  message: string;
}

export async function checkBotToken(token: string, api: TelegramApi): Promise<BotIdentity> {
  if (!BOT_TOKEN.test(token)) {
    return { ok: false, message: "That isn't a bot token. BotFather sends one like 123456789:AAH…" };
  }
  const me = await api("getMe");
  if (me.ok && me.result?.is_bot) return { ok: true, username: me.result.username, message: `Bot @${me.result.username} found.` };
  if (me.unreachable) {
    return { ok: false, unreachable: true, message: "Telegram's Bot API can't be reached from this network." };
  }
  return { ok: false, message: me.error_code === 401 ? "Telegram rejected this token. Copy it again from BotFather." : `Telegram said: ${me.description ?? "unknown error"}` };
}

export interface TelegramOwner {
  userId: number;
  chatId: number;
  name: string;
}

/**
 * The first private message sent to the bot after this call starts. Older updates are skipped, so a
 * stranger who messaged the bot earlier is never picked; the caller still asks the user to confirm.
 */
export async function waitForFirstMessage(
  api: TelegramApi,
  opts: { deadline: number; cancelled: () => boolean; now?: () => number; pollSeconds?: number }
): Promise<TelegramOwner | { error: string } | null> {
  const now = opts.now ?? Date.now;
  const latest = await api("getUpdates", { offset: -1, timeout: 0, allowed_updates: ["message"] });
  if (!latest.ok) return { error: conflictHint(latest) };
  let offset = latest.result?.length ? latest.result[latest.result.length - 1].update_id + 1 : 0;
  while (!opts.cancelled() && now() < opts.deadline) {
    const res = await api("getUpdates", { offset, timeout: opts.pollSeconds ?? 20, allowed_updates: ["message"] });
    if (!res.ok) return { error: conflictHint(res) };
    for (const update of res.result ?? []) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (msg?.chat?.type !== "private" || !Number.isSafeInteger(msg.from?.id) || msg.from.is_bot) continue;
      await api("getUpdates", { offset, timeout: 0 });
      const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || "Telegram user";
      return {
        userId: msg.from.id,
        chatId: msg.chat.id,
        name: msg.from.username ? `${name} (@${msg.from.username})` : name,
      };
    }
  }
  return null;
}

function conflictHint(res: { error_code?: number; description?: string }): string {
  if (res.error_code === 409) {
    return "Another program is reading this bot's messages (another Cursor window, or a webhook). Stop it, then try again.";
  }
  return `Telegram said: ${res.description ?? "unknown error"}`;
}

export interface TelegramFile {
  botToken: string;
  allowedUserIds: number[];
  allowedChatIds: number[];
  apiId?: number;
  apiHash?: string;
}

/** apiId/apiHash already saved in the file, so a re-run doesn't ask for them again. */
export function savedMtprotoCredentials(filePath: string): { apiId?: number; apiHash?: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const apiId = Number(parsed.apiId);
    const apiHash = typeof parsed.apiHash === "string" && API_HASH.test(parsed.apiHash) ? parsed.apiHash : undefined;
    return { apiId: Number.isSafeInteger(apiId) && apiId > 0 ? apiId : undefined, apiHash };
  } catch {
    return {};
  }
}

/** Write telegram.json readable only by this user (directory 0700, file 0600), atomically. */
export function writeTelegramFile(filePath: string, file: TelegramFile): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = {
    enabled: true,
    botToken: file.botToken,
    allowedUserIds: file.allowedUserIds,
    allowedChatIds: file.allowedChatIds,
    ...(file.apiId && file.apiHash ? { apiId: file.apiId, apiHash: file.apiHash } : {}),
    transport: "auto",
  };
  const tmp = path.join(dir, `.telegram.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600, encoding: "utf8" });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}
