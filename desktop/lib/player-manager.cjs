'use strict';

const { EventEmitter } = require('node:events');
const { SLOT_IDS, validSlot } = require('./channels.cjs');
const { trustedRemote } = require('./auth-session.cjs');

class PlayerManager extends EventEmitter {
  constructor({ window, WebContentsView, partition, rewards }) {
    super();
    this.window = window;
    this.View = WebContentsView;
    this.partition = partition;
    this.rewards = rewards;
    this.views = new Map();
    this.pages = new Map();
    this.audioSlot = null;
    this.quitting = false;
  }

  has(slotId) { return this.views.has(slotId); }
  status(slotId) { return this.pages.get(slotId) || {}; }
  rewardStatus(slotId) { return this.rewards.status(slotId); }
  setAutoRewards(enabled) { return this.rewards.setEnabled(enabled); }
  update(slotId, state) { this.pages.set(slotId, state); this.emit('change'); }

  applyAudio() {
    for (const [slotId, view] of this.views) if (!view.webContents.isDestroyed()) view.webContents.setAudioMuted(slotId !== this.audioSlot);
  }

  selectAudio(slotId) {
    if (slotId !== null) {
      validSlot(slotId);
      if (!this.has(slotId)) throw new Error('먼저 방송을 열어 주세요.');
    }
    this.audioSlot = slotId;
    this.applyAudio(); this.emit('change');
  }

  shortcuts(contents, slotId) {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat || input.isComposing || this.quitting) return;
      let command;
      if (input.control && input.alt && !input.shift && !input.meta) {
        if (/^Digit[1-4]$/.test(input.code)) command = { method: 'selectAudio', arg: Number(input.code.slice(-1)) - 1 };
        if (input.code === 'KeyM') command = { method: 'selectAudio', arg: null };
      }
      if (input.control && input.shift && !input.alt && !input.meta && input.code === 'KeyS') command = { method: 'saveClip', slotId: this.audioSlot ?? slotId };
      if (command) { event.preventDefault(); this.emit('shortcut', command); }
    });
  }

  open(slotId, channelId) {
    const view = new this.View({ webPreferences: { partition: this.partition, nodeIntegration: false,
      contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } });
    const contents = view.webContents;
    this.views.set(slotId, view);
    this.window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 }); view.setVisible(false);
    const url = `https://chzzk.naver.com/live/${channelId}`;
    const current = () => this.views.get(slotId) === view && !this.quitting;
    contents.setAudioMuted(slotId !== this.audioSlot);
    contents.on('dom-ready', () => { if (!contents.isDestroyed()) contents.setZoomFactor(0.5); });
    this.shortcuts(contents, slotId);
    contents.setWindowOpenHandler(({ url: target }) => {
      if (trustedRemote(target)) this.emit(new URL(target).hostname === 'nid.naver.com' ? 'login-requested' : 'external-requested', target);
      return { action: 'deny' };
    });
    for (const name of ['will-navigate', 'will-redirect']) contents.on(name, (event, target) => {
      const allowed = trustedRemote(target) && new URL(target).hostname === 'chzzk.naver.com' && new URL(target).pathname === `/live/${channelId}`;
      if (!allowed) {
        event.preventDefault();
        if (trustedRemote(target) && new URL(target).hostname === 'nid.naver.com') this.emit('login-requested');
      }
    });
    contents.on('did-navigate-in-page', (_event, target, isMainFrame) => {
      if (!current() || !isMainFrame) return;
      if (!trustedRemote(target) || new URL(target).pathname !== `/live/${channelId}`) {
        contents.loadURL(url).catch(() => {});
        this.emit('notice', '다른 방송은 즐겨찾기에서 A–D 자리에 열어 주세요.');
      }
    });
    contents.on('did-start-loading', () => { if (current()) this.update(slotId, { pageStatus: 'loading', pageError: null }); });
    contents.on('did-start-navigation', (_event, _target, isInPlace, isMainFrame) => {
      if (current() && isMainFrame && !isInPlace) this.rewards.detach(slotId);
    });
    contents.on('did-finish-load', () => {
      if (!current()) return;
      this.pages.set(slotId, { pageStatus: 'ready', pageError: null }); this.applyAudio(); this.emit('change');
      void this.rewards.attach(slotId, contents, channelId);
    });
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (current() && isMainFrame && code !== -3) this.update(slotId, { pageStatus: 'error',
        pageError: `방송 페이지를 불러오지 못했습니다 (${code}). 새로고침을 눌러 주세요.` });
    });
    contents.on('render-process-gone', () => {
      if (!current()) return;
      this.rewards.detach(slotId);
      this.update(slotId, { pageStatus: 'error', pageError: '플레이어가 종료되었습니다. 새로고침해 주세요.' });
    });
    contents.loadURL(url).catch(() => {});
  }

  async close(slotId, beforeDestroy) {
    this.rewards.detach(slotId);
    const view = this.views.get(slotId);
    // Revoke ownership before waiting: a late load must not reattach rewards.
    this.views.delete(slotId);
    if (view && !view.webContents.isDestroyed()) view.webContents.setAudioMuted(true);
    try { await beforeDestroy(); }
    finally {
      if (view) {
        if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
        if (!view.webContents.isDestroyed()) view.webContents.close();
      }
      this.pages.delete(slotId);
      if (this.audioSlot === slotId) this.audioSlot = null;
      this.applyAudio();
    }
  }

  reload(slotId, channelId) {
    const view = this.views.get(slotId);
    if (view && !view.webContents.isDestroyed()) view.webContents.reload();
    else if (channelId) this.open(slotId, channelId);
  }

  reloadAll() { for (const view of this.views.values()) if (!view.webContents.isDestroyed()) view.webContents.reload(); }

  setBounds(bounds) {
    if (!Array.isArray(bounds) || bounds.length > SLOT_IDS.length) throw new Error('잘못된 화면 배치입니다.');
    const [windowWidth, windowHeight] = this.window.getContentSize();
    for (const item of bounds) {
      validSlot(item.slotId);
      const view = this.views.get(item.slotId);
      if (!view || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(item[key]))) continue;
      const x = Math.max(0, Math.min(windowWidth, Math.round(item.x))), y = Math.max(0, Math.min(windowHeight, Math.round(item.y)));
      const width = Math.max(0, Math.min(windowWidth - x, Math.round(item.width))), height = Math.max(0, Math.min(windowHeight - y, Math.round(item.height)));
      view.setBounds({ x, y, width, height }); view.setVisible(width > 0 && height > 0);
    }
  }

  beginShutdown() { this.quitting = true; this.rewards.close(); }
  destroyAll() {
    for (const view of this.views.values()) if (!view.webContents.isDestroyed()) view.webContents.close();
    this.views.clear();
  }
}

module.exports = { PlayerManager };
