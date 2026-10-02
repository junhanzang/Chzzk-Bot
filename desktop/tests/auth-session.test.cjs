'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AuthSession, trustedRemote } = require('../lib/auth-session.cjs');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(fetchImpl = async () => ({ ok: true, json: async () => ({ content: { loggedIn: false } }) }), options = {}) {
  const windows = [], calls = [], changes = [], notices = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.focused = 0;
      this.webContents = new EventEmitter();
      this.webContents.urls = [];
      this.webContents.setWindowOpenHandler = handler => { this.webContents.openHandler = handler; };
      this.webContents.loadURL = async url => { this.webContents.urls.push(url); };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.emit('closed'); }
    focus() { this.focused++; }
  }
  const auth = new AuthSession({ BrowserWindow: Window, partition: 'fake-only', ...options,
    session: { fetch: async (url, args) => { calls.push({ url, args }); return fetchImpl(url, args); } } });
  auth.on('change', value => changes.push(value)); auth.on('notice', (...args) => notices.push(args));
  return { auth, windows, calls, changes, notices };
}

test('authentication status coalesces requests and does not misreport a malformed response as signed out', async t => {
  const gate = deferred(), f = fixture(() => gate.promise); t.after(() => f.auth.close());
  const first = f.auth.refresh(); assert.equal(f.auth.refresh(), first); assert.equal(f.calls.length, 1);
  gate.resolve({ ok: true, json: async () => ({ content: { loggedIn: 'yes', nickname: 'private' } }) });
  assert.deepEqual(await first, { status: 'error', nickname: null });
  assert.equal(f.calls[0].args.credentials, 'include');
});

test('login window reuses its session, blocks unexpected navigation and announces a successful return once', async t => {
  const f = fixture(async () => ({ ok: true, json: async () => ({ content: { loggedIn: true, nickname: '\nviewer' } }) }));
  t.after(() => f.auth.close());
  let signedIn = 0; f.auth.on('signed-in', () => signedIn++);
  f.auth.open(); f.auth.open();
  const window = f.windows[0], contents = window.webContents;
  assert.equal(f.windows.length, 1); assert.equal(window.focused, 1);
  assert.equal(window.options.webPreferences.partition, 'fake-only');
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  let blocked = 0;
  contents.emit('will-redirect', { preventDefault() { blocked++; } }, 'https://evil.example/');
  assert.equal(blocked, 1);
  assert.deepEqual(contents.openHandler({ url: 'https://evil.example/' }), { action: 'deny' });
  assert.equal(contents.urls.length, 1);
  contents.emit('did-navigate', {}, 'https://chzzk.naver.com/');
  await f.auth.refresh();
  assert.equal(signedIn, 1); assert.equal(window.destroyed, true);
  assert.deepEqual(f.auth.state, { status: 'signed_in', nickname: 'viewer' });
});

test('shutdown aborts a session check and ignores its late sign-in without reopening or publishing', async () => {
  const gate = deferred(), f = fixture(() => gate.promise);
  f.auth.open(); const pending = f.auth.refresh(); const changed = f.changes.length;
  f.auth.close(); assert.equal(f.calls[0].args.signal.aborted, true); assert.equal(f.windows[0].destroyed, true);
  gate.resolve({ ok: true, json: async () => ({ content: { loggedIn: true } }) });
  await pending; f.auth.open();
  assert.equal(f.changes.length, changed); assert.equal(f.windows.length, 1); assert.equal(f.calls.length, 1);
});

test('an ignored abort cannot keep authentication stuck in checking forever', async t => {
  const f = fixture(() => new Promise(() => {}), { timeoutMs: 5 }); t.after(() => f.auth.close());
  const pending = f.auth.refresh(); await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(await pending, { status: 'error', nickname: null }); assert.equal(f.calls[0].args.signal.aborted, true);
});

test('login URLs reject credentials, ports and lookalike origins', () => {
  assert.equal(trustedRemote('https://nid.naver.com/nidlogin.login'), true);
  assert.equal(trustedRemote('https://chzzk.naver.com/'), true);
  for (const url of ['http://nid.naver.com/', 'https://nid.naver.com.evil/', 'https://user@nid.naver.com/', 'https://nid.naver.com:123/', 'javascript:alert(1)']) assert.equal(trustedRemote(url), false);
});
