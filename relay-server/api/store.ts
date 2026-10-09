import { withRelayAuth } from "../lib/relay-auth.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ApiResponse } from "../lib/types.js";

/**
 * Storage backend in use by the relay server (Upstash Redis)
 * GET /api/store → { store: "redis", storeLabel: "Upstash Redis" }
 */
async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.writeHead(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
      timestamp: Date.now(),
    });
  }

  const response: ApiResponse<{ store: "redis"; storeLabel: string }> = {
    success: true,
    data: { store: "redis", storeLabel: "Upstash Redis" },
    timestamp: Date.now(),
  };
  return res.status(200).json(response);
}

export default withRelayAuth(handler);
