/**
 * Telegram Bot bridge — full Cursor Remote control from Telegram.
 *
 * Secrets: ~/.config/cursor-remote/telegram.json
 * {
 *   "enabled": true,
 *   "botToken": "...",
 *   "allowedUserIds": [123456789],
 *   "allowedChatIds": [123456789],
 *   "apiId": 12345678,
 *   "apiHash": "...",
 *   "transport": "auto"
 * }
 *
 * transport: auto (Bot API, then MTProto fallback) | botapi | mtproto
 * MTProto uses Telethon DCs (same path as telegcli) when api.telegram.org is blocked.
 */

import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CLI_NOT_INSTALLED } from "./cli-handler";
import { isStaleTelegramMessage, readTelegramOffset, writeTelegramOffset } from "./private-state";
import { CommandHandler } from "./command-handler";
import { CommandRouter } from "./command-router";
import {
  ensureTelethonVenv,
  loadTelegcliApiCredentials,
  resolveMtprotoScript,
} from "./telegram-mtproto";
import { AgentMode, CommandMessage } from "./types";
import { WebSocketServer } from "./websocket-server";
import { ChatWatcher } from "./chat-watcher";
import { ComposerState } from "./cdp/agents-window";

export interface TelegramSecrets {
  enabled?: boolean;
  botToken: string;
  allowedUserIds: number[];
  allowedChatIds: number[];
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
  /** Agents-window chat picked with /c_N or /newchat; plain text prompts it. */
  agentChatId?: string;
  chatsCache: Array<{ id: string; title: string; group: string }>;
}

/** A permission alert's short code, bound to one exact pending request. */
interface ApprovalCode {
  requestId: string;
  chatId: string;
  title: string;
  command: string;
  expiresAt: number;
  armed?: { action: "approve" | "reject"; userId: number };
}

const APPROVAL_CODE_TTL_MS = 2 * 60 * 1000;

const DEFAULT_SECRETS_PATH = path.join(
  os.homedir(),
  ".config",
  "cursor-remote",
  "telegram.json"
);

const TG_TEXT_LIMIT = 3900;
const HELP_TEXT = [
  "Cursor Remote",
  "",
  "Agents window",
  "/chats [search]  Chats grouped like Cursor's sidebar; tap /c_3, then just type",
  "/last            Full latest reply of the open chat",
  "/newchat [text]  Start a new chat (optionally with a first prompt)",
  "/model [name]    List models, or switch the open chat's model",
  "/stop            Stop the agent",
  "Approval alerts carry /approve_<code> and /reject_<code>. Each asks you to confirm, and the code expires after 2 minutes.",
  "",
  "More",
  "/new [text]      Fresh Cursor CLI chat",
  "/mode [m]        agent | ask | plan | debug | auto",
  "/backend [b]     cdp (Agents window chats) | cli (Cursor CLI)",
  "/file · /save",
  "/sync [on|off]   Send replies here automatically (default on)",
  "/status · /whoami",
  "",
  "Replies arrive when the agent pauses.",
].join("\n");

const BOT_COMMANDS = [
  { command: "chats", description: "Agents-window chats grouped like the sidebar" },
  { command: "newchat", description: "Start a new chat: /newchat text" },
  { command: "model", description: "List or switch models: /model name" },
  { command: "stop", description: "Stop the agent" },
  { command: "last", description: "Full latest reply of the open chat" },
  { command: "new", description: "New Cursor CLI chat" },
  { command: "ask", description: "Send a prompt" },
  { command: "mode", description: "agent | ask | plan | debug | auto" },
  { command: "backend", description: "cdp (Agents window chats) or cli" },
  { command: "file", description: "Active file in Cursor" },
  { command: "save", description: "Save the active file" },
  { command: "sync", description: "Auto-send replies on/off" },
  { command: "status", description: "Connection status" },
  { command: "help", description: "All commands" },
];

export function defaultTelegramSecretsPath(): string {
  return DEFAULT_SECRETS_PATH;
}

