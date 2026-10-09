import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

// Uses an isolated local Redis over a private Unix socket, never a configured service.
let dir, socket, child, bridge;
const cli = (...args) => {
  const result = spawnSync('redis-cli', ['-s', socket, ...args.map(String)], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, 'Local fixture Redis command failed');
  return result.stdout.trim();
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cursor-relay-test-'));
  socket = join(dir, 'redis.sock');
  child = spawn('redis-server', ['--port','0','--unixsocket',socket,'--unixsocketperm','700',
    '--save','','--appendonly','no','--dir',dir], { stdio: 'ignore' });
  let childError;
  child.on('error', error => { childError = error; });
  const encode = value => typeof value === 'string' ? Buffer.from(value).toString('base64')
    : Array.isArray(value) ? value.map(encode) : value;
  bridge = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      const run = command => {
        const result = spawnSync('redis-cli', ['-s',socket,'--json',...command.map(String)], { encoding:'utf8', timeout: 3000 });
        if (result.status !== 0) return { error: 'Local fixture Redis command failed' };
        let value = JSON.parse(result.stdout);
        if (req.headers['upstash-encoding'] === 'base64') value = encode(value);
        return { result: value };
      };
      const result = Array.isArray(input[0]) ? input.map(run) : run(input);
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(result));
    } catch { res.statusCode = 500; res.end(JSON.stringify({error:'Fixture bridge failed'})); }
  });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (childError) throw childError;
    try { await access(socket); ready = true; break; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  assert.ok(ready, 'Local Redis did not start');
  bridge.listen(0,'127.0.0.1'); await once(bridge,'listening');
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${bridge.address().port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'local-fixture-only';
});

after(async () => {
  bridge?.closeAllConnections();
  if (bridge?.listening) await new Promise(r => bridge.close(r));
  if (child?.pid && child.exitCode === null) { const done = once(child,'exit'); child.kill('SIGTERM'); await done; }
  await rm(dir,{recursive:true,force:true});
});

let clientNumber = 0;
const call = async (name, method, body = {}, token, query = {}) => {
  const handler = (await import(`../.test-dist/api/${name}.js`)).default;
  // A distinct client address per call keeps the per-IP enrollment limit out of the way.
  const headers = { 'x-vercel-forwarded-for': `198.51.100.${++clientNumber % 250}`, ...(token ? {authorization:`Bearer ${token}`} : {}) };
  const req = { method, body, query, headers, socket:{remoteAddress:'127.0.0.1'} };
  const res = { code:0, data:null, setHeader() {}, status(code) {this.code=code;return this;},
    json(data) {this.data=data;return this;}, end(){return this;} };
  await handler(req,res); return res;
};
const createPc = async sessionId => {
  const owner = await call('session','POST',{sessionId,deviceId:`pc-${sessionId}`,deviceType:'pc'});
  assert.equal(owner.code,201, owner.data?.error);
  return owner.data.data;
};
const invite = async (sessionId, pcToken) => {
  const res = await call('pair','POST',{sessionId},pcToken);
  assert.equal(res.code,200,res.data?.error);
  return res.data.data.pairingCode;
};
const pairPhone = async (sessionId, pcToken) => {
  const joined = await call('connect','POST',{sessionId,deviceId:'mobile-test',deviceType:'mobile',pairingCode:await invite(sessionId, pcToken)});
  assert.equal(joined.code,200,joined.data?.error);
  return { token: joined.data.data.token, deviceId: joined.data.data.deviceId };
};
const command = (type, extra = {}) => ({ type, data: { type, id: `cmd-${Math.random().toString(36).slice(2)}`, deadline: Date.now() + 60000, ...extra } });
const pollCount = async (sessionId, token) => {
  const res = await call('poll','GET',{},token,{sessionId});
  assert.equal(res.code,200,res.data?.error);
  return res.data.data.messages.length;
};

