import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { RelayClient, resumeSavedRelaySession } from "../relay-client";

test("extension relay client persists device credentials and authenticates reconnect, pairing and revocation", async () => {
  const requests: Array<{ path: string; authorization?: string; body: any }> = [];
  const token = "t".repeat(43);
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url!, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : {} });
    res.setHeader("Content-Type", "application/json");
    res.statusCode = req.url === "/api/session" ? 201 : 200;
    res.end(JSON.stringify({ success: true, protocolVersion: 2, data: req.url === "/api/pair"
      ? { pairingCode: "p".repeat(43) } : { token, sessionId: "TEST12" } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const secrets = new Map<string, string>();
  const vault = { get: async (key: string) => secrets.get(key),
    store: async (key: string, value: string) => { secrets.set(key, value); },
    delete: async (key: string) => { secrets.delete(key); } };
  const logs: string[] = [];
  const output = { appendLine: (line: string) => logs.push(line) };
  const url = `http://127.0.0.1:${address.port}`;
  const first = new RelayClient(url, output as any, vault as any);
  const second = new RelayClient(url, output as any, vault as any);
  try {
    await first.connectToSessionById("TEST12");
    assert.equal(first.isConnectedToSession(), true);
    assert.equal(secrets.size, 1);
    first.stop();
    await second.connectToSessionById("TEST12");
    assert.equal(second.isConnectedToSession(), true);
    assert.equal(await second.createMobilePairingCode(), "p".repeat(43));
    await second.disconnectSession();
    assert.equal(second.isConnectedToSession(), false);
    assert.equal(secrets.size, 0);
    assert.deepEqual(requests.map(r => r.path), ["/api/session", "/api/connect", "/api/pair", "/api/disconnect"]);
    assert.equal(requests[0].authorization, undefined);
    assert.equal(requests[0].body.deviceId, requests[1].body.deviceId);
    assert.ok(requests.slice(1).every(r => r.authorization === `Bearer ${token}`));
    assert.ok(logs.every(log => !log.includes(token)));
  } finally {
    first.stop(); second.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("relay client recovers from a failed poll instead of going silent", async () => {
  const pollFailures = [503, 401];
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    paths.push(req.url!.split("?")[0]);
    res.setHeader("Content-Type", "application/json");
    if (req.url!.startsWith("/api/poll") && pollFailures.length) {
      res.statusCode = pollFailures.shift()!;
      res.end("{}");
      return;
    }
    res.statusCode = req.url === "/api/session" ? 201 : 200;
    res.end(JSON.stringify({ success: true, protocolVersion: 2, data: { token: "t".repeat(43), sessionId: "TEST34", messages: [] } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const secrets = new Map<string, string>();
  const vault = { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => { secrets.set(k, v); },
    delete: async (k: string) => { secrets.delete(k); } };
  const client = new RelayClient(`http://127.0.0.1:${address.port}`, { appendLine() {} } as any, vault as any);
  const internals = client as unknown as { pollMessages: () => Promise<void>; nextConnectAt: number };
  let connectedCallbacks = 0;
  client.setOnSessionConnected(() => { connectedCallbacks++; });
  try {
    await client.connectToSessionById("TEST34");
    assert.equal(connectedCallbacks, 1);
    assert.ok((client as unknown as { pollInterval: unknown }).pollInterval, "connecting by ID starts receiving messages");
    await internals.pollMessages();
    assert.equal(client.isConnectedToSession(), true, "a relay hiccup (503) keeps the login");
    await internals.pollMessages();
    assert.equal(client.isConnectedToSession(), false, "a refused login (401) drops the connection");
    internals.nextConnectAt = 0;
    await internals.pollMessages();
    assert.equal(client.isConnectedToSession(), true, "the next poll re-authenticates");
    assert.equal(paths.filter((p) => p === "/api/connect").length, 1);
    assert.equal(connectedCallbacks, 1, "a reconnect does not re-announce the session");
  } finally {
    client.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("an expired relay login is dropped and replaced by a new session to pair", async () => {
  const requests: Array<{ path: string; sessionId: string }> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url!.split("?")[0], sessionId: body.sessionId });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/connect") {
      res.statusCode = 401;
      res.end(JSON.stringify({ success: false, error: "CREDENTIAL_INVALID_OR_EXPIRED" }));
      return;
    }
    res.statusCode = req.url === "/api/session" ? 201 : 200;
    res.end(JSON.stringify({ success: true, protocolVersion: 2, data: { token: "n".repeat(43), sessionId: body.sessionId, messages: [] } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const secrets = new Map<string, string>([[`cursorRemote.relay.v2:${url}:OLD123`, JSON.stringify({ token: "o".repeat(43), deviceId: "pc-1" })]]);
  const vault = { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => { secrets.set(k, v); },
    delete: async (k: string) => { secrets.delete(k); } };
  const client = new RelayClient(url, { appendLine() {} } as any, vault as any);
  const expired: string[][] = [];
  let announced = 0;
  client.setOnSessionExpired((old, next) => expired.push([old, next]));
  client.setOnSessionConnected(() => { announced++; });
  try {
    // Pair Relay Client connects by ID and must come back connected so pairing can continue.
    await client.connectToSessionById("OLD123");
    assert.equal(expired.length, 1);
    const [old, next] = expired[0];
    assert.equal(old, "OLD123");
    assert.match(next, /^[A-Z2-9]{6}$/);
    assert.ok(![...secrets.keys()].some((k) => k.endsWith(":OLD123")), "the expired credential is deleted");
    assert.equal(client.isConnectedToSession(), true);
    assert.equal(client.getSessionId(), next);
    assert.equal(announced, 1, "the new session is announced so the user can pair the phone");
    assert.deepEqual(requests.slice(0, 2).map((r) => [r.path, r.sessionId]), [["/api/connect", "OLD123"], ["/api/session", next]]);
  } finally {
    client.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a taken session ID is swapped for a fresh one, and a new session revokes the old", async () => {
  const requests: Array<{ path: string; sessionId: string }> = [];
  const taken = new Set(["KRISHN"]);
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const path = req.url!.split("?")[0];
    requests.push({ path, sessionId: body.sessionId });
    res.setHeader("Content-Type", "application/json");
    if (path === "/api/session" && taken.has(body.sessionId)) {
      res.statusCode = 409;
      res.end(JSON.stringify({ success: false, error: "LEGACY_SESSION_REQUIRES_NEW_ID" }));
      return;
    }
    if (path === "/api/session") taken.add(body.sessionId);
    res.statusCode = path === "/api/session" ? 201 : 200;
    res.end(JSON.stringify({ success: true, protocolVersion: 2, data: { token: "n".repeat(43), sessionId: body.sessionId, messages: [] } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const secrets = new Map<string, string>();
  const vault = { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => { secrets.set(k, v); },
    delete: async (k: string) => { secrets.delete(k); } };
  const client = new RelayClient(url, { appendLine() {} } as any, vault as any);
  try {
    await client.connectToSessionById("KRISHN");
    const first = client.getSessionId();
    assert.equal(client.isConnectedToSession(), true, "pairing can continue on the replacement");
    assert.notEqual(first, "KRISHN");
    assert.equal(await client.hasCredential(first!), true);

    const second = await client.startNewSession();
    assert.ok(second && second !== first);
    assert.equal(client.getSessionId(), second);
    assert.equal(await client.hasCredential(first!), false, "the old session's login is dropped");
    assert.ok(requests.some((r) => r.path === "/api/disconnect" && r.sessionId === first), "the old session is revoked on the relay");
  } finally {
    client.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

/** A fake relay: `routes` answers per path; everything else succeeds with a v2 credential. */
async function fakeRelay(routes: Record<string, (body: any) => Promise<[number, any]> | [number, any]> = {}) {
  const requests: Array<{ path: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const path = req.url!.split("?")[0];
    requests.push({ path, body });
    const [status, reply] = routes[path] ? await routes[path](body)
      : [path === "/api/session" ? 201 : 200, { success: true, protocolVersion: 2, data: { token: "t".repeat(43), sessionId: body.sessionId, messages: [] } }];
    res.setHeader("Content-Type", "application/json");
    res.statusCode = status;
    res.end(JSON.stringify(reply));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const secrets = new Map<string, string>();
  const vault = { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => { secrets.set(k, v); },
    delete: async (k: string) => { secrets.delete(k); } };
  const client = new RelayClient(url, { appendLine() {} } as any, vault as any);
  const close = async () => {
    client.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  return { client, requests, secrets, url, close };
}

test("one malformed relay message does not drop the rest of the batch", async () => {
  const deadline = Date.now() + 60_000;
  const relay = await fakeRelay({
    "/api/poll": () => [200, { success: true, data: { messages: [
      { id: "1", senderDeviceId: "phone", data: JSON.stringify({ type: "list_chats", id: "a", deadline }) },
      { id: "2", senderDeviceId: "phone", data: "{not json" },
      { id: "3", senderDeviceId: "phone", data: { type: "get_chat", id: "c", deadline } },
    ] } }],
  });
  const got: any[] = [];
  relay.client.setOnMessage((m) => got.push(JSON.parse(m)));
  try {
    await relay.client.connectToSessionById("TEST56");
    await (relay.client as any).pollMessages();
    assert.deepEqual(got.map((m) => m.id), ["a", "c"]);
    assert.ok(got.every((m) => m.clientId === "relay:TEST56:phone"));
  } finally { await relay.close(); }
});

test("a reply to a phone that left the session drops that phone's watches, not the connection", async () => {
  const relay = await fakeRelay({
    "/api/send": () => [403, { success: false, errorCode: "TARGET_MEMBERSHIP_REQUIRED" }],
  });
  const gone: string[] = [];
  relay.client.setOnTargetGone((clientId) => gone.push(clientId));
  try {
    await relay.client.connectToSessionById("TEST78");
    await relay.client.sendMessage(JSON.stringify({ type: "chat_delta", clientId: "relay:TEST78:phone", targetDeviceId: "phone" }));
    assert.deepEqual(gone, ["relay:TEST78:phone"]);
    assert.equal(relay.client.isConnectedToSession(), true);
  } finally { await relay.close(); }
});

test("a fatal rejection stops polling and says so once", async () => {
  const relay = await fakeRelay({
    "/api/session": () => [403, { success: false, errorCode: "ENROLLMENT_REFUSED" }],
  });
  const rejected: Array<[string, number]> = [];
  relay.client.setOnRejected((sid, status) => rejected.push([sid, status]));
  try {
    await relay.client.connectToSessionById("TEST90");
    assert.deepEqual(rejected, [["TEST90", 403]]);
    assert.equal((relay.client as any).pollInterval, null, "no poll timer keeps running");
    assert.equal(relay.client.isConnectedToSession(), false);
  } finally { await relay.close(); }
});

test("starting a new session waits out a connect already in flight, which then changes nothing", async () => {
  let releaseSlow!: () => void;
  const slow = new Promise<void>((r) => { releaseSlow = r; });
  const relay = await fakeRelay({
    "/api/session": async (body) => {
      if (body.sessionId === "SLOW12") await slow;
      return [201, { success: true, protocolVersion: 2, data: { token: (body.sessionId === "SLOW12" ? "s" : "n").repeat(43) } }];
    },
  });
  try {
    const first = relay.client.connectToSessionById("SLOW12");
    await new Promise((r) => setTimeout(r, 20));
    const next = relay.client.startNewSession();
    await new Promise((r) => setTimeout(r, 20));
    releaseSlow();
    await first;
    const sid = await next;
    assert.ok(sid && sid !== "SLOW12");
    assert.equal(relay.client.getSessionId(), sid);
    assert.equal(relay.client.isConnectedToSession(), true);
    assert.equal(await relay.client.hasCredential("SLOW12"), false, "the stale connect stored no login");
  } finally { await relay.close(); }
});

test("startup resume reconnects only with a saved login and only in the window holding the lock", async () => {
  const relay = await fakeRelay();
  try {
    assert.equal(await resumeSavedRelaySession(relay.client, undefined, () => true), "no-session");
    assert.equal(await resumeSavedRelaySession(relay.client, "SAVED1", () => true), "no-credential");
    relay.secrets.set(`cursorRemote.relay.v2:${relay.url}:SAVED1`, JSON.stringify({ token: "o".repeat(43), deviceId: "pc-1" }));
    assert.equal(await resumeSavedRelaySession(relay.client, "saved1", () => false), "locked");
    assert.equal(relay.requests.length, 0, "a window without the lock never contacts the relay");
    assert.equal(await resumeSavedRelaySession(relay.client, "saved1", () => true), "connected");
    assert.deepEqual(relay.requests.map((r) => r.path), ["/api/connect"]);
  } finally { await relay.close(); }
});