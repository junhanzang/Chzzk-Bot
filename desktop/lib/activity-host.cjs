'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { activityPage } = require('../../browser-extension/shared/activity-observer.js');
const WORLD_ID = 1044;

function bootstrap(source, entry) {
  return `${source}\n;(() => {
    if (globalThis.__deskActivity?.epoch > ${entry.epoch}) return;
    globalThis.__deskActivity?.observer?.stop();
    const host = { epoch: ${entry.epoch}, generation: ${JSON.stringify(entry.generation)} };
    globalThis.__deskActivity = host;
    if (!globalThis.DeskActivity.activityPage(location, ${JSON.stringify(entry.channelId)})) return;
    host.observer = globalThis.DeskActivity.createActivityObserver({ document, location, channelId: ${JSON.stringify(entry.channelId)} });
    host.observer.start();
  })();`;
}

// No Node/IPC/network capability is exposed inside the observer's isolated world.
class ActivityHost {
  constructor({ onActivity = () => {}, source, intervalMs = 5000, clock = Date.now } = {}) {
    this.onActivity = onActivity; this.clock = clock;
    this.source = source ?? fs.readFileSync(path.join(__dirname, '../../browser-extension/shared/activity-observer.js'), 'utf8');
    this.entries = new Map(); this.epoch = 0; this.closed = false;
    if (intervalMs) { this.timer = setInterval(() => this.tick(), intervalMs); this.timer.unref?.(); }
  }
  valid(entry) {
    return !this.closed && this.entries.get(entry.key) === entry && !entry.contents.isDestroyed() &&
      activityPage(entry.contents.getURL(), entry.channelId) && entry.contents.getURL() === entry.url;
  }
  execute(entry, code) { return entry.contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]); }
  attach(key, contents, channelId) {
    this.detach(key);
    if (this.closed || contents.isDestroyed() || !activityPage(contents.getURL(), channelId)) return;
    const entry = { key, contents, channelId, url: contents.getURL(), generation: randomUUID(), epoch: ++this.epoch,
      pending: false, installed: false, sequence: 0, lastAt: this.clock(), chatAt: null };
    this.entries.set(key, entry);
    return this.poll(entry);
  }
  async poll(entry) {
    if (entry.pending || !this.valid(entry)) return;
    entry.pending = true;
    try {
      if (!entry.installed) {
        await this.execute(entry, bootstrap(this.source, entry));
        if (!this.valid(entry)) return;
        entry.installed = true; entry.lastAt = this.clock();
      }
      const result = await this.execute(entry, `(() => {
        const host = globalThis.__deskActivity;
        return host?.generation === ${JSON.stringify(entry.generation)} ? host.observer?.drain() : null;
      })()`);
      if (!this.valid(entry)) return;
      const now = this.clock(), elapsed = Math.max(0, (now - entry.lastAt) / 1000); entry.lastAt = now;
      if (!result || !Number.isInteger(result.watchSeconds) || result.watchSeconds < 0 || result.watchSeconds > 60 ||
          !Number.isInteger(result.chatCount) || result.chatCount < 0 || result.chatCount > 2) return;
      const watchSeconds = activityPage(entry.url, entry.channelId) === 'live' ? Math.min(result.watchSeconds, Math.ceil(elapsed), 60) : 0;
      const chatCount = result.chatCount && (entry.chatAt === null || now - entry.chatAt >= 30000) ? 1 : 0;
      if (chatCount) entry.chatAt = now;
      if (watchSeconds || chatCount) await this.onActivity({ key: entry.key, channelId: entry.channelId,
        generation: entry.generation, sequence: ++entry.sequence, watchSeconds, chatCount });
    } catch { /* Navigation/closed documents safely lose only the unfinished delta. */ }
    finally { entry.pending = false; }
  }
  tick() { for (const entry of this.entries.values()) void this.poll(entry); }
  reset() {
    if (this.closed) return Promise.resolve();
    const entries = [...this.entries.values()];
    for (const entry of entries) this.detach(entry.key);
    return Promise.all(entries.map(entry => this.attach(entry.key, entry.contents, entry.channelId)));
  }
  detach(key) {
    const entry = this.entries.get(key); this.entries.delete(key);
    if (!entry || entry.contents.isDestroyed()) return;
    const epoch = ++this.epoch;
    try {
      Promise.resolve(this.execute(entry, `if (!globalThis.__deskActivity || globalThis.__deskActivity.epoch <= ${epoch}) {
        globalThis.__deskActivity?.observer?.stop(); globalThis.__deskActivity = { epoch: ${epoch} };
      }`)).catch(() => {});
    } catch { /* The document can be destroyed between the check and execution. */ }
  }
  close() { this.closed = true; clearInterval(this.timer); for (const key of this.entries.keys()) this.detach(key); }
}
module.exports = { ActivityHost, bootstrap, WORLD_ID };
