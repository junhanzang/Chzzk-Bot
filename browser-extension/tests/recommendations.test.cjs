'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ActivityHistory, ActivityBudget, normalizeHistory, rankChannels, MAX_CHANNELS, HALF_LIFE_MS, VISIT_INTERVAL_MS, COUNTER_LIMITS, ACTIVITY_LIMITS, ACTIVITY_CHANNEL_LIMIT } = require('../shared/recommendations.js');
const id = n => n.toString(16).padStart(32, '0');
const NOW = 1800000000000;
const channel = (n, extra = {}) => ({ id: id(n), name: `채널 ${n}`, live: true, ...extra });
const counts = (extra = {}) => ({ visits: 4, watchSeconds: 1200, chatCount: 2, updatedAt: NOW, lastVisitAt: NOW, ...extra });
const history = channels => ({ version: 1, channels });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('history whitelist strips message text and unknown data, bounds counters and future dates, and isolates snapshots', () => {
  const raw = history({ [id(1)]: counts({ visits: Infinity, watchSeconds: 1e20, chatCount: -1, updatedAt: NOW * 2,
    lastVisitAt: NOW * 3, apiKey: 'private', message: 'chat transcript', recent: { watchSeconds: 1e30, message: 'private' } }),
  invalid: counts(), [id(2)]: { visits: 10, updatedAt: NaN } });
  const normalized = normalizeHistory(raw, { now: NOW });
  assert.deepEqual(Object.keys(normalized.channels), [id(1)]);
  assert.equal(normalized.channels[id(1)].watchSeconds, COUNTER_LIMITS.watchSeconds);
  assert.equal(normalized.channels[id(1)].recent.watchSeconds, COUNTER_LIMITS.watchSeconds);
  assert.equal(normalized.channels[id(1)].updatedAt, NOW);
  assert.equal(normalized.channels[id(1)].lastVisitAt, null);
  assert(!JSON.stringify(normalized).includes('private')); assert(!JSON.stringify(normalized).includes('transcript'));
  const service = new ActivityHistory({ initial: normalized, clock: () => NOW });
  const snapshot = service.snapshot(); snapshot.channels[id(1)].recent.watchSeconds = 0;
  assert.notEqual(service.snapshot().channels[id(1)].recent.watchSeconds, 0);
});

test('history retains the most recent bounded set and normalizes channel IDs without changing category IDs', () => {
  const raw = {};
  for (let n = 0; n < MAX_CHANNELS + 10; n++) raw[id(n)] = counts({ updatedAt: NOW - n });
  const normalized = normalizeHistory(history(raw), { now: NOW });
  assert.equal(Object.keys(normalized.channels).length, MAX_CHANNELS);
  assert(normalized.channels[id(0)]); assert(!normalized.channels[id(MAX_CHANNELS)]);
  assert.deepEqual(normalizeHistory({ channels: [] }, { now: NOW }), history({}));
});

test('explicit visits deduplicate for ten minutes; activity does not manufacture visits and is capped per heartbeat', async () => {
  let now = NOW;
  const service = new ActivityHistory({ clock: () => now });
  service.recordVisit(id(1)); service.recordVisit(id(1)); now += VISIT_INTERVAL_MS - 1; service.recordVisit(id(1));
  assert.equal(service.snapshot().channels[id(1)].visits, 1);
  now++; service.recordVisit(id(1));
  assert.equal(service.snapshot().channels[id(1)].visits, 2);
  service.recordActivity(id(2), { watchSeconds: 1e6, chatCount: 1e6, message: 'never kept' });
  const record = service.snapshot().channels[id(2)];
  assert.equal(record.visits, 0); assert.equal(record.lastVisitAt, null);
  assert.equal(record.watchSeconds, ACTIVITY_LIMITS.watchSeconds); assert.equal(record.chatCount, ACTIVITY_LIMITS.chatCount);
  assert(!JSON.stringify(service.snapshot()).includes('never kept'));
  for (const input of [{ watchSeconds: -1 }, { watchSeconds: Infinity }, { chatCount: 0.5 }, { chatCount: '1' }]) {
    assert.throws(() => service.recordActivity(id(1), input));
  }
  assert.throws(() => service.recordVisit('bad'));
  await service.flush();
});

test('recent weights decay without rewriting lifetime totals or refreshing old activity timestamps', async () => {
  let now = NOW;
  const service = new ActivityHistory({ clock: () => now });
  service.recordActivity(id(1), { watchSeconds: 120, chatCount: 10 });
  now += HALF_LIFE_MS;
  const before = service.snapshot().channels[id(1)];
  assert.equal(before.watchSeconds, 120); assert.equal(before.updatedAt, NOW);
  service.recordActivity(id(1), { watchSeconds: 20, chatCount: 2 });
  const after = service.snapshot().channels[id(1)];
  assert.equal(after.watchSeconds, 140); assert.equal(after.recent.watchSeconds, 80);
  assert.equal(after.chatCount, 12); assert.equal(after.recent.chatCount, 7);
  await service.flush();
});

