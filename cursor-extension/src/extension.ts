import * as vscode from "vscode";
import { WebSocketServer } from "./websocket-server";
import { CommandHandler } from "./command-handler";
import { CommandRouter } from "./command-router";
import { ChatCapture } from "./chat-capture";
import { HttpServer } from "./http-server";
import { RulesManager } from "./rules-manager";
import { StatusBarManager } from "./status-bar";
import { RelayClient } from "./relay-client";
import { CONFIG } from "./config";
import { CdpManager } from "./cdp/cdp-manager";

let wsServer: WebSocketServer | null = null;
let commandHandler: CommandHandler | null = null;
let commandRouter: CommandRouter | null = null;
let chatCapture: ChatCapture | null = null;
let httpServer: HttpServer | null = null;
let rulesManager: RulesManager | null = null;
let statusBarManager: StatusBarManager | null = null;
let relayClient: RelayClient | null = null;
let cdpManager: CdpManager | null = null;
let outputChannel: vscode.OutputChannel;
/** 연결 정보 Webview 패널 (열려 있을 때만 갱신용) */
let connectionsPanel: vscode.WebviewPanel | null = null;
/** 패널 열린 동안 주기 갱신 타이머 (dispose 시 해제) */
let connectionsPanelRefreshInterval: ReturnType<typeof setInterval> | null =
  null;
/** 릴레이 서버 저장소 라벨 (연결 정보 패널에서 표시, /api/store 조회 결과) */
let lastRelayStoreLabel: string | null = null;

/** 연결 정보 Webview용 HTML 생성 */
function getConnectionsViewHtml(data: {
  serverRunning: boolean;
  serverPort: number | null;
  relaySessionId: string | null;
  relayStoreLabel: string | null;
  relayServerUrl: string | null;
  localClientIds: string[];
}): string {
  const { serverRunning, serverPort, relaySessionId, relayStoreLabel, relayServerUrl, localClientIds } = data;
  const relayStoreLine =
    relayStoreLabel != null
      ? `<p class="relay-meta"><strong>Store:</strong> ${escapeHtml(relayStoreLabel)}</p>`
      : "";
  const relayUrlLine =
    relayServerUrl != null
      ? `<p class="relay-meta"><strong>Server:</strong> <code>${escapeHtml(relayServerUrl)}</code></p>`
      : "";
  const relaySection =
    relaySessionId != null
      ? `
    <section class="section">
      <h2>📡 Relay</h2>
      <p class="status connected">Connected via relay server</p>
      <p class="session-id"><strong>Session ID:</strong> <code>${escapeHtml(
        relaySessionId
      )}</code></p>
      ${relayStoreLine}
      ${relayUrlLine}
    </section>`
      : `
    <section class="section">
      <h2>📡 Relay</h2>
      <p class="status disconnected">Not connected</p>
      ${relayStoreLine}
      ${relayUrlLine}
    </section>`;

  const localSection =
    localClientIds.length > 0
      ? `
    <section class="section">
      <h2>🖥️ Local clients (${localClientIds.length})</h2>
      <ul>${localClientIds
        .map((id) => `<li><code>${escapeHtml(id)}</code></li>`)
        .join("")}</ul>
    </section>`
      : `
    <section class="section">
      <h2>🖥️ Local clients</h2>
      <p class="status disconnected">No connections</p>
    </section>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 1rem; color: var(--vscode-foreground); }
    h1 { font-size: 1.2rem; margin-bottom: 1rem; }
    h2 { font-size: 1rem; margin: 1rem 0 0.5rem; color: var(--vscode-descriptionForeground); }
    .section { margin-bottom: 1.25rem; }
    .status.connected { color: var(--vscode-testing-iconPassed); }
    .status.disconnected { color: var(--vscode-descriptionForeground); }
    code { background: var(--vscode-textBlockQuote-background); padding: 0.2em 0.4em; border-radius: 4px; }
    ul { margin: 0.25rem 0; padding-left: 1.25rem; }
    .relay-meta { font-size: 0.9em; color: var(--vscode-descriptionForeground); margin-top: 0.25rem; }
  </style>
</head>
<body>
  <h1>Cursor Remote - Connection Info</h1>
  <section class="section">
    <h2>🔌 Server</h2>
    <p class="status ${serverRunning ? "connected" : "disconnected"}">
      ${serverRunning ? `Running on port ${serverPort ?? "-"}` : "Stopped"}
    </p>
  </section>
  ${relaySection}
  ${localSection}
</body>
</html>`;
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
  const serverStatus = wsServer
    ? wsServer.getConnectionStatus()
    : {
        isRunning: false,
        clientCount: 0,
        port: null as number | null,
      };
  const relaySessionId =
    relayClient?.isConnectedToSession() === true
      ? relayClient.getSessionId()
      : null;
  const localClientIds = wsServer ? wsServer.getClientIds() : [];
  connectionsPanel.webview.html = getConnectionsViewHtml({
    serverRunning: serverStatus.isRunning,
    serverPort: serverStatus.port,
    relaySessionId,
    relayStoreLabel: lastRelayStoreLabel,
    relayServerUrl: CONFIG.RELAY_SERVER_URL,
    localClientIds,
  });
}

