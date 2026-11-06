import '../shared/recommendations.js';
/** Private, bounded counters from owned live tabs/chat popups, never message text. */
export class ActivityService {
  constructor({ chromeApi, resolveTab, history, clock = Date.now, newId = () => crypto.randomUUID() }) {
    Object.assign(this, { chrome: chromeApi, resolveTab, history, clock, newId });
    this.entries = new Map(); this.revision = 0; this.epochs = new Map(); this.epochSequence = 0;
    this.budget = new globalThis.DeskRecommendations.ActivityBudget({ clock });
  }
  forget(tabId) { this.entries.delete(tabId); this.markEpoch(tabId); }
  markEpoch(tabId) {
    this.epochs.set(tabId, ++this.epochSequence);
    if (this.epochs.size > 500) { const oldest = this.epochs.keys().next().value; this.epochs.delete(oldest); this.entries.delete(oldest); }
    return this.epochSequence;
  }
  reset() { this.revision++; this.entries.clear(); this.epochs.clear(); this.budget.reset(); }
  async context(sender) {
    if (sender?.id !== this.chrome.runtime.id || sender.frameId !== 0 || sender.tab?.incognito || !Number.isInteger(sender.tab?.id)) return null;
    if (sender.documentLifecycle && sender.documentLifecycle !== 'active') return null;
    let channelId, popup;
    try {
      const url = new URL(sender.url);
      if (url.origin !== 'https://chzzk.naver.com' || url.username || url.password) return null;
      const match = url.pathname.match(/^\/live\/([a-f\d]{32})(\/chat)?\/?$/i);
      if (!match) return null;
      channelId = match[1].toLowerCase(); popup = Boolean(match[2]);
    } catch { return null; }
    const revision = this.revision, epoch = this.epochs.get(sender.tab.id) ?? this.markEpoch(sender.tab.id), owned = await this.resolveTab(sender.tab.id, popup);
    if (revision !== this.revision || epoch !== this.epochs.get(sender.tab.id) || owned?.channelId !== channelId) return null;
    // documentId prevents an old page from submitting after a reload of the same URL.
    const identity = `${channelId}:${popup}:${sender.documentId || ''}`;
    let entry = this.entries.get(sender.tab.id);
    if (!entry || entry.identity !== identity) {
      entry = { identity, channelId, popup, generation: this.newId(), sequence: 0, at: this.clock(), revision };
      this.entries.set(sender.tab.id, entry);
    }
    return entry;
  }
  async handleMessage(message, sender) {
    if (!['getContext', 'submit'].includes(message?.method)) throw new Error('지원하지 않는 시청 기록 요청입니다.');
    const entry = await this.context(sender);
    if (message.method === 'getContext') return entry && this.entries.get(sender.tab.id) === entry ? { channelId: entry.channelId, generation: entry.generation } : null;
    const arg = message.arg;
    if (!entry || this.entries.get(sender.tab.id) !== entry || entry.revision !== this.revision || arg?.channelId !== entry.channelId || arg?.generation !== entry.generation ||
        !Number.isSafeInteger(arg.sequence) || arg.sequence <= entry.sequence ||
        !Number.isFinite(arg.watchSeconds) || arg.watchSeconds < 0 || arg.watchSeconds > 60 ||
        !Number.isInteger(arg.chatCount) || arg.chatCount < 0 || arg.chatCount > 2) return { accepted: false };
    const now = this.clock(), elapsed = Math.max(0, Math.min(60, (now - entry.at) / 1000));
    const watchSeconds = entry.popup ? 0 : Math.min(arg.watchSeconds, elapsed);
    entry.sequence = arg.sequence; entry.at = now;
    const delta = this.budget.accept(entry.channelId, { watchSeconds, chatCount: arg.chatCount });
    if (delta.watchSeconds || delta.chatCount) this.history.recordActivity(entry.channelId, delta);
    return { accepted: true };
  }
}
