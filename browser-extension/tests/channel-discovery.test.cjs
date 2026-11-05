'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Document } = require('./helpers/fake-dom.cjs');
const A = 'a'.repeat(32), B = 'b'.repeat(32);
async function fixture(desktop = false) {
  const { createChannelDiscovery } = await import('../shared/ui/channel-discovery.mjs');
  const document = new Document(['discovery']), root = document.querySelector('#discovery'), calls = [];
  const view = createChannelDiscovery({ document, root, desktop, run: (...args) => calls.push(args) });
  const snapshot = { initialized: true, pending: desktop ? new Set() : false, preview: false,
    state: { connection: { status: 'standalone' }, slots: [0, 1, 2, 3].map(slotId => ({ slotId })), channels: [],
      following: { status: 'ready', channels: [{ id: A, name: '<img onerror=bad()>', live: false }, { id: B, name: '방송 중 채널', live: true, title: '같이 보기' }] } } };
  view.render(snapshot); return { document, root, calls, view, snapshot };
}
for (const desktop of [false, true]) test(`followed discovery ${desktop ? 'desktop' : 'Chrome'} pins explicitly, preserves filter and clears stale account`, async () => {
  const f = await fixture(desktop), list = f.root.querySelector('.following-list');
  assert.equal(list.children.length, 2); assert.equal(list.children[0].querySelector('button').dataset.channel, B);
  assert.equal(f.calls.length, 0, 'Displaying followed channels must not import or open them');
  assert.match(list.children[1].textContent, /<img onerror/); assert.equal(list.querySelector('img'), null);
  await f.root.dispatch('click', list.children[0].querySelector('button'));
  assert.deepEqual(f.calls[0].slice(0, 2), ['pinFollowedChannel', B]);
  const search = f.root.querySelector('input'); search.value = '방송 중'; await search.dispatch('input');
  f.snapshot.state.channels = [{ id: B, name: '내 별명', pinned: true }]; f.view.render(f.snapshot);
  assert.equal(search.value, '방송 중'); assert.equal(list.children.length, 1); assert.equal(list.querySelector('button').disabled, true);
  f.snapshot.state.following = { status: 'signed_out', channels: [] }; f.view.render(f.snapshot);
  assert.equal(list.children.length, 0); assert.equal(list.hidden, true);
  assert.match(f.root.textContent, /로그인/);
  f.view.dispose(); await f.root.dispatch('click', f.root.querySelector('[data-action="refresh-following"]'));
  assert.equal(f.calls.length, 1);
});
test('pinned Chrome favorites remain visible with assignment controls and do not depend on following login', async () => {
  const f = await fixture(); f.snapshot.state.channels = [{ id: A, name: '고정 채널', pinned: true }, { id: B, name: '일반 채널' }];
  f.snapshot.state.following = { status: 'signed_out', channels: [] }; f.view.render(f.snapshot);
  const pins = f.root.querySelector('.pinned-list'); assert.equal(pins.children.length, 1);
  const buttons = pins.querySelectorAll('button'); assert.equal(buttons.length, 4);
  await f.root.dispatch('click', buttons[1]); assert.deepEqual(f.calls[0], ['assignSlot', { channelId: A, slotId: 1 }]);
  f.snapshot.pending = true; f.view.render(f.snapshot); assert(pins.querySelectorAll('button').every(button => button.disabled)); f.view.dispose();
});
test('multiple selected audio slots are distinct from the primary shortcut target', async () => {
  const { audioSlots, isAudible } = await import('../shared/ui/model.mjs');
  const state = { audioSlots: [0, 1], audioSlot: 1 };
  assert(isAudible(state, 0)); assert(isAudible(state, 1)); assert(!isAudible(state, 2));
  assert.deepEqual(audioSlots({ audioSlot: 0 }), [0]); assert.deepEqual(audioSlots({ audioSlots: [], audioSlot: 0 }), []);
});
