'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../shared/channels.js');
const ID_A = '11111111111111111111111111111111';
const ID_B = '22222222222222222222222222222222';
const ID_C = '33333333333333333333333333333333';
const ID_D = '44444444444444444444444444444444';
const TOKEN = 'a'.repeat(48);
const CODE = `43210:${TOKEN}`;

function browserFixture() {
  const local = {}, session = {}, tabs = new Map(), effects = [];
  let nextTabId = 1, nextWindowId = 2, focusedWindowId = 1;
  const windows = new Map([[1, { id: 1, incognito: false, left: 20, top: 30, width: 1400, height: 900 }]]);
  const area = data => ({
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; }
  });
  const chromeApi = {
    runtime: { id: 'b'.repeat(32), getURL: value => `chrome-extension://${'b'.repeat(32)}/${value}` },
    storage: { local: area(local), session: area(session) },
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error('No tab'); return structuredClone(tabs.get(id)); },
      async query(query = {}) { return [...tabs.values()].filter(tab => (query.windowId === undefined || tab.windowId === query.windowId) &&
        (!query.url || tab.url.startsWith('https://chzzk.naver.com/live/'))).map(tab => structuredClone(tab)); },
      async sendMessage() { return true; },
      async create(options) {
        const tab = { id: nextTabId++, windowId: options.windowId || 1, incognito: false, mutedInfo: { muted: false }, status: 'complete', ...options };
        tabs.set(tab.id, tab); effects.push(['create', tab.id, options]); return structuredClone(tab);
      },
      async update(id, update) {
        if (!tabs.has(id)) throw new Error('No tab');
        const tab = tabs.get(id);
        Object.assign(tab, update);
        if (typeof update.muted === 'boolean') tab.mutedInfo = { muted: update.muted };
        effects.push(['update', id, update]); return structuredClone(tab);
      },
      async remove(id) { tabs.delete(id); effects.push(['remove', id]); }
    },
    windows: {
      async getLastFocused() { return structuredClone(windows.get(focusedWindowId)); },
      async update(id, update) {
        if (!windows.has(id)) throw new Error('No window');
        Object.assign(windows.get(id), update);
        if (update.focused) focusedWindowId = id;
        effects.push(['window-update', id, update]);
        return structuredClone(windows.get(id));
      },
      async create(options) {
        const result = { ...options, id: nextWindowId++, incognito: false };
        windows.set(result.id, result);
        if (options.tabId) tabs.get(options.tabId).windowId = result.id;
        if (options.focused) focusedWindowId = result.id;
        effects.push(['window-create', options]); return structuredClone(result);
      }
    }
  };
  return { chromeApi, local, session, tabs, windows, effects };
}

function remoteFixture() {
  const state = { channels: [], slots: [0, 1, 2, 3].map(slotId => ({ slotId, channelId: null, playbackMode: 'browser', replay: { state: 'idle', bufferedSeconds: 0 } })),
    layout: 'side-by-side', mainSlot: 0, clipSeconds: 30, autoClipSettings: {}, autoClips: [], audioSlot: null, clips: [], savingSlots: [], ffmpegAvailable: true, auth: { status: 'signed_in', nickname: 'must-not-leak' }, secret: TOKEN };
  const calls = [];
  let unavailable = false;
  const fetchImpl = async (url, options) => {
    if (unavailable) throw new TypeError('network');
    assert.equal(url, 'http://127.0.0.1:43210/rpc');
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.credentials, 'omit');
    const { method, arg } = JSON.parse(options.body);
    calls.push([method, arg]);
    if (method === 'addChannel') {
      state.channels.push({ id: arg.input, name: arg.name });
      const empty = state.slots.find(slot => !slot.channelId);
      if (empty) empty.channelId = arg.input;
    }
    if (method === 'assignSlot') Object.assign(state.slots[arg.slotId], { channelId: arg.channelId, playbackMode: arg.playbackMode });
    if (method === 'setLayout') Object.assign(state, { layout: arg.layout, mainSlot: arg.mainSlot });
    if (method === 'setClipSeconds') state.clipSeconds = arg;
    if (method === 'setAutoClipSettings') state.autoClipSettings[arg.channelId] = model.normalizeAutoClipConfig(arg);
    if (method === 'clearSlot') state.slots[arg].channelId = null;
    if (method === 'removeChannel') {
      state.channels = state.channels.filter(channel => channel.id !== arg);
      state.slots.filter(slot => slot.channelId === arg).forEach(slot => { slot.channelId = null; });
    }
    if (method === 'setBuffer') state.slots[arg.slotId].replay = { state: arg.enabled ? 'buffering' : 'idle', bufferedSeconds: arg.enabled ? 30 : 0 };
    return { ok: true, status: 200, json: async () => ({ ok: true, value: structuredClone(state) }) };
  };
  return { state, calls, fetchImpl, setUnavailable(value) { unavailable = value; } };
}

async function setup() {
  const { DeskController } = await import('../lib/core.js');
  const browser = browserFixture(), remote = remoteFixture();
  const controller = new DeskController({ ...browser, model, fetchImpl: remote.fetchImpl });
  return { ...browser, remote, controller, DeskController };
}

test('pair codes accept only a loopback port and exact token shape', async () => {
  const { parsePairCode } = await import('../lib/core.js');
  assert.deepEqual(parsePairCode(CODE), { port: 43210, token: TOKEN });
  for (const value of ['https://evil.com:123', '0:' + TOKEN, '65536:' + TOKEN, '12:' + TOKEN.slice(1), {}, null]) assert.throws(() => parsePairCode(value));
});

test('only the extension panel may invoke controller methods', async () => {
  const { panelSenderAllowed } = await import('../lib/core.js');
  const { chromeApi } = browserFixture();
  const valid = { id: chromeApi.runtime.id, url: chromeApi.runtime.getURL('panel.html') };
  assert.equal(panelSenderAllowed(valid, chromeApi), true);
  for (const sender of [{ ...valid, url: 'https://chzzk.naver.com/live/' + ID_A }, { ...valid, id: 'evil' },
    { ...valid, url: chromeApi.runtime.getURL('other.html') }, { ...valid, tab: { incognito: true } }]) assert.equal(panelSenderAllowed(sender, chromeApi), false);
});

