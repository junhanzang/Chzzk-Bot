'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { MediaGateway, validateUpstream, validateReferer } = require('../lib/media-gateway.cjs');

const REFERER = 'https://chzzk.naver.com/live/testchannel';
const ROOT = 'https://video.pstatic.net/live/master.m3u8?token=private';
const KEY = 'https://api.chzzk.naver.com/service/v1/encryption/lives/123/aes_key?token=private-key';
const playlist = text => new Response(text, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function setup(t, fetchImpl, options = {}) {
  const gateway = new MediaGateway({ fetchImpl, ...options });
  await gateway.start();
  t.after(() => gateway.close());
  return gateway;
}

test('upstream and referer validation reject SSRF, credentials, unexpected ports and key paths', () => {
  assert.equal(validateUpstream(KEY), KEY);
  assert.equal(validateUpstream('https://pstatic.net/a.ts'), 'https://pstatic.net/a.ts');
  for (const url of ['http://video.pstatic.net/a.ts', 'https://127.0.0.1/a.ts', 'https://localhost/a.ts',
    'https://pstatic.net.evil.test/a', 'https://evilpstatic.net/a', 'https://u:p@video.pstatic.net/a',
    'https://video.pstatic.net:444/a', 'https://api.chzzk.naver.com/service/v1/live-detail',
    'https://api.chzzk.naver.com/service/v1/encryption/lives/a/aes_key',
    'https://api.chzzk.naver.com/service/v1/encryption/lives/123/aes_key/extra', 'file:///secret']) {
    assert.throws(() => validateUpstream(url), /허용되지/);
  }
  for (const value of ['https://evil.test/live/a', `${REFERER}?token=private`, 'http://chzzk.naver.com/live/a']) {
    assert.throws(() => validateReferer(value), /올바르지/);
  }
});

test('rewrites master, relative media, URI attributes and key URLs using session-scoped credentials', async t => {
  const calls = [];
  const gateway = await setup(t, async (url, options) => {
    calls.push({ url, options });
    if (url === ROOT) return playlist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant.m3u8\n');
    if (url.endsWith('/variant.m3u8')) return playlist(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="${KEY}"\n#EXT-X-MAP:URI="../init.mp4"\n#EXTINF:2,\n../segment.ts?signature=hidden\n`);
    if (url === KEY) return new Response(Buffer.from('0123456789abcdef'));
    return new Response('media');
  });
  const lease = gateway.createStream(ROOT, { referer: REFERER });
  assert.ok(lease.url.endsWith('.m3u8'));
  const master = await fetch(lease.url);
  assert.equal(master.headers.get('cache-control'), 'no-store');
  assert.equal(master.headers.get('access-control-allow-origin'), null);
  const text = await master.text();
  assert.ok(!text.includes('pstatic.net'));
  assert.ok(!text.includes('private'));
  assert.match(text, /URI="http:\/\/127\.0\.0\.1:/);
  const variantUrl = text.split('\n').find(line => line.startsWith('http:'));
  const variant = await (await fetch(variantUrl)).text();
  const keyUrl = /EXT-X-KEY:[^\n]*URI="([^"]+)"/.exec(variant)[1];
  assert.ok(keyUrl.endsWith('.key'));
  assert.equal(await (await fetch(keyUrl)).text(), '0123456789abcdef');
  assert.ok(!variant.includes('private-key'));
  assert.ok(!variant.includes('signature=hidden'));
  for (const call of calls) {
    assert.equal(call.options.credentials, 'include');
    assert.equal(call.options.redirect, 'manual');
    assert.equal(call.options.cache, 'no-store');
    assert.deepEqual(call.options.headers, { Referer: 'https://chzzk.naver.com/' });
    assert.ok(call.options.signal instanceof AbortSignal);
  }
  lease.close();
  assert.equal((await fetch(keyUrl)).status, 404);
});

test('binary Range and HEAD work without forwarding browser cookies or upstream Set-Cookie', async t => {
  const calls = [];
  const gateway = await setup(t, async (url, options) => {
    calls.push(options);
    return new Response(options.method === 'HEAD' ? null : 'abcd', { status: 206, headers: {
      'Content-Range': 'bytes 0-3/10', 'Accept-Ranges': 'bytes', 'Content-Length': '4', 'Content-Type': 'video/mp2t', 'Set-Cookie': 'secret-cookie',
    } });
  });
  const lease = gateway.createStream('https://video.pstatic.net/segment.ts', { referer: REFERER });
  const response = await fetch(lease.url, { headers: { Range: 'bytes=0-3', Cookie: 'private-browser-cookie' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-3/10');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await response.text(), 'abcd');
  assert.deepEqual(calls[0].headers, { Referer: 'https://chzzk.naver.com/', Range: 'bytes=0-3' });
  const head = await fetch(lease.url, { method: 'HEAD' });
  assert.equal(head.status, 206);
  assert.equal(await head.text(), '');
});

test('m3u8 Range requests fetch a complete upstream playlist and return rewritten status 200', async t => {
  const calls = [];
  const gateway = await setup(t, async (_url, options) => {
    calls.push(options);
    if (options.headers.Range) return new Response('#EXTM3U\n', { status: 206, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
    return playlist('#EXTM3U\n#EXTINF:2,\nsegment.ts?token=private\n');
  });
  const lease = gateway.createStream(ROOT, { referer: REFERER });
  const response = await fetch(lease.url, { headers: { Range: 'bytes=0-' } });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Range, undefined);
  const text = await response.text();
  assert.ok(text.startsWith('#EXTM3U\n'));
  assert.match(text, /http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\/[a-f0-9]+\.ts/);
  assert.ok(!text.includes('token='));
});

test('fragmented CHZZK HLS preserves m4s initialization and m4v segment extensions for FFmpeg', async t => {
  const calls = [];
  const gateway = await setup(t, async url => {
    calls.push(url);
    if (url === ROOT) return playlist(`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="init.m4s?token=init-secret"\n#EXT-X-KEY:METHOD=AES-128,URI="${KEY}"\n#EXTINF:2,\nfragment.m4v?token=segment-secret\n`);
    return new Response('fragment-bytes');
  });
  const lease = gateway.createStream(ROOT, { referer: REFERER });
  const text = await (await fetch(lease.url)).text();
  const mapUrl = /EXT-X-MAP:URI="([^"]+)"/.exec(text)[1];
  const segmentUrl = text.split('\n').find(line => line.startsWith('http:'));
  assert.ok(mapUrl.endsWith('.m4s'));
  assert.ok(segmentUrl.endsWith('.m4v'));
  assert.ok(!text.includes('.bin'));
  assert.ok(!text.includes('token='));
  assert.equal(await (await fetch(mapUrl)).text(), 'fragment-bytes');
  assert.equal(await (await fetch(segmentUrl)).text(), 'fragment-bytes');
  assert.equal(new URL(calls[1]).pathname, '/live/init.m4s');
  assert.equal(new URL(calls[2]).pathname, '/live/fragment.m4v');
});

test('upstream denial statuses are preserved with generic bodies and no credential leakage', async t => {
  let status = 401;
  const gateway = await setup(t, async () => new Response('https://secret.test/?token=private Cookie: hidden', { status }));
  const lease = gateway.createStream(KEY, { referer: REFERER });
  for (status of [401, 403, 404, 500]) {
    const response = await fetch(lease.url);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), '미디어 요청을 처리하지 못했습니다.');
  }
});

test('redirects are limited to three and every destination is validated before fetching', async t => {
  const calls = [];
  let mode = 'valid';
  const gateway = await setup(t, async url => {
    calls.push(url);
    if (mode === 'blocked') return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/secret' } });
    const index = Number(new URL(url).searchParams.get('hop') || 0);
    if (index < (mode === 'valid' ? 3 : 4)) return new Response(null, { status: 302, headers: { Location: `/segment.ts?hop=${index + 1}` } });
    return new Response('video');
  });
  const lease = gateway.createStream('https://video.pstatic.net/segment.ts', { referer: REFERER });
  assert.equal(await (await fetch(lease.url)).text(), 'video');
  assert.equal(calls.length, 4);
  mode = 'blocked'; calls.length = 0;
  assert.equal((await fetch(lease.url)).status, 502);
  assert.equal(calls.length, 1);
  mode = 'loop'; calls.length = 0;
  assert.equal((await fetch(lease.url)).status, 502);
  assert.equal(calls.length, 4);
});

test('missing tokens, external origins, forged hosts and closed leases cannot make upstream requests', async t => {
  let calls = 0;
  const gateway = await setup(t, async () => { calls++; return new Response('media'); });
  const lease = gateway.createStream('https://video.pstatic.net/segment.ts', { referer: REFERER });
  assert.equal((await fetch(new URL('/', lease.url))).status, 404);
  assert.equal((await fetch(lease.url, { headers: { Origin: 'https://evil.test' } })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    http.get(lease.url, { headers: { Host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await fetch(lease.url, { method: 'POST' })).status, 405);
  lease.close();
  assert.equal((await fetch(lease.url)).status, 404);
  assert.equal(calls, 0);
});

test('playlist size and resource-map limits are bounded; old entries expire after three minutes', async t => {
  let text = '#EXTM3U\n' + 'x'.repeat(1024 * 1024);
  const gateway = await setup(t, async () => playlist(text));
  const lease = gateway.createStream(ROOT, { referer: REFERER });
  assert.equal((await fetch(lease.url)).status, 502);
  text = '#EXTM3U\n' + Array.from({ length: 2001 }, (_, i) => `${i}.ts`).join('\n');
  assert.equal((await fetch(lease.url)).status, 502);
  const state = [...gateway._leases.values()][0];
  assert.equal(state.resources.size, 2000);
  gateway._prune(state);
  assert.equal(state.resources.size, 2000);
  for (const resource of state.resources.values()) resource.touchedAt = Date.now() - 181000;
  gateway._prune(state);
  assert.equal(state.resources.size, 1); // The lease's root is pinned for repeated live refreshes.
});

test('timeout aborts an upstream fetch and returns a safe gateway timeout', async t => {
  const aborted = deferred();
  const gateway = await setup(t, (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted.resolve(); reject(new Error('private-url')); }, { once: true });
  }), { requestTimeoutMs: 40 });
  const lease = gateway.createStream(ROOT, { referer: REFERER });
  const response = await fetch(lease.url);
  assert.equal(response.status, 504);
  assert.equal(await response.text(), '미디어 요청을 처리하지 못했습니다.');
  await aborted.promise;
});

test('closing a binary client cancels its upstream stream and fetch signal', async t => {
  const aborted = deferred();
  const bodyCancelled = deferred();
  const gateway = await setup(t, async (_url, { signal }) => {
    signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('first-chunk')); },
      cancel() { bodyCancelled.resolve(); },
    }), { headers: { 'content-type': 'video/mp2t' } });
  });
  const lease = gateway.createStream('https://video.pstatic.net/segment.ts', { referer: REFERER });
  await new Promise((resolve, reject) => {
    const request = http.get(lease.url, response => {
      response.once('data', () => { request.destroy(); resolve(); });
      response.on('error', () => {});
    });
    request.on('error', reject);
  });
  await aborted.promise;
  await bodyCancelled.promise;
});

