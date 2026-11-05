'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../shared/channels.js');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture() {
  const { ManagedTabs } = await import('../lib/managed-tabs.js');
  const tabs = new Map(), effects = [], session = {}; let nextId = 1;
  const chromeApi = {
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error('closed'); return structuredClone(tabs.get(id)); },
      async query() { return [...tabs.values()].map(tab => structuredClone(tab)); },
      async create(value) { const tab = { id: nextId++, windowId: 1, mutedInfo: { muted: false }, status: 'complete', ...value }; tabs.set(tab.id, tab); return structuredClone(tab); },
      async update(id, patch) { if (!tabs.has(id)) throw new Error('closed'); const tab = tabs.get(id); Object.assign(tab, patch); if (typeof patch.muted === 'boolean') tab.mutedInfo = { muted: patch.muted }; effects.push([id, structuredClone(patch)]); return structuredClone(tab); },
      async remove(id) { tabs.delete(id); }
    },
    windows: { async getLastFocused() { return { id: 1, type: 'normal' }; }, async update() {} }
  };
  const storage = { async updateSession(patch) { Object.assign(session, structuredClone(patch)); } };
  const manager = new ManagedTabs({ chromeApi, model, storage });
  for (const slotId of [0, 1, 2]) await manager.open(slotId, { id: String(slotId + 1).repeat(32), name: `방송 ${slotId}` });
  return { ManagedTabs, manager, chromeApi, tabs, effects, session, storage };
}

test('managed broadcasts toggle independently, retain primary selection, and preserve solo/mute-all', async () => {
  const f = await fixture(), m = f.manager;
  assert.deepEqual(m.audioSlots, []); assert([...f.tabs.values()].every(tab => tab.mutedInfo.muted));
  await m.setAudioEnabled({ slotId: 2, enabled: true }); await m.setAudioEnabled({ slotId: 0, enabled: true });
  assert.deepEqual(m.audioSlots, [0, 2]); assert.equal(m.audioSlot, 0);
  assert.equal(f.tabs.get(m.slot(2).tabId).mutedInfo.muted, false);
  assert.deepEqual(f.session.audioSlots, [2, 0], 'Persist activation order for the next primary after a toggle off');
  await m.setAudioEnabled({ slotId: 0, enabled: false }); assert.equal(m.audioSlot, 2);
  await m.setAudioEnabled({ slotId: 1, enabled: true }); await m.selectAudio(0);
  assert.deepEqual(m.audioSlots, [0]); assert([...f.tabs.values()].filter(tab => !tab.mutedInfo.muted).length === 1);
  await m.selectAudio(null); assert.deepEqual(m.audioSlots, []); assert.equal(m.audioSlot, null);
  await assert.rejects(m.setAudioEnabled({ slotId: 4, enabled: true }));
  await assert.rejects(m.setAudioEnabled({ slotId: 0, enabled: 1 }));
});

test('worker restoration keeps live multi-audio selection but never unmutes closed or manually muted tabs', async () => {
  const f = await fixture(); await f.manager.setAudioEnabled({ slotId: 2, enabled: true }); await f.manager.setAudioEnabled({ slotId: 0, enabled: true });
  const revived = new f.ManagedTabs({ chromeApi: f.chromeApi, model, storage: f.storage });
  const effects = f.effects.length; revived.restore(f.session); await revived.inspect();
  assert.deepEqual(revived.audioSlots, [0, 2]); assert.equal(revived.audioSlot, 0); assert.equal(f.effects.length, effects);
  await revived.setAudioEnabled({ slotId: 0, enabled: false }); assert.equal(revived.audioSlot, 2);
  f.tabs.get(revived.slot(2).tabId).mutedInfo.muted = true;
  await revived.inspect(); assert.deepEqual(revived.audioSlots, []); assert.equal(revived.audioSlot, null);
  const fresh = new f.ManagedTabs({ chromeApi: f.chromeApi, model, storage: f.storage }); fresh.restore({});
  assert.deepEqual(fresh.audioSlots, []); assert.deepEqual(fresh.tabIds(), []);
  const legacy = new f.ManagedTabs({ chromeApi: f.chromeApi, model, storage: f.storage });
  legacy.restore({ slots: f.manager.records(), audioSlot: 1 }); assert.deepEqual(legacy.audioSlots, [1]);
});

test('closing or replacing one tab removes only its audio selection', async () => {
  const f = await fixture(), m = f.manager;
  await m.setAudioEnabled({ slotId: 0, enabled: true }); await m.setAudioEnabled({ slotId: 1, enabled: true });
  await m.open(0, { id: 'a'.repeat(32), name: '새 방송' });
  assert.deepEqual(m.audioSlots, [1]); assert.equal(f.tabs.get(m.slot(1).tabId).mutedInfo.muted, false);
  await m.setAudioEnabled({ slotId: 0, enabled: true }); await m.release(0);
  assert.deepEqual(m.audioSlots, [1]); assert.equal(m.audioSlot, 1);
  f.tabs.delete(m.slot(1).tabId); await m.inspect(); assert.deepEqual(m.audioSlots, []);
});

