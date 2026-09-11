/**
 * Telegram Bot bridge — full Cursor Remote control from Telegram.
 *
 * Secrets: ~/.config/cursor-remote/telegram.json
 * {
 *   "enabled": true,
 *   "botToken": "...",
 *   "allowedUserIds": [123456789],
 *   "apiId": 12345678,
 *   "apiHash": "...",
 *   "transport": "auto"
 * }
 *
 * transport: auto (Bot API, then MTProto fallback) | botapi | mtproto
 * MTProto uses Telethon DCs (same path as telegcli) when api.telegram.org is blocked.
 */

import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CommandHandler } from "./command-handler";
import { CommandRouter } from "./command-router";
import {
  ensureTelethonVenv,
  loadTelegcliApiCredentials,
  resolveMtprotoScript,
} from "./telegram-mtproto";
import { AgentMode } from "./types";
import { WebSocketServer } from "./websocket-server";

export interface TelegramSecrets {
  enabled?: boolean;
  botToken: string;
  allowedUserIds: number[];
  apiId?: number;
  apiHash?: string;
  /** auto | botapi | mtproto */
  transport?: string;
}

interface TgUserState {
  chatId: number;
  agentMode: AgentMode;
  backend: "cli" | "cdp";
  /** Mirror agent replies + important events to this chat */
  sync: boolean;
  sessionId?: string;
  sessionsCache: Array<{ id: string; title: string; state?: string }>;
  historyCache: Array<{ id: string; title: string; group?: string }>;
}

const DEFAULT_SECRETS_PATH = path.join(
  os.homedir(),
  ".config",
  "cursor-remote",
  "telegram.json"
);

const TG_TEXT_LIMIT = 3900;
const HELP_TEXT = [
  "Cursor Remote — Telegram control",
  "",
  "Chat & prompts",
  "/ask <text>     Send prompt (or just type text)",
  "/new [text]     New CLI session (+ optional prompt)",
  "/stop           Stop current agent run",
  "/mode [m]       agent | ask | plan | debug | auto",
  "/backend [b]    cli | cdp",
  "",
  "Sessions & history",
  "/sessions       List IDE Agent sessions (CDP)",
  "/use <n|id>     Select session by number or id",
  "/history [n]    List agent history (default 20)",
  "/open <n|id>    Open a history chat",
  "/state          Current agent state / messages",
  "/plan           Current plan (if any)",
  "/messages [n]   Recent CLI chat messages",
  "/chats          Alias for /messages",
  "",
  "Approvals & files",
  "/approve        Approve pending CDP action",
  "/reject         Reject pending CDP action",
  "/file           Active editor path + preview",
  "/save           Save active file",
  "",
  "Sync & system",
  "/sync [on|off]  Live-mirror agent replies here (default on)",
  "/status         Server + Telegram + mode",
  "/whoami         Your Telegram user id",
  "/help           This list",
  "",
  "Tips: /sessions then /use 1 · /history then /open 2",
  "With /sync on, replies stream here automatically.",
  "If Bot API is blocked, MTProto (telegcli path) is used automatically.",
].join("\n");

const BOT_COMMANDS = [
  { command: "help", description: "All commands" },
  { command: "ask", description: "Send prompt to Cursor" },
  { command: "new", description: "New CLI session" },
  { command: "stop", description: "Stop current run" },
  { command: "sessions", description: "List agent sessions" },
  { command: "use", description: "Select session: /use 1" },
  { command: "history", description: "List agent history" },
  { command: "open", description: "Open history chat" },
  { command: "state", description: "Current agent state" },
  { command: "plan", description: "Show plan" },
  { command: "messages", description: "Recent chat messages" },
  { command: "mode", description: "Set mode: agent|ask|plan|…" },
  { command: "backend", description: "cli or cdp" },
  { command: "approve", description: "Approve pending action" },
  { command: "reject", description: "Reject pending action" },
  { command: "file", description: "Active file" },
  { command: "save", description: "Save active file" },
  { command: "sync", description: "Live sync on/off" },
  { command: "status", description: "Connection status" },
  { command: "whoami", description: "Your Telegram id" },
];

export function defaultTelegramSecretsPath(): string {
  return DEFAULT_SECRETS_PATH;
}

