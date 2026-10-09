import { withRelayAuth, relaySecurity } from "../lib/relay-auth.js";
import { SecurityError } from "../lib/relay-security.js";
export default withRelayAuth(async (req, res, principal) => {
  if (req.method !== "POST") throw new SecurityError(405, "METHOD_NOT_ALLOWED");
  if (req.body?.reusable === true) {
    return res.status(200).json({ success: true, data: await relaySecurity.reusableInvite(principal) });
  }
  const pairingCode = await relaySecurity.invite(principal);
  return res.status(200).json({ success: true, data: { pairingCode, expiresInSeconds: 300 } });
}, "pc");