test('failed replacement or close does not report a still-audible managed tab as muted', async () => {
  const f = await fixture(), m = f.manager;
  await m.setAudioEnabled({ slotId: 0, enabled: true }); await m.setAudioEnabled({ slotId: 1, enabled: true });
  f.chromeApi.tabs.query = async () => { throw new Error('query failed'); };
  await assert.rejects(m.open(0, { id: 'd'.repeat(32), name: '교체 실패' }), /query failed/);
  assert.deepEqual(m.audioSlots, [0, 1]);
  f.chromeApi.tabs.remove = async () => { throw new Error('close failed'); };
  await assert.rejects(m.release(0), /close failed/);
  assert.deepEqual(m.audioSlots, [0, 1]); assert.equal(f.tabs.get(m.slot(0).tabId).mutedInfo.muted, false);
});

test('parallel toggles of different broadcasts both remain enabled', async () => {
  const f = await fixture();
  await Promise.all([f.manager.setAudioEnabled({ slotId: 0, enabled: true }), f.manager.setAudioEnabled({ slotId: 1, enabled: true })]);
  assert.deepEqual(f.manager.audioSlots, [0, 1]);
  for (const slotId of [0, 1]) assert.equal(f.tabs.get(f.manager.slot(slotId).tabId).mutedInfo.muted, false);
});

test('a stale tab lookup cannot unmute an old ownership or clear the replacement selection', async () => {
  const f = await fixture(), gate = deferred(), old = structuredClone(f.tabs.get(f.manager.slot(0).tabId));
  const get = f.chromeApi.tabs.get; let delayed = false;
  f.chromeApi.tabs.get = id => { if (id === old.id && !delayed) { delayed = true; return gate.promise; } return get(id); };
  const pending = f.manager.setAudioEnabled({ slotId: 0, enabled: true });
  await f.manager.release(0); await f.manager.open(0, { id: 'b'.repeat(32), name: '교체 방송' });
  await f.manager.setAudioEnabled({ slotId: 0, enabled: true });
  gate.resolve(old); assert.equal(await pending, false);
  assert.deepEqual(f.manager.audioSlots, [0]); assert.equal(f.tabs.get(f.manager.slot(0).tabId).mutedInfo.muted, false);
});

test('late mute updates are ordered so the newest solo action wins', async () => {
  const f = await fixture(), gate = deferred(), update = f.chromeApi.tabs.update, id = f.manager.slot(0).tabId;
  let delayed = false;
  f.chromeApi.tabs.update = async (tabId, patch) => { if (tabId === id && patch.muted === false && !delayed) { delayed = true; await gate.promise; } return update(tabId, patch); };
  const pending = f.manager.setAudioEnabled({ slotId: 0, enabled: true });
  await new Promise(resolve => setImmediate(resolve)); const solo = f.manager.selectAudio(1);
  gate.resolve(); await Promise.all([pending, solo]);
  assert.deepEqual(f.manager.audioSlots, [1]); assert.equal(f.tabs.get(id).mutedInfo.muted, true);
  assert.equal(f.tabs.get(f.manager.slot(1).tabId).mutedInfo.muted, false);
});

test('opening a video asks for the last normal window, excluding a focused chat popup', async () => {
  const f = await fixture(), calls = [];
  f.chromeApi.windows.getLastFocused = async options => {
    calls.push(options);
    return options?.windowTypes?.includes('normal') ? { id: 12, type: 'normal' } : { id: 44, type: 'popup' };
  };
  await f.manager.open(3, { id: 'd'.repeat(32), name: '다음 방송' });
  assert.deepEqual(calls, [{ windowTypes: ['normal'] }]);
  assert.equal(f.tabs.get(f.manager.slot(3).tabId).windowId, 12);
});

test('opening a video recovers a regular window when the last window is unavailable or unsuitable', async () => {
  for (const current of [null, { id: 44, type: 'popup' }, { id: 45, type: 'normal', incognito: true }]) {
    const f = await fixture();
    f.chromeApi.windows.getLastFocused = async () => { if (!current) throw new Error('closed'); return current; };
    f.chromeApi.windows.getAll = async options => {
      assert.deepEqual(options, { windowTypes: ['normal'] });
      return [{ id: 44, type: 'popup', focused: true }, { id: 45, type: 'normal', incognito: true }, { id: 12, type: 'normal' }];
    };
    await f.manager.open(3, { id: 'd'.repeat(32), name: '다음 방송' });
    assert.equal(f.tabs.get(f.manager.slot(3).tabId).windowId, 12);
  }
});

test('opening a video with only popup windows asks for a normal window without creating a tab', async () => {
  const f = await fixture(), before = f.tabs.size;
  f.chromeApi.windows.getLastFocused = async () => ({ id: 44, type: 'popup' });
  f.chromeApi.windows.getAll = async () => [{ id: 44, type: 'popup' }];
  await assert.rejects(f.manager.open(3, { id: 'd'.repeat(32), name: '다음 방송' }), /일반 Chrome 창/);
  assert.equal(f.tabs.size, before); assert.equal(f.manager.slot(3), null);
});
