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
interface Invitation { sessionId: string; epoch: string; expiresAt: number; reusable?: boolean }
export interface PairingInvite { pairingCode: string; expiresInSeconds: number; reusable: boolean; usesLeft?: number }
/** A reusable code enrolls at most this many devices; it never outlives the session or its epoch. */
export const MAX_REUSABLE_PAIRINGS = 3;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const validSessionId = (value: unknown): value is string => typeof value === "string" && /^[A-Z0-9]{6,32}$/.test(value);
export const validDeviceId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
export const newSessionId = () => randomBytes(9).toString("hex").toUpperCase();
const AUTH_FAILURES_PER_IP_PER_MINUTE = 60;

/** Opaque capabilities are verified by a shared store, not process-local state. */
export class RelaySecurity {
  constructor(readonly store: SecurityStore, private now = Date.now) {}
  private rateKey(key: string): string {
    return `rate:${hash(key)}:${Math.floor(this.now() / 60_000)}`;
  }
  async limit(key: string, limit: number): Promise<void> {
    if (await this.store.increment(this.rateKey(key), 120) > limit) {
      throw new SecurityError(429, "RATE_LIMITED");
    }
  }
  async reserve(sessionId: string): Promise<SessionSecurity> {
    const state = { epoch: randomUUID(), expiresAt: this.now() + 86_400_000 };
    if (!await this.store.put(`session:${sessionId}`, state, 86400)) throw new SecurityError(409, "SESSION_ALREADY_OWNED");
    return state;
  }
  async state(sessionId: string): Promise<SessionSecurity> {
    return this.live(await this.store.get<SessionSecurity>(`session:${sessionId}`));
  }
  private live(state: SessionSecurity | null): SessionSecurity {
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
  /**
   * Failed lookups are counted per client IP; a valid credential is never refused because of
   * other clients' failures. [sessionHint] lets the session state be fetched in the same round trip.
   */
  async authenticate(token: unknown, clientIp = "unknown", sessionHint?: string): Promise<Principal> {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new SecurityError(401, "CREDENTIAL_REQUIRED");
    const verifier = hash(token);
    const failuresKey = this.rateKey(`authentication-failures:${clientIp}`);
    const [principal, failures, hinted] = await Promise.all([
      this.store.get<Principal>(`token:${verifier}`),
      this.store.get<number>(failuresKey),
      sessionHint ? this.store.get<SessionSecurity>(`session:${sessionHint}`) : null,
    ]);
    try {
      if (!principal || principal.expiresAt <= this.now() ||
          typeof principal.verifier !== "string" || principal.verifier.length !== 64 ||
          !timingSafeEqual(Buffer.from(verifier), Buffer.from(principal.verifier))) {
        throw new SecurityError(401, "CREDENTIAL_INVALID_OR_EXPIRED");
      }
      const state = principal.sessionId === sessionHint ? this.live(hinted) : await this.state(principal.sessionId);
      if (state.epoch !== principal.epoch) throw new SecurityError(401, "CREDENTIAL_REVOKED");
      return principal;
    } catch (error) {
      if (!(error instanceof SecurityError) || error.status !== 401) throw error;
      if (Number(failures) >= AUTH_FAILURES_PER_IP_PER_MINUTE) throw new SecurityError(429, "RATE_LIMITED");
      await this.store.increment(failuresKey, 120);
      throw error;
    }
  }
  private secondsUntil(expiresAt: number): number {
    return Math.max(1, Math.ceil((expiresAt - this.now()) / 1000));
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
  /**
   * One code for the rest of the session, good for [MAX_REUSABLE_PAIRINGS] devices. Minting a new
   * one invalidates the previous one; the session's epoch and expiry bound it like any credential.
   */
  async reusableInvite(principal: Principal): Promise<PairingInvite> {
    if (principal.role !== "pc") throw new SecurityError(403, "PC_CAPABILITY_REQUIRED");
    const state = await this.state(principal.sessionId);
    if (state.epoch !== principal.epoch) throw new SecurityError(401, "CREDENTIAL_REVOKED");
    await this.limit(`invite:${principal.sessionId}`, 10);
    await this.dropReusableInvite(principal.sessionId);
    const pairingCode = randomBytes(32).toString("base64url");
    const verifier = hash(pairingCode);
    const ttl = this.secondsUntil(state.expiresAt);
    // The pointer is claimed first, so of two concurrent mints only one code ever becomes valid.
    if (!await this.store.put(`invite-reusable:${principal.sessionId}`, { verifier }, ttl)) {
      throw new SecurityError(409, "PAIRING_ISSUANCE_CONFLICT");
    }
    const stored = await this.store.put(`invite:${verifier}`, {
      sessionId: principal.sessionId, epoch: principal.epoch, expiresAt: state.expiresAt, reusable: true,
    } satisfies Invitation, ttl);
    if (!stored) {
      await this.store.delete(`invite-reusable:${principal.sessionId}`);
      throw new SecurityError(503, "PAIRING_ISSUANCE_FAILED");
    }
    return { pairingCode, expiresInSeconds: ttl, reusable: true, usesLeft: MAX_REUSABLE_PAIRINGS };
  }
  private async dropReusableInvite(sessionId: string): Promise<void> {
    const previous = await this.store.take<{ verifier: string }>(`invite-reusable:${sessionId}`);
    if (previous?.verifier) await this.store.delete(`invite:${previous.verifier}`);
  }
  /**
   * [beforeConsume] runs after the code is known valid and before it is used up; if it throws, the code stays valid.
   * Every successful redeem enrolls a new device ID, so a phone that pairs again counts as another use.
   */
  async redeem(sessionId: string, deviceId: string, pairingCode: unknown, beforeConsume?: () => Promise<void>) {
    if (typeof pairingCode !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(pairingCode)) throw new SecurityError(403, "PAIRING_CODE_REQUIRED");
    const verifier = hash(pairingCode);
    const key = `invite:${verifier}`;
    const usesKey = `invite-uses:${verifier}`;
    const [preview, uses] = await Promise.all([this.store.get<Invitation>(key), this.store.get<number>(usesKey)]);
    if (!preview || preview.sessionId !== sessionId) throw new SecurityError(403, "PAIRING_CODE_INVALID_OR_EXPIRED");
    if (preview.reusable && Number(uses) >= MAX_REUSABLE_PAIRINGS) throw new SecurityError(403, "PAIRING_CODE_USED_UP");
    await beforeConsume?.();
    if (preview.reusable) {
      const [state, current] = await Promise.all([
        this.state(sessionId), this.store.get<{ verifier: string }>(`invite-reusable:${sessionId}`),
      ]);
      if (preview.epoch !== state.epoch || preview.expiresAt <= this.now() || current?.verifier !== verifier) {
        throw new SecurityError(403, "PAIRING_CODE_INVALID_OR_EXPIRED");
      }
      const used = await this.store.increment(usesKey, this.secondsUntil(preview.expiresAt));
      if (used > MAX_REUSABLE_PAIRINGS) throw new SecurityError(403, "PAIRING_CODE_USED_UP");
      const issued = await this.issue(sessionId, `mobile-${randomUUID()}`, "mobile");
      return { ...issued, reusable: true, usesLeft: MAX_REUSABLE_PAIRINGS - used };
    }
    const invitation = await this.store.take<Invitation>(key);
    const state = await this.state(sessionId);
    if (!invitation || invitation.sessionId !== sessionId || invitation.epoch !== state.epoch || invitation.expiresAt <= this.now()) {
      throw new SecurityError(403, "PAIRING_CODE_INVALID_OR_EXPIRED");
    }
    const issued = await this.issue(sessionId, `mobile-${randomUUID()}`, "mobile");
    return { ...issued, reusable: false, usesLeft: 0 };
  }
  async revoke(principal: Principal): Promise<void> {
    if (principal.role === "pc") {
      await this.store.delete(`session:${principal.sessionId}`);
      await this.dropReusableInvite(principal.sessionId);
    }
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
