import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { WsAuth } from "../ws-auth";
import { remoteCommandError } from "../command-policy";

test("pairing is single-use; credentials expire and revoke; versions fail closed", () => {
  let now = 100_000;
  const auth = new WsAuth(() => now);
  const secret = auth.beginPairing();
  assert.equal(auth.authenticate({ type: "pair", protocolVersion: 1, secret }), null);
  assert.equal(auth.authenticate({ type: "pair", protocolVersion: 2, secret: "wrong" }), null);
  const credential = auth.authenticate({ type: "pair", protocolVersion: 2, secret });
  assert.ok(credential?.token);
  assert.equal(auth.authenticate({ type: "pair", protocolVersion: 2, secret }), null);
  const request = { type: "authenticate", protocolVersion: 2, token: credential.token };
  assert.equal(auth.authenticate(request)?.clientId, credential.clientId);
  now += 86_400_000;
  assert.equal(auth.authenticate(request), null);
  const next = auth.authenticate({ type: "pair", protocolVersion: 2, secret: auth.beginPairing() });
  auth.revokeAll();
  assert.equal(auth.authenticate({ ...request, token: next?.token }), null);
  const expiredSecret = auth.beginPairing();
  now += 300_001;
  assert.equal(auth.authenticate({ type: "pair", protocolVersion: 2, secret: expiredSecret }), null);
});

test("Origins and global authentication rate limits fail closed", () => {
  const auth = new WsAuth(() => 100_000);
  assert.equal(auth.originAllowed(undefined, []), true);
  assert.equal(auth.originAllowed("null", ["null"]), false);
  assert.equal(auth.originAllowed("https://evil.test", ["http://localhost:8080"]), false);
  assert.equal(auth.originAllowed("http://localhost:8080", ["http://localhost:8080"]), true);
  for (let i = 0; i < 60; i++) auth.authenticate({});
  assert.equal(auth.authenticate({ type: "pair", protocolVersion: 2, secret: auth.beginPairing() }), null);
});

test("real WebSocket rejects session requests before auth and accepts them after pairing", async () => {
  const auth = new WsAuth();
  let dispatched = 0;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", ws => auth.attach(ws, () => {}, msg => {
    dispatched++;
    ws.send(JSON.stringify({ type: "sessions", id: msg.id, sessions: [] }));
  }));
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}`;
  try {
    const stranger = new WebSocket(url);
    await once(stranger, "message");
    const rejected = once(stranger, "close");
    stranger.send(JSON.stringify({ type: "get_sessions" }));
    assert.equal((await rejected)[0], 4001);
    assert.equal(dispatched, 0);
    const client = new WebSocket(url);
    await once(client, "message");
    const paired = once(client, "message");
    client.send(JSON.stringify({ type: "pair", protocolVersion: 2, secret: auth.beginPairing() }));
    const credential = JSON.parse((await paired)[0].toString());
    assert.equal(credential.type, "authenticated");
    const result = once(client, "message");
    client.send(JSON.stringify({ type: "get_sessions", id: "test-command", deadline: Date.now() + 60_000 }));
    assert.equal(JSON.parse((await result)[0].toString()).type, "sessions");
    assert.equal(dispatched, 1);
    const duplicate = once(client, "message");
    client.send(JSON.stringify({ type: "get_sessions", id: "test-command", deadline: Date.now() + 60_000 }));
    assert.equal(JSON.parse((await duplicate)[0].toString()).status, "duplicate");
    const expired = once(client, "message");
    client.send(JSON.stringify({ type: "get_sessions", id: "expired", deadline: Date.now() - 1 }));
    assert.equal(JSON.parse((await expired)[0].toString()).status, "invalid_or_expired_command");
    assert.equal(dispatched, 1);
    const reconnect = new WebSocket(url);
    await once(reconnect, "message");
    const reauthenticated = once(reconnect, "message");
    reconnect.send(JSON.stringify({ type: "authenticate", protocolVersion: 2, token: credential.token }));
    assert.equal(JSON.parse((await reauthenticated)[0].toString()).clientId, credential.clientId);
    const replay = once(reconnect, "message");
    reconnect.send(JSON.stringify({ type: "get_sessions", id: "test-command", deadline: Date.now() + 60_000 }));
    assert.equal(JSON.parse((await replay)[0].toString()).status, "duplicate");
    assert.equal(dispatched, 1);
    const rateLimited = once(reconnect, "close");
    for (let i = 0; i < 121; i++) {
      reconnect.send(JSON.stringify({ type: "get_sessions", id: "test-command", deadline: Date.now() + 60_000 }));
    }
    assert.equal((await rateLimited)[0], 4008);
    assert.equal(dispatched, 1);
    const revoked = once(client, "close");
    auth.revokeAll();
    assert.equal((await revoked)[0], 4001);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("typed command policy denies execution aliases and untargeted CDP prompts", () => {
  for (const type of ["execute_command", "execute_action", "unknown", "approve_action", "reject_action", "stop_prompt"]) {
    assert.ok(remoteCommandError({ type }));
  }
  for (const terminal of [true, "true", 1, "1", {}]) {
    assert.ok(remoteCommandError({ type: "insert_text", terminal, prompt: true }));
  }
  assert.ok(remoteCommandError({ type: "insert_text" }));
  assert.ok(remoteCommandError({ type: "agent_prompt" }));
  assert.equal(remoteCommandError({ type: "get_sessions" }), null);
  assert.equal(remoteCommandError({ type: "agent_prompt", sessionId: "explicit-session" }), null);
  assert.equal(remoteCommandError({ type: "insert_text", prompt: true }), null);
});
