'use strict';

const { normalizeChatChannelId, chatPopupUrl, isChatPopupUrl } = require('../../browser-extension/shared/chat-popup.js');

function isLoginUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'nid.naver.com' && !url.port && !url.username && !url.password;
  } catch { return false; }
}

class ChatWindows {
  constructor({ BrowserWindow, partition, onLogin = () => {}, onNotice = () => {}, activity }) {
    this.BrowserWindow = BrowserWindow;
    this.partition = partition;
    this.onLogin = onLogin;
    this.onNotice = onNotice;
    this.activity = activity;
    this.windows = new Map();
    this.closed = false;
  }

  async open(rawChannelId, title) {
    const channelId = normalizeChatChannelId(rawChannelId);
    if (this.closed) throw new Error('앱이 종료 중입니다.');
    const existing = this.windows.get(channelId);
    if (existing && !existing.isDestroyed()) {
      this.focus(existing);
      return { channelId, windowId: existing.id, reused: true };
    }
    const label = typeof title === 'string' ? title.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) : '';
    const win = new this.BrowserWindow({
      width: 440, height: 800, minWidth: 300, minHeight: 320,
      resizable: true, maximizable: true, show: false, autoHideMenuBar: true,
      backgroundColor: '#101319', title: `${label || '치지직'} · 채팅`,
      webPreferences: { partition: this.partition, nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    this.windows.set(channelId, win);
    const activityKey = `chat:${channelId}`;
    win.webContents.on('did-finish-load', () => {
      if (!this.closed && this.windows.get(channelId) === win) void this.activity?.attach(activityKey, win.webContents, channelId);
    });
    win.webContents.on('did-start-navigation', (_event, _target, inPlace, mainFrame) => { if (mainFrame && !inPlace) this.detachActivity(channelId, win); });
    win.webContents.on('render-process-gone', () => this.detachActivity(channelId, win));
    win.on('closed', () => this.detachActivity(channelId, win));
    const url = chatPopupUrl(channelId);
    const owned = () => !this.closed && this.windows.get(channelId) === win && !win.isDestroyed();
    const failed = error => this.failWindow(win, channelId, error);
    const requestLogin = value => {
      if (owned() && isLoginUrl(value)) Promise.resolve().then(() => { if (owned()) return this.onLogin(); }).catch(() => {
        if (owned()) this.onNotice('앱에서 네이버 로그인을 다시 시도해 주세요.', true);
      });
    };
    win.removeMenu();
    win.on('closed', () => { if (this.windows.get(channelId) === win) this.windows.delete(channelId); });
    win.once('ready-to-show', () => { if (owned()) this.focus(win); });
    win.on('page-title-updated', event => event.preventDefault());
    for (const name of ['will-navigate', 'will-redirect']) {
      win.webContents.on(name, (event, target) => {
        if (!isChatPopupUrl(target, channelId)) { event.preventDefault(); requestLogin(target); }
      });
    }
    win.webContents.setWindowOpenHandler(({ url: target }) => { requestLogin(target); return { action: 'deny' }; });
    win.webContents.on('did-navigate-in-page', (_event, target, isMainFrame) => {
      if (owned() && isMainFrame && !isChatPopupUrl(target, channelId)) {
        try { Promise.resolve(win.loadURL(url)).catch(failed); } catch { failed(); }
      }
    });
    win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) failed();
    });
    try { Promise.resolve(win.loadURL(url)).catch(failed); }
    catch (error) { failed(); throw error; }
    return { channelId, windowId: win.id, reused: false };
  }

  focus(win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  detachActivity(channelId, win) {
    if (this.windows.get(channelId) === win) this.activity?.detach(`chat:${channelId}`);
  }

  failWindow(win, channelId, error) {
    // Login refresh can intentionally replace a still-loading document.
    if (error?.code === 'ERR_ABORTED' || error?.errno === -3) return;
    if (this.closed || this.windows.get(channelId) !== win || win.isDestroyed()) return;
    this.detachActivity(channelId, win);
    this.windows.delete(channelId);
    win.destroy();
    this.onNotice('채팅창을 불러오지 못했어요. 연결 상태를 확인한 뒤 다시 열어 주세요.', true);
  }

  // A fresh document reconnects the official chat with newly signed-in cookies.
  reloadAll() {
    if (this.closed) return;
    for (const [channelId, win] of this.windows) {
      if (win.isDestroyed()) continue;
      try { Promise.resolve(win.loadURL(chatPopupUrl(channelId))).catch(error => this.failWindow(win, channelId, error)); }
      catch (error) { this.failWindow(win, channelId, error); }
    }
  }

  closeAll() {
    this.closed = true;
    const entries = [...this.windows];
    for (const [channelId, win] of entries) this.detachActivity(channelId, win);
    this.windows.clear();
    for (const [, win] of entries) if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { ChatWindows };
