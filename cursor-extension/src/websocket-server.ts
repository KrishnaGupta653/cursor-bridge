import WebSocket, { WebSocketServer as WSServer } from "ws";
import * as vscode from "vscode";
import * as net from "net";
import { execFile, execFileSync } from "child_process";
import { WsAuth } from "./ws-auth";

type WebSocketClient = WebSocket;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminate(pid: number, signal: NodeJS.Signals, waitMs: number): Promise<boolean> {
  try {
    process.kill(pid, signal);
  } catch {
    return !isAlive(pid);
  }
  for (let waited = 0; waited < waitMs; waited += 100) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

export function isOrphanedExtensionHost(pid: number): boolean {
  try {
    const out = execFileSync("ps", ["-o", "ppid=,uid=,command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    const m = out.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) return false;
    const [, ppid, uid, command] = m;
    const sameUser = typeof process.getuid !== "function" || Number(uid) === process.getuid();
    return ppid === "1" && sameUser && /(Cursor|Code) Helper \(Plugin\): extension-host/.test(command);
  } catch {
    return false;
  }
}

export class WebSocketServer {
  private wss: WSServer | null = null;
  readonly auth = new WsAuth();
  private port: number;
  private actualPort: number | null = null;
  /** False after a user-initiated stop, so the watchdog leaves the server off. */
  private wanted = false;
  private starting: Promise<void> | null = null;
  private lastRestartError: string | null = null;
  private messageHandlers: ((message: string) => void)[] = [];
  private clientChangeHandlers: ((connected: boolean) => void)[] = [];
  private clientClosedHandlers: ((clientId: string) => void)[] = [];
  private outboundHandlers: ((message: string) => void)[] = [];
  private clients: Set<WebSocketClient> = new Set();
  private outputChannel: vscode.OutputChannel | null = null;
  private relayClient: {
    sendMessage: (message: string) => Promise<void>;
    isConnectedToSession: () => boolean;
  } | null = null;

  constructor(port: number, outputChannel?: vscode.OutputChannel) {
    this.port = port;
    this.outputChannel = outputChannel || null;
  }

  private log(message: string, level: "info" | "warn" | "error" = "info") {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] ${message}`;
    if (this.outputChannel) {
      this.outputChannel.appendLine(logMessage);
    }
    console.log(logMessage);

    // Forward live logs to clients
    this.sendLogToClients({
      level,
      message,
      timestamp: new Date().toISOString(),
      source: "extension",
    });
  }

  private logError(message: string, error?: any) {
    const timestamp = new Date().toLocaleTimeString();
    const errorMessage =
      error instanceof Error ? error.message : String(error || "");
    const logMessage = `[${timestamp}] ERROR: ${message}${
      errorMessage ? ` - ${errorMessage}` : ""
    }`;
    if (this.outputChannel) {
      this.outputChannel.appendLine(logMessage);
    }
    console.error(logMessage);

    // Forward error logs to clients
    this.sendLogToClients({
      level: "error",
      message: `${message}${errorMessage ? ` - ${errorMessage}` : ""}`,
      timestamp: new Date().toISOString(),
      source: "extension",
      error: errorMessage,
    });
  }

  private sendLogToClients(logData: {
    level: "info" | "warn" | "error";
    message: string;
    timestamp: string;
    source: string;
    error?: string;
  }) {
    // Diagnostics are local; they can contain information from other principals.
  }

  /** PIDs of other processes listening anywhere in [from, to] (one lsof call, non-blocking). */
  private listForeignListenerPids(from: number, to: number): Promise<number[]> {
    return new Promise((resolve) => {
      execFile("lsof", ["-nP", `-iTCP:${from}-${to}`, "-sTCP:LISTEN", "-t"], { timeout: 3000 }, (_err, stdout) => {
        const pids = new Set(
          String(stdout || "")
            .split(/\s+/)
            .map((s) => parseInt(s, 10))
            .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid)
        );
        resolve([...pids]);
      });
    });
  }

  /**
   * Free the Cursor Remote port range (WS fallbacks + hooks) from orphaned extension hosts
   * of the current user (parent pid 1, left behind after Cursor quit). Live windows and
   * unrelated processes are never touched.
   */
  async releaseOrphanedPorts(count: number = 10): Promise<void> {
    const pids = await this.listForeignListenerPids(this.port, this.port + count - 1);
    const orphans = pids.filter(isOrphanedExtensionHost);
    await Promise.all(
      orphans.map(async (pid) => {
        // Orphaned hosts often ignore SIGTERM; escalate after a grace period.
        if ((await terminate(pid, "SIGTERM", 2000)) || (await terminate(pid, "SIGKILL", 1000))) {
          this.log(`Stopped orphaned Cursor extension host ${pid} that was holding Cursor Remote ports`);
        }
      })
    );
  }

  /** Bind WebSocket server on an exact port (rejects on EADDRINUSE). */
  private listenOnPort(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // Clear any half-built server
      if (this.wss) {
        try {
          this.wss.close();
        } catch {
          /* ignore */
        }
        this.wss = null;
      }

      this.actualPort = port;
      // Read per connection so "Allow it" in the pairing flow applies without a restart.
      const allowedOrigins = () => vscode.workspace.getConfiguration("cursorRemote")
        .get<string[]>("allowedWebSocketOrigins", ["http://localhost:8080", "http://127.0.0.1:8080"]);
      const wss = new WSServer({ host: "0.0.0.0", port, maxPayload: 64 * 1024,
        verifyClient: (info: { req: import("http").IncomingMessage }) => {
          const origin = info.req.headers.origin;
          const ok = this.auth.originAllowed(origin, allowedOrigins());
          if (!ok) this.log(`Rejected connection from origin ${origin} — add it to cursorRemote.allowedWebSocketOrigins (or run Pair Client and choose "Allow it").`);
          return ok;
        },
      });
      this.wss = wss;

      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      wss.on("connection", (ws: WebSocketClient) => {
        let clientId = "unauthenticated";
        this.auth.attach(ws, id => {
          clientId = id;
          (ws as any).clientId = id;
          this.clients.add(ws);
          this.notifyClientChange(true);
        }, parsed => {
          // Identity and source always come from the authenticated adapter.
          delete parsed.senderDeviceId;
          delete parsed.relaySessionId;
          parsed.clientId = clientId;
          parsed.source = "local";
          for (const handler of this.messageHandlers) {
            try { handler(JSON.stringify(parsed)); }
            catch { this.logError("Command dispatch failed"); }
          }
        });

        ws.on("close", () => {
          const disconnectedClientId = (ws as any).clientId || "unknown";
          this.log(
            `Client disconnected from Cursor Remote (ID: ${disconnectedClientId})`
          );
          this.clients.delete(ws);
          this.notifyClientChange(this.clients.size > 0);
          if ((ws as any).clientId) {
            for (const handler of this.clientClosedHandlers) {
              try { handler((ws as any).clientId); } catch { /* ignore */ }
            }
          }
        });

        ws.on("error", (error) => {
          this.logError("WebSocket error", error);
        });


      });

      wss.on("error", (error: any) => {
        this.logError("WebSocket server error", error);
        if (!settled) {
          try {
            wss.close();
          } catch {
            /* ignore */
          }
          this.wss = null;
          this.actualPort = null;
          settle(() => reject(error));
        }
      });

      wss.on("close", () => {
        this.log("WebSocket server closed");
        if (this.wss === wss) {
          this.wss = null;
          this.actualPort = null;
        }
      });

      wss.on("listening", () => {
        this.log(
          `✅ WebSocket server started on 0.0.0.0:${port} (phone → Mac LAN)`
        );
        settle(() => resolve());
      });

      this.log(`WebSocket server starting on port ${port}...`);
    });
  }

  /**
   * Start local WS. If preferred port is busy, automatically try the next ports.
   * Optionally free safe leftover processes on the preferred port first.
   */
  async start(options?: { preferFreePreferredPort?: boolean; quiet?: boolean }): Promise<void> {
    this.wanted = true;
    // Coalesce concurrent starts (activation, watchdog and commands can overlap).
    if (!this.starting) {
      this.starting = this.startOnce(options).finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async startOnce(options?: { preferFreePreferredPort?: boolean; quiet?: boolean }): Promise<void> {
    if (this.wss && this.actualPort != null) {
      if (await this.probePort(this.actualPort)) return;
      this.log(`Stale WebSocket handle on port ${this.actualPort} — restarting`);
      this.closeServer();
    }

    const maxAttempts = 10;
    const preferFree = options?.preferFreePreferredPort !== false;

    if (preferFree) {
      await this.releaseOrphanedPorts(maxAttempts);
    }

    let lastErr: unknown = null;
    for (let i = 0; i < maxAttempts; i++) {
      const port = this.port + i;
      try {
        await this.listenOnPort(port);
        if (port !== this.port) {
          // Expected with several Cursor windows open; the status bar shows the port.
          this.log(`Port ${this.port} is used by another Cursor window; this window uses ${port}.`);
        }
        return;
      } catch (e: any) {
        lastErr = e;
        if (e?.code === "EADDRINUSE") {
          if (!options?.quiet) this.log(`Port ${port} in use, trying ${port + 1}…`);
          continue;
        }
        throw e;
      }
    }

    const errorMsg = `All ports from ${this.port} to ${
      this.port + maxAttempts - 1
    } are in use. Stop other Cursor Remote instances or free a port.`;
    if (!options?.quiet) {
      this.logError(errorMsg, lastErr);
      vscode.window.showErrorMessage(`Cursor Remote: ${errorMsg}`);
    }
    throw new Error(errorMsg);
  }

  /** User-initiated stop: stays stopped (the watchdog will not restart it) and revokes clients. */
  stop() {
    this.wanted = false;
    this.auth.revokeAll();
    this.closeServer();
  }

  private closeServer() {
    if (this.wss) {
      try {
        this.wss.close();
      } catch (_) {
        /* ignore */
      }
      this.wss = null;
      this.actualPort = null;
      if (this.clients.size > 0) {
        this.clients.clear();
        this.notifyClientChange(false);
      }
      this.log("WebSocket server stopped");
    }
  }

  getActualPort(): number | null {
    return this.actualPort || (this.wss ? this.port : null);
  }

  isRunning(): boolean {
    return this.wss !== null && this.actualPort != null;
  }

  /** True if something is accepting TCP on our port. */
  private probePort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.setTimeout(800, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Health-check listener; restart if the socket died while the extension
   * still thinks the server is up (common after window/host churn).
   */
  async ensureListening(options?: { onlyIfWanted?: boolean }): Promise<boolean> {
    if (options?.onlyIfWanted && (!this.wanted || this.starting)) return this.isRunning();
    const port = this.actualPort || this.port;
    if (this.wss) {
      if (await this.probePort(port)) return true;
      this.log(`⚠️ WebSocket port ${port} not accepting connections — restarting`);
      this.closeServer();
    }
    try {
      await this.start({ quiet: options?.onlyIfWanted });
      this.lastRestartError = null;
      return this.isRunning();
    } catch (e) {
      // The watchdog retries every few seconds; only log when the reason changes.
      const reason = e instanceof Error ? e.message : String(e);
      if (reason !== this.lastRestartError) this.logError("Failed to restart WebSocket server", e);
      this.lastRestartError = reason;
      return false;
    }
  }

  onMessage(handler: (message: string) => void) {
    this.messageHandlers.push(handler);
  }

  // Trigger message handlers directly (for relay messages)
  triggerMessageHandlers(message: string) {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        this.logError("Error in relay message handler", error);
      }
    }
  }

  onClientChange(handler: (connected: boolean) => void): () => void {
    this.clientChangeHandlers.push(handler);
    return () => {
      this.clientChangeHandlers = this.clientChangeHandlers.filter((h) => h !== handler);
    };
  }

  /** Called with the client ID of each authenticated local client that disconnects. */
  onClientClosed(handler: (clientId: string) => void): void {
    this.clientClosedHandlers.push(handler);
  }

  /**
   * Observe outbound messages (chat_response, etc.) for bridges like Telegram.
   * Returns a dispose function.
   */
  onOutbound(handler: (message: string) => void): () => void {
    this.outboundHandlers.push(handler);
    return () => {
      this.outboundHandlers = this.outboundHandlers.filter((h) => h !== handler);
    };
  }

  private notifyOutbound(message: string) {
    for (const handler of this.outboundHandlers) {
      try {
        handler(message);
      } catch (error) {
        this.logError("Error in outbound handler", error);
      }
    }
  }

  private notifyClientChange(connected: boolean) {
    this.clientChangeHandlers.forEach((handler) => {
      try {
        handler(connected);
      } catch (error) {
        console.error("Error in client change handler:", error);
      }
    });
  }

  getClientCount(): number {
    return this.clients.size;
  }

  /** Connected local client IDs (for the status bar / connections view) */
  getClientIds(): string[] {
    const ids: string[] = [];
    this.clients.forEach((ws) => {
      const id = (ws as any).clientId;
      if (id) ids.push(id);
    });
    return ids;
  }

  getConnectionStatus(): {
    isRunning: boolean;
    clientCount: number;
    port: number | null;
  } {
    return {
      isRunning: this.isRunning(),
      clientCount: this.clients.size,
      port: this.getActualPort(),
    };
  }

  /**
   * Set relay client for forwarding messages to relay server
   */
  setRelayClient(
    relayClient: {
      sendMessage: (message: string) => Promise<void>;
      isConnectedToSession: () => boolean;
    } | null
  ) {
    this.relayClient = relayClient;
  }

  send(message: string) {
    let payload: any;
    try { payload = JSON.parse(message); } catch { return; }
    // No global fallback for data with unknown ownership.
    if (!payload || typeof payload.clientId !== "string" || !payload.clientId) return;
    if (payload.type === "log") return;
    this.notifyOutbound(message);
    if (this.wss) {
      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN &&
            (client as any).clientId === payload.clientId) client.send(message);
      }
    }
    if (payload.clientId.startsWith("relay:") && payload.targetDeviceId &&
        payload.source !== "relay" && payload.type !== "chat_response_chunk" &&
        this.relayClient?.isConnectedToSession()) {
      this.relayClient.sendMessage(message).catch(() => {
        this.logError("Failed to deliver relay response");
      });
    }
  }

  broadcast(message: string) {
    this.send(message);
  }

  private sendToClient(ws: WebSocketClient, message: string) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}
