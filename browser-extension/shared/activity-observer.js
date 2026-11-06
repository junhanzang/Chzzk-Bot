'use strict';

((root, factory) => {
  const model = factory();
  root.DeskActivity = model;
  if (typeof module === 'object' && module.exports) module.exports = model;
})(globalThis, () => {
  // Official DOM evidence: index-BcgE118t.js on ssl.pstatic.net/static/nng/glive/resource/p/static/js/.
  // Live player: #live_player_layout. Shared live/popup composer: aside#aside-chatting,
  // qv(tagName:'pre', className:sy.input, contentEditable:true). No message text is read.
  const COMPOSER = 'pre[contenteditable="true"][class*="_input_"]';
  const EXCLUDED = '[hidden], [aria-hidden="true"], [role="dialog"], [role="alertdialog"]';
  const SAMPLE_MS = 1000, REPORT_MS = 15000, CHAT_INTERVAL_MS = 30000, MAX_GAP_MS = 5000;

  function activityPage(value, channelId) {
    if (typeof channelId !== 'string' || !/^[a-f\d]{32}$/i.test(channelId)) return null;
    try {
      const url = new URL(typeof value === 'string' ? value : value.href || `${value.origin}${value.pathname}`);
      if (url.origin !== 'https://chzzk.naver.com' || url.username || url.password) return null;
      const match = url.pathname.match(/^\/live\/([a-f\d]{32})(\/chat)?\/?$/i);
      return match?.[1].toLowerCase() === channelId.toLowerCase() ? (match[2] ? 'chat' : 'live') : null;
    } catch { return null; }
  }

  function createActivityObserver({ document, location, channelId, onActivity = null,
    clock = () => globalThis.performance?.now?.() ?? Date.now(), getComputedStyle = globalThis.getComputedStyle,
    timerDeps = {} } = {}) {
    const timers = { setInterval: timerDeps.setInterval || globalThis.setInterval,
      clearInterval: timerDeps.clearInterval || globalThis.clearInterval };
    let active = false, timer = null, previous = null, watch = 0, chats = 0, lastChat = -Infinity, lastReport = 0;
    let interrupted = new WeakSet(), observedVideo = null;
    const interruptionEvents = ['seeking', 'pause', 'waiting', 'emptied', 'ratechange'];

    function observeVideo(current) {
      if (current === observedVideo) return;
      for (const name of interruptionEvents) observedVideo?.removeEventListener(name, interrupt);
      observedVideo = current;
      for (const name of interruptionEvents) observedVideo?.addEventListener(name, interrupt, { passive: true });
    }

    function visible(node) {
      if (!node?.isConnected) return false;
      for (let current = node; current; current = current.parentElement) {
        if (current.matches?.(EXCLUDED)) return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(current) : current.style;
        if (style?.display === 'none' || style?.visibility === 'hidden') return false;
      }
      return true;
    }
    function video() {
      const root = document.querySelector('#live_player_layout');
      if (!root?.isConnected || root.classList?.contains('is_preview')) return null;
      // The official player can render video inside open custom-element roots.
      // Never inspect page JS objects, network traffic, iframe contents or closed roots.
      const roots = [root], found = new Set(); let inspected = 0;
      while (roots.length && inspected < 1000) {
        const scope = roots.shift();
        for (const node of scope.querySelectorAll('*')) {
          if (++inspected > 1000) break;
          if (node.tagName === 'VIDEO' && node.isConnected) found.add(node);
          if (node.shadowRoot) roots.push(node.shadowRoot);
        }
      }
      // Ambiguous DOM (e.g. an ad alongside the player) must not inflate history.
      return found.size === 1 ? [...found][0] : null;
    }
    function sample() {
      if (!active) return;
      if (activityPage(location, channelId) !== 'live') { previous = null; observeVideo(null); return; }
      const current = video(), now = clock();
      observeVideo(current);
      const valid = current && Number.isFinite(now) && Number.isFinite(current.currentTime) &&
        current.paused === false && current.ended === false && current.seeking === false && current.readyState >= 2 &&
        Number.isFinite(current.playbackRate) && current.playbackRate > 0 && current.playbackRate <= 4;
      const next = valid ? { video: current, at: now, time: current.currentTime, rate: current.playbackRate } : null;
      if (next && previous?.video === current && previous.rate === next.rate && !interrupted.has(current)) {
        const elapsed = now - previous.at, advanced = (next.time - previous.time) / next.rate;
        if (elapsed > 0 && elapsed <= MAX_GAP_MS && advanced > 0 && advanced <= elapsed / 1000 * 1.5 + 0.1) {
          watch = Math.min(60, watch + Math.min(elapsed / 1000, advanced));
        }
      }
      if (current) interrupted.delete(current);
      previous = next;
    }
    function drain() {
      if (!active || !activityPage(location, channelId)) { watch = 0; chats = 0; return { watchSeconds: 0, chatCount: 0 }; }
      sample();
      const watchSeconds = Math.floor(watch), chatCount = chats;
      watch -= watchSeconds; chats = 0;
      return { watchSeconds, chatCount };
    }
    function input(event) {
      if (!active || event.isTrusted !== true || !activityPage(location, channelId)) return;
      const target = event.target?.closest?.(COMPOSER);
      const aside = target?.closest?.('aside#aside-chatting');
      if (!aside || !visible(target) || !aside.contains(target) ||
          (document.activeElement !== target && !target.contains?.(document.activeElement))) return;
      const now = clock();
      if (!Number.isFinite(now)) return;
      if (now < lastChat) { lastChat = now; return; }
      if (now - lastChat < CHAT_INTERVAL_MS) return;
      lastChat = now; chats = Math.min(2, chats + 1);
    }
    function interrupt(event) { if (event.target?.tagName === 'VIDEO') interrupted.add(event.target); }
    function tick() {
      sample();
      const now = clock();
      if (onActivity && now - lastReport >= REPORT_MS) {
        lastReport = now;
        const delta = drain();
        if (delta.watchSeconds || delta.chatCount) {
          try { Promise.resolve(onActivity(delta)).catch(() => {}); } catch { /* Delivery owns errors. */ }
        }
      }
    }
    return {
      start() {
        if (active) return;
        active = true; previous = null; watch = 0; chats = 0; lastChat = -Infinity; lastReport = clock();
        document.addEventListener('input', input, { capture: true, passive: true });
        sample(); timer = timers.setInterval(tick, SAMPLE_MS);
      },
      stop() {
        active = false; timers.clearInterval(timer); timer = null; previous = null; watch = 0; chats = 0; interrupted = new WeakSet();
        document.removeEventListener('input', input, true); observeVideo(null);
      }, sample, drain
    };
  }

  return Object.freeze({ createActivityObserver, activityPage, SAMPLE_MS, REPORT_MS, CHAT_INTERVAL_MS });
});
