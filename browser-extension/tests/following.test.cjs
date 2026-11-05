'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FollowingService, parseFollowingPage, ENDPOINT, PAGE_SIZE, MAX_PAGES } = require('../shared/following.js');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const id = n => n.toString(16).padStart(32, '0');
const row = (n, live = false) => ({ channelId: id(n), channel: { channelId: id(n), channelName: `채널 ${n}` }, streamer: { openLive: live }, liveInfo: live ? { liveTitle: `방송 ${n}` } : null });
const body = (rows = [], totalPage = 1) => ({ code: 200, content: { followingList: rows, totalPage } });
const response = (data = body(), status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const create = (fetchImpl, options = {}) => new FollowingService({ fetchImpl, ...options });

test('following rows normalize only display fields with both known channel ID locations', () => {
  const first = row(1, true); first.channel.channelName = '\n 한글\u0000 채널 '; first.liveInfo.liveTitle = ' 제목\n ';
  first.nickname = 'private'; first.token = 'secret'; delete first.channel.channelId;
  const second = row(2); delete second.channelId; delete second.streamer; second.channel.openLive = false;
  assert.deepEqual(parseFollowingPage(body([first, second]), 0), { totalPages: 1, channels: [
    { id: id(1), name: '한글 채널', live: true, title: '제목' }, { id: id(2), name: '채널 2', live: false }
  ] });
  assert.deepEqual(parseFollowingPage(body([], 0), 0), { totalPages: 1, channels: [] });
});

test('all pages publish atomically, deduplicate channels and use a fixed credentialed read-only request', async t => {
  const second = deferred(), calls = [], changes = [];
  const service = create((url, options) => { calls.push({ url, options }); return calls.length === 1 ? response(body([row(1), row(2)], 2)) : second.promise; }, { clock: () => 123, onChange: value => changes.push(value) });
  t.after(() => service.close());
  const pending = service.refresh(); assert.equal(service.refresh(), pending);
  await tick(); assert.equal(calls.length, 2); assert.deepEqual(service.snapshot().channels, []);
  second.resolve(response(body([row(2), row(3, true)], 2)));
  const state = await pending;
  assert.equal(state.status, 'ready'); assert.equal(state.updatedAt, 123);
  assert.deepEqual(state.channels.map(channel => channel.id), [id(1), id(2), id(3)]);
  assert.deepEqual(changes.map(change => change.status), ['loading', 'ready']);
  for (const [page, call] of calls.entries()) {
    assert.equal(call.url, `${ENDPOINT}?page=${page}&size=${PAGE_SIZE}&sortType=FOLLOW`);
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.credentials, 'include');
    assert.equal(call.options.cache, 'no-store'); assert.equal(call.options.redirect, 'error');
    assert.deepEqual(call.options.headers, { Accept: 'application/json' });
  }
  state.channels[0].name = 'changed'; assert.equal(service.snapshot().channels[0].name, '채널 1');
});

test('refresh clears the previous account list immediately and does not keep it on failure', async t => {
  const gate = deferred(); let calls = 0;
  const service = create(() => ++calls === 1 ? response(body([row(1)])) : gate.promise); t.after(() => service.close());
  await service.refresh(); const pending = service.refresh();
  assert.equal(service.snapshot().status, 'loading'); assert.deepEqual(service.snapshot().channels, []);
  gate.resolve(response({}, 500)); assert.equal((await pending).status, 'error'); assert.deepEqual(service.snapshot().channels, []);
});

test('empty following list is ready while HTTP and envelope authentication failures are signed_out', async t => {
  const fixtures = [response(body([], 0)), response({}, 401), response({}, 403), response({ code: 401 }), response({ code: 403 })];
  for (const [index, item] of fixtures.entries()) {
    const service = create(async () => item); t.after(() => service.close());
    const state = await service.refresh(); assert.equal(state.status, index ? 'signed_out' : 'ready'); assert.deepEqual(state.channels, []);
  }
});

test('remote payloads and error text never become public messages', async t => {
  for (const transport of [async () => { throw new Error('https://private.example/?token=secret'); }, async () => response({ code: 500, message: 'secret' }), async () => response({ message: 'secret' }, 429)]) {
    const service = create(transport); t.after(() => service.close());
    const state = await service.refresh(); assert.equal(state.status, 'error'); assert(!JSON.stringify(state).includes('secret'));
    assert(!JSON.stringify(state).includes('https://'));
  }
});

