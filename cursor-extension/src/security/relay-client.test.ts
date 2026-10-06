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
