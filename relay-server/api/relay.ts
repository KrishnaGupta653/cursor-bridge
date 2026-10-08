import type { VercelRequest, VercelResponse } from "@vercel/node";
import connect from "./connect.js";
import debugSessions from "./debug-sessions.js";
import disconnect from "./disconnect.js";
import health from "./health.js";
import heartbeat from "./heartbeat.js";
import pair from "./pair.js";
import poll from "./poll.js";
import send from "./send.js";
import session from "./session.js";
import sessionsWithMobile from "./sessions-with-mobile.js";
import store from "./store.js";

type Handler = (req: VercelRequest, res: VercelResponse) => unknown;

// The Hobby plan allows 12 functions per deployment, so every endpoint is served by this one.
const routes: Record<string, Handler> = {
  connect,
  "debug-sessions": debugSessions,
  disconnect,
  health,
  heartbeat,
  pair,
  poll,
  send,
  session,
  "sessions-with-mobile": sessionsWithMobile,
  store,
};

function routeName(req: VercelRequest): string {
  const q = req.query.route;
  const fromQuery = Array.isArray(q) ? q[0] : q;
  const raw = fromQuery ?? new URL(req.url ?? "/", "http://relay").pathname.replace(/^\/api\//, "");
  return raw.replace(/\.ts$/, "").replace(/\/+$/, "");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const name = routeName(req);
  const route = Object.prototype.hasOwnProperty.call(routes, name) ? routes[name] : undefined;
  if (!route) return res.status(404).json({ success: false, error: "Not found" });
  delete req.query.route;
  Object.assign(req, { relayRoute: name });
  return route(req, res);
}
