import * as os from "os";
import * as vscode from "vscode";
import { WebSocketServer } from "./websocket-server";
import { CommandHandler } from "./command-handler";
import { CommandRouter } from "./command-router";
import { StatusBarManager } from "./status-bar";
import { RELAY_LOCK_PATH, RelayClient, resumeSavedRelaySession } from "./relay-client";
import { CONFIG } from "./config";
import { CdpManager } from "./cdp/cdp-manager";
import { claimOnce, cursorBinary, scheduleRelaunchWithCdp } from "./cdp/relaunch";
import { ChatWatcher } from "./chat-watcher";
import { TranscriptIndex } from "./transcripts/transcript-index";
import { WorkspaceDiff } from "./transcripts/workspace-diff";
import { CloudflareTunnelManager } from "./cloudflare-tunnel";
import {
  TelegramBridge,
  defaultTelegramSecretsPath,
  ensureTelegramSecretsTemplate,
  loadTelegramSecrets,
  TELEGRAM_LOCKED_PREFIX,
  acquireTelegramLock,
  releaseTelegramLock,
} from "./telegram-bridge";

let wsServer: WebSocketServer | null = null;
let commandHandler: CommandHandler | null = null;
let commandRouter: CommandRouter | null = null;
let statusBarManager: StatusBarManager | null = null;
let relayClient: RelayClient | null = null;
let cdpManager: CdpManager | null = null;
let cloudflareTunnel: CloudflareTunnelManager | null = null;
let telegramBridge: TelegramBridge | null = null;
let chatWatcher: ChatWatcher | null = null;
let outputChannel: vscode.OutputChannel;
/** 연결 정보 Webview 패널 (열려 있을 때만 갱신용) */
let connectionsPanel: vscode.WebviewPanel | null = null;
/** 릴레이 서버 저장소 라벨 (연결 정보 패널에서 표시, /api/store 조회 결과) */
let lastRelayStoreLabel: string | null = null;
let relayLockHeld = false;

function claimRelayLock(): { ok: true } | { ok: false; ownerPid: number } {
  if (relayLockHeld) return { ok: true };
  const lock = acquireTelegramLock(RELAY_LOCK_PATH);
  relayLockHeld = lock.ok;
  return lock;
}

/** True (after telling the user) when another live Cursor window already polls the relay. */
function relayOwnedElsewhere(): boolean {
  const lock = claimRelayLock();
  if (lock.ok) return false;
  void vscode.window.showWarningMessage(lock.ownerPid > 0
    ? `Cursor Remote: another Cursor window (pid ${lock.ownerPid}) is already connected to the relay. Use that window, or close it and try again.`
    : `Cursor Remote: could not create ${RELAY_LOCK_PATH}; check the temp folder's permissions.`);
  return true;
}

/** 연결 정보 Webview용 HTML 생성 */
function getConnectionsViewHtml(data: {
  serverRunning: boolean;
  serverPort: number | null;
  lanAddress: string | null;
  originAllowed: boolean;
  relaySessionId: string | null;
  relayStoreLabel: string | null;
  relayServerUrl: string | null;
  localClientIds: string[];
  tunnelWssUrl: string | null;
  telegramRunning: boolean;
}): string {
  const e = escapeHtml;
  const status = (ok: boolean, text: string) =>
    `<p class="status ${ok ? "ok" : "off"}"><span aria-hidden="true">${ok ? "●" : "○"}</span> ${e(text)}</p>`;
  const row = (label: string, value: string) =>
    `<div class="row"><dt>${e(label)}</dt><dd><code>${e(value)}</code></dd></div>`;
  const hint = (text: string) => `<p class="hint">${text}</p>`;

  const host = data.lanAddress || "this computer's IP";
  const phone = data.serverRunning
    ? `${status(true, `Listening on port ${data.serverPort ?? "?"}`)}
      <dl>
        ${row("Web app", `http://${host}:8080`)}
        ${row("Local host", host)}
        ${row("Local port", String(data.serverPort ?? "?"))}
      </dl>
      ${data.originAllowed ? "" : hint(`<strong>Blocked origin:</strong> <code>http://${e(host)}:8080</code> is not in <code>cursorRemote.allowedWebSocketOrigins</code>. Run <em>Cursor Remote: Pair Client</em> and choose “Allow it”.`)}
      ${hint("The Web app is served separately on port 8080 (repo: <code>scripts/start-cursor-remote-stack.sh</code>). Open it on the phone, then run <em>Cursor Remote: Pair Client</em> and paste the code. Both devices must be on the same Wi-Fi.")}`
    : `${status(false, "Server stopped")}${hint("Run <em>Cursor Remote: Start Server</em>.")}`;

  const clients = data.localClientIds.length
    ? `${status(true, `${data.localClientIds.length} paired device(s) connected`)}<ul>${data.localClientIds
        .map((id) => `<li><code>${e(id)}</code></li>`)
        .join("")}</ul>`
    : status(false, "No devices connected");

  const relayMeta = [
    data.relayStoreLabel != null ? row("Store", data.relayStoreLabel) : "",
    data.relayServerUrl != null ? row("Server", data.relayServerUrl) : "",
  ].join("");
  const relay = data.relaySessionId
    ? `${status(true, "Connected")}<dl>${row("Session ID", data.relaySessionId)}${relayMeta}</dl>`
    : `${status(false, "Not connected")}<dl>${relayMeta}</dl>${hint("For phones on other networks: click the status bar item → Connect to Relay.")}`;

  const tunnel = data.tunnelWssUrl
    ? `${status(true, "Running")}<dl>${row("Phone URL", data.tunnelWssUrl)}</dl>${hint("In the app: Tunnel → paste this URL → Connect.")}`
    : `${status(false, "Not running")}${hint("Run <em>Cursor Remote: Start Cloudflare Tunnel</em> for access from other networks.")}`;

  const telegram = data.telegramRunning
    ? `${status(true, "Bot running in this window")}${hint("Message your bot <code>/help</code>.")}`
    : `${status(false, "Not running in this window")}${hint("Only one window runs the bot. Run <em>Cursor Remote: Start Telegram Bot</em> if none does.")}`;

  const section = (icon: string, title: string, body: string) => {
    const id = `h-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    return `<section aria-labelledby="${id}"><h2 id="${id}"><span aria-hidden="true">${icon}</span> ${e(title)}</h2>${body}</section>`;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 0 1.25rem 1.5rem; color: var(--vscode-foreground); max-width: 44rem; line-height: 1.5; }
    h1 { font-size: 1.3em; font-weight: 600; margin: 1.25rem 0 0.5rem; }
    h2 { font-size: 1em; font-weight: 600; margin: 0 0 0.35rem; }
    section { padding: 0.9rem 0; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
    .status { margin: 0 0 0.4rem; }
    .status.ok span { color: var(--vscode-testing-iconPassed); }
    .status.off { color: var(--vscode-descriptionForeground); }
    dl { margin: 0.25rem 0; }
    .row { display: flex; gap: 0.75rem; align-items: baseline; margin: 0.15rem 0; }
    dt { min-width: 7rem; color: var(--vscode-descriptionForeground); }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 0.1em 0.35em; border-radius: 3px; user-select: all; }
    ul { margin: 0.25rem 0; padding-left: 1.25rem; }
    .hint { margin: 0.35rem 0 0; color: var(--vscode-descriptionForeground); }
    @media (max-width: 420px) { .row { flex-direction: column; gap: 0; } }
  </style>
