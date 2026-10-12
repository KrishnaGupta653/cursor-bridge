import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";
import { appLink, normalizeAppUrl, pairLink } from "../links";
import type { RelayClient } from "../relay-client";
import { checkRelay } from "./relay-check";
import { cursorAppPath, findLoginItem, installLoginItem } from "./login-item";
import { qrSvg } from "./qr";
import {
  API_HASH,
  BOT_TOKEN,
  TelegramOwner,
  botApi,
  checkBotToken,
  savedMtprotoCredentials,
  waitForFirstMessage,
  writeTelegramFile,
} from "./telegram-setup";

const REPO = "https://github.com/KrishnaGupta653/cursor-bridge";
export const SETUP_GUIDE_URL = `${REPO}/blob/main/SETUP.md`;
export const RELAY_DEPLOY_URL =
  "https://vercel.com/new/clone?" +
  new URLSearchParams({
    "repository-url": `${REPO}/tree/main/relay-server`,
    "project-name": "cursor-remote-relay",
    "repository-name": "cursor-remote-relay",
    stores: JSON.stringify([{ type: "integration", integrationSlug: "upstash", productSlug: "upstash-kv", protocol: "storage" }]),
  }).toString();
const BOTFATHER_URL = "https://t.me/BotFather";
const MY_TELEGRAM_URL = "https://my.telegram.org/apps";
const USERINFOBOT_URL = "https://t.me/userinfobot";
const OWNER_WAIT_MS = 3 * 60_000;

export interface SetupDeps {
  output: { appendLine(line: string): void; show(preserveFocus?: boolean): void };
  extensionVersion: string;
  appRoot: string;
  relay: () => RelayClient | null;
  relayServerUrl: () => string;
  relayOwnedElsewhere: () => boolean;
  saveSessionId: (sid: string) => Thenable<void>;
  cdpStatus: () => { enabled: boolean; connected: boolean; port: number } | null;
  restartWithSessionControl: () => Promise<void>;
  telegramRunning: () => boolean;
  stopTelegram: () => Promise<void>;
  startTelegram: () => Thenable<unknown>;
  telegramSecretsPath: () => string;
  localServer: () => { running: boolean; port: number | null };
}

const config = () => vscode.workspace.getConfiguration("cursorRemote");
const open = (url: string) => vscode.env.openExternal(vscode.Uri.parse(url));
type Pick<T> = vscode.QuickPickItem & { value: T };

async function choose<T>(title: string, items: Pick<T>[], placeHolder?: string): Promise<T | undefined> {
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder, ignoreFocusOut: true });
  return picked?.value;
}

/** "Cursor Remote: Set Up": relay, Telegram, the phone, then session control (which may restart Cursor). */
export async function runSetup(deps: SetupDeps): Promise<void> {
  const relayUrl = await setUpRelay(deps);
  if (relayUrl === undefined) return;
  const telegram = await setUpTelegram(deps);
  if (telegram === undefined) return;
  if (relayUrl) await showPhoneLink(deps, relayUrl);
  const restart = await setUpSessionControl(deps);
  if (restart === undefined) return;

  const done = [
    relayUrl ? `relay ${new URL(relayUrl).host}` : "no relay",
    telegram ? "Telegram bot on" : "no Telegram",
  ].join(", ");
  if (restart) {
    const pick = await vscode.window.showInformationMessage(
      `Cursor Remote is set up (${done}). Restart Cursor now to turn on session control? You'll be asked about unsaved files.`,
      { modal: true },
      "Restart Cursor"
    );
    if (pick === "Restart Cursor") await deps.restartWithSessionControl();
    return;
  }
  const pick = await vscode.window.showInformationMessage(`Cursor Remote is set up (${done}).`, "Run Diagnose", "Open Guide");
  if (pick === "Run Diagnose") await vscode.commands.executeCommand("cursorRemote.diagnose");
  else if (pick === "Open Guide") await open(SETUP_GUIDE_URL);
}

