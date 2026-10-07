import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { RelayClient } from "../relay-client";

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
  let failPoll = true;
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    paths.push(req.url!.split("?")[0]);
    res.setHeader("Content-Type", "application/json");
    if (req.url!.startsWith("/api/poll") && failPoll) {
      failPoll = false;
      res.statusCode = 503;
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
    assert.equal(client.isConnectedToSession(), false, "a failed poll drops the connection");
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
