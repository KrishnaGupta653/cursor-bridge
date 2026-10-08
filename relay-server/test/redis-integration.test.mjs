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
  assert.equal(poll.data.data.messages.length,1);
  assert.equal(poll.data.data.messages[0].senderDeviceId,joined.data.data.deviceId);
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

test('real Redis: oversized phone commands are rejected with 413 before anything is queued', { timeout: 45000 }, async () => {
  const { token: pcToken } = await createPc('SIZE01');
  const phone = await pairPhone('SIZE01', pcToken);
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
