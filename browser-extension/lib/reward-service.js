const REWARD_STATES = new Set(['disabled', 'watching', 'claiming', 'claimed', 'unavailable']);

/** Chrome-session rewards only. This service has no desktop pairing or loopback RPC access. */
export class RewardService {
  constructor({ chromeApi, model, fetchImpl, timeoutMs, resolveTab, enabled }) {
    this.chrome = chromeApi;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.resolveTab = resolveTab;
    this.enabled = enabled;
    this.byTab = new Map();
    this.inflight = new Map();
  }

  forget(tabId) { this.byTab.delete(tabId); }

  async notifyConfig(tabId) {
    try { await this.chrome.tabs.sendMessage(tabId, { target: 'desk-rewards-config' }); } catch { /* Loading or no adapter yet. */ }
  }

  notifyAll(tabIds) { return Promise.all(tabIds.map(tabId => this.notifyConfig(tabId))); }

  async senderContext(sender) {
    if (sender?.id !== this.chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.tab.incognito || sender.frameId !== 0) return null;
    let channelId;
    try {
      const url = new URL(sender.url || '');
      if (url.origin !== 'https://chzzk.naver.com' || !/^\/live\/[a-f\d]{32}\/?$/i.test(url.pathname) || url.username || url.password) return null;
      channelId = this.model.parseChannel(url.href);
    } catch { return null; }
    const context = await this.resolveTab(sender.tab.id);
    return context?.channelId === channelId ? context : null;
  }

  async handleMessage(message, sender) {
    const context = await this.senderContext(sender);
    if (message?.method === 'getConfig') return { enabled: Boolean(context && this.enabled()), channelId: context?.channelId || null };
    if (!context || message?.channelId !== context.channelId) throw new Error('관리 중인 방송에서만 통나무 상태를 확인할 수 있어요.');
    if (message.method === 'getBalance') return this.fetchBalance(context, sender);
    if (message.method !== 'reportStatus') throw new Error('지원하지 않는 통나무 요청입니다.');
    const value = message.state || {};
    const balance = Number.isFinite(value.balance) && value.balance >= 0 ? value.balance : null;
    const status = REWARD_STATES.has(value.status) ? value.status : 'unavailable';
    const lastClaimAt = Number.isFinite(value.lastClaimAt) && value.lastClaimAt > 0 && value.lastClaimAt <= Date.now() + 1000 ? value.lastClaimAt : null;
    this.byTab.set(context.tabId, { channelId: context.channelId, balance,
      status: this.enabled() ? status : 'disabled', lastClaimAt,
      message: typeof value.message === 'string' ? value.message.slice(0, 200) : '' });
    return true;
  }

  stateFor(slotId, channelId, tabId) {
    const value = Number.isInteger(tabId) ? this.byTab.get(tabId) : null;
    return { slotId, balance: null, status: this.enabled() ? 'watching' : 'disabled',
      ...(value?.channelId === channelId ? value : {}), ...(!this.enabled() ? { status: 'disabled' } : {}) };
  }

  async fetchBalance(context, sender) {
    const key = `${context.tabId}:${context.channelId}`;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const request = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`https://api.chzzk.naver.com/service/v1/channels/${context.channelId}/log-power`, {
          method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal
        });
        if (!response.ok) throw new Error('통나무 보유량을 확인하지 못했어요. Chrome의 치지직 로그인을 확인해 주세요.');
        const value = await response.json();
        if (value?.code !== 200 || !Number.isFinite(value?.content?.amount) || value.content.amount < 0) throw new Error('통나무 보유량 응답을 확인하지 못했어요.');
        // Only reward facts cross into the isolated content script, never arbitrary account data.
        const claims = (Array.isArray(value.content.claims) ? value.content.claims : []).slice(0, 100).filter(item => item &&
          (typeof item.claimId === 'string' || Number.isSafeInteger(item.claimId))).map(item => ({
          claimId: typeof item.claimId === 'string' ? item.claimId.slice(0, 200) : item.claimId,
          claimType: typeof item.claimType === 'string' ? item.claimType.slice(0, 50) : '',
          state: typeof item.state === 'string' ? item.state.slice(0, 50) : '',
          saveType: typeof item.saveType === 'string' ? item.saveType.slice(0, 50) : '',
          amount: Number.isFinite(item.amount) && item.amount >= 0 ? item.amount : 0
        }));
        if (!(await this.senderContext(sender))) throw new Error('방송이 변경되어 통나무 조회를 취소했어요.');
        return { code: 200, content: { amount: value.content.amount, claims } };
      } catch (error) {
        if (error?.name === 'AbortError' || error instanceof TypeError) throw new Error('통나무 보유량을 확인하지 못했어요. 잠시 뒤 다시 확인합니다.');
        throw error;
      } finally { clearTimeout(timer); }
    })();
    this.inflight.set(key, request);
    try { return await request; } finally { this.inflight.delete(key); }
  }
}
