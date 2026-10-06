import test from 'node:test';
import assert from 'node:assert/strict';
import { RelaySecurity } from '../.test-dist/lib/relay-security.js';
import { authorize } from '../.test-dist/lib/relay-auth.js';

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
  for (const name of ['send','poll','heartbeat','stream','command-events','command-approvals',
    'command-timeline-summary','resolve-command-approval','pair','disconnect','store','session']) {
    const handler = (await import(`../.test-dist/api/${name}.js`)).default;
    const res = response();
    await handler({ method: 'GET', headers: {}, query: { sessionId: 'ABC123', deviceId: 'pc-owner' }, body: {} }, res);
    assert.equal(res.code, 401, name);
    assert.equal(res.value.success, false, name);
  }
});

test('public discovery and debug enumeration are disabled', async () => {
  for (const name of ['sessions-with-mobile','sessions-waiting-for-pc','debug-sessions']) {
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