test('standalone favorites open official muted tabs and switch only managed audio', async () => {
  const f = await setup();
  await f.controller.handle('addChannel', { input: ID_A, name: 'A' });
  await f.controller.handle('addChannel', { input: `https://chzzk.naver.com/live/${ID_B}`, name: 'B' });
  let state = await f.controller.handle('getState');
  assert.equal(state.connection.status, 'standalone');
  assert.equal(state.channels.length, 2);
  assert.equal(state.ffmpegAvailable, false);
  assert.ok(state.slots.filter(slot => slot.tabId).every(slot => f.tabs.get(slot.tabId).mutedInfo.muted));
  const unrelated = await f.chromeApi.tabs.create({ url: 'https://example.com', active: false });
  await f.controller.handle('selectAudio', 1);
  state = await f.controller.handle('getState');
  assert.equal(state.audioSlot, 1);
  assert.equal(f.tabs.get(state.slots[0].tabId).mutedInfo.muted, true);
  assert.equal(f.tabs.get(state.slots[1].tabId).mutedInfo.muted, false);
  assert.equal(f.tabs.get(unrelated.id).mutedInfo.muted, false);
  await assert.rejects(f.controller.handle('setBuffer', { slotId: 1, enabled: true }), /데스크톱 앱/);
});

test('invalid URLs do not persist favorites or open tabs', async () => {
  const f = await setup();
  for (const input of ['https://example.com/' + ID_A, 'javascript:alert(1)', 'https://chzzk.naver.com.evil.com/live/' + ID_A]) {
    await assert.rejects(f.controller.handle('addChannel', { input }));
  }
  assert.equal(f.tabs.size, 0);
  assert.equal((await f.controller.handle('getState')).channels.length, 0);
});

test('existing same-broadcast tab is adopted without a duplicate and clear restores it', async () => {
  const f = await setup();
  const existing = await f.chromeApi.tabs.create({ url: `https://chzzk.naver.com/live/${ID_A}` });
  await f.controller.handle('addChannel', { input: ID_A, name: 'A' });
  const state = await f.controller.handle('getState');
  assert.equal(state.slots[0].tabId, existing.id);
  assert.equal(f.tabs.size, 1);
  assert.equal(f.tabs.get(existing.id).mutedInfo.muted, true);
  await f.controller.handle('clearSlot', 0);
  assert.equal(f.tabs.size, 1);
  assert.equal(f.tabs.get(existing.id).mutedInfo.muted, false);
});

test('assigning one broadcast to both slots is rejected before desktop mutation', async () => {
  const f = await setup();
  await f.controller.handle('pair', CODE);
  await f.controller.handle('addChannel', { input: ID_A, name: 'A' });
  await assert.rejects(f.controller.handle('assignSlot', { slotId: 1, channelId: ID_A }), /다른 자리/);
  assert.equal(f.remote.calls.filter(([method]) => method === 'assignSlot').length, 0);
  assert.equal(f.tabs.size, 1);
});

test('navigation away detaches ownership without closing or muting the unrelated page', async () => {
  const f = await setup();
  await f.controller.handle('addChannel', { input: ID_A });
  let state = await f.controller.handle('getState');
  const tabId = state.slots[0].tabId;
  f.tabs.get(tabId).url = 'https://example.com/private';
  f.tabs.get(tabId).mutedInfo.muted = false;
  await f.controller.onTabChanged(tabId);
  const afterNavigation = f.effects.length;
  state = await f.controller.handle('getState');
  assert.equal(state.slots[0].pageStatus, 'detached');
  await f.controller.handle('clearSlot', 0);
  assert.equal(f.tabs.has(tabId), true);
  assert.equal(f.effects.length, afterNavigation);
});

test('incognito tabs are never adopted', async () => {
  const f = await setup();
  const privateTab = await f.chromeApi.tabs.create({ url: `https://chzzk.naver.com/live/${ID_A}`, incognito: true });
  await f.controller.handle('addChannel', { input: ID_A });
  assert.notEqual((await f.controller.handle('getState')).slots[0].tabId, privateTab.id);
  assert.equal(f.tabs.get(privateTab.id).mutedInfo.muted, false);
});

test('service worker recreation restores session-managed tabs but not browser-restart ownership', async () => {
  const f = await setup();
  await f.controller.handle('addChannel', { input: ID_A });
  await f.controller.handle('selectAudio', 0);
  const revived = new f.DeskController({ chromeApi: f.chromeApi, model, fetchImpl: f.remote.fetchImpl });
  assert.equal((await revived.handle('getState')).audioSlot, 0);
  delete f.session['desk.tabs'];
  const restarted = new f.DeskController({ chromeApi: f.chromeApi, model, fetchImpl: f.remote.fetchImpl });
  const state = await restarted.handle('getState');
  assert.equal(state.channels.length, 1);
  assert.equal(state.slots[0].channelId, null);
  assert.equal(state.audioSlot, null);
});

test('pairing validates a desktop response before persisting credentials and strips secrets', async () => {
  const f = await setup();
  f.remote.setUnavailable(true);
  await assert.rejects(f.controller.handle('pair', CODE));
  assert.equal(f.local['desk.pairing'], undefined);
  f.remote.setUnavailable(false);
  const state = await f.controller.handle('pair', CODE);
  assert.equal(state.connection.status, 'connected');
  assert.equal(f.local['desk.pairing'].token, TOKEN);
  assert.equal(JSON.stringify(state).includes(TOKEN), false);
  assert.equal(JSON.stringify(state).includes('must-not-leak'), false);
  assert.equal(f.tabs.size, 0);
  assert.deepEqual(f.remote.calls.map(([method]) => method), ['getState']);
});

test('lost desktop connection never silently creates standalone favorites', async () => {
  const f = await setup();
  await f.controller.handle('pair', CODE);
  f.remote.setUnavailable(true);
  await assert.rejects(f.controller.handle('addChannel', { input: ID_A }));
  const state = await f.controller.handle('getState');
  assert.equal(state.connection.status, 'unavailable');
  assert.equal(state.channels.length, 0);
  assert.equal(f.local['desk.favorites'], undefined);
  assert.equal(f.tabs.size, 0);
  assert.equal(f.local['desk.pairing'].token, TOKEN);
});

