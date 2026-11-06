'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { ActivityHost, WORLD_ID } = require('../lib/activity-host.cjs');
const ID = 'a'.repeat(32), liveUrl = `https://chzzk.naver.com/live/${ID}`;
const source = `globalThis.DeskActivity = {
  activityPage: (location, id) => location.origin === 'https://chzzk.naver.com' && location.pathname.startsWith('/live/' + id),
  createActivityObserver(options) { globalThis.observerOptions = options; return {
    start() { globalThis.starts = (globalThis.starts || 0) + 1; }, stop() { globalThis.stops = (globalThis.stops || 0) + 1; },
    drain() { const delta = globalThis.delta || { watchSeconds: 0, chatCount: 0 }; globalThis.delta = null; return delta; }
  }; }
};`;

function fixture({ popup = false } = {}) {
  let url = liveUrl + (popup ? '/chat' : ''), now = 0, destroyed = false;
  const world = vm.createContext({ location: new URL(url), document: {} }), worlds = [], received = [];
  const contents = { isDestroyed: () => destroyed, getURL: () => url,
    async executeJavaScriptInIsolatedWorld(id, scripts) { worlds.push(id); return vm.runInContext(scripts[0].code, world); } };
  const host = new ActivityHost({ source, intervalMs: 0, clock: () => now, onActivity: value => received.push(value) });
  return { host, contents, world, worlds, received, setUrl(value) { url = value; }, destroy() { destroyed = true; },
    advance(ms) { now += ms; }, async delta(value, ms = 5000) { now += ms; world.delta = value; await host.poll(host.entries.get(0)); } };
}

test('host isolates DOM code and delivers only bounded numeric activity with stable generation', async () => {
  const f = fixture(); await f.host.attach(0, f.contents, ID);
  assert.deepEqual(f.worlds, [WORLD_ID, WORLD_ID]); assert.deepEqual(f.received, []);
  await f.delta({ watchSeconds: 5, chatCount: 1, text: 'never forwarded' });
  await f.delta({ watchSeconds: 5, chatCount: 0 });
  assert.equal(f.received.length, 2); assert.equal(f.received[0].watchSeconds, 5); assert.equal(f.received[0].chatCount, 1);
  assert.equal(f.received[0].generation, f.received[1].generation); assert.equal(f.received[1].sequence, 2);
  assert.deepEqual(Object.keys(f.received[0]).sort(), ['key', 'channelId', 'generation', 'sequence', 'watchSeconds', 'chatCount'].sort());
  assert.equal(f.world.require, undefined); assert.equal(f.world.desk, undefined); f.host.close();
});

test('host bounds video time by elapsed time and participation by 30 seconds', async () => {
  const f = fixture(); await f.host.attach(0, f.contents, ID);
  await f.delta({ watchSeconds: 60, chatCount: 2 }, 2000);
  assert.equal(f.received[0].watchSeconds, 2); assert.equal(f.received[0].chatCount, 1);
  await f.delta({ watchSeconds: 0, chatCount: 1 }, 2000); assert.equal(f.received.length, 1);
  await f.delta({ watchSeconds: 0, chatCount: 1 }, 30000); assert.equal(f.received.length, 2); f.host.close();
});

test('host rejects malformed deltas and a chat popup can never claim watch time', async () => {
  const f = fixture({ popup: true }); await f.host.attach(0, f.contents, ID);
  for (const delta of [{ watchSeconds: -1, chatCount: 0 }, { watchSeconds: 61, chatCount: 0 },
    { watchSeconds: 1.5, chatCount: 0 }, { watchSeconds: 0, chatCount: 3 }]) await f.delta(delta);
  assert.equal(f.received.length, 0);
  await f.delta({ watchSeconds: 5, chatCount: 1 }); assert.equal(f.received[0].watchSeconds, 0); f.host.close();
});

test('host refuses unassigned routes and ignores a document after SPA navigation', async () => {
  for (const url of ['https://evil.test/', `https://chzzk.naver.com/live/${'b'.repeat(32)}`, `https://user@chzzk.naver.com/live/${ID}`]) {
    const f = fixture(); f.setUrl(url); await f.host.attach(0, f.contents, ID); assert.equal(f.worlds.length, 0); f.host.close();
  }
  const f = fixture(); await f.host.attach(0, f.contents, ID); f.setUrl(`${liveUrl}/chat`);
  await f.delta({ watchSeconds: 5, chatCount: 1 }); assert.equal(f.received.length, 0); f.host.close();
});

test('detaching during an in-flight drain revokes ownership before the result arrives', async () => {
  const f = fixture(); await f.host.attach(0, f.contents, ID); let resolve;
  const original = f.contents.executeJavaScriptInIsolatedWorld;
  f.contents.executeJavaScriptInIsolatedWorld = () => new Promise(done => { resolve = done; });
  f.advance(5000); const pending = f.host.poll(f.host.entries.get(0));
  f.contents.executeJavaScriptInIsolatedWorld = original; f.host.detach(0);
  resolve({ watchSeconds: 5, chatCount: 1 }); await pending; assert.equal(f.received.length, 0); f.host.close();
});

test('reset discards buffered activity and invalidates in-flight generations before restarting', async () => {
  const f = fixture(); await f.host.attach(0, f.contents, ID); const oldGeneration = f.host.entries.get(0).generation;
  let resolve; const original = f.contents.executeJavaScriptInIsolatedWorld;
  f.contents.executeJavaScriptInIsolatedWorld = () => new Promise(done => { resolve = done; });
  f.advance(5000); const pending = f.host.poll(f.host.entries.get(0));
  f.contents.executeJavaScriptInIsolatedWorld = original; await f.host.reset();
  resolve({ watchSeconds: 5, chatCount: 1 }); await pending;
  assert.notEqual(f.host.entries.get(0).generation, oldGeneration); assert.equal(f.received.length, 0);
  assert.equal(f.world.starts, 2); assert.equal(f.world.stops, 1);
  await f.delta({ watchSeconds: 5, chatCount: 0 }); assert.equal(f.received[0].sequence, 1); f.host.close();
});

test('detach during bootstrap cannot resurrect an observer or emit late activity', async () => {
  const f = fixture(); let resolve; const original = f.contents.executeJavaScriptInIsolatedWorld;
  f.contents.executeJavaScriptInIsolatedWorld = (id, scripts) => new Promise(done => { resolve = async () => done(await original(id, scripts)); });
  const pending = f.host.attach(0, f.contents, ID);
  f.contents.executeJavaScriptInIsolatedWorld = original; f.host.detach(0); await resolve(); await pending;
  assert.equal(f.world.starts, undefined); assert.equal(f.received.length, 0); f.host.close();
});

test('close stops observers and prevents reset or attach from reopening collection', async () => {
  const f = fixture(); await f.host.attach(0, f.contents, ID); f.host.close();
  await f.host.reset(); await f.host.attach(1, f.contents, ID);
  assert.equal(f.world.starts, 1); assert.equal(f.world.stops, 1); assert.equal(f.host.entries.size, 0);
});

test('a document destroyed during isolated-world cleanup cannot interrupt app shutdown', async () => {
  const f = fixture(); await f.host.attach(0, f.contents, ID);
  f.contents.executeJavaScriptInIsolatedWorld = () => { throw new Error('Object has been destroyed'); };
  assert.doesNotThrow(() => f.host.close()); assert.equal(f.host.entries.size, 0);
});
