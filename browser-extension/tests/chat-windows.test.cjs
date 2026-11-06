'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = 'a'.repeat(32), B = 'b'.repeat(32);
const url = id => `https://chzzk.naver.com/live/${id}/chat`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture() {
  const { ChatWindows } = await import('../lib/chat-windows.js');
  const windows = new Map(), calls = { create: [], update: [], remove: [], query: [], persist: [] };
  const storage = { async updateSession(patch) { calls.persist.push(structuredClone(patch)); } };
  let nextId = 1;
  function add({ channelId = A, type = 'popup', incognito = false, extraTabs = [], tabUrl, state = 'normal' } = {}) {
    const id = nextId++;
    const win = { id, type, incognito, state, width: 640, height: 960,
      tabs: [{ id: id * 10, windowId: id, url: tabUrl || url(channelId), incognito }, ...extraTabs] };
    windows.set(id, win); return win;
  }
  const chromeApi = {
    tabs: { async query(query) { calls.query.push(query); return [...windows.values()].flatMap(win => win.tabs); } },
    windows: {
      async get(id, options) { assert.deepEqual(options, { populate: true }); if (!windows.has(id)) throw new Error('closed'); return windows.get(id); },
      async update(id, options) { if (!windows.has(id)) throw new Error('closed'); calls.update.push({ id, options }); return Object.assign(windows.get(id), options); },
      async create(options) { calls.create.push(options); return add({ tabUrl: options.url }); },
      async remove(id) { calls.remove.push(id); windows.delete(id); }
    }
  };
  return { service: new ChatWindows({ chromeApi, storage }), ChatWindows, chromeApi, storage, windows, calls, add };
}

test('Chrome opens one chat-only popup and never controls an audio or video tab', async () => {
  const f = await fixture(); const video = f.add({ type: 'normal', tabUrl: `https://chzzk.naver.com/live/${A}` });
  assert.deepEqual(await f.service.open(A, '채널'), { channelId: A, windowId: 2, reused: false });
  assert.deepEqual(f.calls.create, [{ url: url(A), type: 'popup', width: 440, height: 800, focused: true, incognito: false }]);
  assert.equal(video.tabs[0].url, `https://chzzk.naver.com/live/${A}`);
  assert.deepEqual(f.calls.update, []); assert.deepEqual(f.calls.remove, []);
});

test('Chrome validates channel IDs before querying tabs or creating a window', async () => {
  const f = await fixture();
  for (const value of [null, '', url(A), '../', `${A}?url=evil`]) await assert.rejects(f.service.open(value), /채널 ID/);
  assert.deepEqual(f.calls.query, []); assert.deepEqual(f.calls.create, []);
});

test('Chrome reuses each channel, restores minimized popups and preserves size', async () => {
  const f = await fixture(); await f.service.open(A); const win = f.windows.get(1); win.state = 'minimized';
  assert.deepEqual(await f.service.open(A), { channelId: A, windowId: 1, reused: true });
  assert.deepEqual(f.calls.update, [{ id: 1, options: { focused: true, state: 'normal' } }]);
  assert.equal(win.width, 640); assert.equal(win.height, 960);
  await f.service.open(B); assert.equal(f.calls.create.length, 2);
});

test('Chrome concurrent requests create only one popup for a channel', async () => {
  const f = await fixture(), gate = deferred(); const create = f.chromeApi.windows.create;
  f.chromeApi.windows.create = async options => { await gate.promise; return create(options); };
  const first = f.service.open(A), second = f.service.open(A); gate.resolve();
  assert.deepEqual(await first, await second); assert.equal(f.calls.create.length, 1);
});

test('Chrome rediscovery after worker restart focuses only a single-tab official popup', async () => {
  const f = await fixture();
  f.add({ type: 'normal' }); f.add({ incognito: true }); f.add({ extraTabs: [{ id: 99, url: 'https://example.com/' }] });
  f.add({ tabUrl: `${url(A)}?redirect=bad` });
  const matching = f.add();
  assert.deepEqual(await f.service.open(A), { channelId: A, windowId: matching.id, reused: true });
  assert.deepEqual(f.calls.create, []); assert.deepEqual(f.calls.update, [{ id: matching.id, options: { focused: true } }]);
  await f.service.closeAll(); assert.deepEqual(f.calls.remove, []); assert.equal(f.windows.size, 5);
});