test('real Redis: authenticated create/pair/send/poll/revoke lifecycle', { timeout: 45000 }, async () => {
  const owner = await createPc('REDIS1');
  const pcToken = owner.token;
  const second = await createPc('REDIS2');
  const joined = await call('connect','POST',{sessionId:'REDIS1',deviceId:'mobile-test',deviceType:'mobile',pairingCode:await invite('REDIS1', pcToken)});
  assert.equal(joined.code,200,joined.data?.error);
  const mobileToken = joined.data.data.token;
  const wrong = await call('poll','GET',{},mobileToken,{sessionId:'REDIS2'});
  assert.equal(wrong.code,403);
  const spoof = await call('heartbeat','GET',{},mobileToken,{sessionId:'REDIS1',deviceType:'pc'});
  assert.equal(spoof.code,403);
  const send = await call('send','POST',{sessionId:'REDIS1',type:'get_sessions',data:{type:'get_sessions',id:'fixture-command',deadline:Date.now()+60000}},mobileToken);
  assert.equal(send.code,200,send.data?.error);
  const replay = await call('send','POST',{sessionId:'REDIS1',type:'get_sessions',data:{type:'get_sessions',id:'fixture-command',deadline:Date.now()+60000}},mobileToken);
  assert.equal(replay.code,409);
  const expired = await call('send','POST',{sessionId:'REDIS1',type:'get_sessions',data:{type:'get_sessions',id:'expired',deadline:Date.now()-1}},mobileToken);
  assert.equal(expired.code,400);

  const poll = await call('poll','GET',{},pcToken,{sessionId:'REDIS1'});
  assert.equal(poll.code,200,poll.data?.error);
  assert.deepEqual(poll.data.data.messages.map(m => m.type).sort(), ['device_paired','get_sessions']);
  assert.ok(poll.data.data.messages.every(m => m.senderDeviceId === joined.data.data.deviceId));
  assert.notEqual(joined.data.data.deviceId,'mobile-test');
  const disconnected = await call('disconnect','POST',{sessionId:'REDIS1'},pcToken);
  assert.equal(disconnected.code,200,disconnected.data?.error);
  const revoked = await call('poll','GET',{},mobileToken,{sessionId:'REDIS1'});
  assert.equal(revoked.code,401);
  assert.equal(cli('EXISTS','session:REDIS1','session:REDIS1:mobiles','session:REDIS1:pc-seen'),'0');
  const other = await call('poll','GET',{},second.token,{sessionId:'REDIS2'});
  assert.equal(other.code,200,other.data?.error);
});

test('real Redis: phones joining during Mac heartbeats and polls are never dropped', { timeout: 45000 }, async () => {
  const { token: pcToken } = await createPc('RACE01');
  const codes = [await invite('RACE01', pcToken), await invite('RACE01', pcToken), await invite('RACE01', pcToken)];
  const results = await Promise.all([
    ...codes.map(pairingCode => call('connect','POST',{sessionId:'RACE01',deviceId:'mobile-test',deviceType:'mobile',pairingCode})),
    ...Array.from({ length: 4 }, () => call('heartbeat','GET',{},pcToken,{sessionId:'RACE01'})),
    ...Array.from({ length: 4 }, () => call('poll','GET',{},pcToken,{sessionId:'RACE01'})),
    call('connect','POST',{sessionId:'RACE01',deviceId:'pc-RACE01',deviceType:'pc'},pcToken),
  ]);
  for (const res of results) assert.equal(res.code,200,res.data?.error);
  const phones = results.slice(0, 3).map(res => res.data.data.deviceId);
  const session = await call('session','GET',{},pcToken,{sessionId:'RACE01'});
  assert.deepEqual([...session.data.data.mobileDeviceIds].sort(), [...phones].sort());
  assert.ok(session.data.data.pcLastSeenAt > Date.now() - 10000);
  assert.ok(!cli('GET','session:RACE01').includes('mobile-'), 'phones are not kept in the session record');
});