test('linked clear/remove retain ownership until controlled tab release completes', async () => {
  const f = await setup();
  await f.controller.handle('pair', CODE);
  await f.controller.handle('addChannel', { input: ID_A });
  await f.controller.handle('addChannel', { input: ID_B });
  await f.controller.handle('clearSlot', 0);
  assert.equal(f.tabs.size, 1);
  await f.controller.handle('removeChannel', ID_B);
  assert.equal(f.tabs.size, 0);
});

test('recording requires matching live Chrome/desktop assignments and sends expected channel', async () => {
  const f = await setup();
  await f.controller.handle('pair', CODE);
  await f.controller.handle('addChannel', { input: ID_A });
  await f.controller.handle('setBuffer', { slotId: 0, enabled: true });
  assert.deepEqual(f.remote.calls.find(([method]) => method === 'setBuffer')[1], { slotId: 0, enabled: true, channelId: ID_A });
  f.remote.state.slots[0].playbackMode = 'desktop';
  await assert.rejects(f.controller.handle('saveClip', { slotId: 0, seconds: 30 }), /배치가 달라/);
  assert.equal(f.remote.calls.filter(([method]) => method === 'saveClip').length, 0);
});

test('a closed managed tab can still stop its matching desktop buffer', async () => {
  const f = await setup();
  await f.controller.handle('pair', CODE);
  await f.controller.handle('addChannel', { input: ID_A });
  const state = await f.controller.handle('getState');
  f.tabs.delete(state.slots[0].tabId);
  await f.controller.onTabChanged(state.slots[0].tabId);
  await f.controller.handle('setBuffer', { slotId: 0, enabled: false });
  assert.equal(f.remote.calls.find(([method]) => method === 'setBuffer')[1].enabled, false);
  await assert.rejects(f.controller.handle('setBuffer', { slotId: 0, enabled: true }), /배치가 달라/);
});

test('a closed tab can save retained completed footage only for its matching desktop channel', async () => {
  const f = await setup();
  await f.controller.handle('pair', CODE);
  await f.controller.handle('addChannel', { input: ID_A });
  await f.controller.handle('setBuffer', { slotId: 0, enabled: true });
  const state = await f.controller.handle('getState');
  f.tabs.delete(state.slots[0].tabId);
  await f.controller.onTabChanged(state.slots[0].tabId);
  await f.controller.handle('saveClip', { slotId: 0, seconds: 30 });
  assert.deepEqual(f.remote.calls.find(([method]) => method === 'saveClip')[1], { slotId: 0, seconds: 30, channelId: ID_A });
  f.remote.state.channels.push({ id: ID_B, name: 'B' });
  f.remote.state.slots[0].channelId = ID_B;
  await assert.rejects(f.controller.handle('saveClip', { slotId: 0, seconds: 30 }), /배치가 달라/);
  assert.equal(f.remote.calls.filter(([method]) => method === 'saveClip').length, 1);
});

test('disconnect is explicit and preserves shared favorite names for standalone use', async () => {
  const f = await setup();
  await f.controller.handle('pair', CODE);
  await f.controller.handle('addChannel', { input: ID_A, name: 'Shared A' });
  const state = await f.controller.handle('disconnect');
  assert.equal(state.connection.status, 'standalone');
  assert.equal(state.channels[0].name, 'Shared A');
  assert.equal(state.slots[0].channelId, ID_A);
  assert.equal(f.local['desk.pairing'], undefined);
});

test('RPC preserves user-facing desktop errors on HTTP 500', async () => {
  const f = await setup();
  f.controller.fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: '로그인·연령 인증을 확인해 주세요.' }) });
  await assert.rejects(f.controller.rpc('setBuffer', {}, { port: 43210, token: TOKEN }), /로그인·연령 인증/);
});

test('four slots survive worker recreation and duplicate broadcasts are rejected across A-D', async () => {
  const f = await setup();
  for (const input of [ID_A, ID_B, ID_C, ID_D]) await f.controller.handle('addChannel', { input });
  await f.controller.handle('selectAudio', 3);
  let state = await f.controller.handle('getState');
  assert.deepEqual(state.slots.map(slot => slot.channelId), [ID_A, ID_B, ID_C, ID_D]);
  assert.equal(state.audioSlot, 3);
  assert.equal(f.tabs.get(state.slots[3].tabId).mutedInfo.muted, false);
  assert.equal(f.tabs.get(state.slots[2].tabId).mutedInfo.muted, true);
  await assert.rejects(f.controller.handle('assignSlot', { slotId: 0, channelId: ID_D }), /다른 자리/);
  await assert.rejects(f.controller.handle('assignSlot', { slotId: 4, channelId: ID_D }), /잘못된/);
  const revived = new f.DeskController({ chromeApi: f.chromeApi, model, fetchImpl: f.remote.fetchImpl });
  state = await revived.handle('getState');
  assert.deepEqual(state.slots.map(slot => slot.channelId), [ID_A, ID_B, ID_C, ID_D]);
  assert.equal(state.audioSlot, 3);
});

test('layout preferences persist without opening windows and paired layout mutations do not fall back', async () => {
  const f = await setup();
  await f.controller.handle('setLayout', { layout: 'focus', mainSlot: 3 });
  assert.equal(f.effects.length, 0);
  const revived = new f.DeskController({ chromeApi: f.chromeApi, model, fetchImpl: f.remote.fetchImpl });
  let state = await revived.handle('getState');
  assert.equal(state.layout, 'focus');
  assert.equal(state.mainSlot, 3);
  await revived.handle('pair', CODE);
  state = await revived.handle('setLayout', { layout: 'grid', mainSlot: 2 });
  assert.equal(state.layout, 'grid');
  assert.equal(state.mainSlot, 2);
  f.remote.setUnavailable(true);
  await assert.rejects(revived.handle('setLayout', { layout: 'stacked', mainSlot: 1 }));
  assert.equal((await revived.handle('getState')).layout, 'grid');
  assert.equal(f.local['desk.preferences'].layout, 'focus');
});

