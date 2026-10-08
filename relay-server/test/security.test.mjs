import test from 'node:test';
import assert from 'node:assert/strict';
import { RelaySecurity, SecurityError } from '../.test-dist/lib/relay-security.js';
import { admission, authorize, securityFailure } from '../.test-dist/lib/relay-auth.js';

class MemoryStore {
  records = new Map();
  async get(key) { return this.records.get(key) ?? null; }
  async put(key, value) { if (this.records.has(key)) return false; this.records.set(key, value); return true; }
  async take(key) { const value = this.records.get(key); this.records.delete(key); return value ?? null; }
  async delete(key) { this.records.delete(key); }
  async increment(key) { const n = (this.records.get(key) || 0) + 1; this.records.set(key, n); return n; }
}
async function fixture() {
  let now = Date.now();
  const store = new MemoryStore();
  const security = new RelaySecurity(store, () => now);
  await security.reserve('ABC123');
  const owner = await security.issue('ABC123', 'pc-owner', 'pc');
  return { security, store, owner, advance: ms => { now += ms; } };
}
const request = (token, query = {}, body = {}) => ({ headers: { authorization: `Bearer ${token}` }, query, body });

test('capabilities bind session, device and role; ID knowledge cannot authorize', async () => {
  const { security, owner, store } = await fixture();
  await assert.rejects(security.authenticate('ABC123'), /CREDENTIAL_REQUIRED/);
  await assert.rejects(security.authenticate('a'.repeat(43)), /INVALID_OR_EXPIRED/);
  for (const input of [{ sessionId: 'OTHER1' }, { deviceId: 'another-device' }, { deviceType: 'mobile' }]) {
    await assert.rejects(authorize(request(owner.token, input), undefined, security), /MEMBERSHIP|ROLE/);
    await assert.rejects(authorize(request(owner.token, {}, input), undefined, security), /MEMBERSHIP|ROLE/);
  }
  const req = request(owner.token, { sessionId: 'abc123' });
  await authorize(req, 'pc', security);
  assert.equal(req.query.deviceId, 'pc-owner');
  assert.equal(req.body.deviceType, 'pc');
  assert.ok(!JSON.stringify([...store.records]).includes(owner.token));
});