test('malformed rows and pagination fail instead of displaying an incomplete or invented list', () => {
  const badId = row(1); badId.channelId = 'https://private.example/';
  const badLive = row(1); badLive.streamer.openLive = 'true';
  const mismatch = row(1); mismatch.channel.channelId = id(2);
  for (const payload of [null, {}, { code: 200 }, body([badId]), body([badLive]), body([mismatch]), body([{ channelId: id(1) }]),
    body([row(1)], 0), body([], -1), body([], 1.5), body([], MAX_PAGES + 1), body([], 2), body(Array(PAGE_SIZE + 1).fill(row(1)))]) {
    assert.throws(() => parseFollowingPage(payload, 0));
  }
  assert.throws(() => parseFollowingPage(body([row(1)]), 1));
});

test('changed or repeated pagination and a failed later page never publish partial results', async t => {
  for (const last of [response(body([row(2)], 3)), response(body([row(1)], 2)), response({}, 500)]) {
    let calls = 0; const states = [];
    const service = create(async () => ++calls === 1 ? response(body([row(1)], 2)) : last, { onChange: state => states.push(state) }); t.after(() => service.close());
    assert.equal((await service.refresh()).status, 'error');
    assert(states.every(state => state.channels.length === 0)); assert.equal(calls, 2);
  }
});

test('bounded response readers reject oversized declared, streamed and fallback bodies', async t => {
  const huge = ' '.repeat(1024 * 1024 + 1);
  const fixtures = [new Response('{}', { headers: { 'content-length': String(huge.length) } }), new Response(huge), { ok: true, status: 200, text: async () => huge }];
  for (const item of fixtures) {
    const service = create(async () => item); t.after(() => service.close());
    const state = await service.refresh(); assert.equal(state.status, 'error'); assert.match(state.message, /한도/);
  }
});

test('clearing aborts old requests and their late response cannot replace the next account list', async t => {
  const first = deferred(), calls = [];
  const service = create((url, options) => { calls.push(options); return calls.length === 1 ? first.promise : response(body([row(2)])); }); t.after(() => service.close());
  const old = service.refresh(); await tick(); service.clear('signed_out');
  assert.equal(calls[0].signal.aborted, true); assert.deepEqual(service.snapshot().channels, []);
  assert.equal((await service.refresh()).channels[0].id, id(2));
  first.resolve(response(body([row(1)]))); await old; await tick();
  assert.equal(service.snapshot().channels[0].id, id(2));
});

test('a delayed response body after clear is not published', async t => {
  const gate = deferred(); const service = create(async () => ({ ok: true, status: 200, json: () => gate.promise })); t.after(() => service.close());
  const pending = service.refresh(); await tick(); service.clear('signed_out');
  gate.resolve(body([row(1)])); await pending; await tick();
  assert.equal(service.snapshot().status, 'signed_out'); assert.deepEqual(service.snapshot().channels, []);
});

test('an ignored abort still times out and close prevents late publishing or future fetches', async () => {
  let calls = 0; const changes = [], service = create(async () => { calls++; return new Promise(() => {}); }, { timeoutMs: 5, onChange: state => changes.push(state) });
  const pending = service.refresh(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await pending).status, 'error'); assert.match(service.snapshot().message, /초과/);
  service.close(); const count = changes.length; await service.refresh(); assert.equal(calls, 1); assert.equal(changes.length, count);
  const gate = deferred(), lateChanges = [], late = create(() => gate.promise, { onChange: state => lateChanges.push(state) });
  const active = late.refresh(); await tick(); late.close(); gate.resolve(response(body([row(1)]))); await active; await tick();
  assert.deepEqual(late.snapshot().channels, []); assert.deepEqual(lateChanges.map(state => state.status), ['loading']);
});

test('observer errors cannot strand request state or block future refreshes', async t => {
  const service = create(async () => response(body([row(1)])), { onChange: () => { throw new Error('observer'); } }); t.after(() => service.close());
  assert.equal((await service.refresh()).status, 'ready'); assert.equal((await service.refresh()).status, 'ready');
});
