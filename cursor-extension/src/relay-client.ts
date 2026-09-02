/**
 * Relay Server Client for Cursor Remote Extension
 * Handles communication with the relay server for remote mobile client connections
 */

import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";
import { URL } from "url";

export interface RelayMessage {
  type: string;
  data?: any;
  to?: "mobile" | "pc";
  from?: "mobile" | "pc";
  timestamp?: number;
}

export interface Session {
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  pcDeviceId?: string;
  mobileDeviceId?: string;
}

export class RelayClient {
  private relayServerUrl: string;
  private deviceId: string;
  private sessionId: string | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private isConnected: boolean = false;
  private outputChannel: vscode.OutputChannel;
  private onMessageCallback: ((message: string) => void) | null = null;
  private onSessionConnectedCallback: (() => void) | null = null;
  /** 복수 세션 발견 시 사용자 선택용. (sessions) => 선택한 sessionId 또는 null */
  private onSessionsDiscoveredCallback:
    | ((sessions: { sessionId: string }[]) => Promise<string | null>)
    | null = null;
  /** 익스텐션 시작 시 사용자가 입력한 세션 ID (이 세션만 연결 시도) */
  private targetSessionId: string | null = null;
  /** PC가 설정한 PIN (모바일은 이 PIN을 알아야 접속 가능, 메모리에만 보관) */
  private targetPin: string | null = null;
  /** 409 PC_IN_USE 시 재시도 안 함 */
  private pcInUse: boolean = false;
  private lastSessionDiscoveryTime: number = 0;
  private lastPollHeartbeatTime: number = 0;
  private lastNoSessionHeartbeatTime: number = 0; // 세션 없을 때 폴링 동작 확인용
  private readonly SESSION_DISCOVERY_INTERVAL = 5000; // 5초마다 세션 탐지 (빠른 연결용)
  private readonly POLL_INTERVAL = 2000; // 2초마다 폴링
  private readonly POLL_HEARTBEAT_INTERVAL = 30000; // 30초마다 폴링 동작 로그
  /** 연결 유지용 heartbeat (2분 무heartbeat 시 서버가 연결 끊김으로 간주) */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private readonly HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30초마다 heartbeat

  constructor(relayServerUrl: string, outputChannel: vscode.OutputChannel) {
    this.relayServerUrl = relayServerUrl;
    this.deviceId = `pc-${Date.now()}`;
    this.outputChannel = outputChannel;
  }

