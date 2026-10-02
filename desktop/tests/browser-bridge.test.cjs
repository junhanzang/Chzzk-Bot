'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { BrowserBridge, BridgeUserError } = require('../lib/browser-bridge.cjs');

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, handlers = {}, options = {}) {
  const bridge = new BrowserBridge({ handlers: { getState: () => ({ connected: true }), ...handlers }, ...options });
  const code = await bridge.start();
  const [port, token] = code.split(':');
  t.after(() => bridge.close());
  return { bridge, port: Number(port), token };
}

function request(f, { method = 'POST', url = '/rpc', headers = {}, body = { method: 'getState' }, raw,
  omit = [], stream } = {}) {
  const requestHeaders = { Origin: ORIGIN, Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json', ...headers };
  for (const name of omit) delete requestHeaders[name];
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.port, path: url, method, headers: requestHeaders }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null });
      });
      response.once('error', reject);
    });
    req.once('error', reject);
    if (stream) stream(req);
    else req.end(raw === undefined ? JSON.stringify(body) : raw);
  });
}

test('loopback RPC passes the argument and returns only the handler result', async t => {
  const calls = [];
  const f = await fixture(t, { addChannel: arg => { calls.push(arg); return { saved: arg.input }; } });
  assert.match(f.bridge.connectionCode, /^[1-9]\d*:[a-f\d]{48}$/);
  const result = await request(f, { body: { method: 'addChannel', arg: { input: 'channel-id', name: 'channel' } } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, value: { saved: 'channel-id' } });
  assert.deepEqual(calls, [{ input: 'channel-id', name: 'channel' }]);
  assert.equal(result.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(result.headers['cache-control'], 'no-store');
  const health = await request(f, { method: 'GET', url: '/health', omit: ['Authorization'], raw: '' });
  assert.deepEqual(health.body, { ok: true });
  assert.ok(!JSON.stringify(result).includes(f.token));
});

test('missing/wrong authentication, foreign origins and forged hosts never call handlers', async t => {
  let called = 0;
  const f = await fixture(t, { getState: () => { called++; return {}; } });
  for (const opts of [{ omit: ['Authorization'] }, { headers: { Authorization: `Bearer ${'0'.repeat(48)}` } },
    { headers: { Authorization: 'Bearer short' } }]) assert.equal((await request(f, opts)).status, 401);
  for (const origin of ['https://chzzk.naver.com', 'http://localhost', 'null', `${ORIGIN}/`, `chrome-extension://${'z'.repeat(32)}`]) {
    const result = await request(f, { headers: { Origin: origin } });
    assert.equal(result.status, 403);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await request(f, { omit: ['Origin'] })).status, 403);
  assert.equal((await request(f, { headers: { Host: `localhost:${f.port}` } })).status, 403);
  assert.equal((await request(f, { headers: { Host: `evil.example:${f.port}` } })).status, 403);
  assert.equal(called, 0);
});

test('preflight is narrow and does not require disclosing the pairing token', async t => {
  const f = await fixture(t);
  const opts = { method: 'OPTIONS', omit: ['Authorization'], raw: '', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } };
  const result = await request(f, opts);
  assert.equal(result.status, 204);
  assert.equal(result.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(result.headers['access-control-allow-methods'], 'POST');
  assert.equal(result.headers['access-control-allow-headers'], 'authorization, content-type');
  assert.equal((await request(f, { ...opts, headers: { ...opts.headers, 'Access-Control-Request-Headers': 'cookie' } })).status, 403);
  assert.equal((await request(f, { ...opts, headers: { ...opts.headers, 'Access-Control-Request-Method': 'GET' } })).status, 403);
});