const checking = (url: string) =>
  vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking relay ${url}…` }, () => checkRelay(url));

/** The working relay's address, "" when skipped, undefined when the user closed the wizard. */
async function setUpRelay(deps: SetupDeps): Promise<string | undefined> {
  const title = "Cursor Remote Set Up (1/4): relay server";
  const current = deps.relayServerUrl();
  if (current) {
    const check = await checking(current);
    if (check.ok) {
      const keep = await choose(title, [
        { label: `$(check) Keep ${current}`, description: "working", value: true },
        { label: "$(edit) Use a different relay", value: false },
      ]);
      if (keep === undefined) return undefined;
      if (keep) return current;
    } else {
      vscode.window.showWarningMessage(`Cursor Remote: ${check.message}`);
    }
  }
  for (;;) {
    const how = await choose(title, [
      { label: "$(cloud-upload) Deploy my own relay on Vercel", detail: "Free. Opens Vercel: sign in with GitHub, click Deploy, and add Upstash Redis when asked.", value: "deploy" },
      { label: "$(link) I already deployed one: enter its address", value: "enter" },
      { label: "$(book) Open the step-by-step guide", value: "guide" },
      { label: "$(debug-step-over) Skip (same Wi-Fi and Telegram only)", value: "skip" },
    ], "The relay lets your phone reach this Mac from anywhere. Each person runs their own.");
    if (how === undefined) return undefined;
    if (how === "skip") return "";
    if (how === "guide") { await open(`${SETUP_GUIDE_URL}#2-deploy-your-relay`); continue; }
    if (how === "deploy") await open(RELAY_DEPLOY_URL);
    const raw = await vscode.window.showInputBox({
      title,
      prompt: how === "deploy"
        ? "When Vercel shows “Congratulations”, open the project and copy its domain (Settings → Domains), then paste it here."
        : "Your relay's address",
      placeHolder: "https://cursor-remote-relay.vercel.app",
      ignoreFocusOut: true,
      validateInput: (v) => (/^https:\/\/[^\s/?#]+\/?$/i.test(v.trim()) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(v.trim())
        ? null
        : "Paste the https address, like https://cursor-remote-relay.vercel.app"),
    });
    if (raw === undefined) continue;
    const check = await checking(raw);
    if (!check.ok || !check.url) {
      const next = await vscode.window.showErrorMessage(`Cursor Remote: ${check.message}`, "Try Again", "Open Guide");
      if (next === "Open Guide") await open(`${SETUP_GUIDE_URL}#troubleshooting`);
      continue;
    }
    await config().update("relayServerUrl", check.url, vscode.ConfigurationTarget.Global);
    deps.relay()?.setServerUrl(check.url);
    deps.output.appendLine(`[Setup] Relay set to ${check.url}`);
    return check.url;
  }
}

/** True when the bot is set up and running, false when skipped, undefined when the wizard was closed. */
async function setUpTelegram(deps: SetupDeps): Promise<boolean | undefined> {
  const title = "Cursor Remote Set Up (2/4): Telegram bot";
  const secretsPath = deps.telegramSecretsPath();
  const exists = fs.existsSync(secretsPath);
  const how = await choose(title, [
    ...(exists ? [{ label: "$(check) Keep my Telegram bot", description: deps.telegramRunning() ? "running" : "set up", value: "keep" }] : []),
    { label: exists ? "$(refresh) Set up a different bot" : "$(comment-discussion) Set up a Telegram bot", detail: "Chat with your agents, get approval alerts, and get one-tap sign-in links.", value: "new" },
    { label: "$(debug-step-over) Skip", value: "skip" },
  ]);
  if (how === undefined) return undefined;
  if (how === "skip") return false;
  if (how === "keep") {
    if (!deps.telegramRunning()) await deps.startTelegram();
    return deps.telegramRunning();
  }

  const go = await vscode.window.showInformationMessage(
    "In Telegram, open BotFather, send /newbot, choose a name and a username ending in “bot”, then copy the token it sends.",
    "Open BotFather",
    "I Have a Token"
  );
  if (!go) return undefined;
  if (go === "Open BotFather") await open(BOTFATHER_URL);
  const token = (await vscode.window.showInputBox({
    title,
    prompt: "Paste the bot token from BotFather. It stays on this Mac, in a file only you can read.",
    placeHolder: "123456789:AAH…",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (BOT_TOKEN.test(v.trim()) ? null : "A bot token looks like 123456789:AAH… (digits, a colon, then letters)"),
  }))?.trim();
  if (!token) return undefined;

  const api = botApi(token);
  const bot = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Checking the bot token with Telegram…" },
    () => checkBotToken(token, api)
  );
  if (!bot.ok && !bot.unreachable) {
    vscode.window.showErrorMessage(`Cursor Remote: ${bot.message}`);
    return setUpTelegram(deps);
  }

  let owner: TelegramOwner | null = null;
  let mtproto: { apiId?: number; apiHash?: string } = savedMtprotoCredentials(secretsPath);
  if (bot.ok) {
    if (deps.telegramRunning()) await deps.stopTelegram();
    owner = await captureOwner(api, bot.username!);
    if (!owner) return undefined;
  } else {
    const creds = await askMtproto(title, mtproto);
    if (!creds) return undefined;
    mtproto = creds;
    owner = await askOwnerId(title);
    if (!owner) return undefined;
  }

  if (exists) {
    const replace = await vscode.window.showWarningMessage(
      "Replace your existing Telegram bot settings with this bot?",
      { modal: true },
      "Replace"
    );
    if (replace !== "Replace") return undefined;
  }
  writeTelegramFile(secretsPath, {
    botToken: token,
    allowedUserIds: [owner.userId],
    allowedChatIds: [owner.chatId],
    apiId: mtproto.apiId,
    apiHash: mtproto.apiHash,
  });
  deps.output.appendLine(`[Setup] Telegram settings saved to ${secretsPath} (only you can read it)`);
  if (bot.ok) {
    await api("sendMessage", {
      chat_id: owner.chatId,
      text: `✅ Cursor Remote is set up on ${os.hostname().replace(/\.local$/i, "")}. Only you can use this bot. Send /help to see what it can do.`,
    });
  }
  await deps.startTelegram();
  return deps.telegramRunning();
}

