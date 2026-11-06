'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { FollowingSession } = require('../lib/following-session.cjs');
const { CATEGORY_ENDPOINT } = require('../../browser-extension/shared/following.js');
const { AuthSession } = require('../lib/auth-session.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const id = n => n.toString(16).padStart(32, '0');
const response = n => new Response(JSON.stringify({ code: 200, content: { totalPage: 1, followingList: [{ channelId: id(n), channel: { channelName: `채널 ${n}` }, streamer: { openLive: false } }] } }));
const create = ({ fetchImpl, ...options }) => new FollowingSession({ ...options, fetchImpl: (url, args) => url === CATEGORY_ENDPOINT
  ? Promise.resolve(new Response(JSON.stringify({ code: 200, content: { followingList: [] } }))) : fetchImpl(url, args) });
class FakeAuth extends EventEmitter {
  constructor(status = 'checking') { super(); this.state = { status, nickname: 'private' }; this.calls = 0; }
  update(status) { this.state.status = status; this.emit('change', { ...this.state }); }
  async refresh() { this.calls++; this.update('checking'); this.update('signed_in'); return this.state; }
}

test('signed-in auth loads the list without inspecting any account details or cookies', async t => {
  const auth = new FakeAuth(), seen = []; let calls = 0, options;
  const following = create({ auth, fetchImpl: async (_url, request) => { calls++; options = request; return response(1); }, onChange: state => seen.push(state) }); t.after(() => following.close());
  assert.equal(calls, 0); assert.equal(following.snapshot().status, 'idle');
  auth.update('signed_in'); await tick(); assert.equal(calls, 1); assert.equal(following.snapshot().status, 'ready');
  assert(!JSON.stringify(seen).includes('private')); assert.equal(auth.calls, 0);
  assert.deepEqual(options.headers, { Accept: 'application/json', Referer: 'https://chzzk.naver.com/', Origin: 'https://chzzk.naver.com' });
});

test('manual refresh rechecks auth, coalesces callers and performs one following fetch', async t => {
  const auth = new FakeAuth('signed_out'), gate = deferred(); let calls = 0;
  const following = create({ auth, fetchImpl: () => { calls++; return gate.promise; } }); t.after(() => following.close());
  const first = following.refresh(); assert.equal(following.refresh(), first); await tick();
  assert.equal(auth.calls, 1); assert.equal(calls, 1); gate.resolve(response(1));
  assert.equal((await first).status, 'ready'); assert.equal(calls, 1);
});

test('auth checking and signout clear the list immediately and cancel stale account requests', async t => {
  const auth = new FakeAuth(), old = deferred(), options = []; let calls = 0;
  const following = create({ auth, fetchImpl: (_url, request) => { calls++; options.push(request); return calls === 2 ? old.promise : response(calls); } }); t.after(() => following.close());
  auth.update('signed_in'); await tick(); assert.equal(following.snapshot().channels[0].id, id(1));
  auth.update('checking'); assert.deepEqual(following.snapshot().channels, []);
  auth.update('signed_in'); await tick(); assert.equal(following.snapshot().status, 'loading');
  auth.update('signed_out'); assert.equal(options[1].signal.aborted, true); assert.equal(following.snapshot().status, 'signed_out');
  auth.update('signed_in'); await tick(); assert.equal(following.snapshot().channels[0].id, id(3));
  old.resolve(response(2)); await tick(); assert.equal(following.snapshot().channels[0].id, id(3));
});

test('rechecking the same account after a login window closes reloads its follow changes', async t => {
  const auth = new FakeAuth(); let calls = 0;
  const following = create({ auth, fetchImpl: async () => response(++calls) }); t.after(() => following.close());
  auth.update('signed_in'); await tick(); await auth.refresh(); await tick();
  assert.equal(calls, 2); assert.equal(following.snapshot().channels[0].id, id(2));
});

test('failed or signed-out auth never requests a following list and public errors omit exception text', async t => {
  for (const status of ['signed_out', 'error', 'throw']) {
    const auth = new FakeAuth(); let calls = 0;
    auth.refresh = async () => { auth.update('checking'); if (status === 'throw') throw new Error('secret'); auth.update(status); };
    const following = create({ auth, fetchImpl: async () => { calls++; return response(1); } }); t.after(() => following.close());
    const state = await following.refresh(); assert.equal(state.status, status === 'signed_out' ? 'signed_out' : 'error');
    assert.equal(calls, 0); assert(!JSON.stringify(state).includes('secret'));
  }
});

test('closing detaches its auth listener and a late auth check cannot start a fetch', async () => {
  const auth = new FakeAuth(), gate = deferred(); let calls = 0;
  auth.refresh = async () => { auth.update('checking'); await gate.promise; auth.update('signed_in'); };
  const following = create({ auth, fetchImpl: async () => { calls++; return response(1); } });
  assert.equal(auth.listenerCount('change'), 1); const pending = following.refresh(); following.close(); following.close();
  assert.equal(auth.listenerCount('change'), 0); gate.resolve(); await pending; await following.refresh();
  assert.equal(calls, 0); assert.deepEqual(following.snapshot().channels, []);
});

test('real AuthSession lifecycle and manual following refresh have no duplicate request or recursive auth check', async t => {
  let checks = 0, follows = 0;
  const auth = new AuthSession({ session: { fetch: async () => { checks++; return { ok: true, json: async () => ({ content: { loggedIn: true, nickname: 'private' } }) }; } } });
  const following = create({ auth, fetchImpl: async () => { follows++; return response(follows); } });
  t.after(() => { following.close(); auth.close(); });
  await following.refresh(); assert.equal(checks, 1); assert.equal(follows, 1);
  await auth.refresh(); await tick(); assert.equal(checks, 2); assert.equal(follows, 2);
  await following.refresh(); assert.equal(checks, 3); assert.equal(follows, 3);
});

test('the app fetch adapter uses the same fixed headers for categories and clears both lists when auth changes', async t => {
  const auth = new FakeAuth(), calls = [];
  const following = new FollowingSession({ auth, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return url === CATEGORY_ENDPOINT ? new Response(JSON.stringify({ code: 200, content: { followingList: [
      { categoryId: 'League_of_Legends', categoryType: 'GAME', categoryValue: '리그 오브 레전드' }
    ] } })) : response(1);
  } }); t.after(() => following.close());
  const state = await following.refresh(); assert.equal(calls.length, 2); assert.equal(state.categories.length, 1); assert.equal(state.channels.length, 1);
  const categoryCall = calls.find(call => call.url === CATEGORY_ENDPOINT);
  assert.deepEqual(categoryCall.options.headers, { Accept: 'application/json', Referer: 'https://chzzk.naver.com/', Origin: 'https://chzzk.naver.com' });
  auth.update('checking'); assert.deepEqual(following.snapshot().categories, []); assert.deepEqual(following.snapshot().channels, []);
  assert.equal(following.snapshot().categoryStatus, 'idle');
});
