/**
 * Relay Server Client for Cursor Remote Extension
 * Handles communication with the relay server for remote mobile client connections
 */

import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";
import { URL } from "url";
import * as os from "os";
import * as path from "path";
import { randomInt, randomUUID } from "crypto";

const SESSION_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Six characters, as typed on the phone; ambiguous letters and digits are left out. */
export function newRelaySessionId(): string {
  let id = "";
  for (let i = 0; i < 6; i++) id += SESSION_ID_ALPHABET[randomInt(SESSION_ID_ALPHABET.length)];
  return id;
}

/** One Cursor window polls the relay; a second poller would take the phone's commands from the first. */
export const RELAY_LOCK_PATH = path.join(os.tmpdir(), "cursor-remote-relay.lock");

export type ResumeOutcome = "no-session" | "no-credential" | "locked" | "connected" | "failed";

/** Reconnects to the last relay session after a restart, only with a saved login and only in the window that holds the lock. */
export async function resumeSavedRelaySession(
  client: Pick<RelayClient, "hasCredential" | "connectToSessionById" | "isConnectedToSession">,
  savedSid: string | undefined,
  claimLock: () => boolean
): Promise<ResumeOutcome> {
  const sid = savedSid?.trim().toUpperCase();
  if (!sid) return "no-session";
  if (!(await client.hasCredential(sid))) return "no-credential";
  if (!claimLock()) return "locked";
  await client.connectToSessionById(sid);
  return client.isConnectedToSession() ? "connected" : "failed";
}

export interface RelayMessage {
  type: string;
  data?: any;
  to?: "mobile" | "pc";
  from?: "mobile" | "pc";
  timestamp?: number;
}

export interface PairingCode {
  code: string;
  /** False when single use, also when an older relay ignored the request for a reusable code. */
  reusable: boolean;
  expiresAt: number;
  usesLeft?: number;
}

