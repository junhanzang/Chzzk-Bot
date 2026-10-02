(function (root, factory) {
  'use strict';
  const api = factory();
  root.DeskChat = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis, function () {
  'use strict';

  // Selector evidence (read-only; no upstream implementation copied):
  // https://github.com/lirpa62/Chzzk-Platter/blob/main/src/content.js
  // chatHistoryListEl and chatItemMessageText: official chat aside/log,
  // _chatting_message_ body and _text_ spans excluding nickname/username.
  const CONTAINER = '[role="log"], [class*="live_chatting_list_container"]';
  const MESSAGE = '[class*="_chatting_message_"]';
  const TEXT = '[class*="_text_"]';
  const NICKNAME = '[class*="_nickname_"], [class*="_username_"]';
  const EXCLUDED = '[class*="_fixed_"], [class*="_floating_"], [role="dialog"], [role="alertdialog"], [hidden], [aria-hidden="true"]';
  const MAX_CANDIDATES = 500, MAX_BATCH = 100;

  function messageText(element, container) {
    if (!element?.isConnected || !container?.contains(element)) return '';
    for (let node = element; node && node !== container; node = node.parentElement) {
      if (node.matches?.(EXCLUDED)) return '';
    }
    let text = '';
    for (const span of element.querySelectorAll(TEXT)) {
      if (span.closest?.(NICKNAME)) continue;
      // Nested text spans must not count their text twice.
      if (span.parentElement?.closest?.(TEXT) && element.contains(span.parentElement.closest(TEXT))) continue;
      text += span.textContent || '';
      if (text.length >= 500) break;
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, 500);
  }

  /** Read-only DOM observer. Each start/container change seeds existing rows.
   * onMessages([{id,text}]) delivers at most 100 newly observed bodies per 250ms.
   * onStatus({status:'watching'|'waiting',message}) reports recognized DOM only.
   * timerDeps {setTimeout,clearTimeout} is optional and allows headless tests.
   */
  function createChatObserver({ document, MutationObserver = globalThis.MutationObserver, getComputedStyle = globalThis.getComputedStyle,
    onMessages, onStatus = () => {}, timerDeps = {} } = {}) {
    const timers = { setTimeout: timerDeps.setTimeout || globalThis.setTimeout,
      clearTimeout: timerDeps.clearTimeout || globalThis.clearTimeout };
    let active = false, container = null, observer = null, poll = null, flushTimer = null;
    let seen = new WeakMap(), candidates = new Set(), sequence = 0, prefix = '', lastStatus = null;

    function visible(element) {
      if (!element?.isConnected) return false;
      for (let node = element; node; node = node.parentElement) {
        if (node.matches?.('[hidden], [aria-hidden="true"]')) return false;
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : node.style;
        if (style?.display === 'none' || style?.visibility === 'hidden' || style?.contentVisibility === 'hidden') return false;
      }
      return true;
    }
    function canonicalMessage(element) {
      let message = element?.closest?.(MESSAGE);
      if (!message || !container?.contains(message)) return null;
      // Build hashes can put the same substring on a wrapper and its body.
      // One outer message root produces one event, regardless of nested matches.
      for (let parent = message.parentElement; parent && parent !== container; parent = parent.parentElement) {
        if (parent.matches?.(MESSAGE)) message = parent;
      }
      return message;
    }

    function status(value) {
      if (lastStatus === value) return;
      lastStatus = value;
      onStatus({ status: value, message: value === 'watching' ? '새 채팅을 확인하고 있어요.' : '채팅 영역이 열리기를 기다리고 있어요.' });
    }
    function detach() {
      observer?.disconnect(); observer = null; container = null;
      if (flushTimer !== null) timers.clearTimeout(flushTimer);
      flushTimer = null; candidates.clear(); seen = new WeakMap();
    }
    function enqueueNode(node, descendants = true) {
      if (candidates.size >= MAX_CANDIDATES) return;
      const element = node?.nodeType === 3 ? node.parentElement : node;
      if (!element) return;
      const owner = canonicalMessage(element);
      if (owner) candidates.add(owner);
      for (const message of descendants ? element.querySelectorAll?.(MESSAGE) || [] : []) {
        if (candidates.size >= MAX_CANDIDATES) break;
        const canonical = canonicalMessage(message);
        if (canonical) candidates.add(canonical);
      }
    }
    function flush() {
      flushTimer = null;
      if (!active) return;
      if (!visible(container)) { detach(); status('waiting'); return; }
      const events = [];
      for (const element of candidates) {
        const text = messageText(element, container);
        if (!text || seen.get(element) === text) continue;
        seen.set(element, text);
        if (events.length < MAX_BATCH) events.push({ id: `${prefix}:${++sequence}`, text });
      }
      candidates.clear();
      if (events.length) {
        try { Promise.resolve(onMessages(events)).catch(() => {}); } catch { /* Consumer owns delivery failures. */ }
      }
    }
    function changed(records) {
      if (!active) return;
      // A hidden chat may still receive messages before the next container poll.
      // Detach immediately so showing it again seeds that intervening backlog.
      if (!visible(container)) { detach(); status('waiting'); return; }
      for (const record of records) {
        enqueueNode(record.target, false);
        for (const node of record.addedNodes || []) enqueueNode(node);
        if (candidates.size >= MAX_CANDIDATES) break;
      }
      if (candidates.size && flushTimer === null) flushTimer = timers.setTimeout(flush, 250);
    }
    function findContainer() {
      const aside = document?.querySelector?.('aside#aside-chatting');
      const found = aside?.querySelector?.(CONTAINER);
      return visible(aside) && visible(found) ? found : null;
    }
    function inspect() {
      if (!active) return;
      const next = findContainer();
      if (next !== container) {
        detach(); container = next;
        if (container && typeof MutationObserver === 'function') {
          // Attach before reading the seed; mutations during setup cannot be lost.
          observer = new MutationObserver(changed);
          observer.observe(container, { childList: true, subtree: true, characterData: true });
          for (const element of container.querySelectorAll(MESSAGE)) {
            const canonical = canonicalMessage(element);
            if (canonical) seen.set(canonical, messageText(canonical, container));
          }
        }
      }
      status(container && observer ? 'watching' : 'waiting');
      poll = timers.setTimeout(inspect, 2000);
    }
    return {
      start() {
        if (active) return;
        active = true; sequence = 0; lastStatus = null;
        prefix = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        inspect();
      },
      stop() {
        active = false; detach();
        if (poll !== null) timers.clearTimeout(poll);
        poll = null;
      }
    };
  }
  return { createChatObserver };
});
