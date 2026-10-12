/** Relay and web-app addresses, and the links Telegram and the Mac hand to the phone. */

export const DEFAULT_APP_URL = "https://cursor-remote-app.vercel.app/";

const SESSION_ID = /^[A-Z0-9]{6}$/;
const PAIRING_CODE = /^[A-Za-z0-9_-]{43}$/;

function isLocalhost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * A relay origin such as https://my-relay.vercel.app, or null. Only https (http just for localhost),
 * and nothing but scheme, host and port, so the same value always names the same relay.
 */
export function normalizeRelayUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost(url.hostname))) return null;
  if (url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#")) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

/** The web app address, always https and ending in "/"; anything else falls back to the hosted app. */
export function normalizeAppUrl(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_APP_URL;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost(url.hostname))) return DEFAULT_APP_URL;
    if (url.username || url.password || url.search || url.hash) return DEFAULT_APP_URL;
    return `${url.origin}${url.pathname.replace(/\/*$/, "/")}`;
  } catch {
    return DEFAULT_APP_URL;
  }
}

/** The app link: which relay to use and the session to join. Never carries a pairing code. */
export function appLink(appUrl: string, relayUrl: string | null | undefined, sessionId?: string | null): string {
  const params = new URLSearchParams();
  const relay = normalizeRelayUrl(relayUrl);
  if (relay) params.set("relay", relay);
  if (sessionId && SESSION_ID.test(sessionId)) params.set("session", sessionId);
  const query = params.toString();
  return query ? `${appUrl}?${query}` : appUrl;
}

/**
 * One-tap pairing link. The code rides in the fragment, which browsers never send to a server, so it
 * stays out of request logs and Telegram's preview fetch; the app strips it before starting.
 */
export function pairLink(appUrl: string, relayUrl: string | null | undefined, sessionId: string, code: string): string {
  const base = appLink(appUrl, relayUrl, sessionId);
  if (!SESSION_ID.test(sessionId) || !PAIRING_CODE.test(code)) return base;
  return `${base}#code=${code}`;
}
