import type { VercelRequest, VercelResponse } from "@vercel/node";
import { securityStore } from "./security-store.js";
import { RelaySecurity, SecurityError, type Principal } from "./relay-security.js";
export const relaySecurity = new RelaySecurity(securityStore);
export function cors(res: VercelResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Device-Id, X-Device-Type");
  res.setHeader("Cache-Control", "no-store");
}
export function securityFailure(res: VercelResponse, error: unknown) {
  const known = error instanceof SecurityError;
  return res.status(known ? error.status : 503).json({ success: false,
    error: known ? error.code : "Relay security service unavailable", errorCode: known ? error.code : "SECURITY_UNAVAILABLE", timestamp: Date.now() });
}
export function body(req: VercelRequest): Record<string, any> {
  let value = req.body;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { throw new SecurityError(400, "INVALID_JSON"); } }
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new SecurityError(400, "INVALID_BODY");
  return value;
}
export async function authorize(req: VercelRequest, role?: Principal["role"], security = relaySecurity): Promise<Principal> {
  const header = req.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
  const principal = await security.authenticate(token);
  if (role && principal.role !== role) throw new SecurityError(403, "CAPABILITY_ROLE_MISMATCH");
  const parsed = body(req);
  for (const input of [parsed, req.query]) {
    if (input.sessionId !== undefined && (typeof input.sessionId !== "string" || input.sessionId.trim().toUpperCase() !== principal.sessionId)) throw new SecurityError(403, "SESSION_MEMBERSHIP_REQUIRED");
    if (input.deviceId !== undefined && input.deviceId !== principal.deviceId) throw new SecurityError(403, "DEVICE_MEMBERSHIP_REQUIRED");
    if (input.deviceType !== undefined && input.deviceType !== principal.role) throw new SecurityError(403, "CAPABILITY_ROLE_MISMATCH");
  }
  await security.limit("all-authenticated-requests", 3600);
  await security.limit(`principal:${principal.verifier}`, 180);
  // Downstream handlers only see authenticated identity, including GET endpoints.
  const identity = { sessionId: principal.sessionId, deviceId: principal.deviceId, deviceType: principal.role };
  req.body = { ...parsed, ...identity };
  Object.assign(req.query, identity);
  return principal;
}
export function withRelayAuth(handler: (req: VercelRequest, res: VercelResponse, principal: Principal) => any, role?: Principal["role"]) {
  return async (req: VercelRequest, res: VercelResponse) => {
    cors(res);
    if (req.method === "OPTIONS") return res.status(204).end();
    try { return await handler(req, res, await authorize(req, role)); }
    catch (error) { return securityFailure(res, error); }
  };
}
export async function admission(req: VercelRequest): Promise<void> {
  await relaySecurity.limit("enrollment-global", 60);
  await relaySecurity.limit(`enrollment:${req.socket?.remoteAddress || "unknown"}`, 10);
}
export function discoveryDisabled(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  return res.status(403).json({ success: false, errorCode: "PUBLIC_DISCOVERY_DISABLED", error: "Public session discovery is disabled" });
}
