/* Isolated-world adapter: only managed live-tab chat batches cross this boundary.
 * No page listeners, cookie APIs, storage, pairing code or arbitrary RPC methods. */
(() => {
  'use strict';
  if (!globalThis.DeskChat || globalThis.__deskChatAdapter) return;
  globalThis.__deskChatAdapter = true;
  let disposed = false, observer = null, context = null, configRequest = null, configAgain = false;
  let pending = [], heartbeat = false, sending = false, timer = null, sourceStatus = 'waiting', lastHeartbeat = 0;
  const encoder = new TextEncoder();

  const key = value => value ? `${value.slotId}:${value.channelId}:${value.generation}` : '';
  function matchesLocation(value) {
    return value && location.origin === 'https://chzzk.naver.com' &&
      new RegExp(`^/live/${value.channelId}/?$`, 'i').test(location.pathname);
  }
  function stopObserver() {
    observer?.stop(); observer = null; context = null; pending = []; heartbeat = false; sourceStatus = 'waiting';
  }
  async function request(method, arg) {
    const response = await chrome.runtime.sendMessage({ target: 'desk-chat', method, arg });
    if (!response?.ok) throw new Error('Chat delivery unavailable');
    return response.value;
  }
  async function drain() {
    if (sending || disposed || !context) return;
    sending = true;
    let sendingKey = '';
    try {
      while (!disposed && context && (pending.length || heartbeat)) {
        if (!matchesLocation(context)) { stopObserver(); break; }
        const current = context, events = [];
        sendingKey = key(current);
        // A 100 x 500-character batch can exceed 64 KiB in UTF-8 or JSON escapes.
        // Leave room for the fixed RPC envelope and never grow the queue on retry.
        let bytes = 0;
        while (pending.length && events.length < 25) {
          const size = encoder.encode(JSON.stringify(pending[0])).length + 1;
          if (bytes + size > 45000) break;
          bytes += size; events.push(pending.shift());
        }
        heartbeat = false;
        await request('submitBatch', { ...current, sourceStatus, events });
      }
    } catch {
      if (sendingKey === key(context)) stopObserver();
    } finally {
      sending = false;
      if (!disposed && context && (pending.length || heartbeat)) drain();
    }
  }
  function sendHeartbeat(force = false) {
    if (!context || (!force && Date.now() - lastHeartbeat < 5000)) return;
    lastHeartbeat = Date.now(); heartbeat = true; drain();
  }
  function applyContext(value) {
    const valid = value && Number.isInteger(value.slotId) && value.slotId >= 0 && value.slotId < 4 &&
      /^[a-f\d]{32}$/i.test(value.channelId) && typeof value.generation === 'string' && value.generation.length > 0 && value.generation.length <= 128;
    if (!valid || !matchesLocation(value)) { stopObserver(); return; }
    if (key(value) !== key(context)) {
      stopObserver();
      context = { slotId: value.slotId, channelId: value.channelId, generation: value.generation };
      const currentKey = key(context);
      observer = globalThis.DeskChat.createChatObserver({ document,
        onMessages(events) {
          if (disposed || currentKey !== key(context) || !matchesLocation(context)) return;
          pending.push(...events);
          if (pending.length > 200) pending = pending.slice(-200);
          drain();
        },
        onStatus(state) {
          if (disposed || currentKey !== key(context)) return;
          sourceStatus = state.status === 'watching' ? 'watching' : 'waiting';
          sendHeartbeat(true);
        }
      });
      observer.start();
    }
    sendHeartbeat();
  }
  async function configure() {
    if (disposed) return;
    if (context && !matchesLocation(context)) stopObserver();
    if (configRequest) { configAgain = true; return configRequest; }
    configRequest = (async () => {
      try {
        const value = await request('getContext');
        if (!disposed) applyContext(value);
      } catch { stopObserver(); }
    })();
    try { await configRequest; } finally {
      configRequest = null;
      if (configAgain) { configAgain = false; configure(); }
    }
  }
  configure();
  timer = setInterval(configure, 5000);
  chrome.runtime.onMessage.addListener(message => {
    if (message?.target === 'desk-chat-config') configure();
    return false;
  });
  addEventListener('pagehide', () => { disposed = true; clearInterval(timer); stopObserver(); });
  addEventListener('pageshow', event => {
    if (!event.persisted || !disposed) return;
    disposed = false; timer = setInterval(configure, 5000); configure();
  });
})();