</head>
<body>
  <h1>Cursor Remote</h1>
  ${section("📱", "Connect your phone", phone)}
  ${section("🖥️", "Paired devices", clients)}
  ${section("✈️", "Telegram", telegram)}
  ${section("☁️", "Cloudflare Tunnel", tunnel)}
  ${section("📡", "Relay", relay)}
</body>
</html>`;
}

/** This computer's LAN IPv4 (Wi-Fi first), used to tell the user what to type on the phone. */
function lanAddress(): string | null {
  const ifaces = os.networkInterfaces();
  const ordered = [...Object.keys(ifaces).filter((n) => n === "en0"), ...Object.keys(ifaces).filter((n) => n !== "en0")];
  for (const name of ordered) {
    for (const a of ifaces[name] || []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) return a.address;
    }
  }
  return null;
}

function allowedOrigins(): string[] {
  return vscode.workspace
    .getConfiguration("cursorRemote")
    .get<string[]>("allowedWebSocketOrigins", ["http://localhost:8080", "http://127.0.0.1:8080"]);
}

let pairingAfterConnect = false;
/** A startup reconnect to a session that is already paired; no "pair the phone" prompt. */
let resumingRelay = false;

function relayServerUrl(): string {
  const v = (vscode.workspace.getConfiguration("cursorRemote").get<string>("relayServerUrl") ?? "")
    .trim()
    .replace(/\/+$/, "");
  return /^https:\/\/[^\s/]+/i.test(v) ? v : CONFIG.RELAY_SERVER_URL;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 연결 정보가 바뀌었을 때 열려 있는 패널 내용 갱신 */
function updateConnectionsView() {
  if (!connectionsPanel) return;
  const lan = lanAddress();
  connectionsPanel.webview.html = getConnectionsViewHtml({
    serverRunning: wsServer?.isRunning() ?? false,
    serverPort: wsServer?.getActualPort() ?? null,
    lanAddress: lan,
    originAllowed: !lan || allowedOrigins().includes(`http://${lan}:8080`),
    relaySessionId: relayClient?.isConnectedToSession() ? relayClient.getSessionId() : null,
    relayStoreLabel: lastRelayStoreLabel,
    relayServerUrl: relayServerUrl(),
    localClientIds: wsServer ? wsServer.getClientIds() : [],
    tunnelWssUrl: cloudflareTunnel?.getWssUrl() ?? null,
    telegramRunning: telegramBridge?.isRunning() ?? false,
  });
}