test('unknown, prototype and filesystem commands plus malformed/oversized bodies are rejected', async t => {
  let called = 0;
  const f = await fixture(t, { getState: () => { called++; }, arbitrary: () => { called++; } });
  for (const method of ['constructor', 'toString', '__proto__', 'arbitrary', 'openPath', 'openExternal']) {
    assert.equal((await request(f, { body: { method, arg: 'file:///private' } })).status, 400);
  }
  for (const raw of ['{', 'null', '[]']) assert.equal((await request(f, { raw })).status, 400);
  assert.equal((await request(f, { method: 'GET', raw: '' })).status, 405);
  assert.equal((await request(f, { url: '/rpc?token=anything' })).status, 404);
  assert.equal((await request(f, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request(f, { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await request(f, { raw: 'x'.repeat(65537) })).status, 413);
  assert.equal((await request(f, { headers: { 'Content-Length': '65537' }, raw: '' })).status, 413);
  assert.equal(called, 0);
});

test('rotation invalidates old credentials, including a request uploading during revocation', async t => {
  let called = 0;
  const f = await fixture(t, { getState: () => { called++; return {}; } });
  const newCode = f.bridge.rotateToken();
  assert.notEqual(newCode, `${f.port}:${f.token}`);
  assert.equal((await request(f)).status, 401);
  const current = { ...f, token: newCode.split(':')[1] };
  assert.equal((await request(current)).status, 200);
  const slow = await request(current, { stream: req => {
    req.write('{"method":');
    setTimeout(() => { f.bridge.rotateToken(); req.end('"getState"}'); }, 15);
  } });
  assert.equal(slow.status, 401);
  assert.equal(called, 1);
});

test('internal errors are generic while explicitly public errors remain useful', async t => {
  const f = await fixture(t, { getState: () => { throw new Error('secret file and token'); },
    saveClip: () => { throw new BridgeUserError('아직 저장할 구간이 부족합니다.'); } });
  const internal = await request(f);
  assert.equal(internal.body.ok, false);
  assert.ok(!internal.body.error.includes('secret'));
  const exposed = await request(f, { body: { method: 'saveClip', arg: { slotId: 0 } } });
  assert.equal(exposed.body.error, '아직 저장할 구간이 부족합니다.');
});

test('slow request bodies expire without invoking commands', async t => {
  let called = 0;
  const f = await fixture(t, { getState: () => { called++; } }, { bodyTimeoutMs: 40 });
  const result = await request(f, { stream: req => req.write('{') });
  assert.equal(result.status, 408);
  assert.equal(called, 0);
});

test('close waits for an active command, closes the listener and can be repeated', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { saveClip: async () => { entered.resolve(); await release.promise; return { saved: true }; } });
  const pending = request(f, { body: { method: 'saveClip' } });
  await entered.promise;
  let completed = false;
  const close = f.bridge.close().then(value => { completed = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(completed, false);
  assert.equal(f.bridge.connectionCode, null);
  await assert.rejects(request(f));
  release.resolve();
  assert.deepEqual((await pending).body, { ok: true, value: { saved: true } });
  assert.deepEqual(await close, { drained: true });
  assert.deepEqual(await f.bridge.close(), { drained: true });
  await assert.rejects(f.bridge.start());
});

test('close is bounded if a handler never settles, without accepting more commands', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { saveClip: async () => { entered.resolve(); await release.promise; } }, { drainTimeoutMs: 40 });
  const pending = request(f, { body: { method: 'saveClip' } }).catch(() => null);
  await entered.promise;
  assert.deepEqual(await f.bridge.close(), { drained: false });
  assert.equal(await pending, null);
  await assert.rejects(request(f));
  release.resolve();
});

test('active command count is bounded', async t => {
  const entered = deferred(), release = deferred();
  let count = 0;
  const f = await fixture(t, { saveClip: async () => { if (++count === 8) entered.resolve(); await release.promise; return true; } });
  const pending = Array.from({ length: 8 }, () => request(f, { body: { method: 'saveClip' } }));
  await entered.promise;
  assert.equal((await request(f, { body: { method: 'saveClip' } })).status, 429);
  release.resolve();
  assert.ok((await Promise.all(pending)).every(result => result.status === 200));
});
