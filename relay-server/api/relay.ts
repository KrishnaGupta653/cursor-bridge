import type { VercelRequest, VercelResponse } from "@vercel/node";
import commandApprovals from "./command-approvals.js";
import commandEvents from "./command-events.js";
import commandTimelineSummary from "./command-timeline-summary.js";
import connect from "./connect.js";
import debugSessions from "./debug-sessions.js";
import disconnect from "./disconnect.js";
import health from "./health.js";
import heartbeat from "./heartbeat.js";
import pair from "./pair.js";
import poll from "./poll.js";
import resolveCommandApproval from "./resolve-command-approval.js";
import send from "./send.js";
import session from "./session.js";
import sessionsWaitingForPc from "./sessions-waiting-for-pc.js";
import sessionsWithMobile from "./sessions-with-mobile.js";
import store from "./store.js";
import stream from "./stream.js";

type Handler = (req: VercelRequest, res: VercelResponse) => unknown;

// The Hobby plan allows 12 functions per deployment, so every endpoint is served by this one.
const routes: Record<string, Handler> = {
  "command-approvals": commandApprovals,
  "command-events": commandEvents,
  "command-timeline-summary": commandTimelineSummary,
  connect,
  "debug-sessions": debugSessions,
  disconnect,
  health,
  heartbeat,
  pair,
  poll,
  "resolve-command-approval": resolveCommandApproval,
  send,
  session,
  "sessions-waiting-for-pc": sessionsWaitingForPc,
  "sessions-with-mobile": sessionsWithMobile,
  store,
  stream,
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
  return route(req, res);
}