test('Chrome ignores a cached popup if the user navigated away or added another tab', async () => {
  const f = await fixture(); await f.service.open(A); const first = f.windows.get(1);
  first.tabs[0].pendingUrl = 'https://example.com/';
  assert.equal((await f.service.open(A)).windowId, 2);
  const second = f.windows.get(2); second.tabs.push({ id: 44, url: 'https://example.com/' });
  assert.equal((await f.service.open(A)).windowId, 3);
  await f.service.closeAll(); assert.deepEqual(f.calls.remove, [3]);
  assert.equal(f.windows.has(1), true); assert.equal(f.windows.has(2), true);
});

test('Chrome closing an existing popup while focusing safely creates a replacement', async () => {
  const f = await fixture(); await f.service.open(A);
  f.chromeApi.windows.update = async id => { f.windows.delete(id); throw new Error('closed'); };
  assert.equal((await f.service.open(A)).windowId, 2); assert.equal(f.calls.create.length, 2);
});

test('Chrome closeAll removes only still-owned chat windows and rejects later opens', async () => {
  const f = await fixture(); await f.service.open(A); await f.service.open(B);
  f.windows.get(2).tabs[0].url = 'https://example.com/';
  await f.service.closeAll(); assert.deepEqual(f.calls.remove, [1]); assert.equal(f.windows.has(2), true);
  await assert.rejects(f.service.open(A), /종료/);
});

test('Chrome shutdown during create removes its late popup without reopening anything', async () => {
  const f = await fixture(), gate = deferred(), entered = deferred(); const create = f.chromeApi.windows.create;
  f.chromeApi.windows.create = async options => { entered.resolve(); await gate.promise; return create(options); };
  const pending = f.service.open(A); const rejected = assert.rejects(pending, /종료/);
  await entered.promise; await f.service.closeAll(); gate.resolve(); await rejected;
  assert.deepEqual(f.calls.remove, [1]); assert.equal(f.windows.size, 0);
});

test('Chrome create errors clear the in-flight operation so the user can retry', async () => {
  const f = await fixture(), create = f.chromeApi.windows.create;
  f.chromeApi.windows.create = async () => { throw new Error('offline'); };
  await assert.rejects(f.service.open(A), /offline/);
  f.chromeApi.windows.create = create; assert.equal((await f.service.open(A)).reused, false);
  assert.equal(f.calls.create.length, 1);
});

test('explicit chat ownership persists only identifiers and survives service worker replacement', async () => {
  const f = await fixture(); await f.service.open(A, 'private channel title');
  assert.deepEqual(f.calls.persist.at(-1), { chatWindows: [{ channelId: A, windowId: 1, tabId: 10, owned: true }] });
  const restored = new f.ChatWindows({ chromeApi: f.chromeApi, storage: f.storage });
  restored.restore(f.calls.persist.at(-1));
  assert.deepEqual(await restored.resolveContext(10), { channelId: A });
  assert.equal((await restored.open(A)).reused, true); assert.equal(f.calls.create.length, 1);
  await restored.closeAll(); assert.deepEqual(f.calls.persist.at(-1), { chatWindows: [] });
});

test('activity ownership never broadly adopts unrelated chat popups without an explicit open', async () => {
  const f = await fixture(), win = f.add();
  assert.equal(await f.service.resolveContext(win.tabs[0].id), null); assert.equal(f.calls.query.length, 0);
  await f.service.open(A);
  const restored = new f.ChatWindows({ chromeApi: f.chromeApi, storage: f.storage });
  restored.restore(f.calls.persist.at(-1));
  assert.deepEqual(await restored.resolveContext(win.tabs[0].id), { channelId: A });
  assert.equal(f.calls.persist.at(-1).chatWindows[0].owned, false);
  await restored.closeAll(); assert.equal(f.windows.has(win.id), true, 'Adopted user windows are not closed');
});