export async function activate(context: vscode.ExtensionContext) {
  // Output channel creation
  outputChannel = vscode.window.createOutputChannel("Cursor Remote");
  context.subscriptions.push(outputChannel);
  outputChannel.show(true);

  // 로그를 클라이언트에 전송하는 헬퍼 함수
  const sendLogToClients = (
    level: "info" | "warn" | "error",
    message: string,
    error?: any
  ) => {
    if (wsServer) {
      const logData = {
        level,
        message,
        timestamp: new Date().toISOString(),
        source: "extension",
        ...(error && {
          error: error instanceof Error ? error.message : String(error),
        }),
      };
      wsServer.send(
        JSON.stringify({
          type: "log",
          ...logData,
        })
      );
    }
  };

  outputChannel.appendLine("Cursor Remote extension is now active!");
  outputChannel.appendLine(
    `[${new Date().toLocaleTimeString()}] 🔄 Extension activation started`
  );
  console.log("Cursor Remote extension is now active!");
  sendLogToClients("info", "Cursor Remote extension is now active!");

  // Status bar manager
  statusBarManager = new StatusBarManager(context);

  // WebSocket server initialization
  wsServer = new WebSocketServer(CONFIG.WEBSOCKET_PORT, outputChannel);
  statusBarManager.setWebSocketServer(wsServer);

  // CLI mode is always enabled (IDE mode is deprecated)
  const useCLIMode = true;

  commandHandler = new CommandHandler(outputChannel, wsServer, useCLIMode);
  commandRouter = new CommandRouter(commandHandler, wsServer, outputChannel);

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

  await startOrRefreshCdp("activate");

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration("cursorRemote")) return;
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

  // HTTP server for hooks
  httpServer = new HttpServer(outputChannel, wsServer);
  await httpServer.start().catch((error) => {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    outputChannel.appendLine(
      `[${new Date().toLocaleTimeString()}] ❌ Failed to start HTTP server: ${errorMsg}`
    );
    vscode.window.showErrorMessage(
      `Cursor Remote: HTTP server start failed - ${errorMsg}`
    );
  });

  // Rules manager (CHAT_SUMMARY hook 제거됨 - stdout 응답만 사용)
  // rulesManager는 hooks.json 관리를 위해 유지하지만, CHAT_SUMMARY 감시는 제거
  rulesManager = new RulesManager(outputChannel, httpServer);

  // Chat capture
  chatCapture = new ChatCapture(outputChannel, wsServer);
  chatCapture.setup(context);

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

      // If message is from local WebSocket client (not from relay), forward to relay
      if (
        source !== "relay" &&
        relayClient &&
        relayClient.isConnectedToSession()
      ) {
        relayClient.sendMessage(message).catch((error) => {
          const errorMsg =
            error instanceof Error ? error.message : "Unknown error";
          outputChannel.appendLine(
            `[${new Date().toLocaleTimeString()}] ❌ Failed to send to relay: ${errorMsg}`
          );
        });
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

  // Register commands
  const startCommand = vscode.commands.registerCommand(
    "cursorRemote.start",
    () => {
      if (wsServer && !wsServer.isRunning()) {
        wsServer
          .start()
          .then(() => {
            if (statusBarManager) {
              statusBarManager.update(false);
            }
            updateConnectionsView();
            vscode.window.showInformationMessage(
              `Cursor Remote server started on port ${CONFIG.WEBSOCKET_PORT}`
            );
          })
          .catch((error) => {
            const errorMsg =
              error instanceof Error ? error.message : "Unknown error";
            outputChannel.appendLine(
              `[${new Date().toLocaleTimeString()}] ❌ Failed to start WebSocket server: ${errorMsg}`
            );
            vscode.window.showErrorMessage(
              `Cursor Remote: Server start failed - ${errorMsg}`
            );
            if (statusBarManager) {
              statusBarManager.update(false);
            }
            updateConnectionsView();
          });
      } else {
        vscode.window.showInformationMessage(
          "Cursor Remote server is already running"
        );
      }
    }
  );

  const stopCommand = vscode.commands.registerCommand(
    "cursorRemote.stop",
    () => {
      if (wsServer && wsServer.isRunning()) {
        wsServer.stop();
        if (statusBarManager) {
          statusBarManager.update(false);
        }
        updateConnectionsView();
        vscode.window.showInformationMessage("Cursor Remote server stopped");
      } else {
        vscode.window.showInformationMessage(
          "Cursor Remote server is not running"
        );
      }
    }
  );

  const toggleCommand = vscode.commands.registerCommand(
    "cursorRemote.toggle",
    () => {
      if (wsServer) {
        if (wsServer.isRunning()) {
          wsServer.stop();
          if (statusBarManager) {
            statusBarManager.update(false);
          }
          updateConnectionsView();
        } else {
          wsServer
            .start()
            .then(() => {
              if (statusBarManager) {
                statusBarManager.update(false);
              }
              updateConnectionsView();
            })
            .catch((error) => {
              const errorMsg =
                error instanceof Error ? error.message : "Unknown error";
              outputChannel.appendLine(
                `[${new Date().toLocaleTimeString()}] ❌ Failed to start WebSocket server: ${errorMsg}`
              );
              vscode.window.showErrorMessage(
                `Cursor Remote: Server start failed - ${errorMsg}`
              );
              if (statusBarManager) {
                statusBarManager.update(false);
              }
              updateConnectionsView();
            });
        }
      }
    }
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
      const sid = await vscode.window.showInputBox({
        title: "Cursor Remote: Relay Session ID",
        prompt: "Enter the 6-character session ID from the mobile app (e.g. 3ZUESK)",
        placeHolder: "3ZUESK",
        validateInput: (value) => {
          const v = value?.trim().toUpperCase() ?? "";
          if (!v) return "Please enter a session ID.";
          if (!/^[A-Z0-9]{6}$/.test(v)) return "Must be 6 alphanumeric characters (e.g. 3ZUESK)";
          return null;
        },
      });
      if (!sid) return;
      const pin = await vscode.window.showInputBox({
        title: "Cursor Remote: PIN (optional)",
        prompt:
          "If this session has a PIN, enter the 4–6 digit PIN. Leave blank if none was set.",
        placeHolder: "1234",
        password: true,
        validateInput: (v) => {
          const t = (v ?? "").trim();
          if (!t) return null;
          if (!/^\d{4,6}$/.test(t)) return "Must be 4–6 digits";
          return null;
        },
      });
      const pinToUse = pin != null && pin.trim() ? pin.trim() : undefined;
      await relayClient.connectToSessionById(sid, pinToUse);
      outputChannel.show();
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

  const showConnectionsCommand = vscode.commands.registerCommand(
    "cursorRemote.showConnections",
    async () => {
      const serverStatus = wsServer
        ? wsServer.getConnectionStatus()
        : {
            isRunning: false,
            clientCount: 0,
            port: null as number | null,
          };
      const relaySessionId =
        relayClient?.isConnectedToSession() === true
          ? relayClient.getSessionId()
          : null;
      const localClientIds = wsServer ? wsServer.getClientIds() : [];

      // 릴레이 서버 저장소 정보 조회 (Supabase / Upstash Redis)
      try {
        const res = await fetch(`${CONFIG.RELAY_SERVER_URL}/api/store`);
        const json = (await res.json()) as {
          success?: boolean;
          data?: { storeLabel?: string };
        };
        if (json?.success && json?.data?.storeLabel) {
          lastRelayStoreLabel = json.data.storeLabel;
        }
      } catch {
        lastRelayStoreLabel = null;
      }

      const html = getConnectionsViewHtml({
        serverRunning: serverStatus.isRunning,
        serverPort: serverStatus.port,
        relaySessionId,
        relayStoreLabel: lastRelayStoreLabel,
        relayServerUrl: CONFIG.RELAY_SERVER_URL,
        localClientIds,
      });

      const panel = vscode.window.createWebviewPanel(
        "cursorRemote.connections",
        "Cursor Remote - Connection Info",
        vscode.ViewColumn.One,
        { enableScripts: false }
      );
      panel.webview.html = html;
      connectionsPanel = panel;
      panel.onDidDispose(() => {
        connectionsPanel = null;
      });
    }
  );

  /** 상태줄 클릭: 릴레이 비활성 시 세션 ID·PIN 입력 후 연결, 활성 시 연결 정보 패널 */
  const statusBarClickCommand = vscode.commands.registerCommand(
    "cursorRemote.statusBarClick",
    async () => {
      const relayConnected =
        relayClient != null && relayClient.isConnectedToSession();
      if (relayConnected) {
        vscode.commands.executeCommand("cursorRemote.showConnections");
        return;
      }
      if (!relayClient) {
        outputChannel.appendLine(
          `[${new Date().toLocaleTimeString()}] [Relay] ⚠️ Relay client not initialized`
        );
        outputChannel.show();
        return;
      }
      const sid = await vscode.window.showInputBox({
        title: "Cursor Remote: Relay Session ID",
        prompt:
          "Enter a 6-character session ID to connect (enter the same ID on mobile to pair)",
        placeHolder: "3ZUESK",
        value: context.globalState.get<string>("cursorRemote.sessionId") ?? "",
        validateInput: (value) => {
          const v = (value ?? "").trim().toUpperCase();
          if (!v) return "Please enter a session ID.";
          if (!/^[A-Z0-9]{6}$/.test(v)) return "Must be 6 alphanumeric characters (e.g. 3ZUESK)";
          return null;
        },
      });
      if (!sid) return;
      const sidTrimmed = sid.trim().toUpperCase();
      await context.globalState.update("cursorRemote.sessionId", sidTrimmed);

      const pin = await vscode.window.showInputBox({
        title: "Cursor Remote: PIN (optional)",
        prompt:
          "Set a 4–6 digit PIN so mobile clients must know it to connect. Leave blank for no PIN.",
        placeHolder: "1234",
        password: true,
        validateInput: (v) => {
          const t = (v ?? "").trim();
          if (!t) return null;
          if (!/^\d{4,6}$/.test(t)) return "Must be 4–6 digits";
          return null;
        },
      });
      const pinToUse = pin != null && pin.trim() ? pin.trim() : undefined;
      try {
        await relayClient.start(sidTrimmed, pinToUse);
        outputChannel.appendLine(
          `[${new Date().toLocaleTimeString()}] ✅ Relay connected - Session: ${sidTrimmed}${
            pinToUse ? " (PIN set)" : ""
          }`
        );
        outputChannel.show();
        if (statusBarManager) statusBarManager.refresh();
        updateConnectionsView();
        vscode.window.showInformationMessage(
          `Cursor Remote: Connected to session ${sidTrimmed}.`
        );
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : "Unknown error";
        outputChannel.appendLine(
          `[${new Date().toLocaleTimeString()}] ⚠️ Relay connection failed: ${errorMsg}`
        );
        outputChannel.show();
        vscode.window.showErrorMessage(
          `Cursor Remote: Relay connection failed - ${errorMsg}`
        );
      }
    }
  );

  context.subscriptions.push(
    startCommand,
    stopCommand,
    toggleCommand,
    checkRelayServerCommand,
    connectToRelaySessionByIdCommand,
    setRelaySessionIdCommand,
    showConnectionsCommand,
    statusBarClickCommand
  );

  // Initialize relay client
  outputChannel.appendLine(
    `[${new Date().toLocaleTimeString()}] 🔄 Creating RelayClient instance...`
  );
  outputChannel.appendLine(
    `[${new Date().toLocaleTimeString()}] 🔄 Relay Server URL: ${
      CONFIG.RELAY_SERVER_URL
    }`
  );
  relayClient = new RelayClient(CONFIG.RELAY_SERVER_URL, outputChannel);
  outputChannel.appendLine(
    `[${new Date().toLocaleTimeString()}] ✅ RelayClient instance created`
  );

  // Set relay client in WebSocket server for automatic message forwarding
  if (wsServer && relayClient) {
    wsServer.setRelayClient(relayClient);
    outputChannel.appendLine(
      `[${new Date().toLocaleTimeString()}] ✅ Relay client set in WebSocket server`
    );
  }
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
      vscode.window.showInformationMessage(
        sessionId != null
          ? `Cursor Remote: Extension connected to session ${sessionId} via the relay server.`
          : "Cursor Remote: Extension connected to the relay server."
      );
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

  // Set up message forwarding: Relay Server -> Extension WebSocket
  relayClient.setOnMessage((message: string) => {
    outputChannel.appendLine(
      `[${new Date().toLocaleTimeString()}] === RELAY: message received (length: ${
        message.length
      }) ===`
    );
    // Mark message as from relay to prevent loop
    try {
      const parsed = JSON.parse(message);
      parsed.source = "relay";
      // clientId가 없으면 'relay'로 설정
      if (!parsed.clientId) {
        parsed.clientId = "relay-client";
      }
      const relayMessage = JSON.stringify(parsed);

      outputChannel.appendLine(
        `[${new Date().toLocaleTimeString()}] 📥 Message from relay, forwarding to command handler... (type: ${
          parsed.type
        })`
      );
      outputChannel.appendLine(
        `[${new Date().toLocaleTimeString()}] 📋 Relay message: ${relayMessage.substring(
          0,
          300
        )}`
      );

      // Directly trigger the message handlers to process the command
      // This is the same handler that processes WebSocket client messages
      if (wsServer) {
        outputChannel.appendLine(
          `[${new Date().toLocaleTimeString()}] 🔄 Calling triggerMessageHandlers...`
        );
        wsServer.triggerMessageHandlers(relayMessage);
        outputChannel.appendLine(
          `[${new Date().toLocaleTimeString()}] ✅ triggerMessageHandlers called`
        );
      } else {
        outputChannel.appendLine(
          `[${new Date().toLocaleTimeString()}] ⚠️ WebSocket server is null - cannot process relay message`
        );
      }
    } catch (error) {
      // If message is not JSON, send as-is but mark source
      const relayMessage = JSON.stringify({
        type: "message",
        data: message,
        source: "relay",
        clientId: "relay-client",
      });
      outputChannel.appendLine(
        `[${new Date().toLocaleTimeString()}] 📥 Message from relay (non-JSON), forwarding to command handler...`
      );
      if (wsServer) {
        wsServer.triggerMessageHandlers(relayMessage);
      } else {
        outputChannel.appendLine(
          `[${new Date().toLocaleTimeString()}] ⚠️ WebSocket server is null - cannot process relay message`
        );
      }
    }
  });

  // Auto start WebSocket server only (릴레이는 상태줄 클릭 시 세션 ID·PIN 입력 후 연결)
  wsServer
    .start()
    .then(async () => {
      if (statusBarManager) {
        statusBarManager.update(false); // Client not connected yet
      }
      updateConnectionsView();
      outputChannel.appendLine(
        `[${new Date().toLocaleTimeString()}] [Relay] Relay inactive. Click the 'Cursor Remote' status bar item → enter Session ID and PIN to connect`
      );
    })
    .catch((error) => {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      outputChannel.appendLine(
        `[${new Date().toLocaleTimeString()}] ❌ Failed to start WebSocket server: ${errorMsg}`
      );
      vscode.window.showErrorMessage(
        `Cursor Remote: Server start failed - ${errorMsg}`
      );
      if (statusBarManager) {
        statusBarManager.update(false);
      }
    });

  // Keep :8766 alive — if the listener dies, live chat sync to phone breaks.
  const wsWatchdog = setInterval(() => {
    if (!wsServer) return;
    void wsServer.ensureListening().then((ok) => {
      if (ok && statusBarManager) {
        // refresh port display if recovered
        statusBarManager.refresh();
      }
    });
  }, 5000);
  context.subscriptions.push({
    dispose: () => clearInterval(wsWatchdog),
  });

  if (statusBarManager) {
    statusBarManager.show();
  }
}

export function deactivate() {
  if (cdpManager) {
    void cdpManager.stop();
    cdpManager = null;
  }

  if (relayClient) {
    relayClient.stop();
    relayClient = null;
  }

  if (chatCapture) {
    chatCapture.dispose();
    chatCapture = null;
  }

  if (httpServer) {
    httpServer.stop();
    httpServer = null;
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
  rulesManager = null;
  statusBarManager = null;
}
