'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserHandlers } = require('../lib/browser-actions.cjs');
const { normalizeSettings } = require('../lib/channels.cjs');
const channelId = '0123456789abcdef0123456789abcdef';

function fixture() {
  const snapshot = { channels: [{ id: channelId, name: '방송' }], slots: [
    { slotId: 0, channelId, playbackMode: 'browser', replay: { state: 'idle' } },
    { slotId: 1, channelId, playbackMode: 'desktop', replay: { state: 'idle' } }
  ], auth: { status: 'signed_in', nickname: 'private account' }, browserConnection: { connectionCode: 'private token' },
  audioSlot: 1, savingSlots: [], clips: [], ffmpegAvailable: true };
  const calls = [];
  const actions = { getState: () => snapshot };
  for (const method of ['addChannel', 'removeChannel', 'assignSlot', 'clearSlot', 'setBuffer', 'saveClip', 'openClip', 'showClipsFolder']) {
    actions[method] = async arg => { calls.push({ method, arg }); return snapshot; };
  }
  return { handlers: createBrowserHandlers({ actions }), actions, calls, snapshot };
}

test('browser actions force browser playback and never expose pairing or account metadata', async () => {
  const { handlers, calls } = fixture();
  const state = await handlers.assignSlot({ slotId: 0, channelId, playbackMode: 'desktop', url: 'file:///private' });
  assert.deepEqual(calls[0], { method: 'assignSlot', arg: { slotId: 0, channelId, playbackMode: 'browser' } });
  assert.deepEqual(state.auth, { status: 'signed_in' });
  assert.equal(state.browserConnection, undefined);
  assert.equal(state.audioSlot, null);
  const added = await handlers.addChannel({ input: channelId, name: '방송', playbackMode: 'desktop' });
  assert.equal(calls[1].arg.playbackMode, 'browser');
  assert.ok(!JSON.stringify(added).includes('private'));
  assert.equal(handlers.login, undefined);
  assert.equal(handlers.setPlayerBounds, undefined);
});

test('recording from Chrome cannot take over an app player or save a stale channel', async () => {
  const { handlers, calls } = fixture();
  await assert.rejects(handlers.setBuffer({ slotId: 1, enabled: true }), /방송을 먼저/);
  await assert.rejects(handlers.saveClip({ slotId: 0, channelId: 'changed', seconds: 30 }), /변경/);
  assert.equal(calls.length, 0);
  await handlers.setBuffer({ slotId: 0, channelId, enabled: true });
  await handlers.saveClip({ slotId: 0, channelId, seconds: 30 });
  assert.deepEqual(calls.map(call => call.method), ['setBuffer', 'saveClip']);
});

test('shutdown refuses new bridge commands before actions execute', async () => {
  const { actions, calls } = fixture();
  const handlers = createBrowserHandlers({ actions, isQuitting: () => true });
  await assert.rejects(handlers.openClip('clip-id'), /종료/);
  assert.equal(calls.length, 0);
});

test('unexpected filesystem errors do not expose private profile paths to the extension', async () => {
  const { actions } = fixture();
  actions.openClip = async () => { throw Object.assign(new Error('EACCES private/profile/path'), { code: 'EACCES' }); };
  const handlers = createBrowserHandlers({ actions });
  await assert.rejects(handlers.openClip('clip-id'), error => error.expose && !error.message.includes('private'));
});

test('browser mode survives settings restoration without restoring playback audio or recording', () => {
  const normalized = normalizeSettings({ channels: [{ id: channelId }], slots: [channelId, null],
    playbackModes: ['browser', 'browser'], audioSlot: 0, recording: true });
  assert.deepEqual(normalized.playbackModes, ['browser', 'desktop', 'desktop', 'desktop']);
  assert.equal(normalized.audioSlot, undefined);
  assert.equal(normalized.recording, undefined);
});
