import WebSocket, { WebSocketServer as WSServer } from "ws";
import * as vscode from "vscode";
import * as net from "net";
import { execFileSync } from "child_process";

type WebSocketClient = WebSocket;

export class WebSocketServer {
  private wss: WSServer | null = null;
  private port: number;
  private actualPort: number | null = null;
  private messageHandlers: ((message: string) => void)[] = [];
  private clientChangeHandlers: ((connected: boolean) => void)[] = [];
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

    // 실시간 로그를 클라이언트에 전송
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

    // 에러 로그를 클라이언트에 전송
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
    const logMessage = JSON.stringify({
      type: "log",
      ...logData,
    });

    // 로컬 WebSocket 클라이언트에 전송
    if (this.wss && this.clients.size > 0) {
      this.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(logMessage);
        }
      });
    }

    // 릴레이 서버에도 전송 (연결되어 있는 경우)
    if (this.relayClient && this.relayClient.isConnectedToSession()) {
      this.relayClient.sendMessage(logMessage).catch(() => {
        // 로그 전송 실패는 무시 (무한 루프 방지)
      });
    }
  }

  private async findAvailablePort(
    startPort: number,
    maxAttempts: number = 10
  ): Promise<number | null> {
    return new Promise((resolve) => {
      let attempts = 0;

      const tryPort = (port: number) => {
        const server = net.createServer();

        server.listen(port, "0.0.0.0", () => {
          server.once("close", () => {
            resolve(port);
          });
          server.close();
        });

        server.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            attempts++;
            if (attempts < maxAttempts) {
              tryPort(port + 1);
            } else {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        });
      };

      tryPort(startPort);
    });
  }

  /** PIDs listening on TCP port (macOS/Linux). */
  private listListenerPids(port: number): number[] {
    try {
      const out = execFileSync(
        "lsof",
        ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
        { encoding: "utf8", timeout: 3000 }
      );
      return out
        .split(/\s+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch {
      return [];
    }
  }

  private processCommand(pid: number): string {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
    } catch {
      return "";
    }
  }

  /**
   * Free a stuck port when safe (e.g. leftover cloudflared).
   * Never kills Cursor / Electron — those require using the next port.
   */
  async freePortIfSafe(port: number): Promise<{
    killed: number[];
    skipped: string[];
  }> {
    const killed: number[] = [];
    const skipped: string[] = [];
    const pids = this.listListenerPids(port);
    for (const pid of pids) {
      if (pid === process.pid) {
        skipped.push(`${pid} (self)`);
        continue;
      }
      const name = this.processCommand(pid);
      const lower = name.toLowerCase();
      if (
        lower.includes("cursor") ||
        lower.includes("electron") ||
        lower.includes("code helper") ||
        lower.includes("visual studio")
      ) {
        skipped.push(`${pid} (${name || "Cursor"})`);
        continue;
      }
      try {
        process.kill(pid, "SIGTERM");
        killed.push(pid);
        this.log(`Freed port ${port}: sent SIGTERM to pid ${pid} (${name})`);
      } catch (e) {
        skipped.push(
          `${pid} (kill failed: ${e instanceof Error ? e.message : String(e)})`
        );
      }
    }
    if (killed.length > 0) {
      await new Promise((r) => setTimeout(r, 600));
    }
    return { killed, skipped };
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
      const wss = new WSServer({ host: "0.0.0.0", port });
      this.wss = wss;

      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      wss.on("connection", (ws: WebSocketClient) => {
        const clientId = `client-${Date.now()}-${Math.random()
          .toString(36)
          .substring(7)}`;
        (ws as any).clientId = clientId;
        this.clients.add(ws);
        this.log(`Client connected to Cursor Remote (ID: ${clientId})`);
        this.notifyClientChange(true);

        ws.on("message", (message: Buffer) => {
          const messageStr = message.toString();
          this.log(
            `Received message from ${clientId}: ${messageStr.substring(
              0,
              100
            )}${messageStr.length > 100 ? "..." : ""}`
          );
          try {
            const parsed = JSON.parse(messageStr);
            parsed.clientId = clientId;
            const messageWithClientId = JSON.stringify(parsed);
            this.messageHandlers.forEach((handler) => {
              try {
                handler(messageWithClientId);
              } catch (error) {
                this.logError("Error in message handler", error);
              }
            });
          } catch {
            this.messageHandlers.forEach((handler) => {
              try {
                handler(messageStr);
              } catch (err) {
                this.logError("Error in message handler", err);
              }
            });
          }
        });

        ws.on("close", () => {
          const disconnectedClientId = (ws as any).clientId || "unknown";
          this.log(
            `Client disconnected from Cursor Remote (ID: ${disconnectedClientId})`
          );
          this.clients.delete(ws);
          this.notifyClientChange(this.clients.size > 0);
        });

        ws.on("error", (error) => {
          this.logError("WebSocket error", error);
        });

        this.sendToClient(
          ws,
          JSON.stringify({
            type: "connected",
            message: "Connected to Cursor Remote",
            port,
          })
        );
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
  async start(options?: { preferFreePreferredPort?: boolean }): Promise<void> {
    if (this.wss && this.actualPort != null) {
      const alive = await this.probePort(this.actualPort);
      if (alive) {
        this.log(
          `WebSocket server is already running on port ${this.actualPort}`
        );
        return;
      }
      this.log(
        `Stale WebSocket handle on port ${this.actualPort} — restarting`
      );
      this.stop();
    }

    const maxAttempts = 10;
    const preferFree = options?.preferFreePreferredPort !== false;

    if (preferFree) {
      const listeners = this.listListenerPids(this.port);
      if (listeners.length > 0) {
        const { killed, skipped } = await this.freePortIfSafe(this.port);
        if (killed.length > 0) {
          this.log(
            `Freed preferred port ${this.port} (killed: ${killed.join(", ")})`
          );
        }
        if (skipped.length > 0) {
          this.log(
            `Port ${this.port} still held by: ${skipped.join(
              ", "
            )} — will try next free port`
          );
        }
      }
    }

    let lastErr: unknown = null;
    for (let i = 0; i < maxAttempts; i++) {
      const port = this.port + i;
      try {
        await this.listenOnPort(port);
        if (port !== this.port) {
          this.log(
            `⚠️ Preferred port ${this.port} was busy; using port ${port} instead.`
          );
          vscode.window.showWarningMessage(
            `Cursor Remote: Port ${this.port} was busy — listening on ${port}. Use this port in the phone Local field.`
          );
        }
        return;
      } catch (e: any) {
        lastErr = e;
        if (e?.code === "EADDRINUSE") {
          this.log(`Port ${port} in use, trying ${port + 1}…`);
          continue;
        }
        throw e;
      }
    }

    const errorMsg = `All ports from ${this.port} to ${
      this.port + maxAttempts - 1
    } are in use. Stop other Cursor Remote instances or free a port.`;
    this.logError(errorMsg, lastErr);
    vscode.window.showErrorMessage(`Cursor Remote: ${errorMsg}`);
    throw new Error(errorMsg);
  }

  stop() {
    if (this.wss) {
      try {
        this.wss.close();
      } catch (_) {
        /* ignore */
      }
      this.wss = null;
      this.actualPort = null;
      this.clients.clear();
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
  async ensureListening(): Promise<boolean> {
    const port = this.actualPort || this.port;
    if (this.wss) {
      const alive = await this.probePort(port);
      if (alive) return true;
      this.log(
        `⚠️ WebSocket port ${port} not accepting connections — restarting`
      );
      this.stop();
    }
    try {
      await this.start();
      return this.isRunning();
    } catch (e) {
      this.logError("Failed to restart WebSocket server", e);
      return false;
    }
  }

  onMessage(handler: (message: string) => void) {
    this.messageHandlers.push(handler);
  }

  // Trigger message handlers directly (for relay messages)
  triggerMessageHandlers(message: string) {
    this.log(
      `Triggering ${this.messageHandlers.length} message handler(s) for relay message`
    );
    this.messageHandlers.forEach((handler, index) => {
      try {
        this.log(
          `Calling message handler ${index + 1}/${this.messageHandlers.length}`
        );
        handler(message);
        this.log(`Message handler ${index + 1} completed`);
      } catch (error) {
        this.logError(`Error in message handler ${index + 1}`, error);
      }
    });
    this.log(`All message handlers processed`);
  }

  onClientChange(handler: (connected: boolean) => void) {
    this.clientChangeHandlers.push(handler);
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

  /** 연결된 로컬 클라이언트 ID 목록 (상태바/연결 정보 뷰용) */
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

  // 연결 상태를 클라이언트에 전송
  sendConnectionStatus() {
    const status = this.getConnectionStatus();
    const statusMessage = JSON.stringify({
      type: "connection_status",
      status: status.isRunning ? "connected" : "disconnected",
      source: "extension",
      message: status.isRunning
        ? `WebSocket server running on port ${status.port} (${status.clientCount} client(s))`
        : "WebSocket server not running",
      data: status,
    });
    this.send(statusMessage);
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
    // Notify outbound observers (e.g. Telegram live sync) before fan-out
    this.notifyOutbound(message);

    // Send to local WebSocket clients
    if (this.wss) {
      this.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    }

    // Also send to relay server if connected to relay session
    // Skip if message is from relay (to prevent loops)
    if (this.relayClient && this.relayClient.isConnectedToSession()) {
      try {
        const parsed = JSON.parse(message);
        // Only forward if message is not from relay
        if (parsed.source !== "relay") {
          // Skip streaming chunks in relay mode - only send final responses
          // This prevents duplicate/partial messages from reaching mobile app
          if (parsed.type === "chat_response_chunk") {
            // Don't send streaming chunks to relay - wait for final chat_response
            return;
          }
          if (parsed.type === "chat_response") {
            this.log(
              `Forwarding chat_response to relay (text length: ${
                (parsed.text || "").length
              })`
            );
          }
          this.relayClient.sendMessage(message).catch((error) => {
            const errorMsg =
              error instanceof Error ? error.message : "Unknown error";
            this.logError(`Failed to send to relay: ${errorMsg}`);
          });
        }
      } catch (error) {
        // If message is not JSON, send as-is
        // But check if it's a log message (which we don't want to forward)
        if (!message.includes('"type":"log"')) {
          this.relayClient.sendMessage(message).catch((error) => {
            const errorMsg =
              error instanceof Error ? error.message : "Unknown error";
            this.logError(`Failed to send to relay: ${errorMsg}`);
          });
        }
      }
    }
  }

  /**
   * Broadcast message to all clients including relay (for logs)
   * Unlike send(), this also sends log messages to relay
   */
  broadcast(message: string) {
    // Send to local WebSocket clients
    if (this.wss) {
      this.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    }

    // Also send to relay server (including log messages)
    if (this.relayClient && this.relayClient.isConnectedToSession()) {
      this.relayClient.sendMessage(message).catch(() => {
        // Ignore errors for broadcast (to prevent infinite loops)
      });
    }
  }

  // HTTP POST 요청으로 메시지 수신 (hook에서 사용)
  sendFromHook(data: any) {
    const message = JSON.stringify(data);
    this.send(message);
    this.log(`Message sent from hook: ${data.type || "unknown"}`);
  }

  private sendToClient(ws: WebSocketClient, message: string) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}
