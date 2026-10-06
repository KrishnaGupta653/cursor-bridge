import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSession, joinSession } from "../lib/store.js";
import { admission, authorize, body, cors, relaySecurity, securityFailure } from "../lib/relay-auth.js";
import { SecurityError, validDeviceId, validSessionId } from "../lib/relay-security.js";

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
    if (req.headers.authorization) {
      principal = await authorize(req);
    } else {
      await admission(req);
      // PINs and session/device IDs are never credentials. Only a single-use invitation enrolls a mobile.
      if (input.deviceType !== "mobile") throw new SecurityError(401, "PC_CREDENTIAL_REQUIRED");
      const result = await relaySecurity.redeem(sessionId, input.deviceId, input.pairingCode);
      token = result.token;
      principal = result.principal;
    }
    const existing = await getSession(principal.sessionId);
    if (!existing) throw new SecurityError(404, "SESSION_NOT_FOUND");
    if (principal.role === "mobile" && (!existing.pcDeviceId || !existing.pcLastSeenAt || Date.now() - existing.pcLastSeenAt > 120_000)) throw new SecurityError(409, "PC_MUST_CONNECT_FIRST");
    const session = await joinSession(principal.sessionId, principal.deviceId, principal.role);
    if (!session) throw new SecurityError(503, "SESSION_JOIN_FAILED");
    const { pcPinHash: _, ...safe } = session;
    return res.status(200).json({ success: true, protocolVersion: 2,
      data: { ...safe, deviceId: principal.deviceId, ...(token ? { token } : {}), credentialExpiresAt: principal.expiresAt }, timestamp: Date.now() });
  } catch (error) { return securityFailure(res, error); }
}
