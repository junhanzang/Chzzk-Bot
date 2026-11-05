'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ChatWindows } = require('../lib/chat-windows.cjs');
const { chatPopupUrl, chatPopupChannelId } = require('../../browser-extension/shared/chat-popup.js');
const A = 'a'.repeat(32), B = 'b'.repeat(32);
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ load } = {}) {
  const windows = [], notices = [], logins = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.id = windows.length + 1; this.options = options; this.urls = [];
      this.destroyed = false; this.minimized = false; this.shows = 0; this.focuses = 0; windows.push(this);
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    removeMenu() { this.menuRemoved = true; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; this.restored = true; }
    show() { this.shows++; }
    focus() { this.focuses++; }
    loadURL(url) { this.urls.push(url); return load ? load(this) : Promise.resolve(); }
  }
  const service = new ChatWindows({ BrowserWindow: Window, partition: 'persist:same-app-session',
    onNotice: (...args) => notices.push(args), onLogin: () => logins.push(true) });
  return { service, windows, notices, logins };
}

test('popup route accepts only official channel chat, never player, overlay or untrusted URL', () => {
  assert.equal(chatPopupUrl(A.toUpperCase()), `https://chzzk.naver.com/live/${A}/chat`);
  assert.equal(chatPopupChannelId(`${chatPopupUrl(A)}/`), A);
  for (const value of [null, '', 'javascript:alert(1)', `http://chzzk.naver.com/live/${A}/chat`,
    `https://chzzk.naver.com.evil/live/${A}/chat`, `https://user@chzzk.naver.com/live/${A}/chat`,
    `https://chzzk.naver.com:8080/live/${A}/chat`, `https://chzzk.naver.com/live/${A}`,
    `https://chzzk.naver.com/chat/${A}`, `${chatPopupUrl(A)}?redirect=evil`, `${chatPopupUrl(A)}#evil`]) {
    assert.equal(chatPopupChannelId(value), null, String(value));
  }
});

test('desktop opens independent resizable sandboxed chat in the existing app session', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.open(A, ' 채널\u0000\n이름 '), { channelId: A, windowId: 1, reused: false });
  const win = f.windows[0];
  assert.deepEqual(win.urls, [chatPopupUrl(A)]);
  assert.equal(win.options.width, 440); assert.equal(win.options.height, 800);
  assert.equal(win.options.resizable, true); assert.equal(win.options.parent, undefined);
  assert.equal(win.options.title, '채널이름 · 채팅'); assert.equal(win.menuRemoved, true);
  assert.deepEqual(win.options.webPreferences, {
    partition: 'persist:same-app-session', sandbox: true, contextIsolation: true, nodeIntegration: false
  });
  assert.equal(win.shows, 0); win.emit('ready-to-show'); assert.equal(win.shows, 1);
  let prevented = false; win.emit('page-title-updated', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});

test('desktop reuses and restores each channel without changing its dimensions', async () => {
  const f = fixture(); await f.service.open(A); const win = f.windows[0];
  win.minimized = true; win.options.width = 650;
  assert.deepEqual(await f.service.open(A), { channelId: A, windowId: 1, reused: true });
  assert.equal(win.restored, true); assert.equal(win.focuses, 1); assert.equal(win.options.width, 650);
  await f.service.open(B); assert.equal(f.windows.length, 2);
  win.destroy(); await f.service.open(A); assert.equal(f.windows.length, 3);
});

