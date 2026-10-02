'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validSlot } = require('./channels.cjs');
const WORLD_ID = 1042;
const STATUSES = new Set(['disabled', 'watching', 'claiming', 'claimed', 'unavailable']);

function sanitizeStatus(value, channelId, enabled) {
  if (!value || value.channelId !== channelId) return { channelId, balance: null, status: enabled ? 'watching' : 'disabled' };
  return { channelId,
    balance: Number.isSafeInteger(value.balance) && value.balance >= 0 ? value.balance : null,
    status: STATUSES.has(value.status) ? value.status : 'unavailable',
    ...(Number.isSafeInteger(value.lastClaimAt) && value.lastClaimAt > 0 ? { lastClaimAt: value.lastClaimAt } : {}),
    ...(typeof value.message === 'string' ? { message: value.message.replace(/[\x00-\x1f]/g, '').slice(0, 180) } : {}) };
}

// Runs only bundled code in a separate JavaScript world. The remote page receives
// no Node API, IPC, clipboard, app token, or arbitrary network/file command bridge.
function bootstrap(source, channelId, enabled, generation) {
  return `${source}\n;(() => {
    const channelId = ${JSON.stringify(channelId)};
    if (location.origin !== 'https://chzzk.naver.com' || !new RegExp('^/live/' + channelId + '/?$').test(location.pathname) ||
        globalThis.__deskRewards?.generation >= ${JSON.stringify(generation)}) return;
    globalThis.__deskRewards?.watcher.stop();
    const host = { generation: ${JSON.stringify(generation)}, status: { channelId, balance: null, status: 'disabled' }, requests: new Map(), nextId: 0 };
    globalThis.__deskRewards = host;
    host.watcher = globalThis.DeskRewards.createWatcher({ document, location, enabled: ${enabled === true},
      fetchBalance(id, { signal } = {}) {
        if (id !== channelId || location.origin !== 'https://chzzk.naver.com' ||
            !new RegExp('^/live/' + channelId + '/?$').test(location.pathname)) throw new Error('방송이 변경되었습니다.');
        return new Promise((resolve, reject) => {
          if (signal?.aborted) { reject(new Error('요청이 취소되었습니다.')); return; }
          const requestId = ++host.nextId;
          let timeout;
          const done = (value, error) => {
            clearTimeout(timeout); signal?.removeEventListener('abort', cancel); host.requests.delete(requestId);
            if (error) reject(new Error(error)); else resolve(value);
          };
          const cancel = () => done(null, '요청이 취소되었습니다.');
          timeout = setTimeout(() => done(null, '통나무 조회 시간이 초과되었습니다.'), 15000);
          signal?.addEventListener('abort', cancel, { once: true });
          host.requests.set(requestId, { id: requestId, done });
        });
      },
      onStatus(value) { host.status = value; }
    });
    host.watcher.start();
  })();`;
}

class RewardsHost {
  constructor({ enabled = false, onChange = () => {}, fetchImpl, source, intervalMs = 2000 } = {}) {
    this.enabled = enabled === true;
    this.onChange = onChange;
    this.fetchImpl = fetchImpl;
    this.source = source ?? fs.readFileSync(path.join(__dirname, '../../browser-extension/shared/rewards.js'), 'utf8');
    this.entries = new Map();
    this.intervalMs = intervalMs;
    this.timer = null;
    this.closed = false;
    this.generation = 0;
  }

  valid(entry) {
    return !this.closed && this.entries.get(entry.slotId) === entry && !entry.contents.isDestroyed() &&
      (() => { try { const url = new URL(entry.contents.getURL());
        return url.origin === 'https://chzzk.naver.com' && !url.username && !url.password &&
          (url.pathname === `/live/${entry.channelId}` || url.pathname === `/live/${entry.channelId}/`);
      } catch { return false; } })();
  }

