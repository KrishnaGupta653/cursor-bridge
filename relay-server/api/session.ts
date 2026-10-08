import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createSession, getSession, joinSession } from "../lib/store.js";
import { admission, authorize, body, cors, relaySecurity, securityFailure } from "../lib/relay-auth.js";
import { newSessionId, SecurityError, validDeviceId, validSessionId } from "../lib/relay-security.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (req.method === "GET") {
      const principal = await authorize(req);
      const session = await getSession(principal.sessionId);
      if (!session) throw new SecurityError(404, "SESSION_NOT_FOUND");
      return res.status(200).json({ success: true, data: session, timestamp: Date.now() });
    }
    if (req.method !== "POST") throw new SecurityError(405, "METHOD_NOT_ALLOWED");
    await admission(req);
    const input = body(req);
    const sessionId = input.sessionId == null ? newSessionId() : String(input.sessionId).trim().toUpperCase();
    if (!validSessionId(sessionId) || !validDeviceId(input.deviceId) || input.deviceType !== "pc") throw new SecurityError(400, "PC_DEVICE_AND_VALID_SESSION_REQUIRED");
    // Reserve atomically before touching legacy session state. Never take over an existing session.
    const reserved = await relaySecurity.reserve(sessionId);
    if (await getSession(sessionId)) throw new SecurityError(409, "LEGACY_SESSION_REQUIRES_NEW_ID");
    await createSession(sessionId, reserved.expiresAt);
    const session = await joinSession(sessionId, input.deviceId, "pc");
    if (!session) throw new SecurityError(503, "SESSION_CREATION_FAILED");
    const { token, principal } = await relaySecurity.issue(sessionId, input.deviceId, "pc");
    return res.status(201).json({ success: true, protocolVersion: 2, data: {
      ...session, token, credentialExpiresAt: principal.expiresAt,
    }, timestamp: Date.now() });
  } catch (error) { return securityFailure(res, error, req); }
}