test('concurrent updates coalesce, stay ordered, and a clear cannot be overwritten by an older save', async () => {
  const gate = deferred(), writes = [];
  const service = new ActivityHistory({ clock: () => NOW, persist: async value => {
    writes.push(value); if (writes.length === 1) await gate.promise;
  } });
  service.recordVisit(id(1)); service.recordActivity(id(1), { watchSeconds: 30 });
  await tick(); assert.equal(writes.length, 1);
  service.recordVisit(id(2)); service.clear(); const pending = service.flush();
  gate.resolve(); await pending;
  assert.equal(writes.length, 2); assert.deepEqual(writes.at(-1), history({}));
  assert.deepEqual(service.snapshot(), history({}));
});

test('failed persistence is observable and retryable; restore has no persistence or observer side effects', async () => {
  let fail = true, saves = 0, changes = 0;
  const service = new ActivityHistory({ clock: () => NOW, persist: async () => { saves++; if (fail) throw new Error('disk'); }, onChange: () => { changes++; throw new Error('observer'); } });
  service.restore(history({ [id(1)]: counts() })); assert.equal(saves, 0); assert.equal(changes, 0);
  service.recordActivity(id(1), { watchSeconds: 30 });
  assert.throws(() => service.restore({}), /저장/);
  await assert.rejects(service.flush(), /disk/);
  assert.equal(service.snapshot().channels[id(1)].watchSeconds, 1230);
  fail = false; await service.flush(); assert.equal(saves, 2);
  service.restore({}); assert.deepEqual(service.snapshot(), history({}));
});

test('a change arriving just as a writer finishes is drained without needing another heartbeat', async () => {
  const gate = deferred(), writes = [];
  const service = new ActivityHistory({ clock: () => NOW, persist: value => {
    writes.push(value); return writes.length === 1 ? gate.promise : Promise.resolve();
  } });
  service.recordVisit(id(1)); await tick();
  gate.resolve(); queueMicrotask(() => service.clear());
  await tick();
  assert.equal(writes.length, 2); assert.deepEqual(writes[1], history({}));
  await service.flush();
});

test('category preferences match the type and exact ID; recurring interaction outweighs category alone', () => {
  const categories = [{ id: 'GameA', type: 'game', name: '게임' }];
  const channels = [channel(1, { category: { id: 'GameA', type: 'GAME' } }), channel(2),
    channel(3, { category: { id: 'gamea', type: 'GAME' } }), channel(4, { category: { id: 'GameA', type: 'SPORTS' } })];
  const records = history({ [id(2)]: counts({ visits: 10, watchSeconds: 3600, chatCount: 5 }) });
  const ranked = rankChannels(channels, { categories, history: records, now: NOW });
  assert.deepEqual(ranked.map(value => value.id), [id(2), id(1), id(3), id(4)]);
  assert.equal(ranked[1].recommendation.signals.category, 30);
  assert.equal(ranked[2].recommendation.signals.category, 0); assert.equal(ranked[3].recommendation.signals.category, 0);
  assert(ranked[1].recommendation.reasons.includes('팔로우한 카테고리'));
  assert(ranked[0].recommendation.reasons.includes('자주 여는 방송'));
});

test('pinned and live groups are preserved; all ranking modes are stable and name mode uses numeric Korean ordering', () => {
  const channels = [channel(10), channel(2), channel(3, { live: false }), channel(4, { pinned: true, live: false })];
  const raw = JSON.stringify(channels);
  const options = { now: NOW, history: history({ [id(3)]: counts({ visits: 1000 }) }) };
  for (const mode of ['recommended', 'frequent', 'live']) {
    assert.deepEqual(rankChannels(channels, { ...options, mode }).map(value => value.id), [id(4), id(10), id(2), id(3)]);
  }
  assert.deepEqual(rankChannels(channels, { ...options, mode: 'name' }).map(value => value.id), [id(4), id(2), id(10), id(3)]);
  assert.equal(JSON.stringify(channels), raw);
});

test('recent interaction outranks equally strong stale history and scoring never mutates the saved document', () => {
  const records = history({ [id(1)]: counts({ updatedAt: NOW - 10 * HALF_LIFE_MS, lastVisitAt: NOW - 10 * HALF_LIFE_MS }), [id(2)]: counts() });
  const before = JSON.stringify(records);
  const ranked = rankChannels([channel(1), channel(2)], { history: records, now: NOW, mode: 'frequent' });
  assert.equal(ranked[0].id, id(2)); assert.equal(JSON.stringify(records), before);
  for (const value of ranked) {
    const result = value.recommendation;
    assert.equal(result.score, Math.round(Object.values(result.signals).reduce((a, b) => a + b, 0) * 100) / 100);
    assert(result.reasons.length <= 3); assert(Number.isFinite(result.score));
  }
});

