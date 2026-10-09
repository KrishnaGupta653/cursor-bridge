import { logUnexpected, withRelayAuth } from "../lib/relay-auth.js";
import type { Principal } from "../lib/relay-security.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { receiveMessages, markSeen } from "../lib/store.js";
import { ApiResponse, RelayMessage } from "../lib/types.js";

async function handler(req: VercelRequest, res: VercelResponse, principal: Principal) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Device-Id, X-Device-Type"
  );
  res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Device-Id, X-Device-Type",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  if (req.method !== "GET") {
    const response: ApiResponse = {
      success: false,
      error: "Method not allowed",
      timestamp: Date.now(),
    };
    return res.status(405).json(response);
  }

  try {
    // Session, device and role come from the credential (authorize rejects mismatching query values).
    const { sessionId, deviceId, role, expiresAt } = principal;
    const maxLimit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    // Each poll refreshes this device's last-seen time (the Mac's liveness, a phone's delivery).
    const [messages] = await Promise.all([
      receiveMessages(sessionId, role, maxLimit, deviceId),
      markSeen(sessionId, deviceId, role, expiresAt),
    ]);

    const response: ApiResponse<{ messages: RelayMessage[]; count: number }> = {
      success: true,
      data: {
        messages,
        count: messages.length,
      },
      timestamp: Date.now(),
    };

    return res.status(200).json(response);
  } catch (error) {
    logUnexpected(req, error, "RELAY_OPERATION_FAILED");
    const response: ApiResponse = {
      success: false,
      error: "Relay operation failed",
      timestamp: Date.now(),
    };
    return res.status(500).json(response);
  }
}

export default withRelayAuth(handler);