  private log(message: string, level: "info" | "warn" | "error" = "info") {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] [Relay] ${message}`;
    this.outputChannel.appendLine(logMessage);
    console.log(logMessage);
  }

  private logError(message: string, error?: any) {
    const errorMessage =
      error instanceof Error ? error.message : String(error || "");
    const logMessage = `[Relay] ERROR: ${message}${
      errorMessage ? ` - ${errorMessage}` : ""
    }`;
    this.outputChannel.appendLine(logMessage);
    console.error(logMessage, error);
  }

  /**
   * Set callback for receiving messages from relay server
   */
  setOnMessage(callback: (message: string) => void) {
    this.onMessageCallback = callback;
  }

  /**
   * Set callback for when session is connected (e.g. to update status bar)
   */
  setOnSessionConnected(callback: () => void) {
    this.onSessionConnectedCallback = callback;
  }

  /**
   * Set callback for when multiple sessions are discovered (user picks one).
   * If not set or returns null, first session is used.
   */
  setOnSessionsDiscovered(
    callback: (sessions: { sessionId: string }[]) => Promise<string | null>
  ) {
    this.onSessionsDiscoveredCallback = callback;
  }

  /**
   * Connect to a specific relay session by ID (e.g. when user entered 3ZUESK).
   * If already connected, disconnects from current session then connects to sid.
   * pin: PC가 설정한 PIN (설정 시 서버에 저장되어 모바일은 이 PIN으로 접속)
   */
  async connectToSessionById(sid: string, pin?: string): Promise<void> {
    const trimmed = sid.trim().toUpperCase();
    if (!trimmed) {
      this.logError("connectToSessionById", "session ID is empty");
      return;
    }
    if (this.sessionId && this.isConnected) {
      this.log(`🔌 Disconnecting from session ${this.sessionId}, then connecting to ${trimmed}`);
      this.clearHeartbeat();
      this.sessionId = null;
      this.isConnected = false;
    }
    this.targetPin =
      pin != null && typeof pin === "string" && pin.trim() ? pin.trim() : null;
    await this.connectToSession(trimmed, this.targetPin ?? undefined);
  }

  /**
   * Start relay client with session ID (익스텐션 시작 시 입력·저장한 세션 ID만 연결)
   * pin: PC가 설정한 PIN (설정 시 모바일은 이 PIN을 입력해야만 접속 가능)
   */
  async start(sessionId: string, pin?: string): Promise<void> {
    const sid = sessionId.trim().toUpperCase();
    if (!sid) {
      this.logError("start", "session ID is required");
      return;
    }
    this.targetSessionId = sid;
    this.targetPin =
      pin != null && typeof pin === "string" && pin.trim() ? pin.trim() : null;
    this.pcInUse = false;
    this.log("Starting relay client...");
    this.log(`Relay Server: ${this.relayServerUrl}`);
    this.log(`Device ID: ${this.deviceId}`);
    this.log(`Target session ID: ${this.targetSessionId}`);

    this.startPolling();
    this.log(
      "Relay client started - connecting to session when it becomes available (create/connect from mobile first)."
    );
  }

  /**
   * Stop relay client
   */
  stop(): void {
    this.clearHeartbeat();
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.isConnected = false;
    this.sessionId = null;
    this.pcInUse = false;
    this.log("Relay client stopped");
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /** 서버에 "살아있음" 신호 전송 (2분간 없으면 연결 끊김으로 간주 → 같은 세션 ID 재사용 가능) */
  private async sendHeartbeat(): Promise<void> {
    if (!this.sessionId || !this.isConnected) return;
    const url = `${this.relayServerUrl}/api/heartbeat?sessionId=${encodeURIComponent(this.sessionId)}&deviceId=${encodeURIComponent(this.deviceId)}`;
    try {
      await this.httpRequest(url);
    } catch {
      // 로그만 하고 유지 (다음 heartbeat에서 재시도)
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.HEARTBEAT_INTERVAL_MS);
    this.log(
      `💓 Heartbeat started (every ${this.HEARTBEAT_INTERVAL_MS / 1000}s; disconnect assumed after 2 min with no heartbeat)`
    );
  }

  /**
   * Start polling for messages and session discovery
   */
  private startPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    this.pollInterval = setInterval(() => {
      this.pollMessages().catch((err) => {
        this.logError("pollMessages threw", err);
      });
    }, this.POLL_INTERVAL);
    this.log(
      "⏱️ Poll interval started (every 2s) - waiting for session discovery / messages"
    );
  }

  /**
   * Poll messages from relay server; when no session, try connect to targetSessionId
   */
  private async pollMessages(): Promise<void> {
    // If no session, try to connect to targetSessionId (입력한 세션 ID만 연결)
    if (!this.sessionId) {
      if (this.pcInUse) return;

      if (this.targetSessionId) {
        const now = Date.now();
        if (
          now - this.lastNoSessionHeartbeatTime >=
          this.POLL_HEARTBEAT_INTERVAL
        ) {
          this.lastNoSessionHeartbeatTime = now;
          this.log(
            `⏳ Waiting for session ${this.targetSessionId} (will auto-connect after mobile creates/connects that session)`
          );
        }
        await this.connectToSession(this.targetSessionId, this.targetPin ?? undefined);
        return;
      }

      // targetSessionId 없을 때만 discovery (하위 호환)
      const now = Date.now();
      if (
        now - this.lastNoSessionHeartbeatTime >=
        this.POLL_HEARTBEAT_INTERVAL
      ) {
        this.lastNoSessionHeartbeatTime = now;
        this.log(
          "⏳ No session - poll loop running (enter a session ID or wait for mobile to create a session)"
        );
      }
      const discoveredSessionId = await this.discoverSession();
      if (discoveredSessionId) {
        this.log(
          `🔍 Found session waiting for Extension: ${discoveredSessionId}`
        );
        await this.connectToSession(discoveredSessionId);
        return;
      }
      return;
    }

    // If session exists, poll for messages
    if (!this.sessionId || !this.isConnected) {
      this.log(
        `⚠️ Polling skipped: sessionId=${this.sessionId}, isConnected=${this.isConnected}`
      );
      return;
    }

    try {
      const now = Date.now();
      if (now - this.lastPollHeartbeatTime >= this.POLL_HEARTBEAT_INTERVAL) {
        this.lastPollHeartbeatTime = now;
        this.log(`🔄 Polling sessionId=${this.sessionId} (polling normally)`);
      }

      const pollUrl = `${this.relayServerUrl}/api/poll?sessionId=${
        this.sessionId
      }&deviceType=pc&deviceId=${encodeURIComponent(this.deviceId)}`;
      const data = await this.httpRequest(pollUrl);

      if (!data) {
        this.logError("⚠️ Poll returned null/undefined data");
        return;
      }

      // 응답 형식 허용: data.data.messages 또는 data.messages
      const messages: any[] = Array.isArray(data.data?.messages)
        ? data.data.messages
        : Array.isArray((data as any).messages)
        ? (data as any).messages
        : [];

      if (messages.length > 0) {
        this.log(`📥 Received ${messages.length} message(s) from relay`);
        this.log(
          `📋 Messages: ${JSON.stringify(
            messages.map((m: any) => ({
              id: m.id,
              type: m.type,
              from: m.from,
              hasData: !!m.data,
            }))
          )}`
        );
      }

      for (const msg of messages) {
        this.log(
          `📨 Processing message: id=${msg.id}, type=${msg.type}, from=${msg.from}`
        );
        // Forward message to callback (Extension WebSocket server)
        if (this.onMessageCallback) {
          // 페이로드: msg.data가 있으면 그대로, 없으면 전체 msg (하위 호환)
          // 0.3.3 동작: 유니캐스트 없이 브로드캐스트만 사용
          const payload =
            msg.data !== undefined && msg.data !== null ? msg.data : msg;
          const messageStr =
            typeof payload === "string" ? payload : JSON.stringify(payload);
          this.log(
            `📤 Calling onMessageCallback with: ${messageStr.substring(0, 200)}`
          );
          this.onMessageCallback(messageStr);
          this.log(`✅ onMessageCallback completed`);
        } else {
          this.logError(
            "⚠️ onMessageCallback is null - cannot forward message"
          );
        }
      }

      if (!data.success) {
        this.logError(`Poll failed: ${data.error}`);
      } else if (messages.length === 0 && data.success) {
        // No messages - this is normal, don't log
      }
    } catch (error) {
      this.logError("Polling error", error);
      if (error instanceof Error) {
        this.logError(`   Error message: ${error.message}`);
        this.logError(`   Error stack: ${error.stack}`);
      }
    }
  }

  /**
   * Discover sessions waiting for Extension (this client) to connect
   */
  private async discoverSession(): Promise<string | null> {
    if (this.sessionId) {
      return null; // Already connected to a session
    }

    // Rate limiting
    const now = Date.now();
    if (now - this.lastSessionDiscoveryTime < this.SESSION_DISCOVERY_INTERVAL) {
      return null;
    }
    this.lastSessionDiscoveryTime = now;

    try {
      const discoveryUrl = `${this.relayServerUrl}/api/sessions-with-mobile`;
      this.log(`🔍 Discovery: GET ${discoveryUrl}`);
      const data = await this.httpRequest(discoveryUrl);

      if (!data) {
        this.log("🔍 Discovery: API returned no data");
        return null;
      }
      if (!data.success) {
        this.log(
          `🔍 Discovery: API error - ${(data as any).error ?? "unknown"}`
        );
        return null;
      }
      const sessions = data.data?.sessions ?? [];
      const sessionsCount = Array.isArray(sessions) ? sessions.length : 0;
      this.log(
        `🔍 Discovery: server response success=true, sessionsCount=${sessionsCount} (sessions with mobile connected)`
      );
      if (sessionsCount === 0) {
        this.log(
          "🔍 Discovery: no sessions with mobile connected (create a session on mobile, then connect)"
        );
        this.log(
          "💡 If another Cursor window is open, that extension may have claimed the session first. Close other windows and try again with a new session."
        );
        const debugUrl = `${this.relayServerUrl}/api/debug-sessions`;
        this.log(
          `🔧 Check server status: GET ${debugUrl} (or run "Cursor Remote: Check Relay Server Status" from the Command Palette)`
        );
        return null;
      }
      let chosenSessionId: string | null = null;
      if (sessionsCount > 1 && this.onSessionsDiscoveredCallback) {
        this.log(
          `🔍 Discovery: found ${sessionsCount} sessions → waiting for user selection`
        );
        chosenSessionId = await this.onSessionsDiscoveredCallback(sessions);
        if (chosenSessionId === null || chosenSessionId === undefined) {
          this.log(
            "🔍 Discovery: no session selected (will prompt again on next discovery)"
          );
          return null;
        }
      }
      const foundSession = chosenSessionId
        ? sessions.find(
            (s: { sessionId: string }) => s.sessionId === chosenSessionId
          ) ?? sessions[0]
        : sessions[0];
      if (foundSession?.sessionId) {
        this.log(`🔍 Discovery: found session → ${foundSession.sessionId}`);
        return foundSession.sessionId;
      }
      this.log("🔍 Discovery: session has no sessionId");
      return null;
    } catch (error) {
      this.logError("Discovery failed", error);
      return null;
    }
  }

  /**
   * Connect to a relay session (404/409 구분을 위해 statusCode 사용)
   * pin: PC가 설정하면 모바일은 이 PIN을 알아야만 접속 가능 (세션 ID만으로 타인 접속 방지)
   */
  private async connectToSession(sid: string, pin?: string): Promise<void> {
    this.log(`🔗 Connecting to session ${sid}...`);

    try {
      const body: Record<string, string> = {
        sessionId: sid,
        deviceId: this.deviceId,
        deviceType: "pc",
      };
      if (pin != null && pin.trim()) {
        body.pin = pin.trim();
      }
      const result = await this.httpRequestWithStatus(
        `${this.relayServerUrl}/api/connect`,
        "POST",
        body
      );

      if (result.statusCode === 409) {
        this.pcInUse = true;
        const msg =
          (result.body as any)?.error ?? "Session already in use by another PC";
        this.logError(
          "Session ID already in use (another PC is connected)",
          msg
        );
        this.log(
          "💡 Close the other PC window, or create a new session on mobile and enter that session ID."
        );
        return;
      }

      if (result.statusCode === 404) {
        this.log(
          "Session not found. Create and connect the session on mobile first, then connect with the same session ID."
        );
        return;
      }

      if (
        result.statusCode >= 200 &&
        result.statusCode < 300 &&
        result.body?.success
      ) {
        this.sessionId = sid;
        this.isConnected = true;
        this.startHeartbeat();
        this.log(
          `✅ Extension connected to session ${this.sessionId} via the relay server.`
        );
        this.log(`💡 Connect from mobile using session ID ${this.sessionId}.`);
        if (this.onSessionConnectedCallback) {
          this.onSessionConnectedCallback();
        }
      } else {
        const errMsg =
          (result.body as any)?.error ??
          (typeof result.body === "object" && result.body !== null
            ? JSON.stringify(result.body)
            : String(result.statusCode));
        this.logError(`Failed to connect: ${errMsg}`);
        if (result.statusCode >= 500 && result.body) {
          this.logError(
            `[Relay] Server 500 response: ${JSON.stringify(result.body)}`
          );
        }
      }
    } catch (error) {
      this.logError("Error connecting to session", error);
    }
  }

  /**
   * Send message to relay server
   */
  async sendMessage(message: string): Promise<void> {
    if (!this.sessionId || !this.isConnected) {
      this.logError("Cannot send message: not connected to session");
      return;
    }

    try {
      const parsed = JSON.parse(message);
      if (parsed.type === "chat_response") {
        this.log(
          `Sending chat_response to relay (text length: ${
            (parsed.text || "").length
          })`
        );
      }
      const data = await this.httpRequest(
        `${this.relayServerUrl}/api/send`,
        "POST",
        {
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          deviceType: "pc",
          type: parsed.type || "message",
          data: parsed,
        }
      );

      if (!data) {
        this.logError("Relay /api/send returned no data");
        return;
      }
      if (data.success) {
        this.log("✅ Message sent to relay");
      } else {
        this.logError(`Failed to send to relay: ${data.error}`);
      }
    } catch (error) {
      this.logError("Error sending to relay", error);
    }
  }

  /**
   * Get current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Check if connected to relay session
   */
  isConnectedToSession(): boolean {
    return this.isConnected && this.sessionId !== null;
  }

  /**
   * 릴레이 서버 상태 확인 (디버그 API 호출)
   * Output 채널에 totalSessions, waitingForPc, hint 출력
   */
  async checkServerStatus(): Promise<void> {
    const debugUrl = `${this.relayServerUrl}/api/debug-sessions`;
    this.log(`🔧 Checking relay server: GET ${debugUrl}`);
    try {
      const data = await this.httpRequest(debugUrl);
      if (!data) {
        this.log("🔧 No response from server (check network or CORS)");
        return;
      }
      if (!data.success) {
        this.log(`🔧 API error: ${(data as any).error ?? "unknown"}`);
        return;
      }
      const d = data.data as
        | {
            totalSessions?: number;
            waitingForPc?: number;
            sessionsWithPc?: number;
            hint?: string;
          }
        | undefined;
      if (!d) {
        this.log("🔧 Response has no data");
        return;
      }
      this.log(
        `🔧 totalSessions=${d.totalSessions ?? "?"}, waitingForPc=${
          d.waitingForPc ?? "?"
        }, sessionsWithPc=${d.sessionsWithPc ?? "?"}`
      );
      if (d.hint) {
        this.log(`🔧 hint: ${d.hint}`);
      }
    } catch (error) {
      this.logError("checkServerStatus failed", error);
    }
  }

  /**
   * HTTP request that returns statusCode + body (connect API 404/409 구분용)
   */
  private async httpRequestWithStatus(
    url: string,
    method: "GET" | "POST" = "GET",
    body?: any
  ): Promise<{ statusCode: number; body: any }> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === "https:";
      const httpModule = isHttps ? https : http;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: method,
        headers: {
          "Content-Type": "application/json",
        },
      };

      const req = httpModule.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          const statusCode = res.statusCode ?? 0;
          let parsed: any = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = null;
          }
          // 5xx인데 JSON이 아니면 원문 일부를 남겨 로그로 확인 가능하게
          if (statusCode >= 500 && !parsed && data) {
            parsed = {
              error: data.length > 800 ? data.substring(0, 800) + "…" : data,
            };
          }
          resolve({ statusCode, body: parsed });
        });
      });

      req.on("error", (error) => {
        this.logError("Request error", error);
        resolve({ statusCode: 0, body: null });
      });

      if (body && method === "POST") {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * HTTP request helper (using Node.js http/https modules)
   */
  private async httpRequest(
    url: string,
    method: "GET" | "POST" = "GET",
    body?: any
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === "https:";
      const httpModule = isHttps ? https : http;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: method,
        headers: {
          "Content-Type": "application/json",
        },
      };

      const req = httpModule.request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed);
            } catch (error) {
              this.logError("Failed to parse response", error);
              resolve(null);
            }
          } else {
            this.logError(`HTTP ${res.statusCode}: ${data}`);
            resolve(null);
          }
        });
      });

      req.on("error", (error) => {
        this.logError("Request error", error);
        resolve(null);
      });

      if (body && method === "POST") {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }
}