test('the request timeout also cancels a stalled binary body after headers have arrived', async t => {
  const aborted = deferred();
  const bodyCancelled = deferred();
  const gateway = await setup(t, async (_url, { signal }) => {
    signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('incomplete-video')); },
      cancel() { bodyCancelled.resolve(); },
    }), { headers: { 'content-type': 'video/mp2t' } });
  }, { requestTimeoutMs: 80 });
  const lease = gateway.createStream('https://video.pstatic.net/segment.ts', { referer: REFERER });
  const response = await fetch(lease.url);
  await assert.rejects(response.arrayBuffer());
  await aborted.promise;
  await bodyCancelled.promise;
});

test('lease and gateway shutdown abort pending requests and dispose opaque URLs', async t => {
  const entered = [];
  const gateway = await setup(t, (_url, { signal }) => new Promise((_resolve, reject) => {
    const item = { signal, ready: deferred() };
    entered.push(item);
    signal.addEventListener('abort', () => { item.ready.resolve(); reject(new Error('cancelled private source')); }, { once: true });
  }));
  const first = gateway.createStream(ROOT, { referer: REFERER });
  const request = fetch(first.url);
  while (!entered.length) await new Promise(resolve => setImmediate(resolve));
  first.close();
  assert.equal((await request).status, 503);
  await entered[0].ready.promise;
  assert.equal(entered[0].signal.aborted, true);
  assert.equal(gateway._leases.size, 0);

  const second = gateway.createStream(ROOT, { referer: REFERER });
  const pending = fetch(second.url).catch(() => null);
  while (entered.length < 2) await new Promise(resolve => setImmediate(resolve));
  await gateway.close();
  await pending;
  assert.equal(entered[1].signal.aborted, true);
  assert.equal(gateway._leases.size, 0);
  assert.throws(() => gateway.createStream(ROOT, { referer: REFERER }), /먼저 시작/);
});
