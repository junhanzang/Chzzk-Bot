'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = 'a'.repeat(32);
async function setup() {
  const { ActivityService } = await import('../lib/activity-service.js');
  let now = 100000, counter = 0;
  const calls = [], owned = new Map([[1, { channelId: A }], [2, { channelId: A }]]);
  const service = new ActivityService({ chromeApi: { runtime: { id: 'extension' } }, clock: () => now,
    newId: () => `generation-${++counter}`, resolveTab: async id => owned.get(id),
    history: { recordActivity: (id, delta) => calls.push({ id, ...delta }) } });
  const sender = (tabId = 1, popup = false) => ({ id: 'extension', frameId: 0, documentId: `doc-${tabId}`, documentLifecycle: 'active',
    url: `https://chzzk.naver.com/live/${A}${popup ? '/chat' : '?from=following'}`, tab: { id: tabId, incognito: false } });
  const context = (value = sender()) => service.handleMessage({ method: 'getContext' }, value);
  const submit = (ctx, sequence, value = sender(), delta = { watchSeconds: 15, chatCount: 1 }) => service.handleMessage({ method: 'submit', arg: { ...ctx, sequence, ...delta } }, value);
  return { service, calls, owned, sender, context, submit, advance: ms => { now += ms; } };
}
test('activity ingress rejects unowned, foreign, nested and inactive documents without exporting account data', async () => {
  const f = await setup(), valid = f.sender();
  for (const sender of [{ ...valid, id: 'another' }, { ...valid, frameId: 1 }, { ...valid, documentLifecycle: 'cached' },
    { ...valid, tab: { id: 1, incognito: true } }, { ...valid, url: 'https://example.com/' }, f.sender(99)]) assert.equal(await f.context(sender), null);
  const context = await f.context(); assert.deepEqual(Object.keys(context).sort(), ['channelId', 'generation']);
  assert.equal(f.calls.length, 0);
});
test('activity accepts bounded numeric deltas, rejects replay and caps shared live/popup engagement', async () => {
  const f = await setup(), live = await f.context(), popup = await f.context(f.sender(2, true));
  f.advance(15000); assert.equal((await f.submit(live, 1)).accepted, true);
  assert.deepEqual(f.calls[0], { id: A, watchSeconds: 15, chatCount: 1 });
  assert.equal((await f.submit(live, 1)).accepted, false);
  await f.submit(popup, 1, f.sender(2, true), { watchSeconds: 30, chatCount: 1 }); assert.equal(f.calls.length, 1);
  f.advance(15000); await f.submit(live, 2, f.sender(), { watchSeconds: 15, chatCount: 0 });
  assert.deepEqual(f.calls[1], { id: A, watchSeconds: 15, chatCount: 0 });
  f.advance(15000); await f.submit(popup, 2, f.sender(2, true), { watchSeconds: 60, chatCount: 2, text: 'must never record' });
  assert.deepEqual(f.calls[2], { id: A, watchSeconds: 0, chatCount: 1 });
  assert(!JSON.stringify(f.calls).includes('must never'));
});
test('buffered valid adapter batches stay accepted while malformed values are rejected', async () => {
  const f = await setup(), context = await f.context(); f.advance(60000);
  assert.equal((await f.submit(context, 1, f.sender(), { watchSeconds: 60, chatCount: 2 })).accepted, true);
  assert.deepEqual(f.calls[0], { id: A, watchSeconds: 30, chatCount: 1 });
  for (const delta of [{ watchSeconds: 61, chatCount: 1 }, { watchSeconds: Infinity, chatCount: 0 }, { watchSeconds: 1, chatCount: 1.2 }]) {
    assert.equal((await f.submit(context, 2, f.sender(), delta)).accepted, false);
  }
});
test('reset and ownership changes reject late submissions and bound per-tab state', async () => {
  const f = await setup(), context = await f.context(); f.advance(15000);
  f.service.reset(); assert.equal((await f.submit(context, 1)).accepted, false);
  const current = await f.context(); assert.notEqual(current.generation, context.generation);
  const original = f.service.context.bind(f.service);
  f.service.context = async sender => { const entry = await original(sender); queueMicrotask(() => f.service.forget(sender.tab.id)); return entry; };
  assert.equal((await f.submit(current, 2)).accepted, false); assert.equal(f.calls.length, 0);
  for (let id = 0; id < 1500; id++) f.service.forget(id);
  assert(f.service.epochs.size <= 500); assert(f.service.entries.size <= 500);
});
test('a context lookup completing after navigation cannot revive the removed page', async () => {
  const f = await setup(); let resolve;
  f.service.resolveTab = () => new Promise(done => { resolve = done; });
  const pending = f.context(); f.service.forget(1); resolve({ channelId: A });
  assert.equal(await pending, null); assert.equal(f.service.entries.size, 0);
});
