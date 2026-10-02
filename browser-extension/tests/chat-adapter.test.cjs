'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ID = '1'.repeat(32);
const script = fs.readFileSync(path.join(__dirname, '../content/chat-adapter.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture() {
  const requests = [], watchers = [], listeners = [], pageEvents = {}, timers = new Map();
  let nextTimer = 0, remote = { slotId: 0, channelId: ID, generation: 'generation-1' }, deliver = async () => true;
  const location = { origin: 'https://chzzk.naver.com', pathname: `/live/${ID}` };
  const context = {
    document: {}, location, TextEncoder,
    DeskChat: { createChatObserver(options) {
      const watcher = { options, started: 0, stopped: 0,
        start() { this.started++; options.onStatus({ status: 'watching' }); }, stop() { this.stopped++; } };
      watchers.push(watcher); return watcher;
    } },
    chrome: { runtime: { onMessage: { addListener: listener => listeners.push(listener) },
      async sendMessage(message) {
        requests.push(JSON.parse(JSON.stringify(message)));
        assert.equal(message.target, 'desk-chat');
        if (message.method === 'getContext') return { ok: true, value: remote && { ...remote } };
        assert.equal(message.method, 'submitBatch');
        return { ok: true, value: await deliver(message.arg) };
      } } },
    setInterval(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearInterval(id) { timers.delete(id); },
    addEventListener(name, listener) { pageEvents[name] = listener; }
  };
  vm.runInNewContext(script, context);
  await flush();
  return { requests, watchers, listeners, pageEvents, timers, location,
    setRemote(value) { remote = value; }, setDelivery(fn) { deliver = fn; },
    async configure() { listeners[0]({ target: 'desk-chat-config' }); await flush(); },
    batches() { return requests.filter(message => message.method === 'submitBatch').map(message => message.arg); } };
}

test('content adapter reports source heartbeat, splits UTF-8/escaped payloads and exposes only the fixed chat protocol', async () => {
  const f = await fixture();
  assert.equal(f.watchers[0].started, 1);
  assert.deepEqual(f.batches()[0], { slotId: 0, channelId: ID, generation: 'generation-1', sourceStatus: 'watching', events: [] });
  const events = Array.from({ length: 100 }, (_, index) => ({ id: String(index), text: index < 50 ? '가'.repeat(500) : '\u0000'.repeat(499) + 'x' }));
  f.watchers[0].options.onMessages(events); await flush();
  const batches = f.batches().filter(batch => batch.events.length);
  assert.equal(batches.flatMap(batch => batch.events).length, 100);
  assert.ok(batches.every(batch => batch.events.length <= 25));
  assert.ok(batches.every(batch => Buffer.byteLength(JSON.stringify({ method: 'submitChatBatch', arg: batch })) < 50000));
  assert.ok(f.requests.every(message => ['getContext', 'submitBatch'].includes(message.method)));
  f.pageEvents.pagehide(); assert.equal(f.timers.size, 0);
});

test('generation changes stop and reseed the observer and discard old queued messages', async () => {
  const f = await fixture();
  let release;
  f.setDelivery(async batch => { if (batch.events.length && batch.generation === 'generation-1') await new Promise(resolve => { release = resolve; }); return true; });
  f.watchers[0].options.onMessages(Array.from({ length: 100 }, (_, index) => ({ id: String(index), text: '이전 세대' })));
  await flush();
  f.setRemote({ slotId: 0, channelId: ID, generation: 'generation-2' }); await f.configure();
  assert.equal(f.watchers[0].stopped, 1); assert.equal(f.watchers[1].started, 1);
  f.watchers[0].options.onMessages([{ id: 'stale-callback', text: '보내면 안 됨' }]);
  release(); await flush();
  assert.equal(f.batches().filter(batch => batch.generation === 'generation-1').flatMap(batch => batch.events).length, 25);
  assert.ok(f.batches().filter(batch => batch.generation === 'generation-2').every(batch => batch.events.length === 0));
  f.watchers[1].options.onMessages([{ id: 'new', text: '새 세대' }]); await flush();
  assert.equal(f.batches().at(-1).events[0].text, '새 세대');
  f.pageEvents.pagehide();
});

test('slow delivery retains at most 200 queued messages and no retry backlog after page departure', async () => {
  const f = await fixture();
  let release, first = true;
  f.setDelivery(async batch => {
    if (first && batch.events.length) { first = false; await new Promise(resolve => { release = resolve; }); }
    return true;
  });
  const events = prefix => Array.from({ length: 100 }, (_, index) => ({ id: `${prefix}-${index}`, text: '본문' }));
  for (let index = 0; index < 10; index++) f.watchers[0].options.onMessages(events(index));
  await flush(); release(); await flush();
  assert.equal(f.batches().flatMap(batch => batch.events).length, 225);
  const before = f.requests.length;
  f.pageEvents.pagehide(); f.watchers[0].options.onMessages(events('late')); await flush();
  assert.equal(f.requests.length, before);
  assert.equal(f.timers.size, 0);
});

test('missing context or SPA navigation stops observation, and bfcache restore requests fresh context', async () => {
  const f = await fixture();
  f.setRemote(null); await f.configure(); assert.equal(f.watchers[0].stopped, 1);
  f.setRemote({ slotId: 0, channelId: ID, generation: 'generation-1' }); await f.configure();
  assert.equal(f.watchers.length, 2);
  f.location.pathname = '/video/123'; await f.configure(); assert.equal(f.watchers[1].stopped, 1);
  f.pageEvents.pagehide(); f.location.pathname = `/live/${ID}`;
  f.pageEvents.pageshow({ persisted: true }); await flush();
  assert.equal(f.watchers.length, 3); assert.equal(f.timers.size, 1);
  f.pageEvents.pagehide();
});