export const TELEGRAM_LOCKED_PREFIX = "Telegram bot already running in another Cursor window";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/**
 * One bot token must have exactly one poller, otherwise every Cursor window answers.
 * Returns the pid of the live owner when another process holds the lock.
 */
export function acquireTelegramLock(lockPath: string, pid: number = process.pid): { ok: true } | { ok: false; ownerPid: number } {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, String(pid));
      fs.closeSync(fd);
      return { ok: true };
    } catch (e: any) {
      if (e?.code !== "EEXIST") return { ok: false, ownerPid: -1 };
      const owner = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
      if (owner === pid) return { ok: true };
      if (Number.isFinite(owner) && owner > 0 && pidAlive(owner)) return { ok: false, ownerPid: owner };
      try { fs.unlinkSync(lockPath); } catch { /* raced with another window */ }
    }
  }
  return { ok: false, ownerPid: -1 };
}

export function releaseTelegramLock(lockPath: string, pid: number = process.pid): void {
  try {
    if (parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10) === pid) fs.unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
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
        allowedChatIds: Array.isArray(parsed.allowedChatIds) ? parsed.allowedChatIds.filter(Number.isSafeInteger) : [],
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
        allowedChatIds: [] as number[],
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
  const cmd = m[1].toLowerCase();
  const args = (m[2] || "").trim();
  // Telegram only makes space-free commands tappable, so lists offer /c_2 for "/c 2" (older messages: /use_2).
  const tap = cmd.match(/^(use|state|last|open|c)_(\d+)$/) || cmd.match(/^(approve|reject|confirm)_([a-f0-9]{6})$/);
  if (tap) return { cmd: tap[1], args: tap[2] };
  return { cmd, args };
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
  private offsetPath = "";
  private secretsPath: string;
  private lockPath = "";
  private token = "";
  private allowed = new Set<number>();
  private allowedChats = new Set<number>();
  private rateWindow = 0;
  private rateCount = 0;
  private userRates = new Map<number, number>();
  private userState = new Map<number, TgUserState>();
  /** Telegram chats waiting for an agent reply */
  private pendingByChat = new Map<number, { userId: number; startedAt: number }>();
  private chunkByChat = new Map<number, string>();
  private lastSyncChatId: number | null = null;
  private lastApprovalKey = "";
  private outboundDispose: (() => void) | null = null;
  private pollPromise: Promise<void> | null = null;
  private mtprotoChild: ChildProcessWithoutNullStreams | null = null;
  private mtprotoRestartTimer: NodeJS.Timeout | null = null;
  private mtprotoRestarts = 0;
  /** Bumped by stop() so an in-flight reconnect can tell it was cancelled. */
  private stopCount = 0;
  private mtprotoStdoutBuf = "";
  private chatWatcher: ChatWatcher | null;
  /** Replies to commands this bridge is running, keyed by correlation ID. */
  private captures = new Map<string, any[]>();
  private approvalCodes = new Map<string, ApprovalCode>();
  private lastAlertRequestId = "";

  constructor(
    outputChannel: vscode.OutputChannel,
    commandRouter: CommandRouter,
    commandHandler: CommandHandler,
    wsServer: WebSocketServer,
    extensionPath: string,
    chatWatcher: ChatWatcher | null = null
  ) {
    this.outputChannel = outputChannel;
    this.commandRouter = commandRouter;
    this.commandHandler = commandHandler;
    this.wsServer = wsServer;
    this.extensionPath = extensionPath;
    this.chatWatcher = chatWatcher;
    this.secretsPath = DEFAULT_SECRETS_PATH;
  }

  private subscribe(): () => void {
    const offOutbound = this.wsServer.onOutbound((message) => this.handleOutbound(message));
    const offObserve = this.chatWatcher?.observe((s) => this.onComposerState(s));
    return () => {
      offOutbound();
      offObserve?.();
      this.approvalCodes.clear();
      this.lastAlertRequestId = "";
    };
  }

  /** Run a command through the router (policy, remote-actions switch, audit) and collect its replies. */
  private async call(
    userId: number,
    chatId: number,
    command: Omit<CommandMessage, "id" | "clientId">
  ): Promise<{ ok: boolean; error?: string; data?: any; replies: any[] }> {
    const id = `tg-${crypto.randomBytes(8).toString("hex")}`;
    const replies: any[] = [];
    this.captures.set(id, replies);
    try {
      await this.commandRouter.handleCommand({ ...command, id, clientId: `telegram:${chatId}:${userId}` } as CommandMessage);
    } finally {
      this.captures.delete(id);
    }
    const result = replies.find((r) => r.type === "command_result");
    return {
      ok: result?.success === true,
      error: result?.error_message || result?.error || (result ? undefined : "No response"),
      data: result?.data,
      replies,
    };
  }

  /** Alert every allowed chat once per new pending request, with codes bound to that request. */
  private onComposerState(s: ComposerState): void {
    const now = Date.now();
    for (const [code, a] of this.approvalCodes) if (a.expiresAt <= now) this.approvalCodes.delete(code);
    const pending = s.pending;
    if (!pending || !s.chatId) {
      this.lastAlertRequestId = "";
      return;
    }
    if (pending.id === this.lastAlertRequestId) return;
    this.lastAlertRequestId = pending.id;
    const targets = [...this.allowed].filter((userId) =>
      this.allowedChats.has(userId) && this.userState.get(userId)?.sync !== false);
    if (!targets.length) return;
    let code = crypto.randomBytes(3).toString("hex");
    while (this.approvalCodes.has(code)) code = crypto.randomBytes(3).toString("hex");
    const request = pending.command || pending.detail || "Permission required";
    this.approvalCodes.set(code, {
      requestId: pending.id,
      chatId: s.chatId,
      title: s.title,
      command: request,
      expiresAt: now + APPROVAL_CODE_TTL_MS,
    });
    for (const chat of targets) {
      void this.sendText(
        chat,
        `⚠️ Approval needed${s.title ? ` — ${truncate(s.title, 60)}` : ""}\n${truncate(request, 600)}\n\n/approve_${code} · /reject_${code}\nThe code expires in 2 minutes.`
      );
    }
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
        chatsCache: [],
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
    const result = await this.startUnlocked(secretsPath);
    if (!result.ok && this.lockPath && !result.error?.startsWith(TELEGRAM_LOCKED_PREFIX)) {
      releaseTelegramLock(this.lockPath);
    }
    return result;
  }

  private async startUnlocked(secretsPath?: string): Promise<{ ok: boolean; error?: string }> {

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
    if (!loaded.secrets.allowedUserIds.length || !loaded.secrets.allowedChatIds.length) {
      return { ok: false, error: "Telegram requires allowedUserIds and allowedChatIds" };
    }

    this.lockPath = path.join(path.dirname(this.secretsPath), "telegram.lock");
    const lock = acquireTelegramLock(this.lockPath);
    if (!lock.ok) {
      return {
        ok: false,
        error: lock.ownerPid > 0
          ? `${TELEGRAM_LOCKED_PREFIX} (pid ${lock.ownerPid})`
          : `Could not create ${this.lockPath}; check that folder's permissions`,
      };
    }

    this.offsetPath = path.join(path.dirname(this.secretsPath), "telegram.offset");
    this.offset = readTelegramOffset(this.offsetPath);
    this.token = loaded.secrets.botToken;
    this.allowed = new Set(loaded.secrets.allowedUserIds);
    this.allowedChats = new Set(loaded.secrets.allowedChatIds);
    const transport = (loaded.secrets.transport || "auto").toLowerCase();

    // Prefer Bot HTTP API unless blocked / forced to mtproto
    if (transport !== "mtproto") {
      const me = await this.api("getMe");
      if (me.ok) {
        this.running = true;
        this.mode = "botapi";
        this.abort = new AbortController();
        this.outboundDispose = this.subscribe();
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
    this.outboundDispose = this.subscribe();

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
            this.mtprotoRestarts = 0;
            child.stdin.write(JSON.stringify({ type: "set_commands", commands: BOT_COMMANDS }) + "\n");
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
        if (this.mtprotoChild === child) this.mtprotoChild = null;
        // Exited after it was ready and nobody called stop(): reconnect instead of going silent.
        if (settled && this.running && this.mode === "mtproto") {
          this.running = false;
          this.mode = null;
          this.outboundDispose?.();
          this.outboundDispose = null;
          this.scheduleMtprotoRestart(secrets);
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

  private scheduleMtprotoRestart(secrets: TelegramSecrets) {
    const delay = Math.min(60_000, 5_000 * 2 ** this.mtprotoRestarts++);
    this.log(`MTProto bridge stopped unexpectedly — reconnecting in ${delay / 1000}s`);
    const stops = this.stopCount;
    this.mtprotoRestartTimer = setTimeout(async () => {
      this.mtprotoRestartTimer = null;
      const result = await this.startMtproto(secrets);
      if (stops !== this.stopCount) {
        if (result.ok) await this.stop();
        return;
      }
      // Keep the lock and keep trying: the usual cause is a temporary network drop.
      if (!result.ok) this.scheduleMtprotoRestart(secrets);
    }, delay);
  }

  private async handleMtprotoMessage(msg: {
    chat_id: number;
    user_id: number;
    text: string;
  }): Promise<void> {
    // Reuse the same auth + dispatch path as Bot API updates
    await this.handleUpdate({
      message: {
        chat: { id: msg.chat_id, type: msg.chat_id === msg.user_id && msg.chat_id > 0 ? "private" : "group" },
        from: { id: msg.user_id },
        text: msg.text,
      },
    });
  }

  async stop(): Promise<void> {
    this.stopCount++;
    this.running = false;
    if (this.mtprotoRestartTimer) clearTimeout(this.mtprotoRestartTimer);
    this.mtprotoRestartTimer = null;
    this.mtprotoRestarts = 0;
    if (this.lockPath) releaseTelegramLock(this.lockPath);
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

  private resolveSyncTargets(msg: any): number[] {
    // Unattributed/global events are never routed to Telegram.
    return [...this.userState.entries()]
      .filter(([userId, state]) => state.sync && this.allowed.has(userId) &&
        this.allowedChats.has(state.chatId) &&
        msg.clientId === `telegram:${state.chatId}:${userId}`)
      .map(([, state]) => state.chatId);
  }

  private handleOutbound(raw: string) {
    try {
      const msg = JSON.parse(raw);
      const capture = typeof msg.correlationId === "string" ? this.captures.get(msg.correlationId) : undefined;
      if (capture && msg.type !== "chat_response") {
        capture.push(msg);
        return;
      }
      const targets = this.resolveSyncTargets(msg);
      if (!targets.length) {
        return;
      }

      if (msg.type === "chat_response_chunk" && typeof msg.text === "string") {
        for (const chatId of targets) {
          const prev = this.chunkByChat.get(chatId) || "";
          this.chunkByChat.set(chatId, prev + msg.text);
        }
        return;
      }

      if (msg.type === "chat_response" && typeof msg.text === "string") {
        const text = (msg.text as string).trim();
        if (typeof msg.chatId === "string" && msg.chatId) {
          const [, chat, user] = String(msg.clientId).split(":");
          const state = this.userState.get(Number(user));
          if (state && state.chatId === Number(chat) && !state.agentChatId) state.agentChatId = msg.chatId;
        }
        for (const chatId of targets) {
          const buffered = (this.chunkByChat.get(chatId) || "").trim();
          this.chunkByChat.delete(chatId);
          this.pendingByChat.delete(chatId);
          const body = text || buffered;
          void this.sendText(
            chatId,
            body
              ? `🤖 ${body}`
              : "The agent finished without a reply I could read. Try /last or check Cursor."
          );
        }
        return;
      }

      if (msg.type === "error" && typeof msg.message === "string") {
        for (const chatId of targets) {
          this.pendingByChat.delete(chatId);
          this.chunkByChat.delete(chatId);
          void this.sendText(chatId, `❌ ${msg.message} Check the Cursor Remote log in Cursor for details.`);
        }
        return;
      }

      if (msg.type === "chat_response_complete") {
        for (const chatId of targets) {
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
                `⚠️ Approval needed\n${truncate(String(title), 500)}\n\nReview this request in Cursor locally.`
              );
            }
          }
        }
        return;
      }

      if (msg.type === "command_result" && msg.success === false) {
        const err =
          msg.command_type === "agent_prompt"
            ? "Couldn't send to that chat. Run /chats and pick it again."
            : msg.command_type === "cli_prompt"
              ? msg.error_message === CLI_NOT_INSTALLED
                ? `${CLI_NOT_INSTALLED}, or open an Agents-window chat with /chats.`
                : "The Cursor CLI prompt failed. Check the Cursor Remote log in Cursor."
              : "Command failed. Check the Cursor Remote log in Cursor.";
        for (const chatId of targets) {
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
          writeTelegramOffset(this.offsetPath, this.offset);
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

    // Authorization precedes parsing, session lookup, and any response.
    if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(chatId) ||
        message.chat.type !== "private" || chatId !== userId ||
        !this.allowed.has(userId) || !this.allowedChats.has(chatId)) return;
    if (isStaleTelegramMessage(message.date)) {
      this.log(`Ignored a Telegram message sent ${Math.round(Date.now() / 1000 - message.date)}s ago`);
      return;
    }

    if (Date.now() - this.rateWindow >= 60_000) {
      this.rateWindow = Date.now();
      this.rateCount = 0;
      this.userRates.clear();
    }
    const count = (this.userRates.get(userId) || 0) + 1;
    this.userRates.set(userId, count);
    if (++this.rateCount > 180 || count > 30) {
      if (count === 31) await this.sendText(chatId, "Too many messages — wait a minute, then try again.");
      return;
    }

    const state = this.getState(userId, chatId);
    this.lastSyncChatId = chatId;

    try {
      await this.dispatch(userId, chatId, state, text);
    } catch (e) {
      this.log("Telegram command failed");
      await this.sendText(chatId, "Command failed. Check local diagnostics.");
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
        const cdp = (await this.call(userId, chatId, { type: "get_cdp_status" })).data;
        const sessionInfo = (await this.call(userId, chatId, { type: "get_session_info" })).data;
        await this.sendText(
          chatId,
          [
            `WebSocket: ${this.wsServer.isRunning() ? "running" : "stopped"}`,
            port != null ? `Port: ${port}` : "",
            `Telegram: active (${this.mode || "?"})`,
            `Mode: ${state.agentMode}`,
            `Backend: ${state.backend}`,
            `Sync: ${state.sync ? "on" : "off"}`,
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
        if (!state.sync) {
          this.pendingByChat.delete(chatId);
          this.chunkByChat.delete(chatId);
          if (this.lastSyncChatId === chatId) this.lastSyncChatId = null;
        }
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

      case "stop": {
        this.pendingByChat.delete(chatId);
        this.chunkByChat.delete(chatId);
        if (state.backend === "cli" && !state.agentChatId) {
          const r = await this.call(userId, chatId, { type: "stop_prompt" });
          await this.sendText(chatId, r.ok ? "⏹ Stopped the CLI run." : `❌ ${r.error}`);
          return;
        }
        const r = await this.call(userId, chatId, { type: "agent_stop", chatId: state.agentChatId });
        await this.sendText(chatId, r.ok ? "⏹ Stopped the agent." : `❌ ${r.error}`);
        return;
      }

      case "chats": {
        const r = await this.call(userId, chatId, { type: "list_chats", query: args || undefined, limit: 15 });
        const list = r.replies.find((x) => x.type === "chats");
        if (!r.ok || !list) {
          await this.sendText(chatId, `❌ ${r.error || "Couldn't list chats"}`);
          return;
        }
        const chats = (list.chats || []).slice(0, 60) as Array<{ id: string; title: string; group: string; pinned?: boolean; status?: string; unread?: boolean; active?: boolean }>;
        state.chatsCache = chats.map((c) => ({ id: String(c.id), title: String(c.title || c.id), group: c.pinned ? "Pinned" : String(c.group || "Other") }));
        if (!chats.length) {
          await this.sendText(chatId, args ? `No chats match “${truncate(args, 40)}”.` : "No chats found on this Mac.");
          return;
        }
        const order: string[] = [];
        for (const c of state.chatsCache) if (!order.includes(c.group)) order.push(c.group);
        const sections = order.map((group) => {
          const rows = chats
            .map((c, i) => ({ c, i }))
            .filter(({ i }) => state.chatsCache[i].group === group)
            .map(({ c, i }) => {
              const mark = c.status === "running" ? " ⏳" : c.status === "waiting" ? " ⚠️" : c.unread ? " •" : "";
              const here = state.agentChatId === c.id ? " ◀" : "";
              return `${i + 1}. ${truncate(String(c.title || c.id), 70)}${mark}${here}  /c_${i + 1}`;
            });
          return `${group}\n${rows.join("\n")}`;
        });
        await this.sendText(chatId, `${sections.join("\n\n")}\n\nTap /c_N to open a chat, then just type. Search: /chats <text>`);
        return;
      }

      case "c": {
        const picked = state.chatsCache[Number(args) - 1];
        if (!picked) {
          await this.sendText(chatId, "Not in your list. Run /chats first.");
          return;
        }
        const r = await this.call(userId, chatId, {
          type: "open_chat",
          chatId: picked.id,
          group: picked.group === "Pinned" ? undefined : picked.group,
        });
        if (!r.ok) {
          await this.sendText(chatId, `❌ ${r.error}`);
          return;
        }
        state.agentChatId = picked.id;
        state.backend = "cdp";
        await this.sendText(chatId, `Opened “${truncate(picked.title, 60)}”.\nJust type to prompt it. /last · /model · /stop`);
        return;
      }

      case "newchat": {
        if (args) {
          state.agentChatId = undefined;
          await this.sendPrompt(userId, chatId, state, args, false, true);
          return;
        }
        const r = await this.call(userId, chatId, { type: "new_chat" });
        if (!r.ok) {
          await this.sendText(chatId, `❌ ${r.error}`);
          return;
        }
        state.agentChatId = r.data?.chatId || undefined;
        state.backend = "cdp";
        await this.sendText(chatId, "🆕 New chat ready in Cursor. Type your first prompt.");
        return;
      }

      case "model": {
        if (!args) {
          const r = await this.call(userId, chatId, { type: "list_models" });
          const models = r.replies.find((x) => x.type === "models")?.models as string[] | undefined;
          const current = this.chatWatcher?.lastComposerState?.model;
          await this.sendText(
            chatId,
            r.ok && models?.length
              ? `${current ? `Current: ${current}\n\n` : ""}${models.map((m) => `• ${m}`).join("\n")}\n\nSwitch: /model <name>`
              : `❌ ${r.error || "No models found"}`
          );
          return;
        }
        const r = await this.call(userId, chatId, { type: "set_model", model: args.slice(0, 80), chatId: state.agentChatId });
        await this.sendText(chatId, r.ok ? `Model set to ${r.data?.model || args}` : `❌ ${r.error}`);
        return;
      }

      case "approve":
      case "reject": {
        const entry = args ? this.approvalCodes.get(args) : undefined;
        if (!entry || entry.expiresAt <= Date.now()) {
          if (entry) this.approvalCodes.delete(args);
          await this.sendText(chatId, "That code is unknown or expired. Use the code from the latest approval alert.");
          return;
        }
        entry.armed = { action: cmd as "approve" | "reject", userId };
        await this.sendText(
          chatId,
          `${cmd === "approve" ? "Approve" : "Reject"} this exact request${entry.title ? ` in “${truncate(entry.title, 60)}”` : ""}?\n${truncate(entry.command, 600)}\n\nTap /confirm_${args} to ${cmd}. Ignore this to cancel.`
        );
        return;
      }

      case "confirm": {
        const entry = args ? this.approvalCodes.get(args) : undefined;
        if (!entry || entry.expiresAt <= Date.now() || entry.armed?.userId !== userId) {
          if (entry && entry.expiresAt <= Date.now()) this.approvalCodes.delete(args);
          await this.sendText(chatId, "Nothing to confirm. Tap /approve_<code> or /reject_<code> from the alert first.");
          return;
        }
        this.approvalCodes.delete(args);
        const approve = entry.armed.action === "approve";
        const r = await this.call(userId, chatId, {
          type: approve ? "approve_action" : "reject_action",
          chatId: entry.chatId,
          requestId: entry.requestId,
          confirmed: true,
        });
        await this.sendText(chatId, r.ok ? (approve ? "✅ Approved" : "🚫 Rejected") : `❌ ${r.error}`);
        return;
      }

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

      case "last": {
        if (!args && state.agentChatId) {
          const r = await this.call(userId, chatId, { type: "get_chat", chatId: state.agentChatId, limit: 10 });
          const page = r.replies.find((x) => x.type === "chat");
          const reply = [...(page?.items || [])].reverse().find((m: any) => m.role === "assistant" && String(m.text || "").trim());
          const title = page?.chat?.title || page?.composer?.title || "";
          await this.sendText(
            chatId,
            reply ? `🤖 ${title ? `${truncate(title, 60)}\n\n` : ""}${String(reply.text).trim()}` : r.ok ? "No reply in that chat yet." : `❌ ${r.error}`
          );
          return;
        }
        await this.sendText(chatId, "Open a chat first: /chats then tap /c_N.");
        return;
      }

      case "file": {
        const r = await this.call(userId, chatId, { type: "get_active_file" });
        const file = r.replies.find((x) => x.type === "command_result");
        if (!r.ok || !file) {
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
        const r = await this.call(userId, chatId, { type: "save_file" });
        const result = r.replies.find((x) => x.type === "command_result");
        await this.sendText(chatId, r.ok ? `💾 Saved${result?.path ? `: ${result.path}` : ""}` : `❌ ${r.error || "Save failed"}`);
        return;
      }

      case "sessions": case "use": case "to": case "history": case "open": case "state": case "plan": case "messages":
        await this.sendText(chatId, `/${cmd} was replaced by Agents-window chats: /chats, tap /c_N, then just type.`);
        return;

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
    newSession: boolean,
    newAgentChat = false
  ): Promise<void> {
    const text = prompt.trim();
    if (!text) {
      await this.sendText(chatId, "Send a prompt, e.g. /ask fix the bug");
      return;
    }

    if (newAgentChat || (state.agentChatId && !newSession)) {
      this.pendingByChat.set(chatId, { userId, startedAt: Date.now() });
      this.lastSyncChatId = chatId;
      const r = await this.call(userId, chatId, newAgentChat
        ? { type: "agent_prompt", text, newChat: true }
        : { type: "agent_prompt", text, chatId: state.agentChatId });
      if (!r.ok) {
        this.pendingByChat.delete(chatId);
        await this.sendText(chatId, `❌ ${r.error}`);
        return;
      }
      await this.sendText(
        chatId,
        state.sync
          ? `⏳ Sent${newAgentChat ? " to a new chat" : ""} — the reply will appear here.`
          : "Sent. Auto-replies are off: use /last, or /sync on."
      );
      return;
    }

    if (state.backend === "cdp" && !newSession) {
      await this.sendText(chatId, "Open a chat first: /chats then tap /c_N, or start one with /newchat <prompt>.");
      return;
    }
    this.pendingByChat.set(chatId, { userId, startedAt: Date.now() });
    this.chunkByChat.set(chatId, "");
    this.lastSyncChatId = chatId;

    await this.sendText(
      chatId,
      newSession
        ? `🆕 New CLI session · ${state.agentMode} · working…`
        : !state.sync
          ? "Sent. Auto-replies are off: use /last, or /sync on."
          : `⏳ CLI · ${state.agentMode} · working…`
    );

    await this.commandRouter.handleCommand({
      type: "cli_prompt",
      text,
      clientId: `telegram:${chatId}:${userId}`,
      newSession,
      agentMode: state.agentMode,
    });
  }
}
