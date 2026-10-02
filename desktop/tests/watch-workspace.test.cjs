'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { WatchWorkspace } = require('../lib/watch-workspace.cjs');
const { ProfileStore } = require('../lib/profile-store.cjs');
const { normalizeSettings, createWatchPreset, updateChannel } = require('../lib/channels.cjs');
const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fixture = () => {
  const settings = normalizeSettings({ channels: [{ id: A, name: 'A' }, { id: B, name: 'B' }], slots: [A, B], layout: 'grid', mainSlot: 1 });
  const calls = [], saved = [];
  let quitting = false, failure = null;
  const service = new WatchWorkspace({ settings, persist: async () => { saved.push(structuredClone(settings)); },
    exclusive: async action => { calls.push('lock'); try { return await action(); } finally { calls.push('unlock'); } },
    closeSlot: async slotId => { calls.push(`close:${slotId}`); settings.slots[slotId] = null; if (failure === slotId) throw new Error('stop failed'); },
    openSlot: (slotId, channelId, playbackMode) => { calls.push(`open:${slotId}`); settings.slots[slotId] = channelId;
      settings.playbackModes ||= []; settings.playbackModes[slotId] = playbackMode; }, isQuitting: () => quitting });
  return { settings, service, calls, saved, set quitting(value) { quitting = value; }, set failure(value) { failure = value; } };
};

test('presets store portable channels/layout without restoring audio, recording or account data', async () => {
  const f = fixture(); f.settings.audioSlot = 1; f.settings.recording = true; f.settings.token = 'private';
  await f.service.save({ name: '저녁 방송' });
  const preset = f.settings.watchPresets[0];
  assert.deepEqual(Object.keys(preset).sort(), ['id', 'layout', 'mainSlot', 'name', 'slots']);
  assert.deepEqual(preset.slots, [A, B, null, null]); assert.equal(preset.layout, 'grid');
  await assert.rejects(f.service.save({ name: ' 저녁 방송 ' }), /같은 이름/);
  f.settings.slots[0] = B; assert.equal(preset.slots[0], A, 'saved slots are not shared mutable arrays');
});

test('preset swaps close all changed players before opening replacements and keep unchanged buffers', async () => {
  const f = fixture(); await f.service.save({ name: 'saved' });
  const id = f.settings.watchPresets[0].id;
  await f.service.apply(id, 'desktop'); assert.deepEqual(f.calls, ['lock', 'unlock']);
  f.calls.length = 0; f.settings.slots = [B, A, null, null];
  await f.service.apply(id, 'desktop');
  assert.deepEqual(f.calls, ['lock', 'close:0', 'close:1', 'open:0', 'open:1', 'unlock']);
  assert.deepEqual(f.settings.slots, [A, B, null, null]);
  f.calls.length = 0; await f.service.apply(id, 'browser');
  assert.equal(f.calls.filter(value => value.startsWith('close')).length, 2, 'mode switches also stop prior buffer owners');
});

test('partial close failure and shutdown preserve the actual assignments and never reopen after quitting', async () => {
  const f = fixture(); await f.service.save({ name: 'saved' }); f.settings.slots = [B, A, null, null];
  f.failure = 1;
  await assert.rejects(f.service.apply(f.settings.watchPresets[0].id, 'desktop'), /stop failed/);
  assert.ok(!f.calls.some(call => call.startsWith('open'))); assert.deepEqual(f.saved.at(-1).slots, [null, null, null, null]);
  f.failure = null; f.quitting = true;
  await assert.rejects(f.service.apply(f.settings.watchPresets[0].id, 'desktop'), /종료/);
  assert.ok(!f.calls.some(call => call.startsWith('open')));
});

test('normalization prunes removed/duplicate channels and rejects malformed presets', () => {
  const state = normalizeSettings({ channels: [{ id: A, pinned: true }, { id: B, pinned: 'true' }], watchPresets: [
    { id: 'saved', name: 'saved', slots: [A, C, A, B], audioSlot: 0, recording: true },
    { id: 'saved', name: 'duplicate', slots: [B] }, { id: '../outside', name: 'bad', slots: [A] },
    { id: 'empty', name: 'empty', slots: [C] }
  ] });
  assert.equal(state.channels[0].pinned, true); assert.equal(state.channels[1].pinned, undefined);
  assert.equal(state.watchPresets.length, 1); assert.deepEqual(state.watchPresets[0].slots, [A, null, null, B]);
  assert.equal(state.watchPresets[0].recording, undefined);
  const f = fixture(); f.settings.watchPresets = state.watchPresets; f.settings.channels = [{ id: B }]; f.service.prune();
  assert.deepEqual(f.settings.watchPresets[0].slots, [null, null, null, B]);
});

test('favorite edits preserve channel identity and unrelated metadata with strict names/pinning', () => {
  const channels = [{ id: A, name: 'A' }, { id: B, name: 'B' }];
  const renamed = updateChannel(channels, 'renameChannel', { channelId: A, name: ' 새 이름 ' });
  assert.deepEqual(renamed, [{ id: A, name: '새 이름' }, channels[1]]); assert.equal(channels[0].name, 'A');
  assert.equal(updateChannel(renamed, 'setChannelPinned', { channelId: A, pinned: true })[0].pinned, true);
  for (const name of ['', 'x'.repeat(61), 'A\nB']) assert.throws(() => updateChannel(channels, 'renameChannel', { channelId: A, name }));
  assert.throws(() => updateChannel(channels, 'setChannelPinned', { channelId: A, pinned: 'true' }));
  assert.throws(() => createWatchPreset({ id: 'x', name: 'x', slots: [A, A, null, null] }, channels));
});

