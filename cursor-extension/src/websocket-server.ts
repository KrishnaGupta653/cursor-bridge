import WebSocket, { WebSocketServer as WSServer } from "ws";
import * as vscode from "vscode";
import * as net from "net";

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
      let currentPort = startPort;
      let attempts = 0;

      const tryPort = (port: number) => {
        const server = net.createServer();

        server.listen(port, () => {
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

      tryPort(currentPort);
    });
  }

  async start(): Promise<void> {
    if (this.wss) {
      this.log("WebSocket server is already running");
      return;
    }

    // 포트가 사용 중인지 확인하고 사용 가능한 포트 찾기
    const availablePort = await this.findAvailablePort(this.port);

    if (availablePort === null) {
      const errorMsg = `All ports from ${this.port} to ${
        this.port + 10
      } are in use. Stop other processes or change the port.`;
      this.logError(errorMsg);
      vscode.window.showErrorMessage(`Cursor Remote: ${errorMsg}`);
      throw new Error(errorMsg);
    }

    if (availablePort !== this.port) {
      this.log(
        `⚠️ Port ${this.port} is in use; using port ${availablePort} instead.`
      );
      vscode.window.showWarningMessage(
        `Cursor Remote: Port ${this.port} is in use; starting on port ${availablePort}.`
      );
    }

    this.actualPort = availablePort;
    // Bind all interfaces so phone on LAN can reach the Mac (not only localhost).
    this.wss = new WSServer({ host: "0.0.0.0", port: availablePort });

    // Promise로 서버 시작 완료 대기
    return new Promise((resolve, reject) => {
      this.wss!.on("connection", (ws: WebSocketClient) => {
        // 클라이언트 ID 생성 (연결 시점)
        const clientId = `client-${Date.now()}-${Math.random()
          .toString(36)
          .substring(7)}`;
        (ws as any).clientId = clientId; // WebSocket 객체에 clientId 저장

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

          // 메시지에 clientId 추가
          try {
            const parsed = JSON.parse(messageStr);
            parsed.clientId = clientId;
            const messageWithClientId = JSON.stringify(parsed);

            // 모든 핸들러에 clientId가 포함된 메시지 전달
            this.messageHandlers.forEach((handler) => {
              try {
                handler(messageWithClientId);
              } catch (error) {
                this.logError("Error in message handler", error);
              }
            });
          } catch (error) {
            // JSON 파싱 실패 시 원본 메시지 전달
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

        // 연결 성공 메시지 전송
        this.sendToClient(
          ws,
          JSON.stringify({
            type: "connected",
            message: "Connected to Cursor Remote",
          })
        );
      });

      this.wss!.on("error", (error: any) => {
        this.logError("WebSocket server error", error);
        if (error.code === "EADDRINUSE") {
          const errorMsg = `Port ${availablePort} is in use. Stop other processes or restart Cursor.`;
          vscode.window.showErrorMessage(`Cursor Remote: ${errorMsg}`);
          reject(new Error(errorMsg));
        } else {
          vscode.window.showErrorMessage(
            `Cursor Remote server error: ${error.message}`
          );
          // Mark dead so ensureListening() can restart
          this.wss = null;
          this.actualPort = null;
          reject(error);
        }
      });

      this.wss!.on("close", () => {
        this.log("WebSocket server closed");
        this.wss = null;
        this.actualPort = null;
      });

      this.wss!.on("listening", () => {
        this.log(
          `✅ WebSocket server started on 0.0.0.0:${availablePort} (phone → Mac LAN)`
        );
        resolve();
      });

      this.log(`WebSocket server starting on port ${availablePort}...`);
    });
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
      this.log("WebSocket server stopped");
    }
  }

  getActualPort(): number | null {
    return this.actualPort || (this.wss ? this.port : null);
  }

  isRunning(): boolean {
    return this.wss !== null;
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