test('restore validates identifiers, deduplicates records, strips extra fields and bounds session size', async () => {
  const f = await fixture();
  const valid = { channelId: A, windowId: 1, tabId: 10, owned: true, title: 'never retained' };
  f.service.restore({ chatWindows: [valid, { ...valid }, { ...valid, channelId: B },
    { ...valid, channelId: B, windowId: 2 }, { ...valid, channelId: 'invalid' },
    { ...valid, channelId: B, windowId: -1, tabId: 20 }, { ...valid, channelId: B, windowId: 2, tabId: 20, owned: 'true' },
    { channelId: B, windowId: 2, tabId: 20, owned: false }] });
  await f.service.persist();
  assert.deepEqual(f.calls.persist.at(-1).chatWindows, [
    { channelId: A, windowId: 1, tabId: 10, owned: true }, { channelId: B, windowId: 2, tabId: 20, owned: false }
  ]);
  f.service.restore({ chatWindows: Array.from({ length: 150 }, (_, index) => ({
    channelId: index.toString(16).padStart(32, '0'), windowId: index + 1, tabId: index + 100, owned: false
  })) });
  await f.service.persist(); assert.equal(f.calls.persist.at(-1).chatWindows.length, 100);
});

test('resolveContext prunes closed, navigated, multi-tab and incognito restored windows', async () => {
  for (const mutate of [f => f.windows.delete(1), f => { f.windows.get(1).tabs[0].pendingUrl = 'https://example.com/'; },
    f => { f.windows.get(1).tabs.push({ id: 100, url: url(A) }); }, f => { f.windows.get(1).incognito = true; }]) {
    const f = await fixture(); await f.service.open(A); mutate(f);
    assert.equal(await f.service.resolveContext(10), null); assert.deepEqual(f.calls.persist.at(-1), { chatWindows: [] });
    assert.equal(f.calls.remove.length, 0);
  }
});

test('resolveContext drops a late validation after close or session ownership replacement', async () => {
  for (const action of ['close', 'restore']) {
    const f = await fixture(); await f.service.open(A); const original = f.chromeApi.windows.get, gate = deferred();
    f.chromeApi.windows.get = async (...args) => { const win = await original(...args); await gate.promise; return win; };
    const context = f.service.resolveContext(10);
    f.chromeApi.windows.get = original;
    if (action === 'close') await f.service.closeAll(); else f.service.restore({});
    gate.resolve(); assert.equal(await context, null); assert.equal(f.service.windows.size, 0);
  }
});

test('creation fills a missing tab id from a verified populated window before persisting', async () => {
  const f = await fixture(), original = f.chromeApi.windows.create;
  f.chromeApi.windows.create = async options => { const win = await original(options); return { id: win.id }; };
  await f.service.open(A);
  assert.equal(f.calls.persist.at(-1).chatWindows[0].tabId, 10);
  assert.deepEqual(await f.service.resolveContext(10), { channelId: A });
});

test('storage failure after focusing does not create a second popup', async () => {
  const f = await fixture(); await f.service.open(A);
  f.storage.updateSession = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(f.service.open(A), /storage unavailable/);
  assert.equal(f.calls.create.length, 1); assert.equal(f.windows.size, 1);
});

test('restore during pending create prevents an old operation from restoring stale ownership', async () => {
  const f = await fixture(), gate = deferred(), entered = deferred(), create = f.chromeApi.windows.create;
  f.chromeApi.windows.create = async options => { entered.resolve(); await gate.promise; return create(options); };
  const pending = f.service.open(A), rejected = assert.rejects(pending, /종료|연결/);
  await entered.promise; f.service.restore({}); gate.resolve(); await rejected;
  assert.equal(f.service.windows.size, 0); assert.deepEqual(f.calls.remove, [1]);
});
