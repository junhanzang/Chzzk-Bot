'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AutoClipService } = require('../lib/auto-clip-service.cjs');
const { ChatTrigger, validateBatch } = require('../lib/chat-trigger.cjs');
const { normalizeSettings } = require('../lib/channels.cjs');
const channelId = 'a'.repeat(32), other = 'b'.repeat(32);
const flush = () => new Promise(setImmediate);

function fixture() {
  let now = 100000, busy = false, config = { enabled: true, keywords: ['우와'], chatSpike: false };
  let mark = { generation: 'recording-1', channelId, start: 0, end: 30 };
  let assigned = channelId;
  const recordings = new EventEmitter(); recordings.mark = slotId => slotId === 0 ? mark : null;
  const saved = [];
  const service = new AutoClipService({ recordings, intervalMs: 0, now: () => now,
    assignment: slotId => ({ channelId: slotId === 0 ? assigned : null }), config: id => id === channelId ? config : null,
    isBusy: () => busy, save: async (slotId, range, trigger) => { const record = { slotId, ...range, trigger }; saved.push(record); return record; } });
  service.tick();
  const submit = (events = [], extra = {}) => service.submit({ ...service.context(0), sourceStatus: 'watching', events, ...extra });
  return { service, saved, recordings, submit, get mark() { return mark; }, set mark(value) { mark = value; },
    set now(value) { now = value; }, get now() { return now; }, set busy(value) { busy = value; },
    set config(value) { config = value; }, set assigned(value) { assigned = value; },
    trigger() { submit(); now += 6000; submit([{ id: `event-${now}`, text: '우와 명장면' }]); } };
}

test('keyword capture anchors to completed media and waits for post-roll progress', async () => {
  const f = fixture(); f.trigger();
  assert.equal(f.service.state(0).status, 'pending');
  f.now += 11000; f.service.tick(); await flush(); assert.equal(f.saved.length, 0, 'elapsed wall time is not video progress');
  f.mark = { ...f.mark, end: 39.9 }; f.service.tick(); await flush(); assert.equal(f.saved.length, 0);
  f.mark = { ...f.mark, end: 40 }; f.service.tick(); await flush();
  assert.equal(f.saved.length, 1);
  assert.deepEqual([f.saved[0].generation, f.saved[0].start, f.saved[0].end, f.saved[0].trigger], ['recording-1', 10, 40, 'keyword']);
  assert.equal(f.service.state(0).savedCount, 1); f.service.close();
});

test('channel, recorder, disabled settings and shutdown invalidate pending work and old batches', async () => {
  for (const transition of ['channel', 'recorder', 'disable', 'stop', 'shutdown']) {
    const f = fixture(); const old = f.service.context(0); f.trigger();
    if (transition === 'channel') f.assigned = other;
    if (transition === 'recorder') f.mark = { ...f.mark, generation: 'recording-2', end: 50 };
    if (transition === 'disable') f.config = { enabled: false };
    if (transition === 'stop') f.mark = null;
    if (transition === 'shutdown') f.service.close();
    f.service.tick(); await flush(); assert.equal(f.saved.length, 0, transition);
    assert.equal(f.submit([{ id: 'late', text: '우와' }], old).accepted, false, transition);
    f.service.close();
  }
});

test('manual saves take priority, and expired/pruned ranges are skipped without shortening', async () => {
  for (const reason of ['expires', 'prunes', 'manual']) {
    const f = fixture(); f.trigger(); f.busy = true;
    f.mark = { ...f.mark, end: 40 }; f.service.tick(); await flush(); assert.equal(f.saved.length, 0);
    if (reason === 'expires') f.now += 46000;
    if (reason === 'prunes') f.mark = { ...f.mark, start: 12 };
    f.busy = false; f.service.tick(); await flush();
    assert.equal(f.saved.length, reason === 'manual' ? 1 : 0);
    if (reason !== 'manual') assert.equal(f.service.state(0).status, 'error');
    f.service.close();
  }
});