export interface DevicePaired {
  sessionId: string;
  deviceId: string;
  reusable: boolean;
  usesLeft: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How long a pairing code lasts and how often it can be used, for the pairing dialog title. */
export function pairingCodeTerms(pairing: PairingCode, requestedReusable: boolean, now = Date.now()): string {
  if (!pairing.reusable) {
    const minutes = Math.max(1, Math.round((pairing.expiresAt - now) / 60_000));
    return `single use, expires in ${plural(minutes, "minute")}${requestedReusable ? "; this relay does not offer reusable codes yet" : ""}`;
  }
  const minutes = Math.max(1, Math.floor((pairing.expiresAt - now) / 60_000));
  const valid = minutes >= 60 ? `${plural(Math.floor(minutes / 60), "hour")} ${plural(minutes % 60, "minute")}` : plural(minutes, "minute");
  return `reusable: ${plural(pairing.usesLeft ?? 0, "use")} left, valid for ${valid}`;
}

export function devicePairedMessage(event: DevicePaired): string {
  return event.reusable
    ? `Cursor Remote: a new device joined relay session ${event.sessionId} (${plural(event.usesLeft, "pairing use")} left).`
    : `Cursor Remote: a new device joined relay session ${event.sessionId}.`;
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
  private onSessionExpiredCallback: ((expired: string, next: string) => void) | null = null;
  private onRejectedCallback: ((sid: string, statusCode: number) => void) | null = null;
  private onTargetGoneCallback: ((clientId: string) => void) | null = null;
  private onDevicePairedCallback: ((event: DevicePaired) => void) | null = null;
  private connectInFlight: Promise<void> | null = null;
  /** 익스텐션 시작 시 사용자가 입력한 세션 ID (이 세션만 연결 시도) */
  private targetSessionId: string | null = null;
  /** PC가 설정한 PIN (모바일은 이 PIN을 알아야 접속 가능, 메모리에만 보관) */
  private targetPin: string | null = null;
  /** 409 PC_IN_USE 시 재시도 안 함 */
  private pcInUse: boolean = false;
  private capabilityToken: string | null = null;
  private connecting = false;
  private connectAttempts = 0;
  private nextConnectAt = 0;
  /** Bumped on every (re)start and stop so only the newest poll loop reschedules itself. */
  private pollGeneration = 0;
  private lastActivityAt = 0;
  private lastPollHeartbeatTime: number = 0;
  private lastNoSessionHeartbeatTime: number = 0; // 세션 없을 때 폴링 동작 확인용
  private readonly POLL_INTERVAL = 2000; // 2초마다 폴링 (while the phone is active)
  /** Each relay poll costs several Redis commands, so poll slowly once the phone goes quiet. */
  private readonly IDLE_POLL_INTERVAL = 25_000;
  private readonly ACTIVE_WINDOW_MS = 3 * 60 * 1000;
  private readonly POLL_HEARTBEAT_INTERVAL = 30000; // 30초마다 폴링 동작 로그

  constructor(relayServerUrl: string, outputChannel: vscode.OutputChannel, private secrets?: vscode.SecretStorage) {
    this.relayServerUrl = relayServerUrl;
    this.deviceId = `pc-${randomUUID()}`;
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

  /** Called when a saved relay login expired and a new session ID replaced it. */
  setOnSessionExpired(callback: (expired: string, next: string) => void) {
    this.onSessionExpiredCallback = callback;
  }

  /** Called when the relay refused this Mac for good; polling has stopped until a new session is started. */
  setOnRejected(callback: (sid: string, statusCode: number) => void) {
    this.onRejectedCallback = callback;
  }

  /** Called with the client ID of a phone the relay no longer delivers to (it left the session). */
  setOnTargetGone(callback: (clientId: string) => void) {
    this.onTargetGoneCallback = callback;
  }

  /** Called whenever the relay enrolled a new device into this Mac's session. */
  setOnDevicePaired(callback: (event: DevicePaired) => void) {
    this.onDevicePairedCallback = callback;
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
      this.sessionId = null;
      this.isConnected = false;
    }
    // A connect still running for the old loop must not finish after (and over) this one.
    this.haltPolling();
    await this.connectInFlight;
    const generation = this.pollGeneration;
    this.pcInUse = false;
    this.connectAttempts = 0;
    this.nextConnectAt = 0;
    this.targetPin =
      pin != null && typeof pin === "string" && pin.trim() ? pin.trim() : null;
    this.targetSessionId = trimmed;
    await this.connectToSession(trimmed, this.targetPin ?? undefined);
    if (generation !== this.pollGeneration) return;
    // An expired session was just replaced by a new ID: connect to that now so pairing can continue.
    const replacement = this.targetSessionId;
    if (!this.isConnected && !this.pcInUse && replacement && replacement !== trimmed) {
      await this.connectToSession(replacement, this.targetPin ?? undefined);
    }
    if (!this.pcInUse && !this.pollInterval) this.startPolling();
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
    this.connectAttempts = 0;
    this.nextConnectAt = 0;
    this.sessionId = null;
    this.isConnected = false;
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
    this.haltPolling();
    this.isConnected = false;
    this.sessionId = null;
    this.pcInUse = false;
    this.log("Relay client stopped");
  }

  /** Ends the current poll loop; anything still running for it sees a newer generation and gives up. */
  private haltPolling(): void {
    this.pollGeneration++;
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Start polling for messages
   */
  private startPolling(): void {
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
    }
    const generation = ++this.pollGeneration;
    this.lastActivityAt = Date.now();
    // One request at a time: the next poll is scheduled only after the previous one finishes.
    const schedule = () => {
      this.pollInterval = setTimeout(() => {
        this.pollMessages()
          .catch((err) => this.logError("pollMessages threw", err))
          .finally(() => { if (generation === this.pollGeneration) schedule(); });
      }, this.nextPollDelay());
    };
    schedule();
    this.log(
      "⏱️ Polling started (every 2s while the phone is active, every 25s when idle)"
    );
  }

  /** Fast for a few minutes after the last phone message, then slow. */
  nextPollDelay(now: number = Date.now()): number {
    return now - this.lastActivityAt < this.ACTIVE_WINDOW_MS ? this.POLL_INTERVAL : this.IDLE_POLL_INTERVAL;
  }

  /**
   * Poll messages from relay server; when no session, try connect to targetSessionId
   */
  private async pollMessages(): Promise<void> {
    // If no session, try to connect to targetSessionId (입력한 세션 ID만 연결)
    if (!this.sessionId) {
      if (this.pcInUse || !this.targetSessionId) return;

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

    // A failed request drops isConnected; re-authenticate with the saved credential (with backoff).
    if (!this.isConnected) {
      await this.connectToSession(this.sessionId);
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
        this.lastActivityAt = Date.now();
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
        // Phones can't send as "relay": /api/send stamps their role into `from`.
        if (msg?.type === "device_paired" && msg.from === "relay") {
          try { await this.devicePaired(msg.data); }
          catch { this.logError(`Relay notice ${msg.id} dropped`); }
          continue;
        }
        // Forward message to callback (Extension WebSocket server)
        if (this.onMessageCallback) {
          try {
            // 페이로드: msg.data가 있으면 그대로, 없으면 전체 msg (하위 호환)
            const rawPayload = msg.data !== undefined && msg.data !== null ? msg.data : msg;
            const payload = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
            if (!Number.isSafeInteger(payload.deadline) || payload.deadline <= Date.now()) {
              this.logError("Expired or unversioned relay command rejected");
              continue;
            }
            payload.clientId = `relay:${this.sessionId}:${msg.senderDeviceId || "unknown"}`;
            payload.senderDeviceId = msg.senderDeviceId;
            payload.source = "relay";
            this.onMessageCallback(JSON.stringify(payload));
            this.log(`✅ onMessageCallback completed`);
          } catch {
            // The error text can quote the payload, so only the ID is logged.
            this.logError(`Relay message ${msg.id} dropped (malformed or failed to dispatch)`);
          }
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
   * Connect to a relay session (404/409 구분을 위해 statusCode 사용)
   * pin: PC가 설정하면 모바일은 이 PIN을 알아야만 접속 가능 (세션 ID만으로 타인 접속 방지)
   */
  private credentialKey(sid: string): string {
    return `cursorRemote.relay.v2:${this.relayServerUrl}:${sid}`;
  }

  /**
   * Drops the current session (revoking it on the relay so paired phones lose access) and
   * connects to a brand-new one. Returns the new session ID, or null if it could not connect.
   */
  async startNewSession(): Promise<string | null> {
    const previous = this.sessionId ?? this.targetSessionId;
    if (previous) await this.secrets?.delete(this.pairingCodeKey(previous));
    if (this.isConnected) {
      try { await this.disconnectSession(); } catch { /* already revoked or expired */ }
    }
    this.stop();
    this.capabilityToken = null;
    await this.connectToSessionById(newRelaySessionId());
    return this.isConnectedToSession() ? this.sessionId : null;
  }

  /** Whether this Mac holds a login for `sid`, so it can reconnect without creating a session. */
  async hasCredential(sid: string): Promise<boolean> {
    return !!(await this.secrets?.get(this.credentialKey(sid.trim().toUpperCase())));
  }

  async createMobilePairingCode(): Promise<string> {
    return (await this.getPairingCode(false)).code;
  }

  private pairingCodeKey(sid: string): string {
    return `cursorRemote.relay.v2.pairing:${this.relayServerUrl}:${sid}`;
  }

  private async savedPairingCode(sid: string): Promise<PairingCode | null> {
    const raw = await this.secrets?.get(this.pairingCodeKey(sid));
    if (!raw) return null;
    try {
      const saved = JSON.parse(raw) as PairingCode;
      if (typeof saved.code === "string" && saved.reusable && saved.expiresAt > Date.now() && (saved.usesLeft ?? 0) > 0) return saved;
    } catch { /* replaced below */ }
    await this.secrets?.delete(this.pairingCodeKey(sid));
    return null;
  }

  /**
   * With [reusable], the session's current reusable code is shown again while it is valid; a new one
   * (which invalidates the old) is minted only when it is gone, expired or used up.
   */
  async getPairingCode(reusable: boolean): Promise<PairingCode> {
    if (!this.isConnected || !this.sessionId) throw new Error("Connect the extension to a relay session first");
    const sid = this.sessionId;
    if (reusable) {
      const saved = await this.savedPairingCode(sid);
      if (saved) return saved;
    }
    const result = await this.httpRequestWithStatus(`${this.relayServerUrl}/api/pair`, "POST",
      { sessionId: sid, ...(reusable ? { reusable: true } : {}) });
    const data = result.body?.data;
    if (result.statusCode !== 200 || typeof data?.pairingCode !== "string") throw new Error("Unable to create relay pairing code");
    const seconds = Number.isFinite(data.expiresInSeconds) && data.expiresInSeconds > 0 ? data.expiresInSeconds : 300;
    const code: PairingCode = { code: data.pairingCode, reusable: reusable && data.reusable === true, expiresAt: Date.now() + seconds * 1000 };
    if (code.reusable) {
      code.usesLeft = Number.isSafeInteger(data.usesLeft) ? data.usesLeft : 0;
      await this.secrets?.store(this.pairingCodeKey(sid), JSON.stringify(code));
    }
    return code;
  }

  private async devicePaired(data: any): Promise<void> {
    const sid = this.sessionId;
    if (!sid || !data || typeof data.deviceId !== "string") return;
    const usesLeft = Number.isSafeInteger(data.usesLeft) ? data.usesLeft : 0;
    const reusable = data.reusable === true;
    if (reusable) {
      const saved = await this.savedPairingCode(sid);
      if (saved && usesLeft > 0) {
        await this.secrets?.store(this.pairingCodeKey(sid), JSON.stringify({ ...saved, usesLeft: Math.min(usesLeft, saved.usesLeft ?? usesLeft) }));
      } else if (saved) await this.secrets?.delete(this.pairingCodeKey(sid));
    }
    this.log(`A new device joined relay session ${sid}${reusable ? ` (${usesLeft} pairing uses left)` : ""}`);
    this.onDevicePairedCallback?.({ sessionId: sid, deviceId: data.deviceId, reusable, usesLeft });
  }

  async disconnectSession(): Promise<void> {
    if (!this.sessionId || !this.capabilityToken) return;
    const sid = this.sessionId;
    await this.secrets?.delete(this.pairingCodeKey(sid));
    const result = await this.httpRequestWithStatus(`${this.relayServerUrl}/api/disconnect`, "POST", { sessionId: sid });
    if (result.statusCode !== 200) throw new Error("Relay disconnect failed; credentials may already be revoked");
    await this.secrets?.delete(this.credentialKey(sid));
    this.capabilityToken = null;
    this.stop();
  }

  private connectToSession(sid: string, _pin?: string): Promise<void> {
    if (this.connecting || this.pcInUse || Date.now() < this.nextConnectAt) return Promise.resolve();
    this.connecting = true;
    const attempt = this.connectNow(sid, this.pollGeneration).finally(() => {
      this.connecting = false;
      if (this.connectInFlight === attempt) this.connectInFlight = null;
    });
    this.connectInFlight = attempt;
    return attempt;
  }

  /** Gives up without touching any state once [generation] is stale (stop or a newer connect). */
  private async connectNow(sid: string, generation: number): Promise<void> {
    const stale = () => generation !== this.pollGeneration;
    // Temporary failures retry with backoff (4s … 60s); explicit rejections below stop for good.
    const retryLater = () => {
      this.connectAttempts++;
      this.nextConnectAt = Date.now() + Math.min(60_000, 2_000 * 2 ** this.connectAttempts);
    };
    try {
      this.capabilityToken = null;
      const saved = await this.secrets?.get(this.credentialKey(sid));
      if (stale()) return;
      if (saved) {
        const credential = JSON.parse(saved);
        this.capabilityToken = credential.token;
        this.deviceId = credential.deviceId;
      }
      const endpoint = this.capabilityToken ? "connect" : "session";
      const result = await this.httpRequestWithStatus(`${this.relayServerUrl}/api/${endpoint}`, "POST", {
        sessionId: sid, deviceId: this.deviceId, deviceType: "pc",
      });
      if (stale()) return;
      const data = result.body?.data;
      if (![200, 201].includes(result.statusCode) || !result.body?.success || result.body.protocolVersion !== 2) {
        this.isConnected = false;
        if (result.statusCode === 0) {
          retryLater();
          this.logError(`Could not reach the relay server ${this.relayServerUrl} (network, proxy or certificate problem); retrying.`);
          return;
        }
        // Relay logins last 24 hours, and a session ID that was ever used can never be claimed
        // again (no takeovers). Either way, start a fresh session that the phone pairs with.
        const expired = endpoint === "connect" && result.statusCode === 401;
        const taken = endpoint === "session" && result.statusCode === 409;
        if (expired || taken) {
          if (expired) {
            await this.secrets?.delete(this.credentialKey(sid));
            await this.secrets?.delete(this.pairingCodeKey(sid));
          }
          if (stale()) return;
          this.capabilityToken = null;
          const next = newRelaySessionId();
          this.targetSessionId = next;
          this.log(expired
            ? `Relay session ${sid} expired (sessions last 24 hours). Starting new session ${next}; pair the phone again.`
            : `Relay session ID ${sid} is already taken. Starting new session ${next} instead; use that ID on the phone.`);
          this.onSessionExpiredCallback?.(sid, next);
          return;
        }
        this.logError(`Relay connection rejected (HTTP ${result.statusCode}). Existing or legacy sessions require their saved credential or a new session ID.`);
        if ([400, 401, 403, 409].includes(result.statusCode)) {
          this.pcInUse = true;
          this.haltPolling();
          this.onRejectedCallback?.(sid, result.statusCode);
        } else retryLater();
        return;
      }
      if (typeof data?.token === "string") this.capabilityToken = data.token;
      if (!this.capabilityToken) throw new Error("Relay did not provide a v2 credential");
      await this.secrets?.store(this.credentialKey(sid), JSON.stringify({ token: this.capabilityToken, deviceId: this.deviceId }));
      if (stale()) return;
      const reconnected = this.sessionId === sid;
      this.sessionId = sid;
      this.isConnected = true;
      this.connectAttempts = 0;
      this.nextConnectAt = 0;
      if (reconnected) {
        this.log(`Relay session ${sid} reconnected.`);
      } else {
        this.log(`Authenticated relay session ${sid}. Use Cursor Remote: Pair Relay Client for mobile access.`);
        this.onSessionConnectedCallback?.();
      }
    } catch {
      if (stale()) return;
      this.isConnected = false;
      retryLater();
      this.logError("Relay connection failed");
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
      const body = {
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        deviceType: "pc",
        type: parsed.type || "message",
        data: parsed,
      };
      const result = await this.httpRequestWithStatus(`${this.relayServerUrl}/api/send`, "POST", body);
      if (result.statusCode === 403 && result.body?.errorCode === "TARGET_MEMBERSHIP_REQUIRED" &&
          typeof parsed.clientId === "string") {
        this.log("A phone left the relay session; dropping its chat watches");
        this.onTargetGoneCallback?.(parsed.clientId);
        return;
      }
      if (result.statusCode === 401) this.isConnected = false;
      const data = result.statusCode >= 200 && result.statusCode < 300 ? result.body : null;
      if (!data) {
        this.logError(`Relay /api/send failed (HTTP ${result.statusCode})`);
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
      if (!isHttps && !["localhost", "127.0.0.1", "[::1]"].includes(urlObj.hostname)) {
        resolve({ statusCode: 0, body: null }); return;
      }
      const httpModule = isHttps ? https : http;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: method,
        headers: {
          "Content-Type": "application/json",
          ...(this.capabilityToken ? { Authorization: `Bearer ${this.capabilityToken}` } : {}),
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

      req.setTimeout(15_000, () => req.destroy(new Error("Relay request timeout")));
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
  private async httpRequest(url: string, method: "GET" | "POST" = "GET", body?: any): Promise<any> {
    const result = await this.httpRequestWithStatus(url, method, body);
    if (result.statusCode >= 200 && result.statusCode < 300) return result.body;
    // Only a refused login needs a new one; anything else is retried by the next poll as is.
    if (result.statusCode === 401) {
      this.isConnected = false;
      this.logError("Relay login refused (HTTP 401); reconnecting");
    } else {
      this.logError(`Relay request failed (HTTP ${result.statusCode})`);
    }
    return null;
  }
}
