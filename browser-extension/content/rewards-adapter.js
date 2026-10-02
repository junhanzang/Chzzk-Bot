/* Runs in Chrome's isolated content world. No DOM or page messages can invoke the desktop bridge. */
(() => {
  'use strict';
  if (!globalThis.DeskRewards || globalThis.__deskRewardsAdapter) return;
  globalThis.__deskRewardsAdapter = true;
  let disposed = false;
  let activeChannel = null;
  let configRequest = null;
  let configAgain = false;
  let started = false;
  let timer = null;
  let lastStatus = '';

  async function request(method, value = {}) {
    const response = await chrome.runtime.sendMessage({ target: 'desk-rewards', method, ...value });
    if (!response?.ok) throw new Error(response?.error || '통나무 상태를 확인하지 못했어요.');
    return response.value;
  }

  function reportStatus(state, force = false) {
    if (disposed || !activeChannel || state?.channelId !== activeChannel) return;
    const serialized = JSON.stringify(state);
    if (!force && serialized === lastStatus) return;
    lastStatus = serialized;
    request('reportStatus', { channelId: activeChannel, state }).catch(() => {});
  }

  const watcher = globalThis.DeskRewards.createWatcher({
    document, location,
    enabled: false,
    async fetchBalance(channelId, { signal } = {}) {
      if (disposed || signal?.aborted || channelId !== activeChannel) throw new Error('통나무 조회가 중지되었어요.');
      const value = await request('getBalance', { channelId });
      if (disposed || signal?.aborted || channelId !== activeChannel) throw new Error('통나무 조회가 중지되었어요.');
      return value;
    },
    onStatus: reportStatus
  });

  async function configure() {
    if (disposed) return;
    if (configRequest) { configAgain = true; return configRequest; }
    configRequest = (async () => {
      try {
        const config = await request('getConfig');
        if (disposed) return;
        const changed = activeChannel !== config.channelId;
        activeChannel = config.channelId;
        if (changed && started) { watcher.stop(); started = false; lastStatus = ''; }
        watcher.setEnabled(config.enabled === true && Boolean(activeChannel));
      } catch {
        activeChannel = null;
        watcher.setEnabled(false);
      }
      if (!disposed && !started) { watcher.start(); started = true; }
      // The service worker may have restarted while the same balance stayed on screen.
      reportStatus(watcher.getState?.(), true);
    })();
    try { await configRequest; } finally {
      configRequest = null;
      if (configAgain) { configAgain = false; configure(); }
    }
  }

  configure();
  // Also picks up SPA navigation, assignment changes and worker restarts.
  timer = setInterval(configure, 15000);
  chrome.runtime.onMessage.addListener(message => {
    if (message?.target === 'desk-rewards-config') configure();
    return false;
  });
  addEventListener('pagehide', () => {
    disposed = true;
    activeChannel = null;
    clearInterval(timer);
    watcher.stop();
    started = false;
  });
  addEventListener('pageshow', event => {
    if (!event.persisted || !disposed) return;
    disposed = false;
    timer = setInterval(configure, 15000);
    configure();
  });
})();