async function captureOwner(api: ReturnType<typeof botApi>, username: string): Promise<TelegramOwner | null> {
  let cancelled = false;
  const waiting = vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Send /start to @${username} in Telegram`, cancellable: true },
    async (progress, token) => {
      token.onCancellationRequested(() => { cancelled = true; });
      progress.report({ message: "waiting for your message (3 minutes)…" });
      return waitForFirstMessage(api, { deadline: Date.now() + OWNER_WAIT_MS, cancelled: () => cancelled || token.isCancellationRequested });
    }
  );
  void vscode.window.showInformationMessage(`Open @${username} on your phone and send /start, so the bot learns it's you.`, "Open Telegram")
    .then((pick) => pick && open(`https://t.me/${username}`));
  const result = await waiting;
  if (!result) {
    if (cancelled) return null;
    const manual = await vscode.window.showWarningMessage("No message arrived. Enter your Telegram user ID instead?", "Enter ID");
    return manual ? askOwnerId("Cursor Remote Set Up (2/4): Telegram bot") : null;
  }
  if ("error" in result) {
    vscode.window.showErrorMessage(`Cursor Remote: ${result.error}`);
    return null;
  }
  const allow = await vscode.window.showWarningMessage(
    `Allow ${result.name} (Telegram ID ${result.userId}) to control this Mac from Telegram?`,
    { modal: true, detail: "Only this account will be answered. If this isn't you, choose Cancel and run Set Up again." },
    "Allow"
  );
  return allow === "Allow" ? result : null;
}

async function askMtproto(title: string, saved: { apiId?: number; apiHash?: string }): Promise<{ apiId: number; apiHash: string } | null> {
  if (saved.apiId && saved.apiHash) return { apiId: saved.apiId, apiHash: saved.apiHash };
  const go = await vscode.window.showWarningMessage(
    "Telegram's Bot API is blocked on this network. Cursor Remote can use Telegram's app protocol instead: on my.telegram.org sign in, open “API development tools”, create an app, and copy its api_id and api_hash. Needs Python 3.",
    "Open my.telegram.org",
    "I Have Them"
  );
  if (!go) return null;
  if (go === "Open my.telegram.org") await open(MY_TELEGRAM_URL);
  const apiId = await vscode.window.showInputBox({
    title, prompt: "api_id (a number)", ignoreFocusOut: true,
    validateInput: (v) => (/^\d{3,12}$/.test(v.trim()) ? null : "api_id is a number"),
  });
  if (!apiId) return null;
  const apiHash = await vscode.window.showInputBox({
    title, prompt: "api_hash (32 letters and digits)", password: true, ignoreFocusOut: true,
    validateInput: (v) => (API_HASH.test(v.trim()) ? null : "api_hash is 32 letters and digits"),
  });
  if (!apiHash) return null;
  return { apiId: Number(apiId.trim()), apiHash: apiHash.trim() };
}