export async function activate(context: vscode.ExtensionContext) {
  // Never force the panel open: every window activates this extension. Errors offer "Show Log".
  outputChannel = vscode.window.createOutputChannel("Cursor Remote");
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine(
    `[${new Date().toLocaleTimeString()}] Cursor Remote activating…`
  );

  // Status bar manager
  statusBarManager = new StatusBarManager(context);
  statusBarManager.setTelegramStatus(() => telegramBridge?.isRunning() ?? false);

  // WebSocket server initialization
  wsServer = new WebSocketServer(CONFIG.WEBSOCKET_PORT, outputChannel);
  statusBarManager.setWebSocketServer(wsServer);
  context.subscriptions.push(
    vscode.commands.registerCommand("cursorRemote.pairClient", async () => {
      const server = wsServer!;
      if (!server.isRunning() && !(await server.ensureListening())) {
        vscode.window.showErrorMessage("Cursor Remote: the local server is not running, so nothing can pair.", "Show Log")
          .then((pick) => pick && outputChannel.show(true));
        return;
      }
      const lan = lanAddress();
      const webOrigin = lan ? `http://${lan}:8080` : null;
      if (webOrigin && !allowedOrigins().includes(webOrigin)) {
        const pick = await vscode.window.showWarningMessage(
          `Phones opening the Web app at ${webOrigin} will be rejected: that origin is not allowed yet.`,
          "Allow it",
          "Continue anyway"
        );
        if (!pick) return;
        if (pick === "Allow it") {
          await vscode.workspace.getConfiguration("cursorRemote").update(
            "allowedWebSocketOrigins",
            [...allowedOrigins(), webOrigin],
            vscode.ConfigurationTarget.Global
          );
        }
      }
      const secret = server.auth.beginPairing();
      await vscode.env.clipboard.writeText(secret);
      const port = server.getActualPort() ?? CONFIG.WEBSOCKET_PORT;
      const box = vscode.window.createInputBox();
      box.title = "Pair a device — code copied to clipboard (single use, expires in 5 minutes)";
      box.prompt = lan
        ? `In the Web app: Local → host ${lan}, port ${port} → Connect → paste this code. Never share it.`
        : `In the Web app: Local → this computer's IP, port ${port} → Connect → paste this code. Never share it.`;
      box.value = secret;
      box.ignoreFocusOut = true;
      let paired = false;
      const stopWatching = server.onClientChange((connected) => {
        // A reconnecting, already-paired device must not count; only a consumed code does.
        if (!connected || server.auth.isPairingPending()) return;
        paired = true;
        box.hide();
      });
      const expiry = setTimeout(() => {
        box.hide();
        if (!paired) vscode.window.showInformationMessage("Cursor Remote: pairing code expired. Run Pair Client again when the phone is ready.");
      }, 5 * 60_000);
      box.onDidAccept(() => box.hide());
      box.onDidHide(() => {
        stopWatching();
        clearTimeout(expiry);
        box.dispose();
        if (paired) vscode.window.showInformationMessage("Cursor Remote: device paired.");
      });
      box.show();
    }),
    vscode.commands.registerCommand("cursorRemote.revokeClients", async () => {
      const pick = await vscode.window.showWarningMessage(
        "Sign out every paired device? Each one will need a new pairing code.",
        { modal: true },
        "Revoke all"
      );
      if (pick !== "Revoke all") return;
      wsServer!.auth.revokeAll();
      vscode.window.showInformationMessage("Cursor Remote: all paired devices were signed out.");
    }),
  );

  // CLI mode is always enabled (IDE mode is deprecated)
  const useCLIMode = true;

  commandHandler = new CommandHandler(outputChannel, wsServer, useCLIMode, context.globalStorageUri.fsPath);
  commandRouter = new CommandRouter(commandHandler, wsServer, outputChannel);
  const transcriptIndex = new TranscriptIndex();
  chatWatcher = new ChatWatcher({
    index: transcriptIndex,
    composerState: async () =>
      cdpManager?.agents.attached
        ? cdpManager.agents.composerState()
        : { ok: false as const, error: "Cursor Agents window is not attached" },
    send: (payload) => wsServer?.send(JSON.stringify(payload)),
    logError: (msg, err) =>
      outputChannel.appendLine(`${msg}${err ? ` - ${err instanceof Error ? err.message : String(err)}` : ""}`),
  });
  commandRouter.setChatServices({
    index: transcriptIndex,
    diff: new WorkspaceDiff(),
    watcher: chatWatcher,
    agents: () => cdpManager?.agents ?? null,
    remoteActionsEnabled: () =>
      vscode.workspace.getConfiguration("cursorRemote").get<string>("remoteActions", "enabled") !== "disabled",
    sessionControl: () => !!cdpManager?.getStatus().connected,
  });
  wsServer.onClientClosed((clientId) => chatWatcher?.forgetClient(clientId));

  outputChannel.appendLine(
    "[Cursor Remote] CLI mode is enabled - using Cursor CLI"
  );

  // CDP (Existing Cursor Agent) — localhost only, never exposed to Android
  const startOrRefreshCdp = async (reason: string) => {
    const cfg = vscode.workspace.getConfiguration("cursorRemote");
    const enableCdp =
      CONFIG.ENABLE_CDP || cfg.get<boolean>("enableCdp", false) === true;
    const cdpHostRaw =
      process.env.CDP_HOST ||
      cfg.get<string>("cdpHost", CONFIG.CDP_HOST) ||
      CONFIG.CDP_HOST;
    const cdpPort =
      Number(process.env.CDP_PORT) ||
      cfg.get<number>("cdpPort", CONFIG.CDP_PORT) ||
      CONFIG.CDP_PORT;
    const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
    const cdpHostNorm = String(cdpHostRaw).trim().toLowerCase();
    const cdpHost =
      cdpHostNorm === "localhost" || cdpHostNorm === "::1"
        ? "127.0.0.1"
        : cdpHostNorm;

    if (enableCdp && !loopbackHosts.has(cdpHostNorm)) {
      outputChannel.appendLine(
        `[CDP] Refusing non-loopback host "${cdpHostRaw}". CDP must stay on localhost.`
      );
      return;
    }

    if (!cdpManager) {
      cdpManager = new CdpManager({
        host: cdpHost,
        port: cdpPort,
        enabled: enableCdp,
        pollIntervalMs: CONFIG.CDP_POLL_INTERVAL_MS,
        log: (msg) => outputChannel.appendLine(msg),
        logError: (msg, err) =>
          outputChannel.appendLine(
            `${msg}${err ? ` - ${err instanceof Error ? err.message : String(err)}` : ""}`
          ),
        broadcast: (payload) => {
          if (wsServer) {
            wsServer.send(JSON.stringify(payload));
          }
        },
      });
      commandHandler?.setCdpManager(cdpManager);
    } else {
      cdpManager.setEnabled(enableCdp);
      cdpManager.updateEndpoint(cdpHost, cdpPort);
    }

    outputChannel.appendLine(
      `[CDP] Config refresh (${reason}): enableCdp=${enableCdp} ${cdpHost}:${cdpPort}`
    );

    if (enableCdp) {
      await cdpManager.start();
    } else {
      await cdpManager.stop();
      outputChannel.appendLine("[CDP] Disabled via settings");
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      const cdpKeys = ["enableCdp", "cdpHost", "cdpPort"];
      if (!cdpKeys.some((k) => e.affectsConfiguration(`cursorRemote.${k}`))) return;
      try {
        await startOrRefreshCdp("settings-change");
      } catch (error) {
        outputChannel.appendLine(
          `[CDP] Settings refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    })
  );

  // WebSocket message handler
  wsServer.onMessage((message: string) => {
    try {
      const command = JSON.parse(message);
      const clientId = command.clientId || "none";
      const source = command.source || "local";

      outputChannel.appendLine(
        `[${new Date().toLocaleTimeString()}] Received command: ${
          command.type
        } from client: ${clientId} (source: ${source})`
      );

      // Handle command locally (whether from local WebSocket or relay)
      if (commandRouter) {
        commandRouter.handleCommand(command);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      outputChannel.appendLine(
        `[${new Date().toLocaleTimeString()}] Error parsing message: ${errorMsg}`
      );
      console.error("Error parsing message:", error);
    }
  });

  // Client connection/disconnection event handling
  wsServer.onClientChange((connected: boolean) => {
    if (statusBarManager) {
      statusBarManager.update(connected);
    }
    updateConnectionsView();

    if (connected) {
      outputChannel.appendLine(
        `[${new Date().toLocaleTimeString()}] Client connected - Ready to receive commands`
      );
      // 연결 상태 전송
      if (wsServer) {
        wsServer.sendConnectionStatus();
      }
    } else {
      outputChannel.appendLine(
        `[${new Date().toLocaleTimeString()}] Client disconnected`
      );
      // 연결 상태 전송
      if (wsServer) {
        wsServer.sendConnectionStatus();
      }
    }
  });

  const startServer = async () => {
    if (!wsServer) return;
    if (wsServer.isRunning()) {
      vscode.window.showInformationMessage(
        `Cursor Remote: server already running on port ${wsServer.getActualPort()}.`
      );
      return;
    }
    try {
      await wsServer.start();
      vscode.window.showInformationMessage(
        `Cursor Remote: server running on port ${wsServer.getActualPort()}.`
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      outputChannel.appendLine(
        `[${new Date().toLocaleTimeString()}] ❌ Failed to start WebSocket server: ${errorMsg}`
      );
      // "All ports busy" is already reported by the server itself.
      if (!errorMsg.startsWith("All ports")) {
        vscode.window
          .showErrorMessage(`Cursor Remote: server failed to start — ${errorMsg}`, "Show Log")
          .then((pick) => pick && outputChannel.show(true));
      }
    } finally {
      statusBarManager?.refresh();
      updateConnectionsView();
    }
  };

  const stopServer = () => {
    if (!wsServer?.isRunning()) {
      vscode.window.showInformationMessage("Cursor Remote: server is not running.");
      return;
    }
    wsServer.stop();
    statusBarManager?.refresh();
    updateConnectionsView();
    vscode.window.showInformationMessage(
      "Cursor Remote: server stopped. Paired devices were signed out."
    );
  };

  const startCommand = vscode.commands.registerCommand("cursorRemote.start", startServer);
  const stopCommand = vscode.commands.registerCommand("cursorRemote.stop", stopServer);
  const toggleCommand = vscode.commands.registerCommand("cursorRemote.toggle", () =>
    wsServer?.isRunning() ? stopServer() : startServer()
  );

  /** 연결 정보 뷰 (상태바 클릭 시 표시 - Git Graph처럼) */
  const checkRelayServerCommand = vscode.commands.registerCommand(
    "cursorRemote.checkRelayServer",
    async () => {
      if (relayClient) {
        await relayClient.checkServerStatus();
        outputChannel.show();
      } else {
        outputChannel.appendLine(
          `[${new Date().toLocaleTimeString()}] [Relay] ⚠️ Relay client not initialized`
        );
        outputChannel.show();
      }
    }
  );

  const connectToRelaySessionByIdCommand = vscode.commands.registerCommand(
    "cursorRemote.connectToRelaySessionById",
    async () => {
      if (!relayClient) {
        outputChannel.appendLine(
          `[${new Date().toLocaleTimeString()}] [Relay] ⚠️ Relay client not initialized`
        );
        outputChannel.show();
        return;
      }
      if (relayOwnedElsewhere()) return undefined;
      const sid = await vscode.window.showInputBox({
        title: "Cursor Remote: Relay Session ID",
        prompt: "Press Enter to reuse your last session, or type any new 6-character ID (a taken ID is swapped for a fresh one).",
        placeHolder: "3ZUESK",
        value: context.globalState.get<string>("cursorRemote.sessionId") ?? "",
        validateInput: (value) => {
          const v = value?.trim().toUpperCase() ?? "";
          if (!v) return "Please enter a session ID.";
          if (!/^[A-Z0-9]{6}$/.test(v)) return "Must be 6 alphanumeric characters (e.g. 3ZUESK)";
          return null;
        },
      });
      if (!sid) return undefined;
      await relayClient.connectToSessionById(sid);
      outputChannel.show();
      return relayClient.isConnectedToSession();
    }
  );

  const setRelaySessionIdCommand = vscode.commands.registerCommand(
    "cursorRemote.setRelaySessionId",
    async () => {
      const sid = await vscode.window.showInputBox({
        title: "Cursor Remote: Set Relay Session ID",
        prompt:
          "Enter a 6-character session ID to use on the next relay start (connect from mobile with the same ID)",
        placeHolder: "3ZUESK",
        value: context.globalState.get<string>("cursorRemote.sessionId") ?? "",
        validateInput: (value) => {
          const v = (value ?? "").trim().toUpperCase();
          if (!v) return "Please enter a session ID.";
          if (!/^[A-Z0-9]{6}$/.test(v)) return "Must be 6 alphanumeric characters (e.g. 3ZUESK)";
          return null;
        },
      });
      if (sid) {
        await context.globalState.update(
          "cursorRemote.sessionId",
          sid.trim().toUpperCase()
        );
        vscode.window.showInformationMessage(
          `Cursor Remote: Session ID ${sid
            .trim()
            .toUpperCase()} saved. (Used on next relay start)`
        );
      }
    }
  );

  const openTelegramSecretsCommand = vscode.commands.registerCommand(
    "cursorRemote.openTelegramSecrets",
    async () => {
      const cfg = vscode.workspace.getConfiguration("cursorRemote");
      const custom = (cfg.get<string>("telegramSecretsPath", "") || "").trim();
      const filePath = ensureTelegramSecretsTemplate(
        custom || defaultTelegramSecretsPath()
      );
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(
        "Fill in botToken (from BotFather) and your numeric Telegram id in both allowedUserIds and allowedChatIds, set enabled to true, save, then run Start Telegram Bot."
      );
    }
  );

  const startTelegramBotCommand = vscode.commands.registerCommand(
    "cursorRemote.startTelegramBot",
    async () => {
      if (!commandRouter || !wsServer || !commandHandler) {
        vscode.window.showErrorMessage("Cursor Remote: not ready yet.");
        return;
      }
      if (!telegramBridge) {
        telegramBridge = new TelegramBridge(
          outputChannel,
          commandRouter,
          commandHandler,
          wsServer,
          context.extensionPath,
          chatWatcher
        );
      }
      if (telegramBridge.isRunning()) {
        vscode.window.showInformationMessage("Telegram bot already running.");
        return;
      }
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Starting Telegram bot…" },
        () => telegramBridge!.start()
      );
      statusBarManager?.refresh();
      updateConnectionsView();
      if (!result.ok) {
        const locked = result.error?.startsWith(TELEGRAM_LOCKED_PREFIX);
        const pick = await vscode.window.showErrorMessage(
          locked
            ? `Cursor Remote: ${result.error}. That window already answers your bot.`
            : `Cursor Remote: Telegram bot failed — ${result.error}`,
          ...(locked ? [] : ["Open Telegram settings", "Show Log"])
        );
        if (pick === "Open Telegram settings") {
          await vscode.commands.executeCommand("cursorRemote.openTelegramSecrets");
        } else if (pick === "Show Log") {
          outputChannel.show(true);
        }
        return;
      }
      vscode.window.showInformationMessage(
        "Cursor Remote: Telegram bot started. Message your bot /help."
      );
    }
  );

  const stopTelegramBotCommand = vscode.commands.registerCommand(
    "cursorRemote.stopTelegramBot",
    async () => {
      if (!telegramBridge?.isRunning()) {
        vscode.window.showInformationMessage("Telegram bot is not running.");
        return;
      }
      await telegramBridge.stop();
      statusBarManager?.refresh();
      updateConnectionsView();
      vscode.window.showInformationMessage(
        "Cursor Remote: Telegram bot stopped."
      );
    }
  );

  const restartTelegramBotCommand = vscode.commands.registerCommand(
    "cursorRemote.restartTelegramBot",
    async () => {
      if (telegramBridge?.isRunning()) {
        await telegramBridge.stop();
      }
      await vscode.commands.executeCommand("cursorRemote.startTelegramBot");
    }
  );

  cloudflareTunnel = new CloudflareTunnelManager(context, outputChannel);
  cloudflareTunnel.setOnUrlChanged(() => updateConnectionsView());

  const startCloudflareTunnelCommand = vscode.commands.registerCommand(
    "cursorRemote.startCloudflareTunnel",
    async () => {
      try {
        if (!wsServer) {
          vscode.window.showErrorMessage(
            "Cursor Remote: WebSocket server not ready."
          );
          return;
        }
        const ok = await wsServer.ensureListening();
        if (!ok) {
          vscode.window.showErrorMessage(
            "Cursor Remote: Could not start local WebSocket server (ports busy)."
          );
          return;
        }
        const port = wsServer.getActualPort() ?? CONFIG.WEBSOCKET_PORT;
        const url = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Starting Cloudflare Tunnel (local :${port})…`,
            cancellable: false,
          },
          async () => cloudflareTunnel!.start(port)
        );
        await vscode.env.clipboard.writeText(url);
        updateConnectionsView();
        const pick = await vscode.window.showInformationMessage(
          `Cloudflare Tunnel ready (local port ${port}). URL copied.\n${url}`,
          "Copy again",
          "Show Connection Info"
        );
        if (pick === "Copy again") {
          await vscode.env.clipboard.writeText(url);
        } else if (pick === "Show Connection Info") {
          await vscode.commands.executeCommand("cursorRemote.showConnections");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        outputChannel.show(true);
        vscode.window.showErrorMessage(
          `Cursor Remote: Cloudflare Tunnel failed — ${msg}`
        );
      }
    }
  );

  const restartLocalServerCommand = vscode.commands.registerCommand(
    "cursorRemote.restartLocalServer",
    async () => {
      if (!wsServer) {
        vscode.window.showErrorMessage(
          "Cursor Remote: WebSocket server not ready."
        );
        return;
      }
      try {
        if (cloudflareTunnel?.isRunning()) {
          await cloudflareTunnel.stop();
        }
        wsServer.stop();
        await wsServer.start({ preferFreePreferredPort: true });
        const port = wsServer.getActualPort();
        updateConnectionsView();
        if (statusBarManager) statusBarManager.refresh();
        vscode.window.showInformationMessage(
          `Cursor Remote: Local server listening on port ${port ?? "?"}.`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(
          `Cursor Remote: Restart failed — ${msg}`
        );
      }
    }
  );

  const stopCloudflareTunnelCommand = vscode.commands.registerCommand(
    "cursorRemote.stopCloudflareTunnel",
    async () => {
      if (!cloudflareTunnel) return;
      await cloudflareTunnel.stop();
      updateConnectionsView();
      vscode.window.showInformationMessage(
        "Cursor Remote: Cloudflare Tunnel stopped."
      );
    }
  );

  const copyCloudflareTunnelUrlCommand = vscode.commands.registerCommand(
    "cursorRemote.copyCloudflareTunnelUrl",
    async () => {
      const url = cloudflareTunnel?.getWssUrl();
      if (!url) {
        vscode.window.showWarningMessage(
          "No active Cloudflare Tunnel. Run “Start Cloudflare Tunnel” first."
        );
        return;
      }
      await vscode.env.clipboard.writeText(url);
      vscode.window.showInformationMessage(`Copied: ${url}`);
    }
  );

  const showConnectionsCommand = vscode.commands.registerCommand(
    "cursorRemote.showConnections",
    () => {
      if (connectionsPanel) {
        connectionsPanel.reveal();
        updateConnectionsView();
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        "cursorRemote.connections",
        "Cursor Remote — Connection Info",
        vscode.ViewColumn.Active,
        { enableScripts: false }
      );
      connectionsPanel = panel;
      panel.onDidDispose(() => {
        connectionsPanel = null;
      });
      updateConnectionsView();

      // Relay store label is informational only: render first, never block on the network.
      if (relayClient?.isConnectedToSession()) {
        fetch(`${relayServerUrl()}/api/store`, { signal: AbortSignal.timeout(3000) })
          .then((res) => res.json() as Promise<{ success?: boolean; data?: { storeLabel?: string } }>)
          .then((json) => {
            lastRelayStoreLabel = json?.success && json.data?.storeLabel ? json.data.storeLabel : null;
            updateConnectionsView();
          })
          .catch(() => undefined);
      }
    }
  );

  /** Status bar click: one menu for every common action, instead of hunting the palette. */
  const statusBarClickCommand = vscode.commands.registerCommand(
    "cursorRemote.statusBarClick",
    async () => {
      const running = wsServer?.isRunning() ?? false;
      const tgRunning = telegramBridge?.isRunning() ?? false;
      const relayConnected = relayClient?.isConnectedToSession() ?? false;
      const tunnelUrl = cloudflareTunnel?.getWssUrl() ?? null;
      const lan = lanAddress();
      type Action = vscode.QuickPickItem & { run?: () => unknown };
      const cmd = (id: string) => () => vscode.commands.executeCommand(id);
      const items: Action[] = [
        { label: "Same Wi-Fi", kind: vscode.QuickPickItemKind.Separator },
        running
          ? { label: "$(device-mobile) Pair a device", description: `port ${wsServer?.getActualPort()}`, detail: "Shows a one-time code and where to enter it", run: cmd("cursorRemote.pairClient") }
          : { label: "$(play) Start server", run: cmd("cursorRemote.start") },
        ...(running && lan
          ? [{ label: "$(copy) Copy phone address", description: `${lan}:${wsServer?.getActualPort()}`, run: async () => {
              await vscode.env.clipboard.writeText(`${lan}:${wsServer?.getActualPort()}`);
              vscode.window.setStatusBarMessage("Cursor Remote: address copied", 3000);
            } }]
          : []),
        { label: "$(info) Connection info", description: "Address, devices, Telegram, tunnel, relay", run: cmd("cursorRemote.showConnections") },
        { label: "Telegram", kind: vscode.QuickPickItemKind.Separator },
        tgRunning
          ? { label: "$(debug-stop) Stop Telegram bot", run: cmd("cursorRemote.stopTelegramBot") }
          : { label: "$(comment-discussion) Start Telegram bot", run: cmd("cursorRemote.startTelegramBot") },
        { label: "$(gear) Edit Telegram settings", run: cmd("cursorRemote.openTelegramSecrets") },
        { label: "Other networks", kind: vscode.QuickPickItemKind.Separator },
        ...(tunnelUrl
          ? [
              { label: "$(copy) Copy tunnel URL", description: tunnelUrl, run: cmd("cursorRemote.copyCloudflareTunnelUrl") },
              { label: "$(debug-stop) Stop Cloudflare tunnel", run: cmd("cursorRemote.stopCloudflareTunnel") },
            ]
          : [{ label: "$(cloud-upload) Start Cloudflare tunnel", run: cmd("cursorRemote.startCloudflareTunnel") }]),
        relayConnected
          ? { label: "$(key) Pair relay device", description: `session ${relayClient?.getSessionId()}`, run: cmd("cursorRemote.pairRelayClient") }
          : { label: "$(plug) Connect to relay…", run: () => connectRelayFlow() },
        { label: "$(refresh) Start new relay session", description: "Drops the old one", run: cmd("cursorRemote.newRelaySession") },
        { label: "Troubleshooting", kind: vscode.QuickPickItemKind.Separator },
        { label: "$(output) Show log", run: () => outputChannel.show(true) },
        { label: "$(debug-restart) Restart server", description: "Signs out paired devices", run: cmd("cursorRemote.restartLocalServer") },
        ...(running ? [{ label: "$(debug-stop) Stop server", run: cmd("cursorRemote.stop") }] : []),
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: "Cursor Remote",
        placeHolder: running ? `Server on port ${wsServer?.getActualPort()} — choose an action` : "Server stopped — choose an action",
      });
      await picked?.run?.();
    }
  );

  const connectRelayFlow = async () => {
    if (!relayClient || relayOwnedElsewhere()) return;
    const sid = await vscode.window.showInputBox({
      title: "Cursor Remote: Connect to Relay",
      prompt: "6-character session ID (the phone joins the same ID). Afterwards run Pair Relay Client.",
      placeHolder: "3ZUESK",
      value: context.globalState.get<string>("cursorRemote.sessionId") ?? "",
      validateInput: (value) => {
        const v = (value ?? "").trim().toUpperCase();
        if (!v) return "Enter a session ID.";
        if (!/^[A-Z0-9]{6}$/.test(v)) return "Use 6 letters or digits, e.g. 3ZUESK";
        return null;
      },
    });
    if (!sid) return;
    const sidTrimmed = sid.trim().toUpperCase();
    await context.globalState.update("cursorRemote.sessionId", sidTrimmed);
    try {
      await relayClient.start(sidTrimmed);
      statusBarManager?.refresh();
      updateConnectionsView();
      vscode.window.showInformationMessage(
        `Cursor Remote: waiting for relay session ${sidTrimmed}. You'll be notified when it connects; then run Pair Relay Client.`
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      outputChannel.appendLine(
        `[${new Date().toLocaleTimeString()}] ⚠️ Relay connection failed: ${errorMsg}`
      );
      const pick = await vscode.window.showErrorMessage(
        `Cursor Remote: relay connection failed — ${errorMsg}`,
        "Show Log"
      );
      if (pick) outputChannel.show(true);
    }
  };

  context.subscriptions.push(
    startCommand,
    stopCommand,
    toggleCommand,
    checkRelayServerCommand,
    connectToRelaySessionByIdCommand,
    setRelaySessionIdCommand,
    startCloudflareTunnelCommand,
    stopCloudflareTunnelCommand,
    copyCloudflareTunnelUrlCommand,
    restartLocalServerCommand,
    openTelegramSecretsCommand,
    startTelegramBotCommand,
    stopTelegramBotCommand,
    restartTelegramBotCommand,
    showConnectionsCommand,
    statusBarClickCommand
  );

  relayClient = new RelayClient(relayServerUrl(), outputChannel, context.secrets);
  const showPairingCode = async () => {
    try {
      const code = await relayClient!.createMobilePairingCode();
      await vscode.env.clipboard.writeText(code);
      await vscode.window.showInputBox({
        title: `Relay session ${relayClient!.getSessionId()} — pairing code copied (single use, expires in 5 minutes)`,
        value: code, ignoreFocusOut: true,
        prompt: "In the app, enter the session ID above and this code. Keep the code private." });
    } catch { vscode.window.showErrorMessage("Connect to an authenticated relay session before pairing."); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("cursorRemote.pairRelayClient", async () => {
      if (!relayClient!.isConnectedToSession()) {
        pairingAfterConnect = true;
        const ok = await vscode.commands
          .executeCommand<boolean | undefined>("cursorRemote.connectToRelaySessionById")
          .then((v) => v, () => false);
        pairingAfterConnect = false;
        if (ok === undefined) return;
        if (!ok) {
          vscode.window.showErrorMessage("Could not connect to the relay session. Check the Cursor Remote output for the reason.");
          return;
        }
      }
      await showPairingCode();
    }),
    vscode.commands.registerCommand("cursorRemote.newRelaySession", async () => {
      if (relayOwnedElsewhere()) return;
      const pick = await vscode.window.showWarningMessage(
        "Start a new relay session? The current session is revoked and phones must pair again.",
        { modal: true },
        "Start New Session"
      );
      if (pick !== "Start New Session") return;
      pairingAfterConnect = true;
      const sid = await relayClient!.startNewSession().finally(() => { pairingAfterConnect = false; });
      statusBarManager?.refresh();
      updateConnectionsView();
      if (!sid) {
        vscode.window.showErrorMessage("Could not start a relay session. Check the Cursor Remote output for the reason.");
        return;
      }
      await context.globalState.update("cursorRemote.sessionId", sid);
      await showPairingCode();
    }),
    vscode.commands.registerCommand("cursorRemote.revokeRelaySession", async () => {
      const pick = await vscode.window.showWarningMessage(
        "Revoke this relay session? Relay devices will need to pair again.",
        { modal: true },
        "Revoke"
      );
      if (pick !== "Revoke") return;
      try { await relayClient!.disconnectSession(); vscode.window.showInformationMessage("Relay session credentials revoked."); }
      catch { vscode.window.showErrorMessage("Relay disconnect failed; inspect local connection status."); }
    }),
  );
  wsServer.setRelayClient(relayClient);
  // 릴레이 모드일 때 챗 히스토리 저장 시 relaySessionId 포함하도록 getter 설정
  if (commandHandler) {
    commandHandler.setGetRelaySessionId(
      () => relayClient?.getSessionId() ?? null
    );
  }
  // Status bar: reflect relay connection (클라이언트 접속 시 "Connected" 표시)
  if (statusBarManager && relayClient) {
    statusBarManager.setRelayClient(relayClient);
    relayClient.setOnSessionConnected(() => {
      if (statusBarManager) statusBarManager.refresh();
      updateConnectionsView(); // 연결 정보 패널이 열려 있으면 즉시 갱신
      const sessionId = relayClient?.getSessionId();
      if (sessionId) {
        context.globalState.update("cursorRemote.sessionId", sessionId);
      }
      if (pairingAfterConnect || resumingRelay) return;
      void vscode.window
        .showInformationMessage(
          sessionId != null
            ? `Cursor Remote: connected to relay session ${sessionId}. Pair the phone to finish.`
            : "Cursor Remote: connected to the relay server. Pair the phone to finish.",
          "Pair relay device"
        )
        .then((pick) => pick && vscode.commands.executeCommand("cursorRemote.pairRelayClient"));
    });
    relayClient.setOnSessionExpired((expired, next) => {
      void context.globalState.update("cursorRemote.sessionId", next);
      outputChannel.appendLine(`[Relay] Session ${expired} can't be used; switched to new session ${next}.`);
    });
    // 복수 세션 발견 시 사용자가 선택할 수 있도록 QuickPick 표시
    relayClient.setOnSessionsDiscovered(async (sessions) => {
      const picked = await vscode.window.showQuickPick(
        sessions.map((s) => ({
          label: s.sessionId,
          description: "Session ID",
        })),
        {
          title: "Cursor Remote: Select Relay Session",
          placeHolder:
            "Multiple sessions are waiting. Select the one connected from mobile.",
        }
      );
      return picked?.label ?? null;
    });
  }
  // 상태바 즉시 표시 (서버/릴레이 시작 전에 한 번 그려서 늦게 뜨는 현상 완화)
  if (statusBarManager) {
    statusBarManager.refresh();
    statusBarManager.show();
  }

  // Relay Server -> command handlers. Messages are marked as relay so they are not echoed back.
  relayClient.setOnMessage((message: string) => {
    let relayMessage: string;
    try {
      const parsed = JSON.parse(message);
      parsed.source = "relay";
      if (!parsed.clientId) parsed.clientId = "relay-client";
      relayMessage = JSON.stringify(parsed);
    } catch {
      relayMessage = JSON.stringify({ type: "message", data: message, source: "relay", clientId: "relay-client" });
    }
    wsServer?.triggerMessageHandlers(relayMessage);
  });
  relayClient.setOnTargetGone((clientId) => chatWatcher?.forgetClient(clientId));
  relayClient.setOnRejected((sid, statusCode) => {
    statusBarManager?.refresh();
    updateConnectionsView();
    void vscode.window
      .showWarningMessage(
        `Cursor Remote: the relay refused session ${sid} (HTTP ${statusCode}) and stopped trying. Start a new relay session and pair the phone again.`,
        "Start New Relay Session"
      )
      .then((pick) => pick && vscode.commands.executeCommand("cursorRemote.newRelaySession"));
  });

  // After a restart, pick up the last relay session in the one window that owns the relay.
  resumingRelay = true;
  void resumeSavedRelaySession(relayClient, context.globalState.get<string>("cursorRemote.sessionId"), () => claimRelayLock().ok)
    .then((outcome) => {
      if (outcome === "connected" || outcome === "failed" || outcome === "locked") {
        outputChannel.appendLine(`[Relay] Resume last session on startup: ${outcome}`);
      }
      statusBarManager?.refresh();
      updateConnectionsView();
    })
    .catch(() => outputChannel.appendLine("[Relay] Resume last session on startup failed"))
    .finally(() => { resumingRelay = false; });

  // Start servers without blocking activation: commands and the status bar are already live.
  const serversReady = (async () => {
    await wsServer!.releaseOrphanedPorts();
    await wsServer!.start({ preferFreePreferredPort: false }).catch((error) => {
      outputChannel.appendLine(
        `[${new Date().toLocaleTimeString()}] ❌ Failed to start WebSocket server: ${error instanceof Error ? error.message : error}`
      );
    });
    statusBarManager?.refresh();
    updateConnectionsView();
  })();
  // Session control (CDP) is optional and slow to attach; never delay the servers for it.
  const restartWithSessionControl = async () => {
    const bin = cursorBinary(vscode.env.appRoot);
    const port = cdpManager?.getStatus().port ?? CONFIG.CDP_PORT;
    if (!bin) {
      vscode.window.showErrorMessage(
        `Quit Cursor and start it from a terminal with --remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}.`
      );
      return;
    }
    scheduleRelaunchWithCdp(bin, port);
    outputChannel.appendLine(`[CDP] Restarting Cursor with session control on 127.0.0.1:${port}`);
    await vscode.commands.executeCommand("workbench.action.quit");
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("cursorRemote.restartWithSessionControl", async () => {
      if (cdpManager?.getStatus().connected) {
        vscode.window.showInformationMessage("Cursor Remote: session control is already on; no restart needed.");
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        "Cursor will quit and reopen with session control on, so your phone and Telegram can see and control agents. You'll be asked about unsaved files first.",
        { modal: true },
        "Restart Cursor"
      );
      if (choice === "Restart Cursor") await restartWithSessionControl();
    })
  );

  void serversReady.then(async () => {
    try {
      await startOrRefreshCdp("activate");
    } catch (e) {
      outputChannel.appendLine(`[CDP] Start failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const status = cdpManager?.getStatus();
    if (!status?.enabled || status.connected || !claimOnce("cdp-offer", 2 * 60 * 1000)) return;
    const choice = await vscode.window.showWarningMessage(
      "Cursor Remote: session control is off because Cursor was opened normally. Your phone and Telegram can read chats but can't send, stop or approve.",
      "Restart Cursor with Session Control",
      "Not Now"
    );
    if (choice === "Restart Cursor with Session Control") await restartWithSessionControl();
  });

  // Keep :8766 alive — if the listener dies, live chat sync to phone breaks.
  const wsWatchdog = setInterval(() => {
    // Orphaned extension host (Cursor quit without killing it): release ports and the Telegram bot.
    if (process.platform !== "win32" && process.ppid === 1) {
      clearInterval(wsWatchdog);
      deactivate();
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 1000);
      return;
    }
    if (!wsServer) return;
    void wsServer.ensureListening({ onlyIfWanted: true }).then(() => statusBarManager?.refresh());
  }, 5000);
  context.subscriptions.push({
    dispose: () => clearInterval(wsWatchdog),
  });

  if (!context.globalState.get<boolean>("cursorRemote.welcomed")) {
    void context.globalState.update("cursorRemote.welcomed", true);
    void serversReady.then(async () => {
      const pick = await vscode.window.showInformationMessage(
        "Cursor Remote is running. Click “Remote” in the status bar any time for every action — start by pairing your phone.",
        "Pair a device",
        "Quick Actions"
      );
      if (pick === "Pair a device") await vscode.commands.executeCommand("cursorRemote.pairClient");
      else if (pick === "Quick Actions") await vscode.commands.executeCommand("cursorRemote.statusBarClick");
    });
  }

  // Auto-start Telegram bot when secrets file exists and enabled
  const tgCfg = vscode.workspace.getConfiguration("cursorRemote");
  const tgAuto = tgCfg.get<boolean>("telegramAutoStart", true);
  if (tgAuto && commandRouter && wsServer && commandHandler) {
    const secretsPath =
      (tgCfg.get<string>("telegramSecretsPath", "") || "").trim() ||
      defaultTelegramSecretsPath();
    const loaded = loadTelegramSecrets(secretsPath);
    if (loaded.ok && loaded.secrets.enabled) {
      telegramBridge = new TelegramBridge(
        outputChannel,
        commandRouter,
        commandHandler,
        wsServer,
        context.extensionPath,
        chatWatcher
      );
      const bridge = telegramBridge;
      let lockNoticeShown = false;
      const tryStart = () =>
        bridge.start(secretsPath).then((result) => {
          statusBarManager?.refresh();
          updateConnectionsView();
          if (result.ok) return true;
          const locked = result.error?.startsWith(TELEGRAM_LOCKED_PREFIX);
          if (!locked || !lockNoticeShown) {
            outputChannel.appendLine(
              `[${new Date().toLocaleTimeString()}] [Telegram] Auto-start skipped: ${result.error}${
                locked ? " — this window takes over when that one closes" : ""
              }`
            );
          }
          if (locked) lockNoticeShown = true;
          return !locked;
        });
      void tryStart().then((done) => {
        if (done) return;
        const retry = setInterval(() => {
          if (telegramBridge !== bridge) return clearInterval(retry);
          void tryStart().then((ok) => ok && clearInterval(retry));
        }, 30_000);
        context.subscriptions.push({ dispose: () => clearInterval(retry) });
      });
    }
  }
}

export async function deactivate(): Promise<void> {
  // Cursor waits a few seconds for this promise; the Telegram bot and tunnel must exit with the window.
  const stopping: Promise<unknown>[] = [];
  if (telegramBridge) {
    stopping.push(telegramBridge.stop());
    telegramBridge = null;
  }

  if (cloudflareTunnel) {
    stopping.push(cloudflareTunnel.stop());
    cloudflareTunnel = null;
  }

  if (chatWatcher) {
    chatWatcher.dispose();
    chatWatcher = null;
  }

  if (cdpManager) {
    stopping.push(cdpManager.stop());
    cdpManager = null;
  }

  if (relayClient) {
    relayClient.stop();
    relayClient = null;
  }
  if (relayLockHeld) {
    releaseTelegramLock(RELAY_LOCK_PATH);
    relayLockHeld = false;
  }

  if (wsServer) {
    wsServer.stop();
    wsServer = null;
  }

  if (commandHandler) {
    commandHandler.dispose();
    commandHandler = null;
  }

  commandRouter = null;
  statusBarManager = null;

  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(stopping),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, 4000); }),
  ]);
  clearTimeout(timer);
}