test('layout rectangles use actual occupied slots and a selected main broadcast', async () => {
  const { layoutBounds } = await import('../lib/core.js');
  const area = { left: -100, top: 20, width: 1400, height: 900 };
  assert.deepEqual(layoutBounds('side-by-side', [0, 3], 3, area), [
    { slotId: 0, left: -100, top: 20, width: 700, height: 900 },
    { slotId: 3, left: 600, top: 20, width: 700, height: 900 }
  ]);
  const stacked = layoutBounds('stacked', [1, 3], 1, area);
  assert.equal(stacked[1].top, 470);
  assert.equal(stacked[1].height, 450);
  const grid = layoutBounds('grid', [0, 1, 2, 3], 0, area);
  assert.deepEqual(grid[3], { slotId: 3, left: 600, top: 470, width: 700, height: 450 });
  const focused = layoutBounds('focus', [0, 1, 2, 3], 2, area);
  assert.equal(focused[0].slotId, 2);
  assert.equal(focused[0].height, 900);
  assert.ok(focused[0].width > focused[1].width);
  assert.equal(focused[3].top + focused[3].height, 920);
  assert.equal(layoutBounds('focus', [1], 3, area)[0].width, 1400);
  assert.deepEqual(layoutBounds('grid', [], 0, area), []);
});

test('arrange reuses dedicated windows and never resizes a window containing unrelated tabs', async () => {
  const f = await setup();
  for (const input of [ID_A, ID_B, ID_C, ID_D]) await f.controller.handle('addChannel', { input });
  await f.chromeApi.tabs.create({ url: 'https://example.com', windowId: 1 });
  await f.controller.handle('setLayout', { layout: 'grid', mainSlot: 2 });
  await f.controller.handle('arrangeWindows');
  assert.equal(f.effects.filter(effect => effect[0] === 'window-create').length, 4);
  assert.equal(f.effects.some(effect => effect[0] === 'window-update' && effect[1] === 1 && 'width' in effect[2]), false);
  const first = await f.controller.handle('getState');
  const firstTab = f.tabs.get(first.slots[0].tabId);
  assert.equal(f.windows.get(firstTab.windowId).width, 700);
  await f.controller.handle('arrangeWindows');
  assert.equal(f.effects.filter(effect => effect[0] === 'window-create').length, 4);
  assert.equal(f.windows.get(firstTab.windowId).width, 700);
  const sharedWindowId = firstTab.windowId;
  await f.chromeApi.tabs.create({ url: 'https://example.com/unrelated', windowId: sharedWindowId });
  const start = f.effects.length;
  await f.controller.handle('setLayout', { layout: 'focus', mainSlot: 3 });
  await f.controller.handle('arrangeWindows');
  const newEffects = f.effects.slice(start);
  assert.equal(newEffects.filter(effect => effect[0] === 'window-create').length, 1);
  assert.equal(newEffects.some(effect => effect[0] === 'window-update' && effect[1] === sharedWindowId), false);
  const revived = new f.DeskController({ chromeApi: f.chromeApi, model, fetchImpl: f.remote.fetchImpl });
  await revived.handle('arrangeWindows');
  assert.equal(f.effects.filter(effect => effect[0] === 'window-create').length, 5);
});

function rewardSender(f, slotId = 0) {
  const tab = [...f.tabs.values()].find(tab => tab.id === f.controller.snapshot().slots[slotId].tabId);
  return { id: f.chromeApi.runtime.id, frameId: 0, url: tab.url, tab: structuredClone(tab) };
}

test('reward opt-in is local to Chrome, starts off and persists separately from paired settings', async () => {
  const f = await setup();
  await f.controller.handle('addChannel', { input: ID_A });
  const sender = rewardSender(f);
  let config = await f.controller.handleRewardMessage({ method: 'getConfig' }, sender);
  assert.deepEqual(config, { enabled: false, channelId: ID_A });
  await f.controller.handle('setAutoRewards', true);
  config = await f.controller.handleRewardMessage({ method: 'getConfig' }, sender);
  assert.equal(config.enabled, true);
  const revived = new f.DeskController({ chromeApi: f.chromeApi, model, fetchImpl: f.remote.fetchImpl });
  assert.equal((await revived.handle('getState')).rewardSettings.enabled, true);
  await f.controller.handle('pair', CODE);
  await f.controller.handle('setAutoRewards', false);
  assert.equal(f.remote.calls.some(([method]) => method === 'setAutoRewards'), false);
  assert.equal((await f.controller.handle('getState')).rewardSettings.enabled, false);
});

test('content reward messages are limited to a managed top-frame official channel', async () => {
  const f = await setup();
  await f.controller.handle('addChannel', { input: ID_A });
  await f.controller.handle('setAutoRewards', true);
  const valid = rewardSender(f);
  for (const sender of [
    { ...valid, id: 'evil' }, { ...valid, frameId: 1 }, { ...valid, url: 'https://evil.com' },
    { ...valid, url: `https://chzzk.naver.com/live/${ID_B}` },
    { ...valid, tab: { ...valid.tab, incognito: true } }
  ]) {
    assert.deepEqual(await f.controller.handleRewardMessage({ method: 'getConfig' }, sender), { enabled: false, channelId: null });
    await assert.rejects(f.controller.handleRewardMessage({ method: 'getBalance', channelId: ID_A }, sender));
  }
  await assert.rejects(f.controller.handleRewardMessage({ method: 'pair', channelId: ID_A, arg: CODE }, valid), /지원하지/);
  await assert.rejects(f.controller.handleRewardMessage({ method: 'getBalance', channelId: ID_B }, valid));
  await f.controller.handle('clearSlot', 0);
  assert.deepEqual(await f.controller.handleRewardMessage({ method: 'getConfig' }, valid), { enabled: false, channelId: null });
});

test('reward balance uses only credentialed official GET and returns minimal data without bridge secrets', async () => {
  const f = await setup();
  await f.controller.handle('addChannel', { input: ID_A });
  const sender = rewardSender(f);
  let calls = 0;
  f.controller.fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, `https://api.chzzk.naver.com/service/v1/channels/${ID_A}/log-power`);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'include');
    assert.equal(options.body, undefined);
    assert.equal(options.headers, undefined);
    return { ok: true, json: async () => ({ code: 200, secret: TOKEN, content: { amount: 1250, claims: [
      { claimId: 12, claimType: 'WATCH_1_HOUR', state: 'COMPLIED', saveType: 'ACTIVE', amount: 100, internal: TOKEN }
    ], account: TOKEN } }) };
  };
  const request = { method: 'getBalance', channelId: ID_A };
  const [value] = await Promise.all([f.controller.handleRewardMessage(request, sender), f.controller.handleRewardMessage(request, sender)]);
  assert.equal(calls, 1);
  assert.deepEqual(value, { code: 200, content: { amount: 1250, claims: [
    { claimId: 12, claimType: 'WATCH_1_HOUR', state: 'COMPLIED', saveType: 'ACTIVE', amount: 100 }
  ] } });
  assert.equal(JSON.stringify(value).includes(TOKEN), false);
  await f.controller.handleRewardMessage({ method: 'reportStatus', channelId: ID_A,
    state: { balance: 1250, status: 'watching', message: '보유량 확인' } }, sender);
  const state = await f.controller.handle('getState');
  assert.equal(state.rewards[0].balance, 1250);
  assert.equal(state.rewards[0].status, 'disabled');
});

