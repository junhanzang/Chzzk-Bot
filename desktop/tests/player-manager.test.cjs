'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PlayerManager } = require('../lib/player-manager.cjs');
const channel = 'a'.repeat(32);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const views = [], attached = [], detached = [], removed = [];
  class View {
    constructor(options) {
      this.options = options; this.webContents = new EventEmitter(); views.push(this);
      Object.assign(this.webContents, { closed: false, urls: [],
        isDestroyed() { return this.closed; }, close() { this.closed = true; },
        setAudioMuted(value) { this.muted = value; }, setZoomFactor() {},
        setWindowOpenHandler(handler) { this.openHandler = handler; },
        async loadURL(url) { this.urls.push(url); }, reload() {} });
    }
    setBounds(value) { this.bounds = value; }
    setVisible(value) { this.visible = value; }
  }
  const manager = new PlayerManager({ WebContentsView: View, partition: 'fake-only',
    window: { isDestroyed: () => false, getContentSize: () => [1500, 1000],
      contentView: { addChildView() {}, removeChildView(view) { removed.push(view); } } },
    rewards: { attach(slot) { attached.push(slot); }, detach(slot) { detached.push(slot); }, close() {}, status: () => null } });
  return { manager, views, attached, detached, removed };
}

test('player close revokes ownership before recorder wait and rejects late reward attachment', async () => {
  const f = fixture(), gate = deferred(); f.manager.open(0, channel);
  const view = f.views[0]; f.manager.selectAudio(0);
  const closing = f.manager.close(0, () => gate.promise);
  assert.equal(f.manager.has(0), false); assert.equal(view.webContents.muted, true); assert.equal(view.webContents.closed, false);
  view.webContents.emit('did-finish-load'); assert.deepEqual(f.attached, []);
  gate.resolve(); await closing;
  assert.equal(view.webContents.closed, true); assert.equal(f.manager.audioSlot, null); assert.deepEqual(f.removed, [view]);
});

test('navigation remains confined to the assigned channel while login requests use the separate flow', () => {
  const f = fixture(), logins = [], external = []; f.manager.on('login-requested', () => logins.push(true));
  f.manager.on('external-requested', url => external.push(url)); f.manager.open(0, channel);
  const contents = f.views[0].webContents; let blocked = 0;
  contents.emit('will-navigate', { preventDefault() { blocked++; } }, 'https://nid.naver.com/nidlogin.login');
  assert.equal(blocked, 1); assert.equal(logins.length, 1);
  contents.openHandler({ url: 'https://chzzk.naver.com.evil/' }); assert.deepEqual(external, []);
  contents.emit('did-navigate-in-page', {}, `https://chzzk.naver.com/live/${'b'.repeat(32)}`, true);
  assert.equal(contents.urls.at(-1), `https://chzzk.naver.com/live/${channel}`);
  contents.emit('did-start-navigation', {}, 'next', false, true); assert.deepEqual(f.detached, [0]);
});

test('bounds stay inside the shell and shutdown suppresses native shortcuts and late player readiness', () => {
  const f = fixture(), shortcuts = []; f.manager.on('shortcut', command => shortcuts.push(command)); f.manager.open(0, channel);
  f.manager.setBounds([{ slotId: 0, x: -40, y: 950, width: 99999, height: 99999 }]);
  assert.deepEqual(f.views[0].bounds, { x: 0, y: 950, width: 1500, height: 50 });
  f.manager.beginShutdown();
  f.views[0].webContents.emit('before-input-event', { preventDefault() { throw new Error('Shutdown should ignore key'); } },
    { type: 'keyDown', control: true, shift: true, code: 'KeyS' });
  f.views[0].webContents.emit('did-finish-load');
  assert.deepEqual(shortcuts, []); assert.deepEqual(f.attached, []); f.manager.destroyAll();
});
