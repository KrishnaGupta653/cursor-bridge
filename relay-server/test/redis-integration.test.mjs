import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

// Uses an isolated local Redis over a private Unix socket, never a configured service.
test('real Redis: authenticated create/pair/send/poll/revoke lifecycle', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cursor-relay-test-'));
  const socket = join(dir, 'redis.sock');
  const child = spawn('redis-server', ['--port','0','--unixsocket',socket,'--unixsocketperm','700',
    '--save','','--appendonly','no','--dir',dir], { stdio: 'ignore' });
  let childError;
  child.on('error', error => { childError = error; });
  const encode = value => typeof value === 'string' ? Buffer.from(value).toString('base64')
    : Array.isArray(value) ? value.map(encode) : value;
  const bridge = http.createServer(async (req, res) => {
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
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (childError) throw childError;
      try { await access(socket); ready = true; break; } catch { await new Promise(r => setTimeout(r, 50)); }
    }
    assert.ok(ready, 'Local Redis did not start');
    bridge.listen(0,'127.0.0.1'); await once(bridge,'listening');
    delete process.env.SUPABASE_URL;
    process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${bridge.address().port}`;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'local-fixture-only';
    const call = async (name, method, body = {}, token, query = {}) => {
      const handler = (await import(`../.test-dist/api/${name}.js`)).default;
      const req = { method, body, query, headers: token ? {authorization:`Bearer ${token}`} : {}, socket:{remoteAddress:'127.0.0.1'} };
      const res = { code:0, data:null, setHeader() {}, status(code) {this.code=code;return this;},
        json(data) {this.data=data;return this;}, end(){return this;} };
      await handler(req,res); return res;
    };
    const owner = await call('session','POST',{sessionId:'REDIS1',deviceId:'pc-test',deviceType:'pc'});
    assert.equal(owner.code,201, owner.data?.error);
    const pcToken = owner.data.data.token;
    const second = await call('session','POST',{sessionId:'REDIS2',deviceId:'pc-other',deviceType:'pc'});
    assert.equal(second.code,201, second.data?.error);
    const invite = await call('pair','POST',{sessionId:'REDIS1'},pcToken);
    assert.equal(invite.code,200,invite.data?.error);
    const joined = await call('connect','POST',{sessionId:'REDIS1',deviceId:'mobile-test',deviceType:'mobile',pairingCode:invite.data.data.pairingCode});
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
    const disabled = await call('resolve-command-approval','POST',{sessionId:'REDIS1'},mobileToken);
    assert.equal(disabled.code,403);
    const disconnected = await call('disconnect','POST',{sessionId:'REDIS1'},pcToken);
    assert.equal(disconnected.code,200,disconnected.data?.error);
    const revoked = await call('poll','GET',{},mobileToken,{sessionId:'REDIS1'});
    assert.equal(revoked.code,401);
    const other = await call('poll','GET',{},second.data.data.token,{sessionId:'REDIS2'});
    assert.equal(other.code,200,other.data?.error);
  } finally {
    bridge.closeAllConnections();
    if (bridge.listening) await new Promise(r => bridge.close(r));
    if (child.pid && child.exitCode === null) { const done = once(child,'exit'); child.kill('SIGTERM'); await done; }
    await rm(dir,{recursive:true,force:true});
  }
});