async function askOwnerId(title: string): Promise<TelegramOwner | null> {
  const pick = await vscode.window.showInformationMessage("Message @userinfobot in Telegram; it replies with your numeric ID.", "Open @userinfobot", "I Know My ID");
  if (!pick) return null;
  if (pick === "Open @userinfobot") await open(USERINFOBOT_URL);
  const id = await vscode.window.showInputBox({
    title, prompt: "Your Telegram user ID", placeHolder: "123456789", ignoreFocusOut: true,
    validateInput: (v) => (/^\d{4,15}$/.test(v.trim()) ? null : "Your ID is a number, like 123456789"),
  });
  if (!id) return null;
  const userId = Number(id.trim());
  return { userId, chatId: userId, name: `Telegram user ${userId}` };
}

/** A QR code with a one-tap, single-use sign-in link for the phone. */
async function showPhoneLink(deps: SetupDeps, relayUrl: string): Promise<void> {
  const title = "Cursor Remote Set Up (3/4): your phone";
  const relay = deps.relay();
  if (!relay || deps.relayOwnedElsewhere()) return;
  const want = await choose(title, [
    { label: "$(device-mobile) Show a QR code to sign in my phone", value: true },
    { label: "$(debug-step-over) Not now", description: "later: Telegram /pair, or Pair Relay Client", value: false },
  ]);
  if (!want) return;
  let sid = relay.isConnectedToSession() ? relay.getSessionId() : null;
  if (!sid) {
    sid = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Starting a relay session…" },
      () => relay.startNewSession()
    );
    if (sid) await deps.saveSessionId(sid);
  }
  if (!sid) {
    vscode.window.showErrorMessage("Cursor Remote: couldn't start a relay session. Run Diagnose to see why.", "Run Diagnose")
      .then((p) => p && vscode.commands.executeCommand("cursorRemote.diagnose"));
    return;
  }
  let pairing: { code: string; expiresAt: number };
  try {
    pairing = await relay.getPairingCode(false);
  } catch {
    vscode.window.showErrorMessage("Cursor Remote: couldn't create a pairing code. Run Diagnose to see why.");
    return;
  }
  const appUrl = normalizeAppUrl(config().get<string>("appUrl", ""));
  const link = pairLink(appUrl, relayUrl, sid, pairing.code);
  const minutes = Math.max(1, Math.round((pairing.expiresAt - Date.now()) / 60_000));
  const panel = vscode.window.createWebviewPanel("cursorRemote.phoneLink", "Cursor Remote: sign in your phone", vscode.ViewColumn.Active, {
    enableScripts: false,
  });
  panel.webview.html = phoneLinkHtml(qrSvg(link), sid, minutes, appLink(appUrl, relayUrl, sid));
  const close = setTimeout(() => panel.dispose(), Math.max(10_000, pairing.expiresAt - Date.now()));
  panel.onDidDispose(() => clearTimeout(close));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function phoneLinkHtml(svg: string, sessionId: string, minutes: number, plainLink: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<style>body{font-family:var(--vscode-font-family);padding:24px;text-align:center}
.qr{display:inline-block;background:#fff;padding:12px;border-radius:12px}.qr svg{width:300px;height:300px}
p{max-width:460px;margin:12px auto;line-height:1.5}small{opacity:.75}</style></head><body>
<h2>Scan with your phone's camera</h2>
<div class="qr">${svg}</div>
<p>It opens Cursor Remote and signs in to relay session <b>${escapeHtml(sessionId)}</b>.
Works once and expires in ${minutes} minute${minutes === 1 ? "" : "s"}; this page closes then.</p>
<p><small>Then use “Add to Home Screen” so it opens like an app. Later sign-ins: send /pair to your Telegram bot,
or open ${escapeHtml(plainLink)} and use Cursor Remote: Pair Relay Client. Don't share a photo of this code.</small></p>
</body></html>`;
}

/** True when Cursor must restart for session control, false when not, undefined when the wizard was closed. */
async function setUpSessionControl(deps: SetupDeps): Promise<boolean | undefined> {
  const title = "Cursor Remote Set Up (4/4): session control";
  const status = deps.cdpStatus();
  const mac = process.platform === "darwin";
  const appPath = cursorAppPath(deps.appRoot);
  const loginItem = mac ? findLoginItem() : null;
  type Option = "enable" | "auto" | "login";
  const items: Array<vscode.QuickPickItem & { value: Option }> = [
    { label: "Turn on session control", detail: "Lets the phone and Telegram send, stop and approve in Cursor's own Agents window (localhost only).", value: "enable", picked: true },
    { label: "Restart Cursor with session control by itself when it's off", detail: "A 10-second countdown you can cancel.", value: "auto", picked: true },
    ...(mac && appPath && !loginItem
      ? [{ label: "Open Cursor with session control when I log in", detail: "Adds a login item for this Mac user.", value: "login" as Option, picked: true }]
      : []),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title,
    canPickMany: true,
    ignoreFocusOut: true,
    placeHolder: loginItem ? "A login item that opens Cursor with session control is already set up." : "Choose what to turn on, then press Enter.",
  });
  if (!picked) return undefined;
  const on = new Set(picked.map((p) => p.value));
  if (on.has("enable")) await config().update("enableCdp", true, vscode.ConfigurationTarget.Global);
  if (on.has("auto")) await config().update("autoRestartWithSessionControl", true, vscode.ConfigurationTarget.Global);
  if (on.has("login") && appPath) {
    const file = installLoginItem(appPath, status?.port ?? 9222);
    deps.output.appendLine(`[Setup] Login item written to ${file}; it takes effect at your next login.`);
  }
  return on.has("enable") && !status?.connected;
}

/** "Cursor Remote: Diagnose": every moving part, without tokens, codes or file contents. */
export async function diagnose(deps: SetupDeps): Promise<string> {
  const lines: string[] = [`Cursor Remote ${deps.extensionVersion} on ${os.platform()} ${os.release()}`, ""];
  const add = (ok: boolean | null, label: string, detail: string) =>
    lines.push(`${ok === null ? "–" : ok ? "✅" : "❌"} ${label}: ${detail}`);

  const relayUrl = deps.relayServerUrl();
  if (!relayUrl) add(false, "Relay server", "not set up. Run Cursor Remote: Set Up.");
  else {
    const check = await checkRelay(relayUrl);
    add(check.ok, "Relay server", check.message);
    const relay = deps.relay();
    add(relay?.isConnectedToSession() ?? false, "Relay session",
      relay?.isConnectedToSession() ? `connected to ${relay.getSessionId()}` : deps.relayOwnedElsewhere()
        ? "another Cursor window owns the relay" : "not connected. Run Start New Relay Session.");
  }
  add(null, "Web app", appLink(normalizeAppUrl(config().get<string>("appUrl", "")), relayUrl || null));

  const server = deps.localServer();
  add(server.running, "Same Wi-Fi server", server.running ? `listening on port ${server.port}` : "stopped");

  const cdp = deps.cdpStatus();
  add(cdp?.connected ?? false, "Session control", !cdp?.enabled
    ? "off (cursorRemote.enableCdp). Phone and Telegram can read but not send or approve."
    : cdp.connected ? `on (localhost:${cdp.port})` : "Cursor was opened without it. Run Restart Cursor with Session Control.");
  if (process.platform === "darwin") {
    const item = findLoginItem();
    add(item ? true : null, "Login item", item ? `opens Cursor with session control (${item})` : "none");
  }

  const secretsPath = deps.telegramSecretsPath();
  if (!fs.existsSync(secretsPath)) add(null, "Telegram", "not set up");
  else {
    const mode = fs.statSync(secretsPath).mode & 0o777;
    add(mode === 0o600, "Telegram settings file", mode === 0o600 ? "private (0600)" : `readable by others (${mode.toString(8)}); run chmod 600 ${secretsPath}`);
    let token = "";
    let users = 0;
    try {
      const parsed = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
      token = typeof parsed.botToken === "string" ? parsed.botToken.trim() : "";
      users = Array.isArray(parsed.allowedUserIds) ? parsed.allowedUserIds.length : 0;
    } catch {
      add(false, "Telegram settings", "not valid JSON. Run Set Up again.");
    }
    if (token) {
      const bot = await checkBotToken(token, botApi(token, fetch, 10_000));
      add(bot.ok || (bot.unreachable ? null : false), "Telegram bot", bot.ok ? `@${bot.username}` : bot.unreachable ? `${bot.message} MTProto fallback needs apiId/apiHash.` : bot.message);
    }
    add(users > 0, "Telegram allowed users", users > 0 ? String(users) : "none, so the bot answers nobody. Run Set Up.");
    add(deps.telegramRunning(), "Telegram bot running", deps.telegramRunning() ? "yes" : "no (it may be running in another Cursor window)");
  }
  return lines.join("\n");
}