test('content adapter starts after config, scopes balance requests and stops on page departure', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  let options, receiver, config = { enabled: false, channelId: ID_A };
  let starts = 0, stops = 0;
  const enabled = [], requests = [], events = new Map(), timers = new Map();
  const context = {
    document: {}, location: { href: `https://chzzk.naver.com/live/${ID_A}` },
    DeskRewards: { createWatcher(value) {
      options = value;
      return { start() { starts++; }, stop() { stops++; }, setEnabled(value) { enabled.push(value); },
        getState() { return { channelId: ID_A, balance: 41, status: 'disabled' }; } };
    } },
    chrome: { runtime: {
      onMessage: { addListener(fn) { receiver = fn; } },
      async sendMessage(message) {
        requests.push(message);
        if (message.method === 'getConfig') return { ok: true, value: { ...config } };
        if (message.method === 'getBalance') return { ok: true, value: { code: 200, content: { amount: 42, claims: [] } } };
        return { ok: true, value: true };
      }
    } },
    setInterval(fn) { timers.set(1, fn); return 1; }, clearInterval(id) { timers.delete(id); },
    addEventListener(name, fn) { events.set(name, fn); }
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../content/rewards-adapter.js'), 'utf8'), context);
  assert.equal(starts, 0, 'No balance read can precede the managed-channel config');
  await settle();
  assert.equal(starts, 1);
  assert.equal(enabled.at(-1), false);
  const value = await options.fetchBalance(ID_A);
  assert.equal(value.content.amount, 42);
  await assert.rejects(options.fetchBalance(ID_B), /중지/);
  await assert.rejects(options.fetchBalance(ID_A, { signal: { aborted: true } }), /중지/);
  config.enabled = true;
  receiver({ target: 'desk-rewards-config' });
  await settle();
  assert.equal(enabled.at(-1), true);
  const previousReports = requests.filter(item => item.method === 'reportStatus').length;
  assert.equal(previousReports, 2, 'Config refresh republishes current state to a recreated worker');
  options.onStatus({ channelId: ID_A, balance: 42, status: 'watching' });
  options.onStatus({ channelId: ID_A, balance: 42, status: 'watching' });
  options.onStatus({ channelId: ID_B, balance: 99, status: 'watching' });
  await settle();
  assert.equal(requests.filter(item => item.method === 'reportStatus').length, previousReports + 1);
  assert.ok(requests.every(item => item.target === 'desk-rewards'));
  events.get('pagehide')({ persisted: true });
  assert.equal(stops, 1);
  assert.equal(timers.size, 0);
  await assert.rejects(options.fetchBalance(ID_A), /중지/);
  events.get('pageshow')({ persisted: true });
  await settle();
  assert.equal(starts, 2);
  assert.equal(timers.size, 1);
});

test('a channel navigation discards a reward balance request that completed for the old page', async () => {
  const f = await setup();
  await f.controller.handle('addChannel', { input: ID_A });
  const sender = rewardSender(f);
  let finish;
  f.controller.fetchImpl = () => new Promise(resolve => { finish = resolve; });
  const pending = f.controller.handleRewardMessage({ method: 'getBalance', channelId: ID_A }, sender);
  await new Promise(resolve => setImmediate(resolve));
  f.tabs.get(sender.tab.id).url = 'https://example.com';
  finish({ ok: true, json: async () => ({ code: 200, content: { amount: 42, claims: [] } }) });
  await assert.rejects(pending, /변경/);
});

test('clearing a slot during content sender validation safely rejects the old tab snapshot', async () => {
  const f = await setup();
  await f.controller.handle('addChannel', { input: ID_A });
  await f.controller.handle('setAutoRewards', true);
  const sender = rewardSender(f);
  const originalGet = f.chromeApi.tabs.get;
  let release, held = false;
  f.chromeApi.tabs.get = async id => {
    const tab = await originalGet(id);
    if (!held) { held = true; return new Promise(resolve => { release = () => resolve(tab); }); }
    return tab;
  };
  const config = f.controller.handleRewardMessage({ method: 'getConfig' }, sender);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  await f.controller.handle('clearSlot', 0);
  release();
  assert.deepEqual(await config, { enabled: false, channelId: null });
  assert.equal((await f.controller.handle('getState')).slots[0].channelId, null);
});

test('clip length defaults to 30 and standalone choices persist without opening or recording', async () => {
  const f = await setup();
  f.local['desk.preferences'] = { layout: 'focus', mainSlot: 2, autoRewards: true, clipSeconds: '60' };
  assert.equal((await f.controller.handle('getState')).clipSeconds, 30);
  for (const seconds of [15, 60, 30]) {
    const state = await f.controller.handle('setClipSeconds', seconds);
    assert.equal(state.clipSeconds, seconds);
    assert.deepEqual(f.local['desk.preferences'], { layout: 'focus', mainSlot: 2, autoRewards: true, clipSeconds: seconds });
    const revived = new f.DeskController({ chromeApi: f.chromeApi, model, fetchImpl: f.remote.fetchImpl });
    assert.equal((await revived.handle('getState')).clipSeconds, seconds);
  }
  assert.equal(f.effects.length, 0);
  assert.equal(f.remote.calls.length, 0);
});

test('invalid lengths and failed local persistence leave the selected clip length unchanged', async () => {
  const f = await setup();
  await f.controller.handle('setClipSeconds', 15);
  for (const value of [0, 10, 45, 120, '30', null, {}, NaN, Infinity]) {
    await assert.rejects(f.controller.handle('setClipSeconds', value));
  }
  assert.equal((await f.controller.handle('getState')).clipSeconds, 15);
  const originalSet = f.chromeApi.storage.local.set;
  f.chromeApi.storage.local.set = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(f.controller.handle('setClipSeconds', 60), /storage unavailable/);
  f.chromeApi.storage.local.set = originalSet;
  assert.equal((await f.controller.handle('getState')).clipSeconds, 15);
  assert.equal(f.local['desk.preferences'].clipSeconds, 15);
});