test('frequent mode ignores category boosts and capped chat scores cannot swamp a category preference', () => {
  const category = { id: 'GameA', type: 'GAME' };
  const records = history({ [id(2)]: counts({ visits: 0, watchSeconds: 0, chatCount: COUNTER_LIMITS.chatCount }) });
  const channels = [channel(1, { category }), channel(2)];
  const options = { categories: [category], history: records, now: NOW };
  assert.equal(rankChannels(channels, options)[0].id, id(1));
  const frequent = rankChannels(channels, { ...options, mode: 'frequent' });
  assert.equal(frequent[0].id, id(2)); assert.equal(frequent[0].recommendation.signals.chat, 15);
  assert.equal(frequent[1].recommendation.signals.category, 0);
});

test('simultaneous reports for one channel share watch and chat budgets while different channels remain independent', () => {
  let now = NOW;
  const budget = new ActivityBudget({ clock: () => now });
  assert.deepEqual(budget.accept(id(1), { watchSeconds: 90, chatCount: 20 }), { watchSeconds: 30, chatCount: 1 });
  assert.deepEqual(budget.accept(id(1), { watchSeconds: 30, chatCount: 1 }), { watchSeconds: 0, chatCount: 0 });
  assert.deepEqual(budget.accept(id(2), { watchSeconds: 30, chatCount: 1 }), { watchSeconds: 30, chatCount: 1 });
  now += 10000;
  assert.deepEqual(budget.accept(id(1), { watchSeconds: 30, chatCount: 1 }), { watchSeconds: 10, chatCount: 0 });
  now += 20000;
  assert.deepEqual(budget.accept(id(1), { watchSeconds: 30, chatCount: 50 }), { watchSeconds: 20, chatCount: 1 });
});

test('zero and chat-only popup heartbeats do not consume a video watch budget', () => {
  let now = NOW;
  const budget = new ActivityBudget({ clock: () => now });
  budget.accept(id(1), { watchSeconds: 0, chatCount: 1 });
  assert.deepEqual(budget.accept(id(1), { watchSeconds: 30, chatCount: 0 }), { watchSeconds: 30, chatCount: 0 });
  now += 29000; budget.accept(id(1), { watchSeconds: 0, chatCount: 0 });
  now += 1000; budget.accept(id(1), { watchSeconds: 0, chatCount: 1 });
  assert.deepEqual(budget.accept(id(1), { watchSeconds: 30, chatCount: 0 }), { watchSeconds: 30, chatCount: 0 });
  now += 1000000;
  assert.equal(budget.accept(id(1), { watchSeconds: 1e6 }).watchSeconds, ACTIVITY_LIMITS.watchSeconds);
});

test('activity budget rejects invalid inputs and clocks without losing the last valid budget', () => {
  let now = NOW;
  const budget = new ActivityBudget({ clock: () => now }); budget.accept(id(1), { watchSeconds: 30 });
  for (const raw of [{ watchSeconds: -1 }, { watchSeconds: NaN }, { watchSeconds: Infinity }, { chatCount: '1' }, { chatCount: 0.2 }]) {
    assert.throws(() => budget.accept(id(1), raw));
  }
  assert.throws(() => budget.accept('invalid', { watchSeconds: 1 }));
  for (const value of [NOW - 1, -1, NaN, Infinity, NOW + 0.5]) {
    now = value; assert.throws(() => budget.accept(id(1), { watchSeconds: 30 }), /시계/);
  }
  now = NOW + 5000; assert.equal(budget.accept(id(1), { watchSeconds: 30 }).watchSeconds, 5);
});

test('budget reset starts a new collection interval and retained channel state is bounded', () => {
  const budget = new ActivityBudget({ clock: () => NOW });
  budget.accept(id(1), { watchSeconds: 30, chatCount: 1 }); budget.reset();
  assert.deepEqual(budget.accept(id(1), { watchSeconds: 30, chatCount: 1 }), { watchSeconds: 30, chatCount: 1 });
  for (let n = 2; n <= ACTIVITY_CHANNEL_LIMIT + 1; n++) budget.accept(id(n), { watchSeconds: 1 });
  assert.equal(budget.channels.size, ACTIVITY_CHANNEL_LIMIT);
  assert.equal(budget.channels.has(id(1)), false);
  for (let n = ACTIVITY_CHANNEL_LIMIT + 2; n <= ACTIVITY_CHANNEL_LIMIT + 10; n++) budget.accept(id(n), {});
  assert.equal(budget.channels.size, ACTIVITY_CHANNEL_LIMIT);
});
