'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { activityPage } = require('../shared/activity-observer.js');
const ID = 'a'.repeat(32), script = fs.readFileSync(path.join(__dirname, '../content/activity-adapter.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture() {
  const requests = [], watchers = [], listeners = [], pageEvents = {}, timers = new Map();
  let remote = { channelId: ID, generation: 'first' }, deliver = async () => ({ accepted: true });
  const location = { origin: 'https://chzzk.naver.com', pathname: `/live/${ID}` };
  const sandbox = { document: {}, location,
    DeskActivity: { activityPage, createActivityObserver(options) {
      const observer = { options, started: 0, stopped: 0, start() { this.started++; }, stop() { this.stopped++; } };
      watchers.push(observer); return observer;
    } },
    chrome: { runtime: { onMessage: { addListener: fn => listeners.push(fn) }, async sendMessage(message) {
      requests.push(JSON.parse(JSON.stringify(message))); assert.equal(message.target, 'desk-activity');
      if (message.method === 'getContext') return { ok: true, value: remote && { ...remote } };
      assert.equal(message.method, 'submit'); return { ok: true, value: await deliver(message.arg) };
    } } },
    setInterval(fn) { timers.set(1, fn); return 1; }, clearInterval(id) { timers.delete(id); },
    addEventListener(name, fn) { pageEvents[name] = fn; }
  };
  vm.runInNewContext(script, sandbox); await flush();
  return { requests, watchers, listeners, pageEvents, timers, location,
    remote(value) { remote = value; }, deliver(fn) { deliver = fn; },
    async configure() { listeners[0]({ target: 'desk-activity-config' }); await flush(); },
    deltas: () => requests.filter(item => item.method === 'submit').map(item => item.arg) };
}

test('adapter uses the fixed activity protocol with numeric deltas and per-generation sequence', async () => {
  const f = await fixture(); assert.equal(f.watchers[0].started, 1);
  f.watchers[0].options.onActivity({ watchSeconds: 15, chatCount: 1 }); await flush();
  f.watchers[0].options.onActivity({ watchSeconds: 10, chatCount: 0 }); await flush();
  assert.deepEqual(f.deltas(), [
    { channelId: ID, generation: 'first', sequence: 1, watchSeconds: 15, chatCount: 1 },
    { channelId: ID, generation: 'first', sequence: 2, watchSeconds: 10, chatCount: 0 }
  ]); f.pageEvents.pagehide();
});

test('generation changes discard queued old deltas and reject stale observer callbacks', async () => {
  const f = await fixture(); let resolve;
  f.deliver(() => new Promise(done => { resolve = done; }));
  f.watchers[0].options.onActivity({ watchSeconds: 15, chatCount: 1 }); await flush();
  f.watchers[0].options.onActivity({ watchSeconds: 15, chatCount: 0 });
  f.remote({ channelId: ID, generation: 'second' }); await f.configure();
  f.watchers[0].options.onActivity({ watchSeconds: 15, chatCount: 1 });
  f.deliver(async () => true); resolve(true); await flush();
  assert.equal(f.deltas().length, 1); assert.equal(f.watchers[0].stopped, 1);
  f.watchers[1].options.onActivity({ watchSeconds: 5, chatCount: 0 }); await flush();
  assert.equal(f.deltas()[1].generation, 'second'); assert.equal(f.deltas()[1].sequence, 1); f.pageEvents.pagehide();
});

test('pending transmission is bounded and never includes unexpected fields or invalid numbers', async () => {
  const f = await fixture(); let resolve;
  f.deliver(() => new Promise(done => { resolve = done; }));
  f.watchers[0].options.onActivity({ watchSeconds: 1, chatCount: 0 }); await flush();
  for (let i = 0; i < 100; i++) f.watchers[0].options.onActivity({ watchSeconds: 15, chatCount: 1, text: 'must not cross' });
  f.watchers[0].options.onActivity({ watchSeconds: Infinity, chatCount: 1 });
  f.deliver(async () => true); resolve(true); await flush();
  assert.deepEqual(f.deltas()[1], { channelId: ID, generation: 'first', sequence: 2, watchSeconds: 60, chatCount: 2 });
  f.pageEvents.pagehide();
});

test('missing or mismatched context prevents collection and popup context can collect later', async () => {
  const f = await fixture(); f.remote(null); await f.configure(); assert.equal(f.watchers[0].stopped, 1);
  f.remote({ channelId: 'b'.repeat(32), generation: 'wrong' }); await f.configure(); assert.equal(f.watchers.length, 1);
  f.location.pathname = `/live/${ID}/chat`; f.remote({ channelId: ID, generation: 'popup' }); await f.configure();
  assert.equal(f.watchers.length, 2); f.pageEvents.pagehide();
});

test('navigation and pagehide stop observation and bfcache restore asks for context again', async () => {
  const f = await fixture(); f.location.pathname = '/video/1'; await f.configure(); assert.equal(f.watchers[0].stopped, 1);
  f.pageEvents.pagehide(); assert.equal(f.timers.size, 0);
  f.location.pathname = `/live/${ID}`; f.pageEvents.pageshow({ persisted: true }); await flush();
  assert.equal(f.watchers.length, 2); assert.equal(f.timers.size, 1); f.pageEvents.pagehide();
});

test('rejected delivery stops collection and restarting same generation preserves sequence', async () => {
  const f = await fixture(); f.deliver(async () => ({ accepted: false }));
  f.watchers[0].options.onActivity({ watchSeconds: 10, chatCount: 0 }); await flush(); assert.equal(f.watchers[0].stopped, 1);
  await f.configure(); f.deliver(async () => true);
  f.watchers[1].options.onActivity({ watchSeconds: 10, chatCount: 0 }); await flush();
  assert.equal(f.deltas().at(-1).sequence, 2); f.pageEvents.pagehide();
});