test('paired clip length shares desktop settings, fails closed and follows an explicit disconnect', async () => {
  const f = await setup();
  await f.controller.handle('setClipSeconds', 15);
  f.remote.state.clipSeconds = 60;
  assert.equal((await f.controller.handle('pair', CODE)).clipSeconds, 60);
  assert.equal((await f.controller.handle('setClipSeconds', 30)).clipSeconds, 30);
  assert.deepEqual(f.remote.calls.find(([method]) => method === 'setClipSeconds'), ['setClipSeconds', 30]);
  assert.equal(f.local['desk.preferences'].clipSeconds, 15);
  f.remote.setUnavailable(true);
  await assert.rejects(f.controller.handle('setClipSeconds', 60));
  assert.equal((await f.controller.handle('getState')).clipSeconds, 30);
  assert.equal(f.local['desk.preferences'].clipSeconds, 15);
  assert.equal((await f.controller.handle('disconnect')).clipSeconds, 30);
  assert.equal(f.local['desk.preferences'].clipSeconds, 30);
});

test('save sends each supported length with its expected channel and omitted length follows desktop preference', async () => {
  const f = await setup();
  await f.controller.handle('pair', CODE);
  await f.controller.handle('addChannel', { input: ID_A });
  await f.controller.handle('setBuffer', { slotId: 0, enabled: true });
  for (const seconds of [15, 30, 60]) {
    await f.controller.handle('saveClip', { slotId: 0, seconds });
    assert.deepEqual(f.remote.calls.filter(([method]) => method === 'saveClip').at(-1),
      ['saveClip', { slotId: 0, seconds, channelId: ID_A }]);
  }
  f.remote.state.clipSeconds = 60;
  await f.controller.handle('saveClip', { slotId: 0 });
  assert.equal(f.remote.calls.filter(([method]) => method === 'saveClip').at(-1)[1].seconds, 60);
  const beforeInvalid = f.remote.calls.length;
  for (const seconds of [0, 5, 90, '60', null]) await assert.rejects(f.controller.handle('saveClip', { slotId: 0, seconds }));
  assert.equal(f.remote.calls.length, beforeInvalid, 'Unsupported lengths never reach the desktop bridge');
});

test('keyboard save resolves the latest selected length and audible slot, then falls back to the main slot', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const { DeskController, panelSenderAllowed } = await import('../lib/core.js');
  const f = await setup();
  const controller = f.controller;
  await controller.handle('pair', CODE);
  await controller.handle('addChannel', { input: ID_A });
  await controller.handle('addChannel', { input: ID_B });
  await controller.handle('setBuffer', { slotId: 0, enabled: true });
  await controller.handle('setBuffer', { slotId: 1, enabled: true });
  await controller.handle('selectAudio', 1);
  await controller.handle('setClipSeconds', 60);
  let command;
  const noopListener = { addListener() {} };
  f.chromeApi.runtime.onMessage = noopListener;
  f.chromeApi.storage.local.setAccessLevel = async () => {};
  f.chromeApi.sidePanel = { setPanelBehavior: async () => {} };
  f.chromeApi.tabs.onUpdated = noopListener;
  f.chromeApi.tabs.onRemoved = noopListener;
  f.chromeApi.commands = { onCommand: { addListener(fn) { command = fn; } } };
  const background = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('const controller = new DeskController({ chromeApi: chrome, model: globalThis.DeskChannels });', '');
  vm.runInNewContext(background, { controller, DeskController, panelSenderAllowed, chrome: f.chromeApi });
  command('save-recent');
  await new Promise(resolve => setImmediate(resolve));
  await controller.queue;
  assert.deepEqual(f.remote.calls.filter(([method]) => method === 'saveClip').at(-1)[1], { slotId: 1, seconds: 60, channelId: ID_B });
  await controller.handle('selectAudio', null);
  await controller.handle('setLayout', { layout: 'focus', mainSlot: 0 });
  await controller.handle('setClipSeconds', 15);
  command('save-recent');
  await new Promise(resolve => setImmediate(resolve));
  await controller.queue;
  assert.deepEqual(f.remote.calls.filter(([method]) => method === 'saveClip').at(-1)[1], { slotId: 0, seconds: 15, channelId: ID_A });
});

test('headless rpc remains usable without Chrome storage or an explicit model', async () => {
  const { DeskController } = await import('../lib/core.js');
  const remote = remoteFixture();
  const controller = new DeskController({ chromeApi: {}, fetchImpl: remote.fetchImpl });
  const state = await controller.rpc('getState', undefined, { port: 43210, token: TOKEN });
  assert.equal(state.clipSeconds, 30);
  assert.deepEqual(remote.calls, [['getState', undefined]]);
});

test('a replacement assignment invalidates an earlier tab lookup without clearing the new audio selection', async () => {
  const f = await setup();
  await f.controller.handle('addChannel', { input: ID_A });
  await f.controller.handle('addChannel', { input: ID_B });
  await f.controller.handle('clearSlot', 1);
  await f.controller.handle('setAutoRewards', true);
  const sender = rewardSender(f);
  const originalGet = f.chromeApi.tabs.get;
  let release, held = false;
  f.chromeApi.tabs.get = async id => {
    const tab = await originalGet(id);
    if (!held) { held = true; return new Promise(resolve => { release = () => resolve(tab); }); }
    return tab;
  };
  const pending = f.controller.handleRewardMessage({ method: 'getConfig' }, sender);
  await new Promise(resolve => setImmediate(resolve));
  await f.controller.handle('assignSlot', { slotId: 0, channelId: ID_B });
  await f.controller.handle('selectAudio', 0);
  release();
  assert.deepEqual(await pending, { enabled: false, channelId: null });
  const state = f.controller.snapshot();
  assert.equal(state.slots[0].channelId, ID_B);
  assert.equal(state.slots[0].tabId, sender.tab.id);
  assert.equal(state.audioSlot, 0);
  assert.equal(f.tabs.get(sender.tab.id).mutedInfo.muted, false);
});