test('single-use pairing is atomic across concurrent redeemers and cannot cross sessions', async () => {
  const { security, owner } = await fixture();
  const code = await security.invite(owner.principal);
  await assert.rejects(security.redeem('OTHER1', 'mobile-1', code), /INVALID_OR_EXPIRED/);
  const results = await Promise.allSettled([
    security.redeem('ABC123', 'mobile-1', code), security.redeem('ABC123', 'mobile-2', code),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  const mobile = results.find(x => x.status === 'fulfilled').value;
  assert.equal((await security.authenticate(mobile.token)).role, 'mobile');
  await assert.rejects(authorize(request(mobile.token), 'pc', security), /ROLE_MISMATCH/);
  await assert.rejects(security.invite(mobile.principal), /PC_CAPABILITY_REQUIRED/);
});

test('credential/session revocation invalidates access and outstanding invitations', async () => {
  const { security, owner } = await fixture();
  const mobile = await security.redeem('ABC123', 'mobile', await security.invite(owner.principal));
  await security.revoke(mobile.principal);
  await assert.rejects(security.authenticate(mobile.token), /INVALID_OR_EXPIRED/);
  assert.equal((await security.authenticate(owner.token)).role, 'pc');
  const pending = await security.invite(owner.principal);
  await security.revoke(owner.principal);
  await assert.rejects(security.authenticate(owner.token), /INVALID_OR_EXPIRED/);
  await assert.rejects(security.redeem('ABC123', 'mobile', pending), /INVALID_OR_EXPIRED/);
});

test('expiry, ownership reservation, and distributed counters fail closed', async () => {
  const { security, owner, advance } = await fixture();
  await assert.rejects(security.reserve('ABC123'), /ALREADY_OWNED/);
  const code = await security.invite(owner.principal);
  advance(300_001);
  await assert.rejects(security.redeem('ABC123', 'mobile', code), /INVALID_OR_EXPIRED/);
  for (let i = 0; i < 3; i++) await security.limit('same-principal', 3);
  await assert.rejects(security.limit('same-principal', 3), /RATE_LIMITED/);
  advance(86_400_000);
  await assert.rejects(security.authenticate(owner.token), /INVALID_OR_EXPIRED/);
});

function response() {
  return { code: 0, value: null, setHeader() {}, status(code) { this.code = code; return this; },
    json(value) { this.value = value; return this; }, end() { return this; } };
}
test('all data/control endpoints reject unauthenticated requests before datastore access', async () => {
  for (const name of ['send','poll','heartbeat','pair','disconnect','store','session']) {
    const handler = (await import(`../.test-dist/api/${name}.js`)).default;
    const res = response();
    await handler({ method: 'GET', headers: {}, query: { sessionId: 'ABC123', deviceId: 'pc-owner' }, body: {} }, res);
    assert.equal(res.code, 401, name);
    assert.equal(res.value.success, false, name);
  }
});

test('single-function router dispatches to endpoints and keeps their auth', async () => {
  const relay = (await import('../.test-dist/api/relay.js')).default;
  const call = async (query, url) => {
    const res = response();
    await relay({ method: 'GET', headers: {}, url, query: { sessionId: 'ABC123', ...query }, body: {} }, res);
    return res;
  };
  assert.equal((await call({ route: 'poll' }, '/api/poll')).code, 401);
  assert.equal((await call({}, '/api/send?x=1')).code, 401);
  assert.equal((await call({ route: 'debug-sessions' })).code, 403);
  assert.equal((await call({ route: 'sessions-with-mobile' })).code, 403);
  assert.equal((await call({ route: 'nope' })).code, 404);
  assert.equal((await call({ route: '__proto__' })).code, 404);
  for (const route of ['stream', 'command-events', 'command-approvals', 'command-timeline-summary',
    'resolve-command-approval', 'sessions-waiting-for-pc']) {
    assert.equal((await call({ route })).code, 404, route);
  }
});

test('public discovery and debug enumeration are disabled', async () => {
  for (const name of ['sessions-with-mobile','debug-sessions']) {
    const handler = (await import(`../.test-dist/api/${name}.js`)).default;
    const res = response();
    await handler({ method: 'GET', headers: {}, query: {} }, res);
    assert.equal(res.code, 403);
  }
});


test('command reservation is atomic, bounded by deadline, and scoped to membership', async () => {
  const { security, owner } = await fixture();
  const deadline = Date.now() + 60000;
  const outcomes = await Promise.all([
    security.claimCommand(owner.principal, 'same-id', deadline),
    security.claimCommand(owner.principal, 'same-id', deadline),
  ]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  await assert.rejects(security.claimCommand(owner.principal, 'expired', Date.now() - 1), /EXPIRED/);
  await security.revoke(owner.principal);
  await assert.rejects(security.claimCommand(owner.principal, 'new', deadline), /EXPIRED/);
});

test('failed authentications are limited per client IP, never globally or for a valid credential', async () => {
  const { security, owner, advance } = await fixture();
  const forged = 'b'.repeat(43);
  for (let i = 0; i < 60; i++) await assert.rejects(security.authenticate(forged, '198.51.100.1'), /INVALID_OR_EXPIRED/);
  await assert.rejects(security.authenticate(forged, '198.51.100.1'), /RATE_LIMITED/);
  await assert.rejects(security.authenticate(forged, '198.51.100.2'), /INVALID_OR_EXPIRED/);
  assert.equal((await security.authenticate(owner.token, '198.51.100.1')).role, 'pc');
  const forgedRequest = { headers: { authorization: `Bearer ${forged}`, 'x-vercel-forwarded-for': '198.51.100.1, 10.0.0.1' }, query: {}, body: {} };
  await assert.rejects(authorize(forgedRequest, undefined, security), /RATE_LIMITED/);
  for (let i = 0; i < 3601; i++) await security.authenticate(owner.token, `203.0.113.${i % 250}`);
  advance(60_000);
  await assert.rejects(security.authenticate(forged, '198.51.100.1'), /INVALID_OR_EXPIRED/);
});

test('the session hint only saves a lookup; a wrong hint or a revoked session still decides', async () => {
  const { security, owner } = await fixture();
  assert.equal((await security.authenticate(owner.token, 'ip', 'ABC123')).sessionId, 'ABC123');
  assert.equal((await security.authenticate(owner.token, 'ip', 'OTHER1')).sessionId, 'ABC123');
  await security.revoke(owner.principal);
  await assert.rejects(security.authenticate(owner.token, 'ip', 'ABC123'), /INVALID_OR_EXPIRED/);
});

test('enrollment is limited per client IP and per session, not globally', async () => {
  const { security } = await fixture();
  const from = ip => ({ headers: { 'x-real-ip': ip } });
  for (let i = 0; i < 10; i++) await admission(from('198.51.100.3'), undefined, security);
  await assert.rejects(admission(from('198.51.100.3'), undefined, security), /RATE_LIMITED/);
  for (let i = 0; i < 100; i++) await admission(from(`203.0.113.${i}`), undefined, security);
  for (let i = 0; i < 10; i++) await admission(from(`192.0.2.${i}`), 'ABC123', security);
  await assert.rejects(admission(from('192.0.2.200'), 'ABC123', security), /RATE_LIMITED/);
  await admission(from('192.0.2.201'), 'XYZ789', security);
});

test('a pairing code survives a refused join and can be used once the Mac is back', async () => {
  const { security, owner } = await fixture();
  const code = await security.invite(owner.principal);
  const offline = async () => { throw new SecurityError(409, 'PC_MUST_CONNECT_FIRST'); };
  await assert.rejects(security.redeem('ABC123', 'mobile', code, offline), /PC_MUST_CONNECT_FIRST/);
  await assert.rejects(security.redeem('OTHER1', 'mobile', code, offline), /INVALID_OR_EXPIRED/);
  const mobile = await security.redeem('ABC123', 'mobile', code, async () => {});
  assert.equal((await security.authenticate(mobile.token)).role, 'mobile');
  await assert.rejects(security.redeem('ABC123', 'mobile', code, async () => {}), /INVALID_OR_EXPIRED/);
});

test('unexpected failures log the route, error code and request ID, never the error text', async () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  const res = response();
  try {
    securityFailure(res, new Error('leaked-secret-value'), { headers: { 'x-vercel-id': 'bom1::abc123' }, url: '/api/relay.ts?route=poll', relayRoute: 'poll' });
  } finally { console.error = original; }
  assert.equal(res.code, 503);
  const log = lines.join('\n');
  for (const part of ['"route":"poll"', 'SECURITY_UNAVAILABLE', 'bom1::abc123']) assert.ok(log.includes(part), part);
  assert.ok(!log.includes('leaked-secret-value'));
});

test('health reports only its status', async () => {
  const health = (await import('../.test-dist/api/health.js')).default;
  const res = response();
  await health({ method: 'GET', headers: {}, query: {} }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.value.data, { status: 'healthy' });
});
