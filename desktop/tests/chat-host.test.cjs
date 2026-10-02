'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { ChatHost, WORLD_ID } = require('../lib/chat-host.cjs');
const channelId = 'a'.repeat(32);
const source = `globalThis.DeskChat = { createChatObserver(options) {
  globalThis.observerOptions = options;
  return { start() { globalThis.starts = (globalThis.starts || 0) + 1; options.onStatus({ status: 'watching' }); },
    stop() { globalThis.stops = (globalThis.stops || 0) + 1; } };
} };`;

function fixture() {
  let context = { slotId: 0, channelId, generation: 'first' }, url = `https://chzzk.naver.com/live/${channelId}`;
  const world = vm.createContext({ location: new URL(url), document: {}, MutationObserver() {} });
  const received = [], worlds = [];
  const contents = { isDestroyed: () => false, getURL: () => url,
    async executeJavaScriptInIsolatedWorld(id, scripts) { worlds.push(id); return vm.runInContext(scripts[0].code, world); } };
  const host = new ChatHost({ source, intervalMs: 0, context: () => context, onBatch: value => received.push(value) });
  return { host, contents, world, received, worlds, set context(value) { context = value; }, set url(value) { url = value; } };
}

test('desktop chat host uses an isolated read-only world and bounded generation-specific batches', async () => {
  const f = fixture(); await f.host.attach(0, f.contents, channelId);
  assert.deepEqual(f.worlds, [WORLD_ID, WORLD_ID]); assert.equal(f.received[0].sourceStatus, 'watching');
  f.world.observerOptions.onMessages(Array.from({ length: 200 }, (_, i) => ({ id: String(i), text: 'hello' })));
  await f.host.poll(f.host.entries.get(0));
  assert.equal(f.received.at(-1).events.length, 100); assert.equal(f.world.__deskChat.events.length, 0);
  assert.equal(f.world.require, undefined); assert.equal(f.world.desk, undefined);
  f.host.close();
});

test('config generation changes reseed while disabled contexts stop and clear queued text', async () => {
  const f = fixture(); await f.host.attach(0, f.contents, channelId);
  f.world.observerOptions.onMessages([{ id: 'old', text: 'old context' }]);
  f.context = { slotId: 0, channelId, generation: 'second' }; await f.host.poll(f.host.entries.get(0));
  assert.equal(f.world.starts, 2); assert.equal(f.world.stops, 1);
  assert.equal(f.received.at(-1).generation, 'second'); assert.equal(f.received.at(-1).events.length, 0);
  f.context = null; await f.host.poll(f.host.entries.get(0)); assert.equal(f.world.stops, 2); f.host.close();
});

test('a late drain cannot deliver events after navigation/detachment', async () => {
  const f = fixture(); await f.host.attach(0, f.contents, channelId); const count = f.received.length;
  let resolve;
  const original = f.contents.executeJavaScriptInIsolatedWorld;
  f.contents.executeJavaScriptInIsolatedWorld = () => new Promise(done => { resolve = done; });
  const poll = f.host.poll(f.host.entries.get(0));
  f.contents.executeJavaScriptInIsolatedWorld = original;
  f.host.detach(0); resolve({ events: [{ id: 'late', text: 'hello' }], sourceStatus: 'watching' }); await poll;
  assert.equal(f.received.length, count); f.host.close();
});

test('only the exact assigned official channel can be inspected', async () => {
  for (const url of [`https://chzzk.naver.com/live/${'b'.repeat(32)}`, `https://evil.com/live/${channelId}`,
    `https://user@chzzk.naver.com/live/${channelId}`]) {
    const f = fixture(); f.url = url; await f.host.attach(0, f.contents, channelId);
    assert.equal(f.received.length, 0); assert.equal(f.worlds.length, 0); f.host.close();
  }
});