export function loadTelegramSecrets(
  secretsPath?: string
):
  | { ok: true; secrets: TelegramSecrets; path: string }
  | { ok: false; error: string; path: string } {
  const filePath =
    (secretsPath || DEFAULT_SECRETS_PATH).trim() || DEFAULT_SECRETS_PATH;
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      error: `Secrets file not found: ${filePath}`,
      path: filePath,
    };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as TelegramSecrets;
    if (!parsed.botToken || typeof parsed.botToken !== "string") {
      return { ok: false, error: "botToken missing or invalid", path: filePath };
    }
    if (parsed.botToken.includes("PASTE_BOT_TOKEN")) {
      return {
        ok: false,
        error: "Replace botToken with your real BotFather token",
        path: filePath,
      };
    }
    const ids = Array.isArray(parsed.allowedUserIds)
      ? parsed.allowedUserIds
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n))
      : [];
    const teleg = loadTelegcliApiCredentials();
    const apiIdRaw = parsed.apiId ?? (parsed as any).api_id ?? teleg.apiId;
    const apiHashRaw =
      parsed.apiHash ?? (parsed as any).api_hash ?? teleg.apiHash;
    const apiId =
      apiIdRaw != null && Number.isFinite(Number(apiIdRaw))
        ? Number(apiIdRaw)
        : undefined;
    const apiHash =
      typeof apiHashRaw === "string" && apiHashRaw.trim()
        ? apiHashRaw.trim()
        : undefined;
    return {
      ok: true,
      secrets: {
        enabled: parsed.enabled !== false,
        botToken: parsed.botToken.trim(),
        allowedUserIds: ids,
        apiId,
        apiHash,
        transport: String(parsed.transport || "auto").toLowerCase(),
      },
      path: filePath,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      path: filePath,
    };
  }
}

export function ensureTelegramSecretsTemplate(secretsPath?: string): string {
  const filePath =
    (secretsPath || DEFAULT_SECRETS_PATH).trim() || DEFAULT_SECRETS_PATH;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(filePath)) {
    const body = JSON.stringify(
      {
        enabled: true,
        botToken: "PASTE_BOT_TOKEN_FROM_BOTFATHER",
        allowedUserIds: [] as number[],
        apiId: 0,
        apiHash: "PASTE_API_HASH_FROM_my.telegram.org",
        transport: "auto",
      },
      null,
      2
    );
    fs.writeFileSync(filePath, body + "\n", { mode: 0o600, encoding: "utf8" });
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort */
  }
  return filePath;
}

function splitTelegramText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TG_TEXT_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TG_TEXT_LIMIT);
    if (cut < TG_TEXT_LIMIT / 2) {
      cut = TG_TEXT_LIMIT;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  if (remaining.length) {
    chunks.push(remaining);
  }
  return chunks.length ? chunks : [""];
}

function stripBotCommand(text: string): { cmd: string; args: string } {
  const m = text.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) {
    return { cmd: "", args: text };
  }
  return { cmd: m[1].toLowerCase(), args: (m[2] || "").trim() };
}

