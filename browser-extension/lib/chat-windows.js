import '../shared/chat-popup.js';

const { normalizeChatChannelId, chatPopupUrl, isChatPopupUrl } = globalThis.DeskChatPopup;

// Chat popups deliberately have no connection to ManagedTabs or the audio owner.
export class ChatWindows {
  constructor({ chromeApi, storage }) {
    this.chrome = chromeApi;
    this.storage = storage;
    this.windows = new Map();
    this.pending = new Map();
    this.closed = false;
    this.revision = 0;
  }

  restore(session = {}) {
    if (this.closed) return;
    this.revision++;
    this.windows.clear();
    const windowIds = new Set(), tabIds = new Set();
    for (const value of Array.isArray(session?.chatWindows) ? session.chatWindows.slice(0, 100) : []) {
      try {
        const channelId = normalizeChatChannelId(value?.channelId);
        if (!Number.isSafeInteger(value.windowId) || value.windowId < 0 || !Number.isSafeInteger(value.tabId) || value.tabId < 0 ||
            typeof value.owned !== 'boolean' || this.windows.has(channelId) || windowIds.has(value.windowId) || tabIds.has(value.tabId)) continue;
        this.windows.set(channelId, { windowId: value.windowId, tabId: value.tabId, owned: value.owned });
        windowIds.add(value.windowId); tabIds.add(value.tabId);
      } catch { /* Invalid session identifiers never grant page ownership. */ }
    }
  }

  persist() {
    const chatWindows = [...this.windows].map(([channelId, entry]) => ({ channelId,
      windowId: entry.windowId, tabId: entry.tabId, owned: entry.owned === true }));
    return Promise.resolve(this.storage?.updateSession({ chatWindows }));
  }

  remember(channelId, entry) {
    this.windows.delete(channelId);
    this.windows.set(channelId, entry);
    while (this.windows.size > 100) this.windows.delete(this.windows.keys().next().value);
  }

  assertActive(revision) {
    if (this.closed || revision !== this.revision) throw new Error('채팅창 관리가 종료되었거나 새로 연결되었습니다.');
  }

  async open(rawChannelId, _title) {
    const channelId = normalizeChatChannelId(rawChannelId);
    if (this.closed) throw new Error('채팅창 관리가 종료되었습니다.');
    if (this.pending.has(channelId)) return this.pending.get(channelId);
    const operation = this.openChannel(channelId, this.revision);
    this.pending.set(channelId, operation);
    try { return await operation; }
    finally { if (this.pending.get(channelId) === operation) this.pending.delete(channelId); }
  }

  async matchingWindow(windowId, channelId, tabId) {
    try {
      const win = await this.chrome.windows.get(windowId, { populate: true });
      const tab = win?.tabs?.[0];
      if (win?.type !== 'popup' || win.incognito || win.tabs.length !== 1 || !Number.isInteger(tab?.id) ||
          tab.incognito || (Number.isInteger(tabId) && tab.id !== tabId) ||
          !isChatPopupUrl(tab.pendingUrl || tab.url, channelId)) return null;
      return win;
    } catch { return null; }
  }
  async resolveContext(tabId) {
    if (this.closed || !Number.isSafeInteger(tabId) || tabId < 0) return null;
    for (const [channelId, entry] of this.windows) {
      if (entry.tabId !== tabId) continue;
      const win = await this.matchingWindow(entry.windowId, channelId, tabId);
      if (this.closed || this.windows.get(channelId) !== entry) return null;
      if (win) return { channelId };
      this.windows.delete(channelId);
      await this.persist().catch(() => {});
      return null;
    }
    return null;
  }

  async focus(entry, channelId, revision, expected) {
    const win = await this.matchingWindow(entry.windowId, channelId, entry.tabId);
    if (!win || this.closed || revision !== this.revision || (expected && this.windows.get(channelId) !== expected)) return null;
    try {
      await this.chrome.windows.update(win.id, { focused: true, ...(win.state === 'minimized' ? { state: 'normal' } : {}) });
    } catch { return null; }
    if (this.closed || revision !== this.revision || (expected && this.windows.get(channelId) !== expected)) return null;
    this.remember(channelId, { ...entry, tabId: win.tabs[0].id });
    await this.persist();
    this.assertActive(revision);
    return { channelId, windowId: win.id, reused: true };
  }

  async openChannel(channelId, revision) {
    const previous = this.windows.get(channelId);
    if (previous) {
      const result = await this.focus(previous, channelId, revision, previous);
      if (result) return result;
      this.assertActive(revision);
      if (this.windows.get(channelId) === previous) { this.windows.delete(channelId); await this.persist(); }
    }
    // Host permission exposes matching tab URLs without the broad tabs permission.
    // Rediscovery survives a service worker restart, preserving the user's geometry.
    const tabs = await this.chrome.tabs.query({ url: 'https://chzzk.naver.com/live/*/chat*' });
    for (const tab of tabs) {
      if (tab.incognito || !isChatPopupUrl(tab.pendingUrl || tab.url, channelId)) continue;
      const result = await this.focus({ windowId: tab.windowId, tabId: tab.id, owned: false }, channelId, revision);
      if (result) return result;
    }
    this.assertActive(revision);
    const win = await this.chrome.windows.create({
      url: chatPopupUrl(channelId), type: 'popup', width: 440, height: 800, focused: true, incognito: false
    });
    if (!Number.isInteger(win?.id)) throw new Error('Chrome 채팅창을 열지 못했어요. 다시 시도해 주세요.');
    const entry = { windowId: win.id, tabId: win.tabs?.[0]?.id, owned: true };
    if (this.closed || revision !== this.revision) {
      await this.removeOwned(entry, channelId);
      throw new Error('채팅창 관리가 종료되었습니다.');
    }
    const populated = await this.matchingWindow(win.id, channelId, entry.tabId);
    if (this.closed || revision !== this.revision) {
      await this.removeOwned(entry, channelId);
      throw new Error('채팅창 관리가 종료되었습니다.');
    }
    if (!populated) throw new Error('채팅창 상태를 확인하지 못했어요. 다시 열어 주세요.');
    entry.tabId = populated.tabs[0].id;
    this.remember(channelId, entry);
    await this.persist();
    this.assertActive(revision);
    return { channelId, windowId: win.id, reused: false };
  }

  async removeOwned(entry, channelId) {
    if (!entry.owned || !await this.matchingWindow(entry.windowId, channelId, entry.tabId)) return;
    try { await this.chrome.windows.remove(entry.windowId); } catch { /* Already closed by the user. */ }
  }

  async closeAll() {
    this.closed = true;
    const entries = [...this.windows.entries()];
    this.windows.clear();
    await Promise.all([this.persist(), ...entries.map(([channelId, entry]) => this.removeOwned(entry, channelId))]);
  }
}
