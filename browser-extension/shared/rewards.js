'use strict';

// Shared, dependency-free runtime for the extension content script and Electron.
// Native DOM/API observations are documented in REWARDS-SOURCES.md. No API writes.
((root, factory) => {
  const rewards = factory();
  root.DeskRewards = rewards;
  if (typeof module === 'object' && module.exports) module.exports = rewards;
})(globalThis, () => {
  const CHANNEL = /^[a-f\d]{32}$/i;
  const ROOT = 'aside#aside-chatting';
  const BUTTONS = 'button[type="button"][class*="_button_"]';
  const BLOCKED = /구독|팔로우|로그인|결제|쿠폰|선물|후원|충전|구매|베팅|예측|subscribe|follow|login|payment|coupon|gift|donat|purchase|bet/i;
  const compact = value => String(value || '').replace(/\s+/g, '');
  const prefixed = (element, prefix) => [...(element?.classList || [])].some(name => name.startsWith(prefix));
  const integer = value => {
    if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };

  function channelIdFromUrl(value) {
    try {
      const url = new URL(typeof value === 'string' ? value : value?.href);
      if (url.protocol !== 'https:' || url.hostname !== 'chzzk.naver.com' || url.port || url.username || url.password) return null;
      return url.pathname.match(/^\/live\/([a-f\d]{32})(?:\/chat)?\/?$/i)?.[1].toLowerCase() || null;
    } catch { return null; }
  }

  function balanceUrl(channelId) {
    if (typeof channelId !== 'string' || !CHANNEL.test(channelId)) throw new Error('Invalid channel');
    return `https://api.chzzk.naver.com/service/v1/channels/${channelId.toLowerCase()}/log-power`;
  }

  function parseSnapshot(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('Unavailable balance');
    const normalized = Object.prototype.hasOwnProperty.call(raw, 'balance');
    if (!normalized && raw.code !== undefined && raw.code !== 200) throw new Error('Unavailable balance');
    const balance = integer(normalized ? raw.balance : raw.content?.amount);
    if (balance === null) throw new Error('Unavailable balance');
    const claims = normalized ? raw.watchClaims : raw.content?.claims;
    const watchClaims = [];
    for (const claim of Array.isArray(claims) ? claims.slice(0, 100) : []) {
      if (!normalized && (claim?.claimType !== 'WATCH_1_HOUR' || claim.state !== 'COMPLIED' || claim.saveType !== 'ACTIVE')) continue;
      const id = normalized ? claim?.id : claim?.claimId;
      if ((typeof id !== 'string' && typeof id !== 'number') || !String(id) || String(id).length > 128 || /[\x00-\x1f\x7f]/.test(String(id))) continue;
      const amount = integer(claim.amount);
      if (amount === null || amount === 0 || watchClaims.some(item => item.id === String(id))) continue;
      watchClaims.push({ id: String(id), amount });
    }
    return { balance, watchClaims };
  }

  function rewardButton(button, root, getStyle = globalThis.getComputedStyle) {
    if (!button || button.tagName !== 'BUTTON' || button.getAttribute('type') !== 'button' || !root?.contains(button)) return null;
    if (!button.isConnected || button.disabled || button.hasAttribute('disabled') || button.hasAttribute('aria-haspopup') || button.hasAttribute('aria-expanded')) return null;
    if (button.closest('[disabled], [hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]')) return null;
    if (!prefixed(button, '_button_') || prefixed(button, '_ranking_button_')) return null;
    const signal = [button.textContent, ...['title', 'aria-label', 'name', 'value', 'data-action'].map(key => button.getAttribute(key))].join(' ');
    if (BLOCKED.test(signal)) return null;
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const style = getStyle?.(button);
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none')) return null;
    const text = compact(button.textContent);
    const children = [...button.children];
    const notice = text.match(/^(\d+)시간시청통나무파워배달완료!([\d,]+)받기$/);
    if (notice && children.length === 2 && children[0].tagName === 'SPAN' && prefixed(children[0], '_text_') &&
        compact(children[0].textContent) === `${notice[1]}시간시청통나무파워배달완료!` && children[1].localName === 'svg' &&
        (prefixed(children[1], '_icon_power_') || prefixed(children[1], 'icon_power_'))) {
      const amount = integer(notice[2].replace(/,/g, ''));
      return amount ? { button, amount, signature: `watch:${notice[1]}:${amount}` } : null;
    }
    const row = button.parentElement;
    const labels = [...(row?.children || [])].filter(child => child.tagName === 'SPAN');
    const power = text.match(/^([\d,]+)파워$/);
    if (power && row?.tagName === 'LI' && row.parentElement?.tagName === 'UL' && row.closest('[role="alertdialog"]') &&
        labels.length === 1 && /^(?:1시간|60분)(?:라이브)?시청(?:후)?(?:보상|인증)$/.test(compact(labels[0].textContent))) {
      const amount = integer(power[1].replace(/,/g, ''));
      return amount ? { button, amount, signature: `watch:1:${amount}` } : null;
    }
    return null;
  }

  function createWatcher(options = {}) {
    const doc = options.document || globalThis.document;
    const location = options.location || globalThis.location;
    const fetchBalance = options.fetchBalance;
    const notify = typeof options.onStatus === 'function' ? options.onStatus : () => {};
    const timers = options.timerDeps || {};
    const later = timers.setTimeout || globalThis.setTimeout.bind(globalThis);
    const cancel = timers.clearTimeout || globalThis.clearTimeout.bind(globalThis);
    const now = timers.now || Date.now;
    const Observer = options.MutationObserver || globalThis.MutationObserver;
    const getStyle = options.getComputedStyle || globalThis.getComputedStyle;
    let running = false, enabled = options.enabled === true, generation = 0;
    let root = null, observer = null, heartbeat = null, scanTimer = null, clickTimer = null, verifyTimer = null;
    let request = null, pending = null, snapshot = null, nextBalanceAt = 0;
    const attempted = new Map();
    let state = { channelId: null, balance: null, status: 'disabled', lastClaimAt: null, message: '통나무 자동 수령 꺼짐' };

    function emit(patch) {
      const next = { ...state, ...patch };
      if (JSON.stringify(next) === JSON.stringify(state)) return;
      state = next;
      try { notify({ ...state }); } catch { /* A detached UI must not stop cancellation. */ }
    }

    function current(channelId, token = generation) {
      return running && token === generation && channelId === state.channelId && channelId === channelIdFromUrl(location);
    }

    const active = (channelId, token = generation) => enabled && current(channelId, token);

    function abortWork() {
      generation += 1;
      for (const timer of [scanTimer, clickTimer, verifyTimer]) if (timer !== null) cancel(timer);
      scanTimer = clickTimer = verifyTimer = null;
      pending = null;
      request?.controller.abort();
      request = null;
    }

    function resetChannel(channelId) {
      abortWork();
      snapshot = null;
      nextBalanceAt = 0;
      emit({ channelId, balance: null, lastClaimAt: null, status: !enabled ? 'disabled' : channelId ? 'watching' : 'unavailable',
        message: !enabled ? '통나무 자동 수령 꺼짐' : channelId ? '통나무 보상 버튼을 기다리는 중' : '치지직 생방송 페이지에서 사용할 수 있어요.' });
    }

    async function readBalance(channelId, token) {
      if (!current(channelId, token) || typeof fetchBalance !== 'function') return null;
      if (request) return request.promise;
      const controller = new AbortController();
      const work = { controller, promise: null };
      request = work;
      let timeout;
      const expiration = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('Balance canceled')), { once: true });
        timeout = later(() => { controller.abort(); reject(new Error('Balance timeout')); }, 8000);
      });
      work.promise = (async () => {
        try {
          const value = parseSnapshot(await Promise.race([fetchBalance(channelId, { signal: controller.signal }), expiration]));
          if (!current(channelId, token) || controller.signal.aborted) return null;
          snapshot = value;
          nextBalanceAt = now() + 60000;
          emit({ balance: value.balance, ...(state.status === 'unavailable' ? { status: 'watching', message: '통나무 보상 버튼을 기다리는 중' } : {}) });
          return value;
        } catch {
          if (current(channelId, token)) {
            snapshot = null;
            nextBalanceAt = now() + 60000;
            emit({ balance: null, status: enabled ? 'unavailable' : 'disabled', message: '통나무 보유량 확인 불가 · 로그인 상태를 확인해 주세요.' });
          }
          return null;
        } finally {
          cancel(timeout);
          if (request === work) request = null;
        }
      })();
      return work.promise;
    }

    function candidates() {
      if (!root?.isConnected) return [];
      return [...root.querySelectorAll(BUTTONS)].slice(0, 100).map(button => rewardButton(button, root, getStyle)).filter(Boolean);
    }

    function remember(key, signature) {
      attempted.set(key, { signature, absentAt: null });
      while (attempted.size > 128) attempted.delete(attempted.keys().next().value);
    }

    function verify(attempt, count = 0) {
      verifyTimer = later(async () => {
        verifyTimer = null;
        if (!active(attempt.channelId, attempt.token)) return;
        const after = await readBalance(attempt.channelId, attempt.token);
        if (!active(attempt.channelId, attempt.token)) return;
        const stillVisible = candidates().some(item => item.signature === attempt.signature);
        // A removed button alone could be a closed dialog, logout, or network error.
        // Require the previously eligible claim to disappear AND its amount to arrive.
        if (after && attempt.claim && !stillVisible && !after.watchClaims.some(claim => claim.id === attempt.claim.id) &&
            after.balance >= attempt.before.balance + attempt.claim.amount) {
          pending = null;
          emit({ status: 'claimed', lastClaimAt: now(), message: '통나무 보상 수령 후 보유량 갱신을 확인했어요.' });
        } else if (count < 2 && after) {
          verify(attempt, count + 1);
        } else {
          pending = null;
          emit({ status: after ? 'watching' : 'unavailable', message: '수령 버튼을 눌렀어요. 수령 결과는 치지직에서 확인해 주세요.' });
        }
      }, 2000);
    }

    function scheduleClick(candidate) {
      const channelId = state.channelId, token = generation;
      pending = { ...candidate, channelId, token };
      clickTimer = later(async () => {
        clickTimer = null;
        const scheduled = pending;
        if (!scheduled || !active(channelId, token)) return;
        // A fresh read avoids presenting an old account's or old page's balance.
        const before = await readBalance(channelId, token);
        if (!active(channelId, token) || pending !== scheduled) return;
        if (typeof fetchBalance === 'function' && !before) { pending = null; return; }
        const current = rewardButton(scheduled.button, root, getStyle);
        if (!current || current.signature !== scheduled.signature) { pending = null; return; }
        const claim = before?.watchClaims.find(item => item.amount === current.amount) || null;
        const key = `${channelId}:${claim ? `claim:${claim.id}` : `dom:${current.signature}`}`;
        if (attempted.has(key)) { pending = null; return; }
        remember(key, current.signature);
        remember(`${channelId}:dom:${current.signature}`, current.signature);
        emit({ status: 'claiming', message: '치지직 통나무 보상 버튼을 누르는 중' });
        try { current.button.click(); } catch {
          pending = null;
          emit({ status: 'unavailable', message: '통나무 수령 버튼을 처리하지 못했어요. 직접 수령해 주세요.' });
          return;
        }
        if (active(channelId, token)) verify({ ...scheduled, before, claim });
      }, 800);
    }

    function scan() {
      scanTimer = null;
      if (!active(state.channelId) || !state.channelId) return;
      if (state.status === 'unavailable' && now() < nextBalanceAt) return;
      const found = candidates();
      const signatures = new Set(found.map(item => item.signature));
      for (const [key, entry] of attempted) {
        if (!key.startsWith(`${state.channelId}:dom:`)) continue;
        if (signatures.has(entry.signature)) entry.absentAt = null;
        else if (entry.absentAt === null) entry.absentAt = now();
        else if (now() - entry.absentAt >= 60000) attempted.delete(key);
      }
      if (pending) return;
      const candidate = found.find(item => {
        const claim = snapshot?.watchClaims.find(value => value.amount === item.amount);
        return !attempted.has(`${state.channelId}:${claim ? `claim:${claim.id}` : `dom:${item.signature}`}`);
      });
      if (candidate) scheduleClick(candidate);
    }

    function queueScan() {
      if (running && enabled && scanTimer === null) scanTimer = later(scan, 2000);
    }

    function tick() {
      if (heartbeat !== null) cancel(heartbeat);
      heartbeat = null;
      if (!running) return;
      const channelId = channelIdFromUrl(location);
      if (channelId !== state.channelId) resetChannel(channelId);
      const nextRoot = enabled && channelId ? doc?.querySelector(ROOT) : null;
      if (nextRoot !== root) {
        observer?.disconnect();
        root = nextRoot;
        observer = root && Observer ? new Observer(queueScan) : null;
        observer?.observe(root, { childList: true, subtree: true, characterData: true, attributes: true,
          attributeFilter: ['disabled', 'hidden', 'inert', 'class', 'style', 'aria-hidden', 'aria-disabled', 'aria-label', 'type'] });
      }
      if (channelId) {
        if (now() >= nextBalanceAt) void readBalance(channelId, generation);
        if (enabled) queueScan();
      } else if (enabled && state.status !== 'unavailable') resetChannel(null);
      heartbeat = later(tick, 5000);
    }

    function deactivate(clearBalance = true) {
      const channelId = channelIdFromUrl(location);
      const channelChanged = channelId !== state.channelId;
      abortWork();
      if (heartbeat !== null) cancel(heartbeat);
      heartbeat = null;
      observer?.disconnect();
      observer = root = null;
      snapshot = null;
      nextBalanceAt = 0;
      emit({ channelId, ...(clearBalance || channelChanged ? { balance: null } : {}), status: 'disabled', lastClaimAt: null, message: '통나무 자동 수령 꺼짐' });
    }

    return {
      start() {
        if (running) return;
        running = true;
        resetChannel(channelIdFromUrl(location));
        tick();
        try { notify({ ...state }); } catch {}
      },
      setEnabled(value) {
        const next = value === true;
        if (next === enabled) return;
        enabled = next;
        if (!next) { deactivate(false); if (running) tick(); }
        else if (running) { resetChannel(channelIdFromUrl(location)); tick(); }
      },
      stop() { running = false; deactivate(); },
      getState() { return { ...state }; }
    };
  }

  return { channelIdFromUrl, balanceUrl, parseSnapshot, rewardButton, createWatcher };
});