test('ManagedTabs operates independently, preserves adopted mute state and retains existing session fields', async () => {
  const { ManagedTabs } = await import('../lib/managed-tabs.js');
  const { DeskStorage } = await import('../lib/desk-storage.js');
  const f = browserFixture();
  const adopted = await f.chromeApi.tabs.create({ url: `https://chzzk.naver.com/live/${ID_A}` });
  f.session['desk.tabs'] = { remote: { marker: 'preserve' }, managedWindows: [10], arrangementBounds: { left: 1, top: 2, width: 900, height: 700 } };
  const storage = new DeskStorage({ chromeApi: f.chromeApi, model });
  const saved = await storage.load();
  const managed = new ManagedTabs({ chromeApi: f.chromeApi, model, storage });
  managed.restore(saved.session);
  await managed.open(0, { id: ID_A, name: 'A' });
  assert.equal(managed.snapshot([{ id: ID_A, name: 'A' }]).slots[0].tabId, adopted.id);
  managed.records()[0].channelId = ID_B;
  assert.equal(managed.channelId(0), ID_A, 'Callers cannot mutate a service-owned record');
  await managed.selectAudio(0);
  assert.equal(managed.snapshot([]).audioSlot, 0);
  assert.equal((await managed.targets())[0].tab.id, adopted.id);
  assert.deepEqual(f.session['desk.tabs'].remote, { marker: 'preserve' });
  assert.deepEqual(f.session['desk.tabs'].managedWindows, [10]);
  await managed.release(0);
  assert.equal(f.tabs.has(adopted.id), true);
  assert.equal(f.tabs.get(adopted.id).mutedInfo.muted, false);
  assert.equal(f.session['desk.tabs'].audioSlot, null);
  assert.deepEqual(f.session['desk.tabs'].slots, [null, null, null, null]);
});

