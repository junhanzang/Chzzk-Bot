'use strict';

const fs = require('node:fs');
const path = require('node:path');
const WORLD_ID = 1043;

function bootstrap(source, context, sequence) {
  return `${source}\n;(() => {
    if (globalThis.__deskChat?.sequence > ${sequence}) return;
    globalThis.__deskChat?.observer?.stop();
    const context = ${JSON.stringify(context)};
    const host = { sequence: ${sequence}, generation: context.generation, events: [], sourceStatus: 'waiting' };
    globalThis.__deskChat = host;
    if (location.origin !== 'https://chzzk.naver.com' || !new RegExp('^/live/' + context.channelId + '/?$').test(location.pathname)) return;
    host.observer = globalThis.DeskChat.createChatObserver({ document, MutationObserver,
      onMessages(events) { host.events.push(...events); if (host.events.length > 100) host.events.splice(0, host.events.length - 100); },
      onStatus(value) { host.sourceStatus = value.status === 'watching' ? 'watching' : 'waiting'; }
    });
    host.observer.start();
  })();`;
}

// Only bundled, read-only DOM code runs in the isolated world. There is no page
// IPC/Node/network bridge. Bounded batches are polled by the trusted host.
class ChatHost {
  constructor({ context, onBatch, onDetach = () => {}, source, intervalMs = 1000 }) {
    Object.assign(this, { context, onBatch, onDetach, intervalMs });
    this.source = source ?? fs.readFileSync(path.join(__dirname, '../../browser-extension/shared/chat-observer.js'), 'utf8');
    this.entries = new Map(); this.sequence = 0; this.closed = false;
    if (intervalMs) { this.timer = setInterval(() => this.tick(), intervalMs); this.timer.unref?.(); }
  }
  valid(entry) {
    if (this.closed || this.entries.get(entry.slotId) !== entry || entry.contents.isDestroyed()) return false;
    try {
      const url = new URL(entry.contents.getURL());
      return url.origin === 'https://chzzk.naver.com' && !url.username && !url.password &&
        new RegExp(`^/live/${entry.channelId}/?$`).test(url.pathname);
    } catch { return false; }
  }
  execute(entry, code) { return entry.contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]); }
  attach(slotId, contents, channelId) {
    this.detach(slotId);
    if (this.closed) return;
    const entry = { slotId, contents, channelId, generation: null, pending: false, sequence: ++this.sequence };
    this.entries.set(slotId, entry);
    return this.poll(entry);
  }
  async poll(entry) {
    if (entry.pending || !this.valid(entry)) return;
    entry.pending = true;
    try {
      const context = this.context(entry.slotId);
      if (!context || context.channelId !== entry.channelId) {
        if (entry.generation) {
          const generation = entry.generation; entry.generation = null;
          await this.execute(entry, `if (globalThis.__deskChat?.generation === ${JSON.stringify(generation)}) { globalThis.__deskChat.observer?.stop(); globalThis.__deskChat.events = []; }`);
        }
        return;
      }
      if (entry.generation !== context.generation) {
        entry.sequence = ++this.sequence;
        await this.execute(entry, bootstrap(this.source, context, entry.sequence));
        if (!this.valid(entry)) return;
        entry.generation = context.generation;
      }
      const result = await this.execute(entry, `(() => {
        const host = globalThis.__deskChat;
        if (host?.generation !== ${JSON.stringify(context.generation)}) return null;
        return { events: host.events.splice(0, 100), sourceStatus: host.sourceStatus };
      })()`);
      if (!this.valid(entry) || this.context(entry.slotId)?.generation !== context.generation) return;
      if (result) this.onBatch({ ...context, ...result });
    } catch { /* Navigation/source changes are shown as a missing heartbeat. */ }
    finally { entry.pending = false; }
  }
  tick() { for (const entry of this.entries.values()) void this.poll(entry); }
  detach(slotId) {
    const entry = this.entries.get(slotId);
    this.entries.delete(slotId);
    if (!entry) return;
    this.onDetach(slotId);
    if (!entry.contents.isDestroyed()) {
      const sequence = ++this.sequence;
      void this.execute(entry, `if (!globalThis.__deskChat || globalThis.__deskChat.sequence <= ${sequence}) {
        globalThis.__deskChat?.observer?.stop(); globalThis.__deskChat = { sequence: ${sequence}, events: [] };
      }`).catch(() => {});
    }
  }
  close() { this.closed = true; clearInterval(this.timer); for (const slotId of this.entries.keys()) this.detach(slotId); }
}

module.exports = { ChatHost, bootstrap, WORLD_ID };
