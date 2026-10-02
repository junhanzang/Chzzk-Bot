'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const state = (name = '') => ({ channels: name ? [{ id: name, name }] : [], slots: [{ slotId: 0, channelId: name || null, replay: { state: 'buffering', bufferedSeconds: 12 } }], clips: [], savingSlots: [], clipSeconds: 60, ffmpegAvailable: true, connection: { status: 'connected' } });
class Visibility {
  hidden = false;
  listeners = new Set();
  addEventListener(_type, listener) { this.listeners.add(listener); }
  removeEventListener(_type, listener) { this.listeners.delete(listener); }
  change(hidden) { this.hidden = hidden; for (const listener of this.listeners) listener(); }
}

test('desktop controller preserves slot command exclusion, partial saves, and selected duration', async () => {
  const { createDesktopController } = await import('../../desktop/ui/controller.mjs');
  const { canSave } = await import('../../desktop/ui/state.mjs');
  const save = deferred(), received = [], notices = [];
  const controller = createDesktopController({ bridge: {
    getState: async () => state('channel'), onState: () => () => {},
    saveClip: async value => { received.push(value); return save.promise; }
  }, onNotice: (...args) => notices.push(args), onClearNotice() {} });
  controller.start();
  await flush();
  assert.equal(canSave(controller.snapshot(), 0), true, '12 buffered seconds can be saved even when 60 is selected');
  const request = controller.execute('slot-0', 'saveClip', { slotId: 0, seconds: controller.snapshot().state.clipSeconds });
  assert.equal(controller.snapshot().pendingSaves.has(0), true);
  assert.equal(canSave(controller.snapshot(), 0), false);
  assert.equal(await controller.execute('slot-0', 'saveClip', { slotId: 0, seconds: 15 }), false);
  save.resolve({ id: 'saved' });
  assert.equal(await request, true);
  assert.deepEqual(received, [{ slotId: 0, seconds: 60 }]);
  assert.equal(controller.snapshot().pendingSaves.size, 0);
  assert.equal(notices.length, 0);
  controller.dispose();
});

test('desktop controller removes subscriptions and drops late command results after disposal', async () => {
  const { createDesktopController } = await import('../../desktop/ui/controller.mjs');
  const command = deferred();
  let removed = 0, updates = 0, notices = 0, stateListener;
  const controller = createDesktopController({ bridge: {
    getState: async () => state('initial'),
    onState(listener) { stateListener = listener; return () => { removed++; }; },
    onNotice: () => () => { removed++; }, saveClip: () => command.promise
  }, onNotice() { notices++; }, onClearNotice() { notices++; } });
  controller.subscribe(() => { updates++; });
  controller.start();
  await flush();
  const request = controller.execute('slot-0', 'saveClip', { slotId: 0, seconds: 60 }, 'saved');
  const before = updates;
  controller.dispose();
  stateListener(state('obsolete'));
  command.resolve(state('late'));
  assert.equal(await request, false);
  assert.equal(updates, before);
  assert.equal(notices, 0);
  assert.equal(removed, 2);
  assert.equal(controller.snapshot().state.channels[0].id, 'initial');
});

test('panel controller rejects stale refreshes that race with a serialized command', async () => {
  const { createPanelController } = await import('../ui/controller.mjs');
  const firstRead = deferred(), mutation = deferred();
  let reads = 0;
  const notices = [];
  const controller = createPanelController({ document: new Visibility(), onNotice: (...args) => notices.push(args), sendMessage: message => {
    if (message.method === 'getState') return ++reads === 1 ? firstRead.promise : Promise.resolve({ ok: true, value: state('new') });
    return mutation.promise;
  } });
  const refresh = controller.refresh();
  const action = controller.execute('assignSlot', { slotId: 0, channelId: 'new' });
  assert.equal(await controller.execute('clearSlot', 0), false);
  firstRead.resolve({ ok: true, value: state('stale') });
  await refresh;
  assert.equal(controller.snapshot().state.channels.length, 0);
  mutation.resolve({ ok: true, value: {} });
  assert.equal(await action, true);
  assert.equal(controller.snapshot().state.channels[0].id, 'new');
  assert.equal(controller.snapshot().pending, false);
  assert.equal(notices.length, 0);
  controller.dispose();
});

test('panel controller owns visibility timers, deduplicates notices, and ignores late refreshes', async () => {
  const { createPanelController } = await import('../ui/controller.mjs');
  const document = new Visibility(), intervals = new Map(), late = deferred();
  let nextTimer = 0, reads = 0;
  const notices = [];
  const controller = createPanelController({ document, onNotice: (...args) => notices.push(args), timers: {
    setInterval(callback) { intervals.set(++nextTimer, callback); return nextTimer; }, clearInterval(id) { intervals.delete(id); }
  }, sendMessage: async () => {
    reads++;
    if (reads > 2) return late.promise;
    return { ok: true, value: { ...state('channel'), notice: { at: 123, message: 'once' } } };
  } });
  controller.start();
  await flush();
  assert.equal(intervals.size, 1);
  await controller.refresh();
  assert.equal(notices.length, 1);
  document.change(true);
  assert.equal(intervals.size, 0);
  document.change(false);
  assert.equal(intervals.size, 1);
  controller.dispose();
  late.resolve({ ok: true, value: state('late') });
  await flush();
  assert.equal(intervals.size, 0);
  assert.equal(document.listeners.size, 0);
  assert.equal(controller.snapshot().state.channels[0].id, 'channel');
});