  execute(entry, code) {
    if (!this.valid(entry)) return Promise.reject(new Error('방송이 변경되었습니다.'));
    return entry.contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]);
  }

  async attach(slotId, contents, channelId) {
    validSlot(slotId);
    if (this.closed || !/^[a-f\d]{32}$/.test(channelId)) return;
    this.detach(slotId);
    const entry = { slotId, contents, channelId, generation: ++this.generation, pending: false,
      status: sanitizeStatus(null, channelId, this.enabled) };
    this.entries.set(slotId, entry);
    try {
      await this.execute(entry, bootstrap(this.source, channelId, this.enabled, entry.generation));
      if (!this.valid(entry)) return;
      await this.execute(entry, `if (globalThis.__deskRewards?.generation === ${entry.generation}) globalThis.__deskRewards.watcher.setEnabled(${this.enabled});`);
      await this.poll(entry);
    } catch { if (this.valid(entry)) this.update(entry, { channelId, balance: null, status: 'unavailable', message: '통나무 상태를 확인하지 못했어요. 방송을 새로고침해 주세요.' }); }
    if (!this.closed && !this.timer && this.entries.size) {
      this.timer = setInterval(() => { for (const item of this.entries.values()) void this.poll(item); }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  update(entry, value) {
    if (!this.valid(entry)) return;
    const status = sanitizeStatus(value, entry.channelId, this.enabled);
    if (JSON.stringify(status) !== JSON.stringify(entry.status)) { entry.status = status; this.onChange(); }
  }

  async poll(entry) {
    if (entry.pending || !this.valid(entry)) return;
    entry.pending = true;
    try {
      const result = await this.execute(entry, `(() => { const host = globalThis.__deskRewards;
        return host?.generation === ${entry.generation} ? { status: host.status, requestId: host.requests.keys().next().value ?? null } : null; })()`);
      this.update(entry, result?.status);
      if (Number.isSafeInteger(result?.requestId) && result.requestId > 0) await this.balance(entry, result.requestId);
    }
    catch { this.update(entry, { channelId: entry.channelId, balance: null, status: 'unavailable', message: '통나무 상태를 확인하지 못했어요.' }); }
    finally { entry.pending = false; }
  }

  async balance(entry, requestId) {
    if (!this.valid(entry)) return;
    const controller = new AbortController();
    entry.request = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    let result = null, error = null;
    try {
      const response = await this.fetchImpl(`https://api.chzzk.naver.com/service/v1/channels/${entry.channelId}/log-power`, {
        method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', Referer: 'https://chzzk.naver.com/', Origin: 'https://chzzk.naver.com' }
      });
      if (!response.ok) throw new Error('unavailable');
      const body = await response.json();
      if (body.code !== 200 || !Number.isSafeInteger(body.content?.amount) || body.content.amount < 0) throw new Error('unavailable');
      result = { code: 200, content: { amount: body.content.amount,
        claims: (Array.isArray(body.content.claims) ? body.content.claims : []).slice(0, 100).map(claim => ({
          claimId: typeof claim?.claimId === 'string' ? claim.claimId.slice(0, 200) : Number.isSafeInteger(claim?.claimId) ? claim.claimId : '',
          claimType: typeof claim?.claimType === 'string' ? claim.claimType.slice(0, 40) : '',
          state: typeof claim?.state === 'string' ? claim.state.slice(0, 40) : '',
          saveType: typeof claim?.saveType === 'string' ? claim.saveType.slice(0, 40) : '',
          amount: Number.isSafeInteger(claim?.amount) && claim.amount >= 0 ? claim.amount : 0
        })) } };
    } catch { error = '통나무 보유량을 확인하지 못했어요. 로그인 상태를 확인해 주세요.'; }
    finally { clearTimeout(timeout); if (entry.request === controller) entry.request = null; }
    if (this.valid(entry)) await this.execute(entry,
      `if (globalThis.__deskRewards?.generation === ${entry.generation}) globalThis.__deskRewards.requests.get(${requestId})?.done(${JSON.stringify(result)}, ${JSON.stringify(error)});`);
  }

  async setEnabled(enabled) {
    this.enabled = enabled === true;
    await Promise.all([...this.entries.values()].map(async entry => {
      entry.request?.abort();
      try { await this.execute(entry, `if (globalThis.__deskRewards?.generation === ${entry.generation}) globalThis.__deskRewards.watcher.setEnabled(${this.enabled});`); await this.poll(entry); }
      catch { this.update(entry, { channelId: entry.channelId, balance: null, status: 'unavailable' }); }
    }));
  }

  status(slotId) { return this.entries.get(slotId)?.status || null; }

  detach(slotId) {
    const entry = this.entries.get(slotId);
    entry?.request?.abort();
    if (entry && !entry.contents.isDestroyed()) {
      // Stopping is harmless even after navigation; no callback can publish after deletion.
      entry.contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code:
        `if (globalThis.__deskRewards?.generation === ${entry.generation}) { globalThis.__deskRewards.watcher.stop(); delete globalThis.__deskRewards; }` }]).catch(() => {});
    }
    this.entries.delete(slotId);
    if (!this.entries.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  close() { this.closed = true; for (const slotId of this.entries.keys()) this.detach(slotId); }
}

module.exports = { RewardsHost, sanitizeStatus, bootstrap, WORLD_ID };