test('a failed save cannot roll back a queued successful preset and each request captures its original view', async () => {
  const f = fixture(), gate = deferred(), disk = new Map();
  const directory = path.resolve(__dirname, 'VIRTUAL-ONLY-watch-workspace');
  let firstWrite = true;
  // Exercise the real snapshot/queue store using memory only, including a failed
  // first filesystem write. No directory or profile is opened on the computer.
  const store = new ProfileStore(directory, { fileSystem: {
    async writeFile(file, content) {
      if (firstWrite) { firstWrite = false; await gate.promise; throw new Error('save failed'); }
      disk.set(file, content);
    },
    async rename(from, to) { disk.set(to, disk.get(from)); disk.delete(from); },
    async rm(file) { disk.delete(file); }
  } });
  f.service.persist = () => store.save({ settings: f.settings, clips: [] });
  const first = assert.rejects(f.service.save({ name: '실패할 조합' }), /save failed/);
  const second = f.service.save({ name: '남길 조합' });
  await new Promise(setImmediate);
  assert.deepEqual(f.settings.watchPresets.map(preset => preset.name), ['실패할 조합'], 'Queued save must wait before mutating metadata');
  f.settings.slots = [B, A, null, null]; f.settings.layout = 'stacked';
  gate.resolve(); await Promise.all([first, second]);
  const persisted = JSON.parse(disk.get(path.join(directory, 'settings.json')));
  assert.deepEqual(f.settings.watchPresets.map(preset => preset.name), ['남길 조합']);
  assert.deepEqual(persisted.watchPresets, f.settings.watchPresets);
  assert.deepEqual(f.settings.watchPresets[0].slots, [A, B, null, null]);
  assert.equal(f.settings.watchPresets[0].layout, 'grid');
});

test('failed removal restores its preset before a queued save validates and the queue remains usable', async () => {
  const f = fixture(); await f.service.save({ name: '보존할 조합' });
  const original = structuredClone(f.settings.watchPresets[0]), gate = deferred();
  let first = true;
  f.service.persist = async () => {
    if (first) { first = false; await gate.promise; throw new Error('remove failed'); }
    f.saved.push(structuredClone(f.settings));
  };
  const removal = assert.rejects(f.service.remove(original.id), /remove failed/);
  const duplicate = assert.rejects(f.service.save({ name: '보존할 조합' }), /같은 이름/);
  const next = f.service.save({ name: '추가할 조합' });
  gate.resolve(); await Promise.all([removal, duplicate, next]);
  assert.deepEqual(f.settings.watchPresets.map(preset => preset.name), ['보존할 조합', '추가할 조합']);
  assert.deepEqual(f.settings.watchPresets[0], original);
  assert.deepEqual(f.saved.at(-1).watchPresets, f.settings.watchPresets);
  await f.service.remove(original.id);
  assert.deepEqual(f.settings.watchPresets.map(preset => preset.name), ['추가할 조합']);
});

test('concurrent duplicate saves and removals validate against prior committed operations', async () => {
  const f = fixture();
  const first = f.service.save({ name: '같은 조합' });
  const duplicate = assert.rejects(f.service.save({ name: '같은 조합' }), /같은 이름/);
  await Promise.all([first, duplicate]);
  assert.equal(f.settings.watchPresets.length, 1); assert.equal(f.saved.length, 1);
  const id = f.settings.watchPresets[0].id;
  await Promise.all([f.service.remove(id), assert.rejects(f.service.remove(id), /찾지 못/)]);
  assert.deepEqual(f.settings.watchPresets, []); assert.equal(f.saved.length, 2);
});

test('failed metadata writes cannot restore channels pruned while persistence was pending', async () => {
  const f = fixture(); await f.service.save({ name: '기존 조합' });
  const gate = deferred(); f.service.persist = async () => { await gate.promise; throw new Error('save failed'); };
  const saving = assert.rejects(f.service.save({ name: '실패할 조합' }), /save failed/);
  await new Promise(setImmediate);
  f.settings.channels = [{ id: A, name: 'A' }]; f.service.prune();
  gate.resolve(); await saving;
  assert.equal(f.settings.watchPresets.length, 1);
  assert.equal(f.settings.watchPresets[0].name, '기존 조합');
  assert.deepEqual(f.settings.watchPresets[0].slots, [A, null, null, null]);
});

test('queued metadata work does not start a new write after shutdown begins', async () => {
  const f = fixture(), gate = deferred(); let writes = 0;
  f.service.persist = async () => { writes++; await gate.promise; };
  const first = f.service.save({ name: '진행 중' });
  const queued = assert.rejects(f.service.save({ name: '대기 중' }), /종료/);
  await new Promise(setImmediate); f.quitting = true; gate.resolve();
  await Promise.all([first, queued]);
  assert.equal(writes, 1); assert.deepEqual(f.settings.watchPresets.map(preset => preset.name), ['진행 중']);
});
