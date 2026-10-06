import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import WebSocket from "ws";

const digest = (value: string) => createHash("sha256").update(value).digest();
const matches = (value: unknown, verifier: Buffer) =>
  typeof value === "string" && value.length <= 256 && timingSafeEqual(digest(value), verifier);

/** In-memory credentials intentionally expire on extension restart. */
export class WsAuth {
  private pairing?: { verifier: Buffer; expiresAt: number };
  private credentials = new Map<string, { verifier: Buffer; expiresAt: number; clientId: string }>();
  private connections = new Set<WebSocket>();
  private attempts = 0;
  private windowStart = 0;
  private commandRecords = new Map<string, Set<string>>();
  private commandCount = 0;
  private commandWindow = 0;
  private principalRates = new Map<string, { start: number; count: number }>();

  constructor(private now = Date.now) {}

  beginPairing(): string {
    const secret = randomBytes(32).toString("base64url");
    this.pairing = { verifier: digest(secret), expiresAt: this.now() + 300_000 };
    return secret;
  }

  isPairingPending(): boolean {
    return !!this.pairing && this.pairing.expiresAt > this.now();
  }

  revokeAll(): void {
    this.pairing = undefined;
    this.credentials.clear();
    this.commandRecords.clear();
    this.principalRates.clear();
    for (const ws of this.connections) ws.close(4001, "Credentials revoked");
    this.connections.clear();
  }

  originAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
    // Native clients have no Origin; they still require credentials.
    return origin === undefined || (origin !== "null" && allowedOrigins.includes(origin));
  }

  authenticate(message: any): { token?: string; expiresAt: number; clientId: string } | null {
    const now = this.now();
    if (now - this.windowStart >= 60_000) { this.windowStart = now; this.attempts = 0; }
    if (++this.attempts > 60 || message?.protocolVersion !== 2) return null;
    for (const [id, credential] of this.credentials) {
      if (credential.expiresAt <= now) {
        this.credentials.delete(id);
        this.commandRecords.delete(credential.clientId);
        this.principalRates.delete(credential.clientId);
      }
    }
    if (message.type === "pair" && this.pairing && this.pairing.expiresAt > now &&
        matches(message.secret, this.pairing.verifier) && this.credentials.size < 256) {
      const token = randomBytes(32).toString("base64url");
      const credential = { verifier: digest(token), expiresAt: now + 86_400_000, clientId: randomUUID() };
      this.credentials.set(digest(token).toString("hex"), credential);
      this.pairing = undefined; // Single-use pairing window.
      return { token, expiresAt: credential.expiresAt, clientId: credential.clientId };
    }
    if (message.type === "authenticate" && typeof message.token === "string" && message.token.length <= 256) {
      const credential = this.credentials.get(digest(message.token).toString("hex"));
      if (credential && matches(message.token, credential.verifier)) {
        return { expiresAt: credential.expiresAt, clientId: credential.clientId };
      }
    }
    return null;
  }

  attach(ws: WebSocket, onAuthenticated: (clientId: string) => void,
         onCommand: (message: Record<string, unknown>) => void): void {
    if (this.connections.size >= 256) { ws.close(4008, "Connection capacity exceeded"); return; }
    this.connections.add(ws);
    let authenticated = false;
    let principal = "";
    let expiresAt = 0;
    let count = 0;
    let start = this.now();
    let expiryTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => ws.close(4001, "Authentication timeout"), 120_000);
    timer.unref();
    ws.once("close", () => { clearTimeout(timer); clearTimeout(expiryTimer); this.connections.delete(ws); });
    ws.send(JSON.stringify({ type: "auth_required", protocolVersion: 2 }));
    ws.on("message", (raw, binary) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      let message: any;
      try { message = JSON.parse(raw.toString()); } catch { ws.close(4002, "Invalid JSON"); return; }
      if (binary || !message || typeof message !== "object" || Array.isArray(message)) {
        ws.close(4002, "Invalid message"); return;
      }
      if (!authenticated) {
        const credential = this.authenticate(message);
        if (!credential) { ws.close(4001, "Authentication failed"); return; }
        authenticated = true;
        principal = credential.clientId;
        expiresAt = credential.expiresAt;
        expiryTimer = setTimeout(() => ws.close(4001, "Credential expired"), expiresAt - this.now());
        expiryTimer.unref();
        clearTimeout(timer);
        ws.send(JSON.stringify({ type: "authenticated", protocolVersion: 2, scope: "control", ...credential }));
        onAuthenticated(credential.clientId);
        return;
      }
      if (this.now() >= expiresAt) { ws.close(4001, "Credential expired"); return; }
      if (this.now() - start >= 60_000) { start = this.now(); count = 0; }
      if (++count > 120) { ws.close(4008, "Rate limit exceeded"); return; }
      const rate = this.principalRates.get(principal) || { start: this.now(), count: 0 };
      if (this.now() - rate.start >= 60_000) { rate.start = this.now(); rate.count = 0; }
      this.principalRates.set(principal, rate);
      if (++rate.count > 120) { ws.close(4008, "Principal rate limit exceeded"); return; }
      if (this.now() - this.commandWindow >= 60_000) { this.commandWindow = this.now(); this.commandCount = 0; }
      if (++this.commandCount > 600) { ws.close(4008, "Global rate limit exceeded"); return; }
      const reject = (status: string) => ws.send(JSON.stringify({
        type: "command_result", id: typeof message.id === "string" ? message.id : undefined,
        success: false, status, error: status,
      }));
      if (typeof message.id !== "string" || !message.id || message.id.length > 128 ||
          !Number.isSafeInteger(message.deadline) || message.deadline <= this.now() ||
          message.deadline > this.now() + 300_000) {
        reject("invalid_or_expired_command"); return;
      }
      const seen = this.commandRecords.get(principal) || new Set<string>();
      if (seen.has(message.id)) { reject("duplicate"); return; }
      // Retain IDs for the credential lifetime, including across reconnects.
      if (seen.size >= 4096) { reject("command_capacity_exceeded_repair_required"); return; }
      seen.add(message.id);
      this.commandRecords.set(principal, seen);
      onCommand(message);
    });
  }
}