test('config changes between ready-range tick and export microtask cancel the export', async () => {
  const f = fixture(); f.trigger(); f.mark = { ...f.mark, end: 40 }; f.service.tick();
  f.config = { enabled: false }; await flush(); assert.equal(f.saved.length, 0); f.service.close();
});

test('cooldown and channel hourly quota survive source resets', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) {
    f.service.reset(0); f.trigger(); f.mark = { ...f.mark, end: f.mark.end + 10 }; f.service.tick(); await flush();
    assert.equal(f.saved.length, i + 1);
    f.submit([{ id: `again-${i}`, text: '우와' }]); f.service.tick(); await flush(); assert.equal(f.saved.length, i + 1);
    f.now += 121000;
  }
  f.service.reset(0); f.trigger(); f.mark = { ...f.mark, end: f.mark.end + 10 }; f.service.tick(); await flush();
  assert.equal(f.saved.length, 10); assert.match(f.service.state(0).message, /시간당/); f.service.close();
});

test('missing source heartbeat requires a new warmup after source recovery', () => {
  const f = fixture(); f.submit(); f.now += 16000;
  assert.equal(f.service.state(0).status, 'waiting');
  f.submit([{ id: 'late-load', text: '우와' }]); assert.notEqual(f.service.state(0).status, 'pending'); f.service.close();
});

test('chat spikes use a warm baseline, minimum volume and deduplicated message IDs', () => {
  let now = 0; const detector = new ChatTrigger({ now: () => now });
  const config = { keywords: [], chatSpike: true };
  assert.equal(detector.observe(Array.from({ length: 100 }, (_, i) => ({ id: `seed${i}`, text: 'ㅋ' })), config), null);
  for (now = 1000; now <= 35000; now += 1000) detector.observe([{ id: `normal${now}`, text: 'ㅋ' }], config);
  const spike = Array.from({ length: 30 }, (_, i) => ({ id: `spike${i}`, text: 'ㅋ' }));
  assert.equal(detector.observe(spike, config), 'chat-spike');
  const count = [...detector.buckets.values()].reduce((sum, x) => sum + x, 0);
  assert.equal(detector.observe(spike, config), null, 'replayed IDs must not trigger after a busy slot becomes free');
  assert.equal([...detector.buckets.values()].reduce((sum, x) => sum + x, 0), count);
  detector.observe([], config, false); assert.equal(detector.startedAt, null);
  assert.equal(detector.observe(spike, config), null, 'source replacement must collect a new baseline');
});

test('untrusted chat data is bounded before detection', () => {
  const valid = { slotId: 0, channelId, generation: 'g', sourceStatus: 'watching', events: [{ id: '1', text: 'safe' }] };
  assert.equal(validateBatch(valid), valid);
  for (const change of [{ slotId: 5 }, { generation: 1 }, { channelId: 'wrong' }, { sourceStatus: 'anything' },
    { events: Array(101).fill(valid.events[0]) }, { events: [{ id: '', text: '' }] }, { events: [{ id: 'x', text: 'x'.repeat(501) }] }]) {
    assert.throws(() => validateBatch({ ...valid, ...change }));
  }
});

test('only known channel preferences persist; playback and pending jobs never restore', () => {
  const state = normalizeSettings({ channels: [{ id: channelId }], autoClipSettings: {
    [channelId]: { enabled: true, keywords: [' wow ', 'wow', null, 'a'.repeat(100)], chatSpike: true, pending: 'discard' },
    [other]: { enabled: true } }, autoClips: [{ pending: true }] });
  assert.deepEqual(state.autoClipSettings[channelId], { enabled: true, keywords: ['wow', 'a'.repeat(40)], chatSpike: true });
  assert.equal(state.autoClipSettings[other], undefined); assert.equal(state.autoClips, undefined);
});
