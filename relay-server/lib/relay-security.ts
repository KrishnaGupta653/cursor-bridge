import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SecurityStore } from "./security-store.js";

export class SecurityError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export interface Principal {
  sessionId: string; deviceId: string; role: "pc" | "mobile";
  epoch: string; expiresAt: number; verifier: string;
}
interface SessionSecurity { epoch: string; expiresAt: number }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const validSessionId = (value: unknown): value is string => typeof value === "string" && /^[A-Z0-9]{6,32}$/.test(value);
export const validDeviceId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
export const newSessionId = () => randomBytes(9).toString("hex").toUpperCase();

/** Opaque capabilities are verified by a shared store, not process-local state. */
export class RelaySecurity {
  constructor(readonly store: SecurityStore, private now = Date.now) {}
  async limit(key: string, limit: number): Promise<void> {
    const bucket = Math.floor(this.now() / 60_000);
    if (await this.store.increment(`rate:${hash(key)}:${bucket}`, 120) > limit) {
      throw new SecurityError(429, "RATE_LIMITED");
    }
  }
  async reserve(sessionId: string): Promise<SessionSecurity> {
    const state = { epoch: randomUUID(), expiresAt: this.now() + 86_400_000 };
    if (!await this.store.put(`session:${sessionId}`, state, 86400)) throw new SecurityError(409, "SESSION_ALREADY_OWNED");
    return state;
  }
  async state(sessionId: string): Promise<SessionSecurity> {
    const state = await this.store.get<SessionSecurity>(`session:${sessionId}`);
    if (!state || state.expiresAt <= this.now()) throw new SecurityError(401, "CREDENTIAL_INVALID_OR_EXPIRED");
    return state;
  }
  async issue(sessionId: string, deviceId: string, role: Principal["role"]): Promise<{ token: string; principal: Principal }> {
    const state = await this.state(sessionId);
    const token = randomBytes(32).toString("base64url");
    const principal = { ...state, sessionId, deviceId, role, verifier: hash(token) };
    if (!await this.store.put(`token:${principal.verifier}`, principal, Math.max(1, Math.ceil((state.expiresAt - this.now()) / 1000)))) {
      throw new SecurityError(503, "CREDENTIAL_ISSUANCE_FAILED");
    }
    return { token, principal };
  }
  async authenticate(token: unknown): Promise<Principal> {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new SecurityError(401, "CREDENTIAL_REQUIRED");
    await this.limit("authentication-attempts-global", 3600);
    const verifier = hash(token);
    const principal = await this.store.get<Principal>(`token:${verifier}`);
    if (!principal || principal.expiresAt <= this.now() ||
        typeof principal.verifier !== "string" || principal.verifier.length !== 64 ||
        !timingSafeEqual(Buffer.from(verifier), Buffer.from(principal.verifier))) {
      throw new SecurityError(401, "CREDENTIAL_INVALID_OR_EXPIRED");
    }
    const state = await this.state(principal.sessionId);
    if (state.epoch !== principal.epoch) throw new SecurityError(401, "CREDENTIAL_REVOKED");
    return principal;
  }
  async invite(principal: Principal): Promise<string> {
    if (principal.role !== "pc") throw new SecurityError(403, "PC_CAPABILITY_REQUIRED");
    const state = await this.state(principal.sessionId);
    if (state.epoch !== principal.epoch) throw new SecurityError(401, "CREDENTIAL_REVOKED");
    await this.limit(`invite:${principal.sessionId}`, 10);
    const pairingCode = randomBytes(32).toString("base64url");
    const stored = await this.store.put(`invite:${hash(pairingCode)}`, {
      sessionId: principal.sessionId, epoch: principal.epoch, expiresAt: this.now() + 300_000,
    }, 300);
    if (!stored) throw new SecurityError(503, "PAIRING_ISSUANCE_FAILED");
    return pairingCode;
  }
  async redeem(sessionId: string, deviceId: string, pairingCode: unknown) {
    if (typeof pairingCode !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(pairingCode)) throw new SecurityError(403, "PAIRING_CODE_REQUIRED");
    const key = `invite:${hash(pairingCode)}`;
    const preview = await this.store.get<{ sessionId: string }>(key);
    if (!preview || preview.sessionId !== sessionId) throw new SecurityError(403, "PAIRING_CODE_INVALID_OR_EXPIRED");
    const invitation = await this.store.take<{ sessionId: string; epoch: string; expiresAt: number }>(key);
    const state = await this.state(sessionId);
    if (!invitation || invitation.sessionId !== sessionId || invitation.epoch !== state.epoch || invitation.expiresAt <= this.now()) {
      throw new SecurityError(403, "PAIRING_CODE_INVALID_OR_EXPIRED");
    }
    return this.issue(sessionId, `mobile-${randomUUID()}`, "mobile");
  }
  async revoke(principal: Principal): Promise<void> {
    if (principal.role === "pc") await this.store.delete(`session:${principal.sessionId}`);
    await this.store.delete(`token:${principal.verifier}`);
  }
  async claimCommand(principal: Principal, id: unknown, deadline: unknown): Promise<boolean> {
    if (typeof id !== "string" || !id || id.length > 128 || typeof deadline !== "number" ||
        !Number.isSafeInteger(deadline) || deadline <= this.now() || deadline > this.now() + 300_000) {
      throw new SecurityError(400, "INVALID_OR_EXPIRED_COMMAND");
    }
    const state = await this.state(principal.sessionId);
    if (state.epoch !== principal.epoch) throw new SecurityError(401, "CREDENTIAL_REVOKED");
    const prefix = `command:${principal.epoch}:${hash(principal.deviceId)}`;
    const key = `${prefix}:${hash(id)}`;
    if (await this.store.get(key)) return false;
    const ttl = Math.max(1, Math.ceil((state.expiresAt - this.now()) / 1000));
    if (await this.store.increment(`${prefix}:count`, ttl) > 4096) throw new SecurityError(429, "COMMAND_CAPACITY_EXCEEDED");
    return this.store.put(key, { claimed: true }, ttl);
  }
}
