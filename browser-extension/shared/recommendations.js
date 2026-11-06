'use strict';

// Local, explainable ranking. No platform APIs, network, identifiers other than
// channel IDs, or message text enter the activity document.
((root, factory) => {
  const model = factory();
  root.DeskRecommendations = model;
  if (typeof module === 'object' && module.exports) module.exports = model;
})(globalThis, () => {
  const DAY = 86400000, HALF_LIFE_MS = 14 * DAY, VISIT_INTERVAL_MS = 10 * 60000;
  const MAX_CHANNELS = 2000, CHANNEL_ID = /^[a-f\d]{32}$/i;
  const COUNTER_LIMITS = Object.freeze({ visits: 1000000, watchSeconds: 1000000000, chatCount: 10000000 });
  const ACTIVITY_LIMITS = Object.freeze({ watchSeconds: 120, chatCount: 100 });
  const ACTIVITY_CHANNEL_LIMIT = 500, CHAT_INTERVAL_MS = 30000;
  const MODES = Object.freeze(['recommended', 'frequent', 'live', 'name']);
  const MODE_LABELS = Object.freeze({ recommended: '추천순', frequent: '자주 보는 순', live: '방송 중 우선', name: '이름순' });
  const text = (value, length) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, length) : '';
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const counter = (value, limit) => Number.isFinite(value) && value > 0 ? Math.min(value, limit) : 0;
  const timestamp = (value, now) => Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), now) : null;
  const time = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  const validId = value => typeof value === 'string' && CHANNEL_ID.test(value) ? value.toLowerCase() : null;
  const round = value => Math.round(value * 100) / 100;

  function normalizeHistory(raw, { now = Date.now() } = {}) {
    now = time(now);
    const channels = {}, source = object(raw?.channels) ? raw.channels : {};
    const records = [];
    for (const key of Object.keys(source).slice(0, MAX_CHANNELS * 4)) {
      const id = validId(key), value = source[key];
      if (!id || !object(value)) continue;
      const updatedAt = timestamp(value.updatedAt, now);
      if (updatedAt === null) continue;
      const counts = {}, recent = {};
      for (const field of Object.keys(COUNTER_LIMITS)) {
        counts[field] = Math.floor(counter(value[field], COUNTER_LIMITS[field]));
        recent[field] = counter(object(value.recent) ? value.recent[field] : counts[field], counts[field]);
      }
      if (!Object.values(counts).some(Boolean)) continue;
      records.push([id, { ...counts, recent, updatedAt,
        lastVisitAt: counts.visits ? timestamp(value.lastVisitAt, updatedAt) : null }]);
    }
    records.sort((a, b) => b[1].updatedAt - a[1].updatedAt || a[0].localeCompare(b[0]));
    for (const [id, record] of records.slice(0, MAX_CHANNELS)) if (!Object.hasOwn(channels, id)) channels[id] = record;
    return { version: 1, channels };
  }

  function recentAt(record, now) {
    const factor = 2 ** (-Math.max(0, now - record.updatedAt) / HALF_LIFE_MS);
    return Object.fromEntries(Object.keys(COUNTER_LIMITS).map(field => [field, record.recent[field] * factor]));
  }

  /** Aggregate concurrent video/chat views into one real-time budget per channel. */
  class ActivityBudget {
    constructor({ clock = Date.now } = {}) {
      if (typeof clock !== 'function') throw new TypeError('이용 기록 시계를 확인해 주세요.');
      this.clock = clock; this.channels = new Map(); this.lastClock = null;
    }

    accept(channelId, { watchSeconds = 0, chatCount = 0 } = {}) {
      const id = validId(channelId), now = this.clock();
      if (!id) throw new TypeError('이용 기록의 채널 ID를 확인해 주세요.');
      if (![watchSeconds, chatCount].every(value => Number.isFinite(value) && value >= 0) || !Number.isInteger(chatCount)) {
        throw new TypeError('시청 시간과 채팅 횟수를 확인해 주세요.');
      }
      if (!Number.isSafeInteger(now) || now < 0 || (this.lastClock !== null && now < this.lastClock)) {
        throw new TypeError('이용 기록 시계를 확인해 주세요.');
      }
      this.lastClock = now;
      if (!watchSeconds && !chatCount) return { watchSeconds: 0, chatCount: 0 };
      const previous = this.channels.get(id) || { watchAt: null, chatAt: null };
      const watchBudget = previous.watchAt === null ? 30 : Math.floor((now - previous.watchAt) / 1000);
      const accepted = {
        watchSeconds: Math.min(Math.floor(watchSeconds), watchBudget, ACTIVITY_LIMITS.watchSeconds),
        chatCount: chatCount > 0 && (previous.chatAt === null || now - previous.chatAt >= CHAT_INTERVAL_MS) ? 1 : 0
      };
      // A chat-only popup must not consume the video's accumulated watch time.
      if (accepted.watchSeconds > 0) previous.watchAt = now;
      if (accepted.chatCount > 0) previous.chatAt = now;
      this.channels.delete(id); this.channels.set(id, previous);
      if (this.channels.size > ACTIVITY_CHANNEL_LIMIT) this.channels.delete(this.channels.keys().next().value);
      return accepted;
    }

    reset() { this.channels.clear(); this.lastClock = null; }
  }

  class ActivityHistory {
    constructor({ initial, persist = async () => {}, onChange = () => {}, clock = Date.now } = {}) {
      if (![persist, onChange, clock].every(value => typeof value === 'function')) throw new TypeError('이용 기록 연결을 확인해 주세요.');
      this.persist = persist; this.onChange = onChange; this.clock = clock;
      this.state = normalizeHistory(initial, { now: time(clock()) });
      this.revision = 0; this.savedRevision = 0; this.pending = null;
    }

    snapshot() { return normalizeHistory(this.state, { now: time(this.clock()) }); }

    restore(raw) {
      if (this.pending || this.savedRevision !== this.revision) throw new Error('이용 기록 저장을 마친 뒤 다시 불러와 주세요.');
      this.state = normalizeHistory(raw, { now: time(this.clock()) });
      return this.snapshot();
    }

    schedule() {
      if (this.pending || this.savedRevision === this.revision) return;
      // A single writer coalesces heartbeats. A clear made during an older save
      // is necessarily written afterwards, so late writes cannot resurrect it.
      let succeeded = false;
      const operation = Promise.resolve().then(async () => {
        while (this.savedRevision !== this.revision) {
          const revision = this.revision, value = this.snapshot();
          await this.persist(value);
          this.savedRevision = revision;
        }
        succeeded = true;
      }).finally(() => {
        if (this.pending === operation) {
          this.pending = null;
          // A mutation may run in the microtask between the writer returning
          // and this cleanup. Drain it too, but never loop on storage failure.
          if (succeeded && this.savedRevision !== this.revision) this.schedule();
        }
      });
      this.pending = operation;
      operation.catch(() => {}); // flush() reports failures; background writes never reject unhandled.
    }

    changed() {
      this.revision++; this.schedule();
      const value = this.snapshot();
      try { this.onChange(value); } catch { /* An observer never owns persistence. */ }
      return this.snapshot();
    }

    record(id, delta, visit) {
      id = validId(id);
      if (!id) throw new TypeError('이용 기록의 채널 ID를 확인해 주세요.');
      const now = time(this.clock()), old = this.state.channels[id];
      if (visit && old?.lastVisitAt !== null && old?.lastVisitAt !== undefined && now - old.lastVisitAt < VISIT_INTERVAL_MS) return this.snapshot();
      if (!Object.values(delta).some(Boolean)) return this.snapshot();
      const previous = old || { visits: 0, watchSeconds: 0, chatCount: 0,
        recent: { visits: 0, watchSeconds: 0, chatCount: 0 }, updatedAt: now, lastVisitAt: null };
      const recent = recentAt(previous, now), next = { ...previous, recent, updatedAt: now,
        lastVisitAt: visit ? now : previous.lastVisitAt };
      for (const field of Object.keys(COUNTER_LIMITS)) {
        const increment = delta[field] || 0;
        next[field] = Math.min(COUNTER_LIMITS[field], previous[field] + increment);
        recent[field] = Math.min(COUNTER_LIMITS[field], recent[field] + increment);
      }
      this.state.channels[id] = next;
      this.state = normalizeHistory(this.state, { now });
      return this.changed();
    }

    recordVisit(id) { return this.record(id, { visits: 1 }, true); }

    recordActivity(id, { watchSeconds = 0, chatCount = 0 } = {}) {
      if (![watchSeconds, chatCount].every(value => Number.isFinite(value) && value >= 0) || !Number.isInteger(chatCount)) {
        throw new TypeError('시청 시간과 채팅 횟수를 확인해 주세요.');
      }
      return this.record(id, { watchSeconds: Math.min(ACTIVITY_LIMITS.watchSeconds, Math.floor(watchSeconds)),
        chatCount: Math.min(ACTIVITY_LIMITS.chatCount, chatCount) }, false);
    }

    clear() { this.state = { version: 1, channels: {} }; return this.changed(); }

    async flush() {
      while (this.savedRevision !== this.revision || this.pending) {
        this.schedule();
        if (this.pending) await this.pending;
      }
    }
  }

  function categoryKey(value) {
    if (!object(value)) return null;
    const id = text(value.id, 200), type = text(value.type, 32).toUpperCase();
    return id && type ? JSON.stringify([type, id]) : null;
  }

  function rankChannels(channels, { categories = [], history, mode = 'recommended', now = Date.now() } = {}) {
    now = time(now);
    if (!MODES.includes(mode)) mode = 'recommended';
    const records = normalizeHistory(history, { now }).channels;
    const preferred = new Set((Array.isArray(categories) ? categories : []).slice(0, MAX_CHANNELS).map(categoryKey).filter(Boolean));
    const names = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
    const ranked = (Array.isArray(channels) ? channels : []).slice(0, MAX_CHANNELS).filter(channel => validId(channel?.id)).map((channel, index) => {
      const record = records[validId(channel.id)];
      const recent = record ? recentAt(record, now) : { visits: 0, watchSeconds: 0, chatCount: 0 };
      const category = preferred.has(categoryKey(channel.category));
      const signals = { category: mode === 'recommended' && category ? 30 : 0,
        visits: round(8 * Math.log2(1 + recent.visits)),
        watch: round(12 * Math.log2(1 + recent.watchSeconds / 600)),
        chat: round(Math.min(15, 4 * Math.log2(1 + recent.chatCount))) };
      const reasons = [];
      if (channel.pinned === true) reasons.push('고정한 채널');
      if (signals.category) reasons.push('팔로우한 카테고리');
      const activity = [
        { score: signals.visits, reason: recent.visits >= 2 ? '자주 여는 방송' : '최근에 연 방송' },
        { score: signals.watch, reason: '오래 본 방송' },
        { score: signals.chat, reason: '채팅 참여' }
      ].filter(signal => signal.score >= 1).sort((a, b) => b.score - a.score);
      reasons.push(...activity.map(signal => signal.reason));
      if (!reasons.length) reasons.push(channel.live === true ? '지금 방송 중' : '팔로우한 채널');
      const score = round(Object.values(signals).reduce((sum, value) => sum + value, 0));
      return { channel, index, recommendation: { score, reasons: reasons.slice(0, 3), signals } };
    });
    ranked.sort((a, b) => Number(b.channel.pinned === true) - Number(a.channel.pinned === true) ||
      Number(b.channel.live === true) - Number(a.channel.live === true) ||
      (mode === 'name' ? names.compare(text(a.channel.name, 100), text(b.channel.name, 100)) :
        mode === 'live' ? 0 : b.recommendation.score - a.recommendation.score) || a.index - b.index);
    return ranked.map(({ channel, recommendation }) => ({ ...channel, recommendation }));
  }

  return Object.freeze({ ActivityHistory, ActivityBudget, normalizeHistory, rankChannels, MODES, MODE_LABELS,
    MAX_CHANNELS, HALF_LIFE_MS, VISIT_INTERVAL_MS, COUNTER_LIMITS, ACTIVITY_LIMITS, ACTIVITY_CHANNEL_LIMIT, CHAT_INTERVAL_MS });
});