test('session updates from separate owners remain ordered and preserve every field after a write failure', async () => {
  const { DeskStorage } = await import('../lib/desk-storage.js');
  const f = browserFixture();
  const storage = new DeskStorage({ chromeApi: f.chromeApi, model });
  await storage.load();
  const originalSet = f.chromeApi.storage.session.set;
  let first = true, release;
  f.chromeApi.storage.session.set = async value => {
    if (first) {
      first = false;
      await new Promise(resolve => { release = resolve; });
      throw new Error('temporary session failure');
    }
    await originalSet(value);
  };
  const tabWrite = storage.updateSession({ slots: [null, null, null, null], audioSlot: null });
  const rejected = assert.rejects(tabWrite, /temporary session failure/);
  const remoteWrite = storage.updateSession({ remote: { channels: [], slots: [] } });
  const windowWrite = storage.updateSession({ managedWindows: [5], arrangementBounds: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.session['desk.tabs'], undefined);
  release();
  await Promise.all([rejected, remoteWrite, windowWrite]);
  assert.deepEqual(f.session['desk.tabs'], { slots: [null, null, null, null], audioSlot: null,
    remote: { channels: [], slots: [] }, managedWindows: [5], arrangementBounds: null });
});

test('DesktopConnection exposes independent snapshots and never touches browser tabs', async () => {
  const { DesktopConnection } = await import('../lib/desktop-connection.js');
  const { DeskStorage } = await import('../lib/desk-storage.js');
  const f = browserFixture(), remote = remoteFixture();
  remote.state.channels = [{ id: ID_A, name: 'A' }];
  remote.state.slots[0].channelId = ID_A;
  const storage = new DeskStorage({ chromeApi: f.chromeApi, model });
  const connection = new DesktopConnection({ model, storage, fetchImpl: remote.fetchImpl, timeoutMs: 5000, actionTimeoutMs: 65000 });
  await connection.restore(await storage.load());
  await connection.pair(CODE);
  const snapshot = connection.remote;
  snapshot.channels[0].name = 'changed';
  snapshot.slots[0].channelId = ID_B;
  assert.equal(connection.remote.channels[0].name, 'A');
  assert.equal(connection.remote.slots[0].channelId, ID_A);
  await connection.mutate('setClipSeconds', 60);
  assert.equal(connection.remote.clipSeconds, 60);
  await connection.disconnect();
  assert.equal(connection.paired, false);
  assert.equal(f.effects.length, 0);
});

async function setupChat() {
  const f = await setup();
  await f.controller.handle('pair', CODE);
  await f.controller.handle('addChannel', { input: ID_A, name: 'A' });
  f.remote.state.autoClips = [{ slotId: 0, channelId: ID_A, generation: 'generation-1', status: 'warming', message: '준비 중' }];
  await f.controller.handle('setAutoClipSettings', { channelId: ID_A, enabled: true, keywords: ['키워드'], chatSpike: true });
  return { ...f, sender: rewardSender(f) };
}

test('automatic clip settings are paired-only, sanitized and preserve clip trigger labels', async () => {
  const f = await setup();
  let state = await f.controller.handle('getState');
  assert.deepEqual(state.autoClipSettings, {});
  assert.ok(state.autoClips.every(slot => slot.status === 'unavailable'));
  await assert.rejects(f.controller.handle('setAutoClipSettings', { channelId: ID_A, enabled: true }), /데스크톱 앱/);
  await f.controller.handle('pair', CODE);
  await f.controller.handle('addChannel', { input: ID_A });
  f.remote.state.clips = [{ id: 'clip-1', trigger: 'keyword', title: '자동 클립' }];
  state = await f.controller.handle('setAutoClipSettings', { channelId: ID_A, enabled: true, keywords: [' 키워드 ', '키워드'], chatSpike: true, secret: TOKEN });
  assert.deepEqual(state.autoClipSettings, { [ID_A]: { enabled: true, keywords: ['키워드'], chatSpike: true } });
  assert.equal(state.clips[0].trigger, 'keyword');
  assert.equal(JSON.stringify(state).includes(TOKEN), false);
  assert.deepEqual(f.remote.calls.find(([method]) => method === 'setAutoClipSettings')[1],
    { channelId: ID_A, enabled: true, keywords: [' 키워드 ', '키워드'], chatSpike: true });
  f.remote.setUnavailable(true);
  await assert.rejects(f.controller.handle('setAutoClipSettings', { channelId: ID_A, enabled: false }), /연결/);
  assert.equal(f.local['desk.preferences']?.autoClipSettings, undefined, 'There is no stale standalone fallback');
});

test('chat content receives only active context and submits a fixed RPC without per-batch refresh or raw-chat storage', async () => {
  const f = await setupChat();
  const context = await f.controller.handleChatMessage({ method: 'getContext' }, f.sender);
  assert.deepEqual(context, { slotId: 0, channelId: ID_A, generation: 'generation-1' });
  const before = f.remote.calls.length;
  const batch = { ...context, sourceStatus: 'watching', events: [{ id: 'message-1', text: '원본 채팅은 저장하지 않음', nickname: '제외' }] };
  assert.equal(await f.controller.handleChatMessage({ method: 'submitBatch', arg: batch }, f.sender), true);
  assert.deepEqual(f.remote.calls.slice(before), [['submitChatBatch', { ...batch, events: [{ id: 'message-1', text: '원본 채팅은 저장하지 않음' }] }]]);
  assert.equal(JSON.stringify([f.local, f.session]).includes('원본 채팅은 저장하지 않음'), false);
  assert.equal(await f.controller.handleChatMessage({ method: 'submitBatch', arg: { ...context, sourceStatus: 'waiting', events: [] } }, f.sender), true);
});

test('chat rejects other frames/tabs/origins, stale generations, oversized messages and arbitrary methods', async () => {
  const f = await setupChat();
  const context = await f.controller.handleChatMessage({ method: 'getContext' }, f.sender);
  const batch = { ...context, sourceStatus: 'watching', events: [{ id: 'message-1', text: '본문' }] };
  const invalidSenders = [
    { ...f.sender, id: 'other-extension' }, { ...f.sender, frameId: 1 },
    { ...f.sender, tab: { ...f.sender.tab, incognito: true } },
    { ...f.sender, tab: { id: 999 } }, { ...f.sender, url: 'https://example.com/live/' + ID_A },
    { ...f.sender, url: 'https://chzzk.naver.com/live/' + ID_B }
  ];
  const before = f.remote.calls.length;
  for (const sender of invalidSenders) {
    assert.equal(await f.controller.handleChatMessage({ method: 'getContext' }, sender), null);
    await assert.rejects(f.controller.handleChatMessage({ method: 'submitBatch', arg: batch }, sender));
  }
  for (const arg of [{ ...batch, generation: 'old' }, { ...batch, channelId: ID_B }, { ...batch, slotId: 1 },
    { ...batch, events: Array(101).fill(batch.events[0]) }, { ...batch, events: [{ id: 'x'.repeat(129), text: 'a' }] },
    { ...batch, events: [{ id: 'x', text: 'a'.repeat(501) }] }, { ...batch, sourceStatus: 'unknown' },
    { ...batch, events: Array.from({ length: 100 }, (_, index) => ({ id: String(index), text: '가'.repeat(500) })) }]) {
    await assert.rejects(f.controller.handleChatMessage({ method: 'submitBatch', arg }, f.sender));
  }
  await assert.rejects(f.controller.handleChatMessage({ method: 'saveClip', arg: batch }, f.sender), /지원하지/);
  assert.equal(f.remote.calls.length, before, 'Rejected content does not reach the desktop transport');
  f.tabs.get(f.sender.tab.id).url = 'https://example.com/';
  assert.equal(await f.controller.handleChatMessage({ method: 'getContext' }, f.sender), null);
});

test('chat stops on generation/config changes and an in-flight tab lookup cannot revive a released slot', async () => {
  const f = await setupChat();
  const context = await f.controller.handleChatMessage({ method: 'getContext' }, f.sender);
  const request = { method: 'submitBatch', arg: { ...context, sourceStatus: 'watching', events: [] } };
  f.remote.state.autoClips[0].generation = 'generation-2';
  await f.controller.handle('getState');
  await assert.rejects(f.controller.handleChatMessage(request, f.sender));
  await f.controller.handle('setAutoClipSettings', { channelId: ID_A, enabled: false, keywords: ['키워드'], chatSpike: true });
  assert.equal(await f.controller.handleChatMessage({ method: 'getContext' }, f.sender), null);
  await f.controller.handle('setAutoClipSettings', { channelId: ID_A, enabled: true, keywords: ['키워드'], chatSpike: true });
  const originalGet = f.chromeApi.tabs.get;
  let release, held = false;
  f.chromeApi.tabs.get = async id => {
    const tab = await originalGet(id);
    if (!held) { held = true; return new Promise(resolve => { release = () => resolve(tab); }); }
    return tab;
  };
  const pending = f.controller.handleChatMessage({ ...request, arg: { ...request.arg, generation: 'generation-2' } }, f.sender);
  const rejection = assert.rejects(pending);
  await new Promise(resolve => setImmediate(resolve));
  await f.controller.handle('clearSlot', 0);
  release(); await rejection;
  assert.equal(f.remote.calls.some(([method]) => method === 'submitChatBatch'), false);
});

test('invalid auto-clip input reaches strict desktop validation intact instead of being silently truncated', async () => {
  const f = await setupChat();
  const keywords = ['가'.repeat(41)];
  const originalFetch = f.controller.fetchImpl;
  f.controller.fetchImpl = async (url, options) => {
    const { method, arg } = JSON.parse(options.body);
    if (method === 'setAutoClipSettings') {
      assert.deepEqual(arg.keywords, keywords);
      return { ok: true, status: 200, json: async () => ({ ok: false, error: '키워드는 최대 10개, 각각 40자까지 입력해 주세요.' }) };
    }
    return originalFetch(url, options);
  };
  await assert.rejects(f.controller.handle('setAutoClipSettings', { channelId: ID_A, enabled: true, keywords, chatSpike: true }), /40자/);
  assert.deepEqual(f.controller.snapshot().autoClipSettings[ID_A].keywords, ['키워드']);
});

test('desktop rejection of a stale chat generation is not reported as accepted to content', async () => {
  const f = await setupChat();
  const context = await f.controller.handleChatMessage({ method: 'getContext' }, f.sender);
  const originalFetch = f.controller.fetchImpl;
  f.controller.fetchImpl = async (url, options) => JSON.parse(options.body).method === 'submitChatBatch'
    ? { ok: true, status: 200, json: async () => ({ ok: true, value: { accepted: false } }) }
    : originalFetch(url, options);
  await assert.rejects(f.controller.handleChatMessage({ method: 'submitBatch', arg: { ...context, sourceStatus: 'watching', events: [] } }, f.sender), /전달하지/);
});
