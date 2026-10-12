import { normalizeRelayUrl } from "../links";

export const RELAY_PROTOCOL_VERSION = 2;

export interface RelayCheck {
  ok: boolean;
  /** Normalized origin when the address itself was valid. */
  url: string | null;
  /** One line for the user: what is wrong and what to do about it. */
  message: string;
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Ask a relay's /api/health whether it is a Cursor Remote relay with working Redis. */
export async function checkRelay(raw: string, fetchImpl: Fetch = fetch as unknown as Fetch, timeoutMs = 10_000): Promise<RelayCheck> {
  const url = normalizeRelayUrl(raw);
  if (!url) {
    return { ok: false, url: null, message: "Enter the relay's https address, like https://my-relay.vercel.app (no path)." };
  }
  let res: { status: number; json(): Promise<unknown> };
  try {
    res = await fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, url, message: `Couldn't reach ${url}. Check the address, your internet connection, and that the Vercel deployment finished.` };
  }
  let body: any = null;
  try {
    body = ((await res.json()) as any)?.data ?? null;
  } catch {
    // Not JSON: not a relay.
  }
  if (!body || typeof body !== "object" || !("redis" in body)) {
    return {
      ok: false,
      url,
      message: res.status === 401 || res.status === 403
        ? `${url} asks for a login. In Vercel → Settings → Deployment Protection, turn off Vercel Authentication for production.`
        : `${url} doesn't look like a Cursor Remote relay (no /api/health). Deploy the relay-server folder, not the app.`,
    };
  }
  if (body.redis === "not_configured") {
    return { ok: false, url, message: "The relay has no Redis. In Vercel → Storage, connect Upstash Redis to the project, then redeploy." };
  }
  if (body.redis === "unreachable") {
    return { ok: false, url, message: "The relay can't reach Redis. Check the Upstash database is active and its env vars are current, then redeploy." };
  }
  if (res.status !== 200 || body.redis !== "ok") {
    return { ok: false, url, message: `The relay answered HTTP ${res.status}. Open ${url}/api/health to see why.` };
  }
  if (Number(body.protocolVersion) !== RELAY_PROTOCOL_VERSION) {
    return { ok: false, url, message: "This relay runs an older version. Redeploy it from the latest relay-server code." };
  }
  return { ok: true, url, message: `Relay ${url} is working (Redis connected).` };
}
