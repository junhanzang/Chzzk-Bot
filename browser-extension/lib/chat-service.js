const STALE = '방송 또는 자동 클립 설정이 바뀌어 채팅 전달을 중지했어요.';

/** Narrow read-only chat ingress. Content scripts cannot choose an RPC method or see pairing data. */
export class ChatService {
  constructor({ chromeApi, model, resolveTab, readRemote, submit }) {
    this.chrome = chromeApi;
    this.model = model;
    this.resolveTab = resolveTab;
    this.readRemote = readRemote;
    this.submit = submit;
    this.inflight = new Set();
  }

  async notifyConfig(tabId) {
    try { await this.chrome.tabs.sendMessage(tabId, { target: 'desk-chat-config' }); } catch { /* Adapter may still be loading. */ }
  }
  notifyAll(tabIds) { return Promise.all(tabIds.map(id => this.notifyConfig(id))); }

  async managedSender(sender) {
    if (sender?.id !== this.chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.tab.incognito || sender.frameId !== 0) return null;
    let channelId;
    try {
      const url = new URL(sender.url || '');
      if (url.origin !== 'https://chzzk.naver.com' || url.username || url.password || !/^\/live\/[a-f\d]{32}\/?$/i.test(url.pathname)) return null;
      channelId = this.model.parseChannel(url.href);
    } catch { return null; }
    const managed = await this.resolveTab(sender.tab.id);
    return managed?.channelId === channelId ? managed : null;
  }

  async senderContext(sender) {
    const managed = await this.managedSender(sender);
    const remote = this.readRemote();
    if (!remote || !managed) return null;
    const channelId = managed.channelId;
    const slot = remote.slots[managed.slotId], detector = remote.autoClips.find(item => item.slotId === managed.slotId);
    if (slot?.channelId !== channelId || slot.playbackMode !== 'browser' || !remote.autoClipSettings[channelId]?.enabled ||
        detector?.channelId !== channelId || typeof detector.generation !== 'string' || !detector.generation) return null;
    return { slotId: managed.slotId, channelId, generation: detector.generation };
  }

  async handleMessage(message, sender) {
    if (!['getContext', 'submitBatch'].includes(message?.method)) throw new Error('지원하지 않는 채팅 요청입니다.');
    const context = await this.senderContext(sender);
    if (message.method === 'getContext') return context;
    const value = message.arg;
    if (!context || value?.slotId !== context.slotId || value?.channelId !== context.channelId || value?.generation !== context.generation) throw new Error(STALE);
    if (!['watching', 'waiting'].includes(value.sourceStatus) || !Array.isArray(value.events) || value.events.length > 100 ||
        value.events.some(event => !event || typeof event.id !== 'string' || !event.id || event.id.length > 128 ||
          typeof event.text !== 'string' || event.text.length > 500 || !event.text.trim())) throw new Error('잘못된 채팅 묶음입니다.');
    const batch = { ...context, sourceStatus: value.sourceStatus, events: value.events.map(({ id, text }) => ({ id, text })) };
    if (new TextEncoder().encode(JSON.stringify(batch)).length > 50000) throw new Error('채팅 묶음이 너무 큽니다.');
    if (this.inflight.has(sender.tab.id)) throw new Error('앞선 채팅 묶음을 전달하고 있어요.');
    this.inflight.add(sender.tab.id);
    try {
      const result = await this.submit(batch);
      if (result?.accepted === false) throw new Error(STALE);
      // Never relay arbitrary desktop snapshots, errors or account details to a page.
      return true;
    } catch { throw new Error('채팅을 앱에 전달하지 못했어요. 연결과 자동 클립 설정을 다시 확인합니다.'); }
    finally { this.inflight.delete(sender.tab.id); }
  }
}
