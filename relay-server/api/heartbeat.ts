import { logUnexpected, withRelayAuth } from "../lib/relay-auth.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSessionRecord, updatePcLastSeen } from "../lib/store.js";
import { ApiResponse } from "../lib/types.js";

/**
 * PC extension "still alive" signal (heartbeat)
 * - Calling it periodically refreshes pcLastSeenAt
 * - With no heartbeat for 2 minutes the PC counts as disconnected, so another PC may join with the same session ID
 * - Lets the relay safely decide a session is released without an explicit "disconnect" call
 */
async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Device-Id"
  );
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Device-Id",
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
    const { sessionId, deviceId } = req.query;
    if (
      !sessionId ||
      typeof sessionId !== "string" ||
      !deviceId ||
      typeof deviceId !== "string"
    ) {
      const response: ApiResponse = {
        success: false,
        error: "sessionId and deviceId are required",
        timestamp: Date.now(),
      };
      return res.status(400).json(response);
    }

    const session = await getSessionRecord(sessionId);
    if (!session) {
      const response: ApiResponse = {
        success: false,
        error: "Session not found",
        timestamp: Date.now(),
      };
      return res.status(404).json(response);
    }

    if (session.pcDeviceId !== deviceId) {
      const response: ApiResponse = {
        success: false,
        error: "Device not registered for this session",
        timestamp: Date.now(),
      };
      return res.status(403).json(response);
    }

    await updatePcLastSeen(sessionId, session.expiresAt);

    const response: ApiResponse<{ ok: boolean }> = {
      success: true,
      data: { ok: true },
      timestamp: Date.now(),
    };
    return res.status(200).json(response);
  } catch (error) {
    logUnexpected(req, error, "RELAY_OPERATION_FAILED");
    const response: ApiResponse = {
      success: false,
      error:
        "Relay operation failed",
      timestamp: Date.now(),
    };
    return res.status(500).json(response);
  }
}

export default withRelayAuth(handler, "pc");