test('real Redis: broadcasts reach live phones, replies only their target, silent phones are pruned', { timeout: 45000 }, async () => {
  const { token: pcToken } = await createPc('MULTI1');
  const a = await pairPhone('MULTI1', pcToken);
  const b = await pairPhone('MULTI1', pcToken);
  const pcSend = (type, extra) => call('send','POST',{sessionId:'MULTI1',...command(type, extra)},pcToken);

  assert.equal((await pcSend('chats')).code, 200);
  assert.equal(await pollCount('MULTI1', a.token), 1);
  assert.equal(await pollCount('MULTI1', b.token), 1);
  assert.equal((await pcSend('chat', { targetDeviceId: a.deviceId })).code, 200);
  assert.equal(await pollCount('MULTI1', a.token), 1);
  assert.equal(await pollCount('MULTI1', b.token), 0);
  assert.equal(cli('EXISTS','messages:MULTI1:pc2mobile'),'0');

  cli('ZADD','session:MULTI1:mobiles', Date.now() - 180000, b.deviceId);
  assert.equal((await pcSend('chats')).code, 200);
  assert.equal(cli('ZSCORE','session:MULTI1:mobiles', b.deviceId), '', 'the silent phone is pruned');
  assert.equal(cli('LLEN',`messages:MULTI1:device:${b.deviceId}`), '0');
  assert.equal(await pollCount('MULTI1', a.token), 1);
  const gone = await pcSend('chat', { targetDeviceId: b.deviceId });
  assert.equal(gone.code, 403);
  assert.equal(gone.data.errorCode, 'TARGET_MEMBERSHIP_REQUIRED');
  assert.equal(await pollCount('MULTI1', b.token), 0);
  assert.equal((await pcSend('chat', { targetDeviceId: b.deviceId })).code, 200, 'polling again rejoins delivery');
  assert.equal(await pollCount('MULTI1', b.token), 1);

  const queue = `messages:MULTI1:device:${a.deviceId}`;
  cli('LPUSH', queue, ...Array.from({ length: 1000 }, (_, i) => `{"id":"old-${i}"}`));
  assert.equal((await pcSend('chat', { targetDeviceId: a.deviceId })).code, 200);
  assert.equal(cli('LLEN', queue), '1000', 'per-device queues are trimmed');
  assert.equal(cli('LINDEX', queue, -1), '{"id":"old-1"}', 'the oldest entry is the one dropped');
});

test('real Redis: a pairing code is kept when the Mac is offline and works once it is back', { timeout: 45000 }, async () => {
  const { token: pcToken } = await createPc('PAIR01');
  const pairingCode = await invite('PAIR01', pcToken);
  cli('SET','session:PAIR01:pc-seen', Date.now() - 300000);
  const offline = await call('connect','POST',{sessionId:'PAIR01',deviceId:'mobile-test',deviceType:'mobile',pairingCode});
  assert.equal(offline.code,409);
  assert.equal(offline.data.errorCode,'PC_MUST_CONNECT_FIRST');
  const missing = await call('connect','POST',{sessionId:'NOSUCH',deviceId:'mobile-test',deviceType:'mobile',pairingCode});
  assert.equal(missing.code,403, 'a code for another session reveals nothing about this one');
  assert.equal((await call('heartbeat','GET',{},pcToken,{sessionId:'PAIR01'})).code,200);
  const joined = await call('connect','POST',{sessionId:'PAIR01',deviceId:'mobile-test',deviceType:'mobile',pairingCode});
  assert.equal(joined.code,200,joined.data?.error);
  const reused = await call('connect','POST',{sessionId:'PAIR01',deviceId:'mobile-test',deviceType:'mobile',pairingCode});
  assert.equal(reused.code,403);
});

