'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { RewardsHost, sanitizeStatus, WORLD_ID } = require('../lib/rewards-host.cjs');
const id = 'a'.repeat(32);
const source = `globalThis.DeskRewards = { createWatcher(options) {
  const controller = new AbortController();
  let enabled = options.enabled, balance = null;
  const send = () => options.onStatus({ channelId: '${id}', balance, status: enabled ? 'watching' : 'disabled' });
  return { start() { send(); options.fetchBalance('${id}', { signal: controller.signal })
    .then(value => { globalThis.receivedBalance = value; balance = value.content.amount; send(); }).catch(() => {}); },
    setEnabled(value) { enabled = value; if (!value) controller.abort(); send(); },
    stop() { controller.abort(); globalThis.stopped = true; } };
} };`;

function fixture(fetchImpl, runtimeSource = source) {
  const context = vm.createContext({ document: { querySelector: () => null }, location: new URL(`https://chzzk.naver.com/live/${id}`),
    URL, AbortController, setTimeout, clearTimeout });
  const scripts = [];
  const contents = { destroyed: false, isDestroyed() { return this.destroyed; }, getURL: () => context.location.href,
    async executeJavaScriptInIsolatedWorld(world, items) {
      assert.equal(world, WORLD_ID);
      for (const { code } of items) { scripts.push(code); var value = vm.runInContext(code, context); }
      return value;
    } };
  const calls = [];
  const host = new RewardsHost({ enabled: true, source: runtimeSource, intervalMs: 60000,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return fetchImpl ? fetchImpl(url, options) : {
      ok: true, json: async () => ({ code: 200, content: { amount: 450, nickname: 'private', claims: [], token: 'private' } })
    }; } });
  return { host, contents, context, scripts, calls };
}

test('desktop reward world uses only fixed session GET and publishes a sanitized balance', async t => {
  const f = fixture(); t.after(() => f.host.close());
  await f.host.attach(3, f.contents, id);
  await new Promise(setImmediate);
  await f.host.poll(f.host.entries.get(3));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `https://api.chzzk.naver.com/service/v1/channels/${id}/log-power`);
  assert.equal(f.calls[0].options.method, 'GET');
  assert.equal(f.calls[0].options.credentials, 'include');
  assert.equal(f.host.status(3).balance, 450);
  assert.ok(!JSON.stringify(f.context.receivedBalance).includes('private'));
  assert.ok(!f.scripts.some(code => code.includes('ipcRenderer') || code.includes('contextBridge')));
  await f.host.setEnabled(false);
  assert.equal(f.host.status(3).status, 'disabled');
  f.host.close();
  assert.equal(f.context.stopped, true);
});

test('navigation away refuses script execution and balance reads', async t => {
  const f = fixture(); t.after(() => f.host.close());
  f.context.location = new URL('https://example.com/');
  await f.host.attach(0, f.contents, id);
  assert.equal(f.calls.length, 0);
  assert.equal(f.scripts.length, 0);
});

test('closing or replacing the player aborts pending balance and discards its reply', async () => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const f = fixture((_url, { signal }) => new Promise((_resolve, reject) => {
    started(signal);
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const pending = f.host.attach(0, f.contents, id);
  const signal = await began;
  f.host.close();
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(f.host.status(0), null);
  assert.equal(f.host.timer, null);
  assert.equal(f.context.receivedBalance, undefined);
});

test('page status cannot supply arbitrary objects or claim a different channel', () => {
  assert.deepEqual(sanitizeStatus({ channelId: 'b'.repeat(32), balance: 500, status: 'claimed' }, id, false),
    { channelId: id, balance: null, status: 'disabled' });
  assert.deepEqual(sanitizeStatus({ channelId: id, balance: Infinity, status: 'arbitrary',
    nickname: 'private', lastClaimAt: 'now', message: 'hello\nworld' }, id, true),
    { channelId: id, balance: null, status: 'unavailable', message: 'helloworld' });
});

test('an old stop deferred during navigation cannot remove the replacement watcher', async t => {
  const f = fixture(); t.after(() => f.host.close());
  await f.host.attach(0, f.contents, id);
  const execute = f.contents.executeJavaScriptInIsolatedWorld.bind(f.contents);
  let delayedStop;
  f.contents.executeJavaScriptInIsolatedWorld = async (world, items) => {
    if (items[0].code.includes('delete globalThis.__deskRewards')) { delayedStop = () => execute(world, items); return; }
    return execute(world, items);
  };
  await f.host.attach(0, f.contents, id);
  const generation = f.context.__deskRewards.generation;
  assert.ok(generation > 1);
  await delayedStop();
  assert.equal(f.context.__deskRewards.generation, generation);
  f.contents.executeJavaScriptInIsolatedWorld = execute;
});

test('the production shared watcher receives its balance through the desktop broker', async t => {
  const runtimeSource = fs.readFileSync(path.join(__dirname, '../../browser-extension/shared/rewards.js'), 'utf8');
  const f = fixture(null, runtimeSource); t.after(() => f.host.close());
  await f.host.attach(0, f.contents, id);
  await new Promise(setImmediate);
  await f.host.poll(f.host.entries.get(0));
  assert.equal(f.host.status(0).balance, 450);
  assert.equal(f.host.status(0).status, 'watching');
  assert.equal(f.calls.length, 1);
});
