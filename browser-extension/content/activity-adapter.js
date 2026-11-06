/* Isolated content world. Only local numeric activity deltas cross this boundary. */
(() => {
  'use strict';
  if (!globalThis.DeskActivity || globalThis.__deskActivityAdapter) return;
  globalThis.__deskActivityAdapter = true;
  let disposed = false, observer = null, context = null, sequence = 0, requestInFlight = null, again = false;
  let sending = false, pending = null, timer = null, lastGeneration = null;
  const key = value => value ? `${value.channelId}:${value.generation}` : '';
  const matches = value => value && globalThis.DeskActivity.activityPage(location, value.channelId);
  function stop() { observer?.stop(); observer = null; context = null; pending = null; }
  async function request(method, arg) {
    const result = await chrome.runtime.sendMessage({ target: 'desk-activity', method, arg });
    if (!result?.ok) throw new Error('Activity unavailable');
    return result.value;
  }
  async function send() {
    if (sending || disposed) return;
    sending = true; let currentKey = '';
    try {
      while (pending && context && !disposed) {
        if (!matches(context)) { stop(); break; }
        currentKey = key(context);
        const delta = pending; pending = null;
        const result = await request('submit', { ...context, sequence: ++sequence, ...delta });
        if (key(context) === currentKey && (result === false || result?.accepted === false)) stop();
      }
    } catch { if (key(context) === currentKey) stop(); }
    finally { sending = false; if (!disposed && context && pending) void send(); }
  }
  function apply(value) {
    if (!value || typeof value.generation !== 'string' || !value.generation.length || value.generation.length > 128 || !matches(value)) { stop(); return; }
    if (observer && key(context) === key(value)) return;
    stop(); context = { channelId: value.channelId, generation: value.generation };
    if (key(context) !== lastGeneration) { sequence = 0; lastGeneration = key(context); }
    const current = context;
    observer = globalThis.DeskActivity.createActivityObserver({ document, location, channelId: current.channelId,
      onActivity(delta) {
        if (disposed || context !== current || !matches(current)) return;
        if (!Number.isInteger(delta.watchSeconds) || delta.watchSeconds < 0 || delta.watchSeconds > 60 ||
            !Number.isInteger(delta.chatCount) || delta.chatCount < 0 || delta.chatCount > 2) return;
        pending = { watchSeconds: Math.min(60, (pending?.watchSeconds || 0) + delta.watchSeconds),
          chatCount: Math.min(2, (pending?.chatCount || 0) + delta.chatCount) };
        if (pending.watchSeconds || pending.chatCount) void send();
      }
    });
    observer.start();
  }
  async function configure() {
    if (disposed) return;
    if (context && !matches(context)) stop();
    if (requestInFlight) { again = true; return requestInFlight; }
    requestInFlight = (async () => {
      try { const value = await request('getContext'); if (!disposed) apply(value); }
      catch { stop(); }
    })();
    try { await requestInFlight; } finally { requestInFlight = null; if (again) { again = false; void configure(); } }
  }
  void configure(); timer = setInterval(configure, 5000);
  chrome.runtime.onMessage.addListener(message => { if (message?.target === 'desk-activity-config') void configure(); return false; });
  addEventListener('pagehide', () => { disposed = true; clearInterval(timer); stop(); });
  addEventListener('pageshow', event => {
    if (!event.persisted || !disposed) return;
    disposed = false; timer = setInterval(configure, 5000); void configure();
  });
})();