function truncate(s: string, max: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

export class TelegramBridge {
  private outputChannel: vscode.OutputChannel;
  private commandRouter: CommandRouter;
  private commandHandler: CommandHandler;
  private wsServer: WebSocketServer;
  private extensionPath: string;
  private running = false;
  private mode: "botapi" | "mtproto" | null = null;
  private abort: AbortController | null = null;
  private offset = 0;
  private secretsPath: string;
  private token = "";
  private allowed = new Set<number>();
  private userState = new Map<number, TgUserState>();
  /** Telegram chats waiting for an agent reply */
  private pendingByChat = new Map<number, { userId: number; startedAt: number }>();
  private chunkByChat = new Map<number, string>();
  private lastSyncChatId: number | null = null;
  private lastApprovalKey = "";
  private outboundDispose: (() => void) | null = null;
  private pollPromise: Promise<void> | null = null;
  private mtprotoChild: ChildProcessWithoutNullStreams | null = null;
  private mtprotoStdoutBuf = "";

  constructor(
    outputChannel: vscode.OutputChannel,
    commandRouter: CommandRouter,
    commandHandler: CommandHandler,
    wsServer: WebSocketServer,
    extensionPath: string
  ) {
    this.outputChannel = outputChannel;
    this.commandRouter = commandRouter;
    this.commandHandler = commandHandler;
    this.wsServer = wsServer;
    this.extensionPath = extensionPath;
    this.secretsPath = DEFAULT_SECRETS_PATH;
  }

  isRunning(): boolean {
    return this.running;
  }

  private log(msg: string) {
    this.outputChannel.appendLine(
      `[${new Date().toLocaleTimeString()}] [Telegram] ${msg}`
    );
  }

  private getState(userId: number, chatId: number): TgUserState {
    let s = this.userState.get(userId);
    if (!s) {
      const cfg = vscode.workspace.getConfiguration("cursorRemote");
      const backend =
        cfg.get<string>("agentBackend", "cli") === "cdp" ? "cdp" : "cli";
      s = {
        chatId,
        agentMode: "auto",
        backend,
        sync: true,
        sessionsCache: [],
        historyCache: [],
      };
      this.userState.set(userId, s);
    } else {
      s.chatId = chatId;
    }
    return s;
  }

  async start(secretsPath?: string): Promise<{ ok: boolean; error?: string }> {
    if (this.running) {
      return { ok: true };
    }

    const cfg = vscode.workspace.getConfiguration("cursorRemote");
    this.secretsPath =
      (
        secretsPath ||
        cfg.get<string>("telegramSecretsPath", "") ||
        DEFAULT_SECRETS_PATH
      ).trim() || DEFAULT_SECRETS_PATH;

    const loaded = loadTelegramSecrets(this.secretsPath);
    if (!loaded.ok) {
      this.log(loaded.error);
      return { ok: false, error: loaded.error };
    }
    if (!loaded.secrets.enabled) {
      return {
        ok: false,
        error: "Telegram disabled in secrets file (enabled: false)",
      };
    }
    if (loaded.secrets.allowedUserIds.length === 0) {
      this.log(
        "allowedUserIds empty — send any message to learn your id, then add it"
      );
    }

    this.token = loaded.secrets.botToken;
    this.allowed = new Set(loaded.secrets.allowedUserIds);
    const transport = (loaded.secrets.transport || "auto").toLowerCase();

    // Prefer Bot HTTP API unless blocked / forced to mtproto
    if (transport !== "mtproto") {
      const me = await this.api("getMe");
      if (me.ok) {
        this.running = true;
        this.mode = "botapi";
        this.abort = new AbortController();
        this.outboundDispose = this.wsServer.onOutbound((message) => {
          this.handleOutbound(message);
        });
        void this.api("setMyCommands", { commands: BOT_COMMANDS });
        this.log(
          `Started (Bot API) as @${me.result?.username || "bot"} — ${this.secretsPath}`
        );
        this.pollPromise = this.pollLoop();
        return { ok: true };
      }

      const detail = me.description || "unknown";
      const blocked =
        /unexpected token\s*['"]?</i.test(detail) ||
        /HTML block|<!DOCTYPE|<!--#|zscaler|forbidden|403|Non-JSON/i.test(
          detail
        );

      if (transport === "botapi") {
        return {
          ok: false,
          error: blocked
            ? `Bot API blocked on this network. Set "transport": "mtproto" and add apiId/apiHash (my.telegram.org). Detail: ${detail.slice(0, 100)}`
            : `Telegram API unreachable or bad token: ${detail}`,
        };
      }

      this.log(
        `Bot API unavailable (${detail.slice(0, 80)}) — falling back to MTProto…`
      );
    }

    return this.startMtproto(loaded.secrets);
  }

  private async startMtproto(
    secrets: TelegramSecrets
  ): Promise<{ ok: boolean; error?: string }> {
    if (!secrets.apiId || !secrets.apiHash || secrets.apiHash.includes("PASTE")) {
      return {
        ok: false,
        error:
          'MTProto needs apiId + apiHash in ~/.config/cursor-remote/telegram.json (from https://my.telegram.org — same as telegcli). Example: "apiId": 12345, "apiHash": "abc…", "transport": "auto"',
      };
    }

    // Persist merged credentials into a temp secrets view for the Python process
    // (Python reads the same file — ensure api fields exist on disk if only from telegcli)
    try {
      const raw = JSON.parse(fs.readFileSync(this.secretsPath, "utf8"));
      let changed = false;
      if (!raw.apiId && !raw.api_id) {
        raw.apiId = secrets.apiId;
        changed = true;
      }
      if (!raw.apiHash && !raw.api_hash) {
        raw.apiHash = secrets.apiHash;
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(
          this.secretsPath,
          JSON.stringify(raw, null, 2) + "\n",
          { encoding: "utf8", mode: 0o600 }
        );
        this.log("Wrote apiId/apiHash into telegram.json from telegcli config");
      }
    } catch {
      /* ignore */
    }

    const script = resolveMtprotoScript(this.extensionPath);
    if (!script) {
      return {
        ok: false,
        error: "MTProto script not found (python/telegram-mtproto-bridge.py)",
      };
    }

    const venv = await ensureTelethonVenv((m) => this.log(m));
    if (!venv.ok) {
      return { ok: false, error: `Telethon venv failed: ${venv.error}` };
    }

    this.running = true;
    this.mode = "mtproto";
    this.abort = new AbortController();
    this.outboundDispose = this.wsServer.onOutbound((message) => {
      this.handleOutbound(message);
    });

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result: { ok: boolean; error?: string }) => {
        if (settled) return;
        settled = true;
        if (!result.ok) {
          this.running = false;
          this.mode = null;
          this.outboundDispose?.();
          this.outboundDispose = null;
        }
        resolve(result);
      };

      this.log(`Spawning MTProto bridge: ${script}`);
      const child = spawn(venv.python, [script, this.secretsPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });
      this.mtprotoChild = child;
      this.mtprotoStdoutBuf = "";

      const readyTimer = setTimeout(() => {
        finish({
          ok: false,
          error:
            "MTProto bridge timed out waiting for ready (check apiId/apiHash/botToken)",
        });
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, 60000);

      child.stdout.on("data", (buf: Buffer) => {
        this.mtprotoStdoutBuf += buf.toString("utf8");
        let idx: number;
        while ((idx = this.mtprotoStdoutBuf.indexOf("\n")) >= 0) {
          const line = this.mtprotoStdoutBuf.slice(0, idx).trim();
          this.mtprotoStdoutBuf = this.mtprotoStdoutBuf.slice(idx + 1);
          if (!line) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            this.log(`MTProto non-json: ${line.slice(0, 120)}`);
            continue;
          }
          if (msg.type === "log") {
            this.log(String(msg.message || ""));
          } else if (msg.type === "error") {
            this.log(`MTProto error: ${msg.error}`);
            if (!settled) {
              clearTimeout(readyTimer);
              finish({ ok: false, error: String(msg.error || "MTProto error") });
            }
          } else if (msg.type === "ready") {
            clearTimeout(readyTimer);
            this.log(
              `Started (MTProto) as @${msg.username || "bot"} id=${msg.id} — bypasses api.telegram.org`
            );
            finish({ ok: true });
          } else if (msg.type === "message") {
            void this.handleMtprotoMessage(msg);
          }
        }
      });

      child.stderr.on("data", (buf: Buffer) => {
        const t = buf.toString("utf8").trim();
        if (t) this.log(`MTProto stderr: ${t.slice(0, 300)}`);
      });

      child.on("exit", (code) => {
        this.log(`MTProto bridge exited code=${code}`);
        this.mtprotoChild = null;
        if (this.running && this.mode === "mtproto") {
          this.running = false;
          this.mode = null;
        }
        if (!settled) {
          clearTimeout(readyTimer);
          finish({
            ok: false,
            error: `MTProto bridge exited before ready (code ${code})`,
          });
        }
      });
    });
  }

  private async handleMtprotoMessage(msg: {
    chat_id: number;
    user_id: number;
    text: string;
  }): Promise<void> {
    // Reuse the same auth + dispatch path as Bot API updates
    await this.handleUpdate({
      message: {
        chat: { id: msg.chat_id },
        from: { id: msg.user_id },
        text: msg.text,
      },
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    this.outboundDispose?.();
    this.outboundDispose = null;
    this.pendingByChat.clear();
    this.chunkByChat.clear();

    if (this.mtprotoChild) {
      try {
        this.mtprotoChild.stdin.write(
          JSON.stringify({ type: "stop" }) + "\n"
        );
      } catch {
        /* ignore */
      }
      try {
        this.mtprotoChild.kill();
      } catch {
        /* ignore */
      }
      this.mtprotoChild = null;
    }

    if (this.pollPromise) {
      try {
        await this.pollPromise;
      } catch {
        /* ignore */
      }
      this.pollPromise = null;
    }
    this.mode = null;
    this.log("Stopped");
  }

  private async api(
    method: string,
    body?: Record<string, unknown>
  ): Promise<{ ok: boolean; result?: any; description?: string }> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    try {
      const res = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: this.abort?.signal,
      });
      const raw = await res.text();
      const trimmed = raw.trim();
      if (trimmed.startsWith("<") || trimmed.startsWith("<!--")) {
        return {
          ok: false,
          description: `HTTP ${res.status} HTML block page from network proxy (not Telegram). First bytes: ${trimmed.slice(0, 40)}`,
        };
      }
      try {
        return JSON.parse(raw) as {
          ok: boolean;
          result?: any;
          description?: string;
        };
      } catch {
        return {
          ok: false,
          description: `Non-JSON from Telegram API (HTTP ${res.status}): ${trimmed.slice(0, 80)}`,
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if ((e as any)?.name === "AbortError") {
        return { ok: false, description: "aborted" };
      }
      return { ok: false, description: msg };
    }
  }

  private async sendText(chatId: number, text: string): Promise<void> {
    for (const part of splitTelegramText(text)) {
      if (this.mode === "mtproto") {
        const child = this.mtprotoChild;
        if (!child?.stdin.writable) {
          this.log("MTProto child not writable for send");
          return;
        }
        try {
          child.stdin.write(
            JSON.stringify({ type: "send", chat_id: chatId, text: part }) + "\n"
          );
        } catch (e) {
          this.log(
            `MTProto send failed: ${e instanceof Error ? e.message : String(e)}`
          );
        }
        continue;
      }

      const res = await this.api("sendMessage", {
        chat_id: chatId,
        text: part,
        disable_web_page_preview: true,
      });
      if (!res.ok) {
        this.log(`sendMessage failed: ${res.description || "unknown"}`);
      }
    }
  }

  private resolveSyncTargets(): number[] {
    const ids = new Set<number>();
    if (this.lastSyncChatId != null) {
      ids.add(this.lastSyncChatId);
    }
    for (const [, s] of this.userState) {
      if (s.sync && s.chatId) {
        ids.add(s.chatId);
      }
    }
    for (const chatId of this.pendingByChat.keys()) {
      ids.add(chatId);
    }
    return [...ids];
  }

  private handleOutbound(raw: string) {
    try {
      const msg = JSON.parse(raw);
      const targets = this.resolveSyncTargets();
      if (!targets.length) {
        return;
      }

      if (msg.type === "chat_response_chunk" && typeof msg.text === "string") {
        for (const chatId of this.pendingByChat.keys()) {
          const prev = this.chunkByChat.get(chatId) || "";
          this.chunkByChat.set(chatId, prev + msg.text);
        }
        return;
      }

      if (msg.type === "chat_response" && typeof msg.text === "string") {
        const text = (msg.text as string).trim();
        for (const chatId of targets) {
          const buffered = (this.chunkByChat.get(chatId) || "").trim();
          this.chunkByChat.delete(chatId);
          this.pendingByChat.delete(chatId);
          const body = text || buffered;
          if (body) {
            void this.sendText(chatId, `🤖 ${body}`);
          }
        }
        return;
      }

      if (msg.type === "chat_response_complete") {
        for (const chatId of [...this.pendingByChat.keys()]) {
          const buffered = (this.chunkByChat.get(chatId) || "").trim();
          this.chunkByChat.delete(chatId);
          this.pendingByChat.delete(chatId);
          if (buffered) {
            void this.sendText(chatId, `🤖 ${buffered}`);
          }
        }
        return;
      }

      if (msg.type === "agent_state") {
        const pending = msg.pendingApproval;
        if (pending) {
          const key = `${msg.sessionId || ""}:${pending.id || pending.title || ""}`;
          if (key !== this.lastApprovalKey) {
            this.lastApprovalKey = key;
            const title =
              pending.title || pending.detail || pending.message || "Permission required";
            for (const chatId of targets) {
              void this.sendText(
                chatId,
                `⚠️ Approval needed\n${truncate(String(title), 500)}\n\n/approve  or  /reject`
              );
            }
          }
        }
        return;
      }

      if (msg.type === "command_result" && msg.success === false) {
        const err = msg.error_message || msg.error || "Command failed";
        for (const chatId of this.pendingByChat.keys()) {
          void this.sendText(chatId, `❌ ${err}`);
          this.pendingByChat.delete(chatId);
          this.chunkByChat.delete(chatId);
        }
      }
    } catch {
      /* ignore non-json */
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const data = await this.api("getUpdates", {
          timeout: 25,
          offset: this.offset,
          allowed_updates: ["message"],
        });
        if (!data.ok) {
          this.log(`getUpdates failed: ${data.description || "unknown"}`);
          await this.sleep(3000);
          continue;
        }
        for (const update of data.result || []) {
          this.offset = Math.max(this.offset, (update.update_id || 0) + 1);
          await this.handleUpdate(update);
        }
      } catch (e) {
        if (!this.running || (e as any)?.name === "AbortError") {
          break;
        }
        this.log(`poll error: ${e instanceof Error ? e.message : String(e)}`);
        await this.sleep(3000);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private resolveIndexOrId(
    arg: string,
    cache: Array<{ id: string; title: string }>
  ): string | null {
    const a = arg.trim();
    if (!a) return null;
    if (/^\d+$/.test(a)) {
      const n = Number(a);
      if (n >= 1 && n <= cache.length) {
        return cache[n - 1].id;
      }
      return null;
    }
    const byId = cache.find((x) => x.id === a || x.id.startsWith(a));
    if (byId) return byId.id;
    const byTitle = cache.find((x) =>
      x.title.toLowerCase().includes(a.toLowerCase())
    );
    return byTitle?.id || a;
  }

  private async handleUpdate(update: any): Promise<void> {
    const message = update.message;
    if (!message?.chat?.id || typeof message.text !== "string") {
      return;
    }
    const chatId = message.chat.id as number;
    const userId = message.from?.id as number | undefined;
    const text = (message.text as string).trim();
    if (!text || userId == null) {
      return;
    }

    const { cmd } = stripBotCommand(text);
    const isBootstrap =
      this.allowed.size === 0 &&
      (!cmd || cmd === "whoami" || cmd === "start" || cmd === "help");

    const allowed = this.allowed.size === 0 ? isBootstrap : this.allowed.has(userId);

    if (!allowed) {
      if (this.allowed.size === 0) {
        await this.sendText(
          chatId,
          `Your Telegram user id: ${userId}\n\nAdd it to allowedUserIds in:\n${this.secretsPath}\n\nThen: Cursor Remote → Restart Telegram Bot`
        );
      } else {
        this.log(`Ignored unauthorized user ${userId}`);
      }
      return;
    }

    if (this.allowed.size === 0) {
      await this.sendText(
        chatId,
        `Your Telegram user id: ${userId}\n\nAdd it to allowedUserIds in:\n${this.secretsPath}\n\nThen restart the Telegram bot.`
      );
      return;
    }

    const state = this.getState(userId, chatId);
    this.lastSyncChatId = chatId;

    try {
      await this.dispatch(userId, chatId, state, text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`command error: ${msg}`);
      await this.sendText(chatId, `❌ ${msg}`);
    }
  }

  private async dispatch(
    userId: number,
    chatId: number,
    state: TgUserState,
    text: string
  ): Promise<void> {
    const { cmd, args } = stripBotCommand(text);

    if (!cmd) {
      await this.sendPrompt(userId, chatId, state, text, false);
      return;
    }

    switch (cmd) {
      case "start":
      case "help":
        await this.sendText(chatId, HELP_TEXT);
        return;

      case "whoami":
        await this.sendText(
          chatId,
          `User id: ${userId}\nChat id: ${chatId}\nMode: ${state.agentMode}\nBackend: ${state.backend}\nSync: ${state.sync ? "on" : "off"}`
        );
        return;

      case "status": {
        const port = this.wsServer.getActualPort();
        const cdp = await this.commandHandler.getCdpStatus();
        const sessionInfo = await this.commandHandler.getSessionInfo("telegram");
        await this.sendText(
          chatId,
          [
            `WebSocket: ${this.wsServer.isRunning() ? "running" : "stopped"}`,
            port != null ? `Port: ${port}` : "",
            `Telegram: active (${this.mode || "?"})`,
            `Mode: ${state.agentMode}`,
            `Backend: ${state.backend}`,
            `Sync: ${state.sync ? "on" : "off"}`,
            state.sessionId ? `Selected session: ${state.sessionId}` : "",
            `CLI session: ${sessionInfo?.currentSessionId || "none"}`,
            `CDP: ${cdp?.connected ? "connected" : "off"} (${cdp?.activeSessionId || "no active"})`,
            `Secrets: ${this.secretsPath}`,
          ]
            .filter(Boolean)
            .join("\n")
        );
        return;
      }

      case "sync": {
        const v = args.toLowerCase();
        if (v === "on" || v === "1" || v === "true") state.sync = true;
        else if (v === "off" || v === "0" || v === "false") state.sync = false;
        else state.sync = !state.sync;
        await this.sendText(
          chatId,
          `Live sync ${state.sync ? "ON — agent replies come here" : "OFF"}`
        );
        return;
      }

      case "mode": {
        const m = args.toLowerCase();
        const allowedModes: AgentMode[] = [
          "agent",
          "ask",
          "plan",
          "debug",
          "auto",
        ];
        if (!m) {
          await this.sendText(
            chatId,
            `Current mode: ${state.agentMode}\nSet with /mode agent|ask|plan|debug|auto`
          );
          return;
        }
        if (!allowedModes.includes(m as AgentMode)) {
          await this.sendText(chatId, "Use: /mode agent|ask|plan|debug|auto");
          return;
        }
        state.agentMode = m as AgentMode;
        await this.sendText(chatId, `Mode set to ${state.agentMode}`);
        return;
      }

      case "backend": {
        const b = args.toLowerCase();
        if (!b) {
          await this.sendText(
            chatId,
            `Current backend: ${state.backend}\nSet with /backend cli|cdp`
          );
          return;
        }
        if (b !== "cli" && b !== "cdp") {
          await this.sendText(chatId, "Use: /backend cli|cdp");
          return;
        }
        state.backend = b;
        await this.sendText(chatId, `Backend set to ${state.backend}`);
        return;
      }

      case "stop":
        await this.commandRouter.handleCommand({
          type: "stop_prompt",
          clientId: "telegram",
        });
        this.pendingByChat.delete(chatId);
        this.chunkByChat.delete(chatId);
        await this.sendText(chatId, "⏹ Stop requested.");
        return;

      case "ask":
        if (!args) {
          await this.sendText(chatId, "Usage: /ask <prompt>");
          return;
        }
        await this.sendPrompt(userId, chatId, state, args, false);
        return;

      case "new":
        await this.sendPrompt(userId, chatId, state, args || "Hello", true);
        return;

      case "sessions": {
        await this.commandHandler.refreshCdpTargets();
        const sessions = await this.commandHandler.listCdpSessions();
        state.sessionsCache = sessions.map((s: any) => ({
          id: String(s.id),
          title: String(s.title || s.id),
          state: s.state ? String(s.state) : undefined,
        }));
        if (!state.sessionsCache.length) {
          await this.sendText(
            chatId,
            "No CDP sessions.\nEnable CDP (Cursor with --remote-debugging-port=9222) or use /backend cli + /ask"
          );
          return;
        }
        const lines = state.sessionsCache.map(
          (s, i) =>
            `${i + 1}. ${s.title}${s.state ? ` [${s.state}]` : ""}\n   id: ${s.id}`
        );
        await this.sendText(
          chatId,
          `Sessions (${state.sessionsCache.length}):\n\n${lines.join("\n\n")}\n\nSelect: /use 1`
        );
        return;
      }

      case "use": {
        if (!args) {
          await this.sendText(chatId, "Usage: /use <number|id>");
          return;
        }
        if (!state.sessionsCache.length) {
          await this.commandHandler.refreshCdpTargets();
          const sessions = await this.commandHandler.listCdpSessions();
          state.sessionsCache = sessions.map((s: any) => ({
            id: String(s.id),
            title: String(s.title || s.id),
            state: s.state ? String(s.state) : undefined,
          }));
        }
        const id = this.resolveIndexOrId(args, state.sessionsCache);
        if (!id) {
          await this.sendText(chatId, "Not found. Run /sessions first.");
          return;
        }
        const ok = this.commandHandler.selectCdpSession(id);
        if (!ok) {
          await this.sendText(chatId, `Could not select session ${id}`);
          return;
        }
        state.sessionId = id;
        state.backend = "cdp";
        const st = await this.commandHandler.getAgentState(id);
        await this.sendText(
          chatId,
          `Selected: ${st?.title || id}\nState: ${st?.state || "?"}\nBackend: cdp\n\nSend a prompt or /state`
        );
        return;
      }

      case "history": {
        const limit = Math.min(50, Math.max(1, Number(args) || 20));
        const hist = await this.commandHandler.getAgentHistory();
        const items = (hist.items || []).slice(0, limit);
        state.historyCache = items.map((it: any) => ({
          id: String(it.id),
          title: String(it.title || it.id),
          group: it.group ? String(it.group) : undefined,
        }));
        if (!state.historyCache.length) {
          await this.sendText(
            chatId,
            `No agent history (${hist.support || "unavailable"}).\n${hist.note || ""}`
          );
          return;
        }
        const lines = state.historyCache.map(
          (h, i) =>
            `${i + 1}. ${h.title}${h.group ? ` (${h.group})` : ""}\n   id: ${h.id}`
        );
        await this.sendText(
          chatId,
          `History (${state.historyCache.length}/${hist.count || state.historyCache.length}):\n\n${lines.join("\n\n")}\n\nOpen: /open 1`
        );
        return;
      }

      case "open": {
        if (!args) {
          await this.sendText(chatId, "Usage: /open <number|id>");
          return;
        }
        if (!state.historyCache.length) {
          const hist = await this.commandHandler.getAgentHistory();
          state.historyCache = (hist.items || []).map((it: any) => ({
            id: String(it.id),
            title: String(it.title || it.id),
            group: it.group ? String(it.group) : undefined,
          }));
        }
        const id = this.resolveIndexOrId(args, state.historyCache);
        if (!id) {
          await this.sendText(chatId, "Not found. Run /history first.");
          return;
        }
        const result = await this.commandHandler.openAgentHistory(id);
        if (!result.ok) {
          await this.sendText(
            chatId,
            `Open failed: ${result.error || "unknown"}`
          );
          return;
        }
        await this.sendText(
          chatId,
          `Opened history chat.\nRun /sessions then /use to attach, or /state`
        );
        return;
      }

      case "state": {
        const st = await this.commandHandler.getAgentState(state.sessionId);
        if (!st) {
          await this.sendText(
            chatId,
            "No agent state. Enable CDP + /sessions /use, or send /ask"
          );
          return;
        }
        const msgs = (st.messages || [])
          .slice(-8)
          .map(
            (m: any, i: number) =>
              `${i + 1}. [${m.role || "?"}] ${truncate(String(m.text || m.content || ""), 200)}`
          )
          .join("\n");
        await this.sendText(
          chatId,
          [
            `Title: ${st.title || "?"}`,
            `State: ${st.state || "?"}`,
            `Model: ${st.model || "?"}`,
            `Session: ${st.id || state.sessionId || "?"}`,
            st.pendingApproval
              ? `⚠️ Pending: ${truncate(String(st.pendingApproval.title || st.pendingApproval.detail || "yes"), 200)}`
              : "",
            "",
            "Recent messages:",
            msgs || "(none)",
          ]
            .filter((l) => l !== undefined)
            .join("\n")
        );
        return;
      }

      case "plan": {
        const st = await this.commandHandler.getAgentState(state.sessionId);
        const plan = st?.plan;
        if (!plan || !(plan as any).available) {
          await this.sendText(chatId, "No plan available on current session.");
          return;
        }
        const steps = ((plan as any).steps || [])
          .map(
            (s: any, i: number) =>
              `${i + 1}. [${s.status || "?"}] ${truncate(String(s.title || s.text || s), 180)}`
          )
          .join("\n");
        await this.sendText(
          chatId,
          `Plan: ${(plan as any).title || ""}\n\n${steps || "(empty)"}`
        );
        return;
      }

      case "messages":
      case "chats": {
        const limit = Math.min(40, Math.max(1, Number(args) || 15));
        const history = await this.commandHandler.getChatHistory(
          "telegram",
          undefined,
          undefined,
          limit
        );
        const entries = history.entries || [];
        if (!entries.length) {
          await this.sendText(
            chatId,
            "No CLI chat messages yet. Send /ask something first."
          );
          return;
        }
        const lines = entries.map((e: any, i: number) => {
          const role = e.role || e.type || "?";
          const body = truncate(String(e.text || e.content || e.message || ""), 220);
          return `${i + 1}. [${role}] ${body}`;
        });
        await this.sendText(
          chatId,
          `Messages (last ${lines.length}):\n\n${lines.join("\n")}`
        );
        return;
      }

      case "approve": {
        const result = await this.commandHandler.approveCdpAction(
          state.sessionId
        );
        await this.sendText(
          chatId,
          result.ok ? "✅ Approved" : `❌ ${result.error || "Approve failed"}`
        );
        return;
      }

      case "reject": {
        const result = await this.commandHandler.rejectCdpAction(
          state.sessionId
        );
        await this.sendText(
          chatId,
          result.ok ? "🚫 Rejected" : `❌ ${result.error || "Reject failed"}`
        );
        return;
      }

      case "file": {
        const file = await this.commandHandler.getActiveFile();
        if (!file) {
          await this.sendText(chatId, "No active file in Cursor.");
          return;
        }
        const preview = truncate(file.content || "", 1500);
        await this.sendText(
          chatId,
          `📄 ${file.path}\n\n${preview || "(empty)"}`
        );
        return;
      }

      case "save": {
        try {
          const result = await this.commandHandler.saveFile();
          await this.sendText(
            chatId,
            result.success
              ? `💾 Saved${result.path ? `: ${result.path}` : ""}`
              : `❌ Save failed`
          );
        } catch (e) {
          await this.sendText(
            chatId,
            `❌ ${e instanceof Error ? e.message : String(e)}`
          );
        }
        return;
      }

      default:
        await this.sendText(
          chatId,
          `Unknown /${cmd}\n\nSend /help for every command.`
        );
    }
  }

  private async sendPrompt(
    userId: number,
    chatId: number,
    state: TgUserState,
    prompt: string,
    newSession: boolean
  ): Promise<void> {
    const text = prompt.trim();
    if (!text) {
      await this.sendText(chatId, "Send a prompt, e.g. /ask fix the bug");
      return;
    }

    this.pendingByChat.set(chatId, { userId, startedAt: Date.now() });
    this.chunkByChat.set(chatId, "");
    this.lastSyncChatId = chatId;

    await this.sendText(
      chatId,
      newSession
        ? `🆕 New session · ${state.agentMode} · working…`
        : `⏳ ${state.backend}/${state.agentMode} · working…`
    );

    const type =
      state.backend === "cdp" && !newSession ? "agent_prompt" : "cli_prompt";

    await this.commandRouter.handleCommand({
      type,
      text,
      clientId: "telegram",
      newSession,
      agentMode: state.agentMode,
      sessionId: state.sessionId,
      agentBackend: state.backend,
    });
  }
}
