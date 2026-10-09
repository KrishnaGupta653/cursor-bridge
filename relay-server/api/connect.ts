import { randomUUID } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSession, joinSession, sendMessage } from "../lib/store.js";
import { admission, authorize, body, cors, relaySecurity, securityFailure } from "../lib/relay-auth.js";
import { SecurityError, validDeviceId, validSessionId, type Principal } from "../lib/relay-security.js";

/** A phone may only join while its Mac is polling. */
async function requireJoinable(sessionId: string, role: Principal["role"]): Promise<void> {
  const existing = await getSession(sessionId);
  if (!existing) throw new SecurityError(404, "SESSION_NOT_FOUND");
  if (role === "mobile" && (!existing.pcDeviceId || !existing.pcLastSeenAt || Date.now() - existing.pcLastSeenAt > 120_000)) throw new SecurityError(409, "PC_MUST_CONNECT_FIRST");
}

/** `from: "relay"` can't be set through /api/send, so the Mac can tell this notice from a phone's message. */
function notifyDevicePaired(sessionId: string, deviceId: string, pairing: { reusable: boolean; usesLeft: number }) {
  const at = Date.now();
  return sendMessage(sessionId, {
    id: `${at}-${randomUUID()}`, type: "device_paired", from: "relay", to: "pc", timestamp: at, senderDeviceId: deviceId,
    data: { type: "device_paired", deviceId, at, reusable: pairing.reusable, usesLeft: pairing.usesLeft },
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (req.method !== "POST") throw new SecurityError(405, "METHOD_NOT_ALLOWED");
    const input = body(req);
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim().toUpperCase() : "";
    if (!validSessionId(sessionId) || !validDeviceId(input.deviceId) || !["mobile", "pc"].includes(input.deviceType)) throw new SecurityError(400, "VALID_SESSION_AND_DEVICE_REQUIRED");
    let token: string | undefined;
    let principal;
    let pairing: { reusable: boolean; usesLeft: number } | undefined;
    if (req.headers.authorization) {
      principal = await authorize(req);
      await requireJoinable(principal.sessionId, principal.role);
    } else {
      await admission(req, sessionId);
      // PINs and session/device IDs are never credentials. Only a single-use invitation enrolls a mobile.
      if (input.deviceType !== "mobile") throw new SecurityError(401, "PC_CREDENTIAL_REQUIRED");
      const result = await relaySecurity.redeem(sessionId, input.deviceId, input.pairingCode,
        () => requireJoinable(sessionId, "mobile"));
      token = result.token;
      principal = result.principal;
      pairing = { reusable: result.reusable, usesLeft: result.usesLeft };
    }
    const session = await joinSession(principal.sessionId, principal.deviceId, principal.role);
    if (!session) throw new SecurityError(503, "SESSION_JOIN_FAILED");
    // The Mac hears about every new device before the phone gets its credential.
    if (pairing) await notifyDevicePaired(principal.sessionId, principal.deviceId, pairing);
    return res.status(200).json({ success: true, protocolVersion: 2,
      data: { ...session, deviceId: principal.deviceId, ...(token ? { token } : {}), credentialExpiresAt: principal.expiresAt,
        ...(pairing?.reusable ? { pairing } : {}) }, timestamp: Date.now() });
  } catch (error) { return securityFailure(res, error, req); }
}