test('real Redis: a reusable code lives as long as the session, counts 3 devices and tells the Mac about each', { timeout: 45000 }, async () => {
  const owner = await createPc('REUSE1');
  const single = await call('pair','POST',{sessionId:'REUSE1'},owner.token);
  assert.equal(single.data.data.expiresInSeconds, 300);
  assert.equal(single.data.data.reusable, undefined, 'single-use stays the default');
  const minted = await call('pair','POST',{sessionId:'REUSE1',reusable:true},owner.token);
  assert.equal(minted.code,200,minted.data?.error);
  const { pairingCode, expiresInSeconds, reusable, usesLeft } = minted.data.data;
  assert.equal(reusable, true);
  assert.equal(usesLeft, 3);
  const expiresAt = owner.credentialExpiresAt;
  assert.ok(Math.abs(Date.now() + expiresInSeconds * 1000 - expiresAt) < 5000, 'valid until the session ends');
  const ttl = key => Number(cli('PTTL', `security:v2:${key}`));
  assert.ok(ttl('invite-reusable:REUSE1') > 86_000_000 && ttl('invite-reusable:REUSE1') <= 86_400_000);

  await pollCount('REUSE1', owner.token);
  const join = () => call('connect','POST',{sessionId:'REUSE1',deviceId:'mobile-test',deviceType:'mobile',pairingCode});
  const joins = await Promise.all([join(), join(), join(), join()]);
  const ok = joins.filter(r => r.code === 200);
  assert.equal(ok.length, 3);
  assert.deepEqual(ok.map(r => r.data.data.pairing.usesLeft).sort(), [0, 1, 2]);
  const refused = joins.find(r => r.code !== 200);
  assert.equal(refused.code, 403);
  assert.equal(refused.data.errorCode, 'PAIRING_CODE_USED_UP');
  const usesKey = cli('KEYS', 'security:v2:invite-uses:*');
  assert.ok(Number(cli('PTTL', usesKey)) > 86_000_000, 'the use counter expires with the session');

  const poll = await call('poll','GET',{},owner.token,{sessionId:'REUSE1',limit:'20'});
  const notices = poll.data.data.messages.filter(m => m.type === 'device_paired');
  assert.equal(notices.length, 3);
  assert.ok(notices.every(m => m.from === 'relay' && m.to === 'pc'));
  assert.deepEqual(notices.map(m => m.data.deviceId).sort(), ok.map(r => r.data.data.deviceId).sort());
  assert.deepEqual(notices.map(m => m.data.usesLeft).sort(), [0, 1, 2]);
  assert.ok(!JSON.stringify(notices).includes(pairingCode) && !ok.some(r => JSON.stringify(notices).includes(r.data.data.token)));

  const fresh = (await call('pair','POST',{sessionId:'REUSE1',reusable:true},owner.token)).data.data.pairingCode;
  assert.equal((await join()).code, 403, 'the used-up code stays refused');
  const replaced = await call('connect','POST',{sessionId:'REUSE1',deviceId:'mobile-test',deviceType:'mobile',pairingCode:fresh});
  assert.equal(replaced.code,200,replaced.data?.error);
  await call('disconnect','POST',{sessionId:'REUSE1'},owner.token);
  assert.equal(cli('EXISTS','security:v2:invite-reusable:REUSE1'),'0', 'revoking the session drops its code');
  const afterRevoke = await call('connect','POST',{sessionId:'REUSE1',deviceId:'mobile-test',deviceType:'mobile',pairingCode:fresh});
  assert.equal(afterRevoke.code,403);
});

test('real Redis: a single-use pairing also tells the Mac', { timeout: 45000 }, async () => {
  const owner = await createPc('NOTE01');
  await pollCount('NOTE01', owner.token);
  const phone = await pairPhone('NOTE01', owner.token);
  const poll = await call('poll','GET',{},owner.token,{sessionId:'NOTE01'});
  assert.deepEqual(poll.data.data.messages.map(m => [m.type, m.from, m.data.deviceId, m.data.reusable, m.data.usesLeft]),
    [['device_paired', 'relay', phone.deviceId, false, 0]]);
});

test('real Redis: oversized phone commands are rejected with 413 before anything is queued', { timeout: 45000 }, async () => {
  const { token: pcToken } = await createPc('SIZE01');
  const phone = await pairPhone('SIZE01', pcToken);
  assert.equal(await pollCount('SIZE01', pcToken), 1, 'the device_paired notice');
  const big = 'x'.repeat(300 * 1024);
  const rejected = await call('send','POST',{sessionId:'SIZE01',...command('agent_prompt', { newChat: true, text: big })},phone.token);
  assert.equal(rejected.code,413);
  assert.equal(rejected.data.errorCode,'PAYLOAD_TOO_LARGE');
  assert.equal(await pollCount('SIZE01', pcToken), 0);
  const reply = await call('send','POST',{sessionId:'SIZE01',...command('file_diff', { diff: big, targetDeviceId: phone.deviceId })},pcToken);
  assert.equal(reply.code,200,'Mac replies keep their larger limit');
  assert.equal(await pollCount('SIZE01', phone.token), 1);
});

test('real Redis: session state expires with the credential instead of sliding', { timeout: 45000 }, async () => {
  const owner = await createPc('EXPIR1');
  const phone = await pairPhone('EXPIR1', owner.token);
  await pollCount('EXPIR1', owner.token);
  await call('connect','POST',{sessionId:'EXPIR1',deviceId:'pc-EXPIR1',deviceType:'pc'},owner.token);
  await call('heartbeat','GET',{},owner.token,{sessionId:'EXPIR1'});
  for (const key of ['session:EXPIR1','session:EXPIR1:mobiles','session:EXPIR1:pc-seen']) {
    assert.equal(Number(cli('PEXPIRETIME', key)), owner.credentialExpiresAt, key);
  }
  assert.ok(phone.deviceId);
});
