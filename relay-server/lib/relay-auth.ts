import type { VercelRequest, VercelResponse } from "@vercel/node";
import { securityStore } from "./security-store.js";
import { RelaySecurity, SecurityError, validSessionId, type Principal } from "./relay-security.js";
export const relaySecurity = new RelaySecurity(securityStore);
export function cors(res: VercelResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Device-Id, X-Device-Type");
  res.setHeader("Cache-Control", "no-store");
}
/** Set by Vercel's edge; the socket address is Vercel's, not the client's. */
export function clientIp(req: VercelRequest): string {
  for (const name of ["x-vercel-forwarded-for", "x-real-ip"]) {
    const value = req.headers?.[name];
    const first = (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}
/** Logs where an unexpected error happened. Never the message: it can quote keys or payloads. */
export function logUnexpected(req: VercelRequest | undefined, error: unknown, errorCode = "SECURITY_UNAVAILABLE"): void {
  const header = req?.headers?.["x-vercel-id"];
  console.error("Relay operation failed", JSON.stringify({
    route: (req as { relayRoute?: string } | undefined)?.relayRoute ?? new URL(req?.url ?? "/", "http://relay").pathname,
    errorCode,
    error: error instanceof Error ? error.name : typeof error,
    vercelId: Array.isArray(header) ? header[0] : header ?? null,
  }));
}
export function securityFailure(res: VercelResponse, error: unknown, req?: VercelRequest) {
  const known = error instanceof SecurityError;
  if (!known) logUnexpected(req, error);
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
function sessionHint(req: VercelRequest): string | undefined {
  const raw = req.query?.sessionId ?? (req.body && typeof req.body === "object" ? req.body.sessionId : undefined);
  const id = typeof raw === "string" ? raw.trim().toUpperCase() : undefined;
  return validSessionId(id) ? id : undefined;
}
export async function authorize(req: VercelRequest, role?: Principal["role"], security = relaySecurity): Promise<Principal> {
  const header = req.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
  const principal = await security.authenticate(token, clientIp(req), sessionHint(req));
  if (role && principal.role !== role) throw new SecurityError(403, "CAPABILITY_ROLE_MISMATCH");
  const parsed = body(req);
  for (const input of [parsed, req.query]) {
    if (input.sessionId !== undefined && (typeof input.sessionId !== "string" || input.sessionId.trim().toUpperCase() !== principal.sessionId)) throw new SecurityError(403, "SESSION_MEMBERSHIP_REQUIRED");
    if (input.deviceId !== undefined && input.deviceId !== principal.deviceId) throw new SecurityError(403, "DEVICE_MEMBERSHIP_REQUIRED");
    if (input.deviceType !== undefined && input.deviceType !== principal.role) throw new SecurityError(403, "CAPABILITY_ROLE_MISMATCH");
  }
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
    catch (error) { return securityFailure(res, error, req); }
  };
}
/** Enrollment (creating or pairing into a session) is limited per client IP and, when known, per session. */
export async function admission(req: VercelRequest, sessionId?: string, security = relaySecurity): Promise<void> {
  await Promise.all([
    security.limit(`enrollment:${clientIp(req)}`, 10),
    sessionId ? security.limit(`enrollment-session:${sessionId}`, 10) : undefined,
  ]);
}
export function discoveryDisabled(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  return res.status(403).json({ success: false, errorCode: "PUBLIC_DISCOVERY_DISABLED", error: "Public session discovery is disabled" });
}
