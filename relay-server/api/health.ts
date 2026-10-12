import type { VercelRequest, VercelResponse } from "@vercel/node";
import { redisHealth } from "../lib/redis.js";
import { cors } from "../lib/relay-auth.js";

/**
 * Setup and uptime check. 200 only when Redis answers; 503 says which part is missing, never how
 * it is configured.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });
  const redis = await redisHealth();
  const healthy = redis === "ok";
  return res.status(healthy ? 200 : 503).json({
    success: healthy,
    data: { status: healthy ? "healthy" : "unhealthy", redis, protocolVersion: 2 },
    ...(healthy ? {} : {
      error: redis === "not_configured"
        ? "Redis is not configured. Add Upstash Redis to this Vercel project, then redeploy."
        : "Redis did not answer. Check the Upstash database and its token, then redeploy.",
    }),
    timestamp: Date.now(),
  });
}