test('desktop blocks arbitrary navigation and routes official login to the app flow', async () => {
  const f = fixture(); await f.service.open(A); const win = f.windows[0]; let blocked = 0;
  const event = { preventDefault() { blocked++; } };
  win.webContents.emit('will-navigate', event, chatPopupUrl(A)); assert.equal(blocked, 0);
  win.webContents.emit('will-redirect', event, chatPopupUrl(B));
  win.webContents.emit('will-navigate', event, 'https://nid.naver.com/nidlogin.login');
  assert.deepEqual(win.openHandler({ url: 'https://nid.naver.com.evil/' }), { action: 'deny' });
  assert.deepEqual(win.openHandler({ url: 'https://evil.test/' }), { action: 'deny' });
  assert.equal(blocked, 2); await tick(); assert.equal(f.logins.length, 1);
  win.webContents.emit('did-navigate-in-page', {}, 'https://evil.test/', false);
  assert.equal(win.urls.length, 1);
  win.webContents.emit('did-navigate-in-page', {}, chatPopupUrl(B), true);
  assert.deepEqual(win.urls, [chatPopupUrl(A), chatPopupUrl(A)]);
});

test('desktop rejects invalid channels before creating windows', async () => {
  const f = fixture();
  for (const value of ['', null, `https://chzzk.naver.com/live/${A}`, `${A}/chat`, '../']) {
    await assert.rejects(f.service.open(value), /채널 ID/);
  }
  assert.equal(f.windows.length, 0);
});

test('desktop login refresh reconnects open chat documents without changing window geometry or focus', async () => {
  const f = fixture(); await f.service.open(A); await f.service.open(B);
  f.windows[0].options.width = 720; f.service.reloadAll();
  assert.deepEqual(f.windows.map(win => win.urls), [[chatPopupUrl(A), chatPopupUrl(A)], [chatPopupUrl(B), chatPopupUrl(B)]]);
  assert.equal(f.windows[0].options.width, 720); assert.equal(f.windows[0].focuses, 0);
  f.service.closeAll(); f.service.reloadAll();
  assert.equal(f.windows[0].urls.length, 2); assert.equal(f.windows[1].urls.length, 2);
});

test('desktop load failure removes the failed window and allows a retry', async () => {
  const f = fixture({ load: win => win.id === 1 ? Promise.reject(new Error('offline')) : Promise.resolve() });
  await f.service.open(A); await tick(); assert.equal(f.windows[0].destroyed, true);
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0][1], true);
  assert.equal((await f.service.open(A)).reused, false); assert.equal(f.windows.length, 2);
  f.windows[1].webContents.emit('did-fail-load', {}, -3, 'aborted', chatPopupUrl(A), true);
  assert.equal(f.windows[1].destroyed, false);
  f.windows[1].webContents.emit('did-fail-load', {}, -105, 'DNS', chatPopupUrl(A), true);
  assert.equal(f.windows[1].destroyed, true); assert.equal(f.notices.length, 2);
});

test('desktop login reload does not close a window when replacing its pending initial load', async () => {
  let rejectInitial;
  const f = fixture({ load: win => win.urls.length === 1
    ? new Promise((_resolve, reject) => { rejectInitial = reject; }) : Promise.resolve() });
  await f.service.open(A); f.service.reloadAll();
  rejectInitial(Object.assign(new Error('net::ERR_ABORTED'), { code: 'ERR_ABORTED', errno: -3 }));
  await tick(); assert.equal(f.windows[0].destroyed, false); assert.deepEqual(f.notices, []);
});

test('desktop shutdown destroys windows and suppresses pending login, readiness and load callbacks', async () => {
  let rejectLoad;
  const f = fixture({ load: () => new Promise((_resolve, reject) => { rejectLoad = reject; }) });
  await f.service.open(A); const win = f.windows[0];
  win.openHandler({ url: 'https://nid.naver.com/nidlogin.login' }); f.service.closeAll();
  win.emit('ready-to-show'); win.webContents.emit('did-navigate-in-page', {}, chatPopupUrl(B), true);
  rejectLoad(new Error('cancelled')); await tick();
  assert.equal(win.destroyed, true); assert.equal(win.shows, 0); assert.equal(win.urls.length, 1);
  assert.deepEqual(f.logins, []); assert.deepEqual(f.notices, []);
  await assert.rejects(f.service.open(A), /종료/);
});
