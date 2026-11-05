import '../shared/chat-popup.js';

const { normalizeChatChannelId, chatPopupUrl, isChatPopupUrl } = globalThis.DeskChatPopup;

// Chat popups deliberately have no connection to ManagedTabs or the audio owner.
export class ChatWindows {
  constructor({ chromeApi }) {
    this.chrome = chromeApi;
    this.windows = new Map();
    this.pending = new Map();
    this.closed = false;
  }

  async open(rawChannelId, _title) {
    const channelId = normalizeChatChannelId(rawChannelId);
    if (this.closed) throw new Error('채팅창 관리가 종료되었습니다.');
    if (this.pending.has(channelId)) return this.pending.get(channelId);
    const operation = this.openChannel(channelId);
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

  async focus(entry, channelId) {
    const win = await this.matchingWindow(entry.windowId, channelId, entry.tabId);
    if (!win || this.closed) return null;
    try {
      await this.chrome.windows.update(win.id, { focused: true, ...(win.state === 'minimized' ? { state: 'normal' } : {}) });
      if (this.closed) return null;
      this.windows.set(channelId, { ...entry, tabId: win.tabs[0].id });
      return { channelId, windowId: win.id, reused: true };
    } catch { return null; }
  }

  async openChannel(channelId) {
    const previous = this.windows.get(channelId);
    if (previous) {
      const result = await this.focus(previous, channelId);
      if (result) return result;
      this.windows.delete(channelId);
    }
    // Host permission exposes matching tab URLs without the broad tabs permission.
    // Rediscovery survives a service worker restart, preserving the user's geometry.
    const tabs = await this.chrome.tabs.query({ url: 'https://chzzk.naver.com/live/*/chat*' });
    for (const tab of tabs) {
      if (tab.incognito || !isChatPopupUrl(tab.pendingUrl || tab.url, channelId)) continue;
      const result = await this.focus({ windowId: tab.windowId, tabId: tab.id, owned: false }, channelId);
      if (result) return result;
    }
    if (this.closed) throw new Error('채팅창 관리가 종료되었습니다.');
    const win = await this.chrome.windows.create({
      url: chatPopupUrl(channelId), type: 'popup', width: 440, height: 800, focused: true, incognito: false
    });
    if (!Number.isInteger(win?.id)) throw new Error('Chrome 채팅창을 열지 못했어요. 다시 시도해 주세요.');
    const entry = { windowId: win.id, tabId: win.tabs?.[0]?.id, owned: true };
    if (this.closed) {
      await this.removeOwned(entry, channelId);
      throw new Error('채팅창 관리가 종료되었습니다.');
    }
    this.windows.set(channelId, entry);
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
    await Promise.all(entries.map(([channelId, entry]) => this.removeOwned(entry, channelId)));
  }
}
