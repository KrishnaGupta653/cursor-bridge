import { withRelayAuth, relaySecurity } from "../lib/relay-auth.js";
import { SecurityError } from "../lib/relay-security.js";
import { deleteSession, leaveSession } from "../lib/store.js";
export default withRelayAuth(async (req, res, principal) => {
  if (req.method !== "POST") throw new SecurityError(405, "METHOD_NOT_ALLOWED");
  // Revoke before cleanup: a failed cleanup must not preserve access.
  await relaySecurity.revoke(principal);
  if (principal.role === "pc") await deleteSession(principal.sessionId);
  else await leaveSession(principal.sessionId, principal.deviceId);
  return res.status(200).json({ success: true });
});
