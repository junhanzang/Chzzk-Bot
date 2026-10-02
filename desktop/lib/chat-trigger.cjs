'use strict';

// Counts and message IDs live only in memory. Chat text is inspected once and
// discarded; neither transcripts nor author/account information is recorded.
class ChatTrigger {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.startedAt = null;
    this.buckets = new Map();
    this.seen = new Map();
  }

  observe(events, config, sourceReady = true) {
    const now = this.now();
    if (!sourceReady) { this.startedAt = null; this.buckets.clear(); this.seen.clear(); return null; }
    this.startedAt ??= now;
    for (const [id, at] of this.seen) if (now - at > 120000) this.seen.delete(id);
    for (const second of this.buckets.keys()) if (second < Math.floor(now / 1000) - 65) this.buckets.delete(second);
    let keyword = false, freshCount = 0;
    const keywords = config.keywords.map(value => value.toLocaleLowerCase());
    for (const event of events) {
      if (this.seen.has(event.id)) continue;
      freshCount++;
      this.seen.set(event.id, now);
      while (this.seen.size > 5000) this.seen.delete(this.seen.keys().next().value);
      const second = Math.floor(now / 1000);
      this.buckets.set(second, (this.buckets.get(second) || 0) + 1);
      if (keywords.some(value => event.text.toLocaleLowerCase().includes(value))) keyword = true;
    }
    if (now - this.startedAt >= 5000 && keyword) return 'keyword';
    if (!config.chatSpike || now - this.startedAt < 35000 || !freshCount) return null;
    const second = Math.floor(now / 1000);
    let recent = 0, baseline = 0;
    for (const [bucket, count] of this.buckets) {
      if (bucket > second - 5) recent += count;
      else if (bucket > second - 35) baseline += count;
    }
    // At least 15 new messages in five seconds, and 3x the previous 30s rate.
    return recent >= 15 && recent >= Math.max(1, baseline / 6) * 3 ? 'chat-spike' : null;
  }
}

function validateBatch(arg) {
  if (!arg || !Number.isInteger(arg.slotId) || arg.slotId < 0 || arg.slotId > 3 ||
      typeof arg.channelId !== 'string' || !/^[a-f\d]{32}$/.test(arg.channelId) ||
      typeof arg.generation !== 'string' || arg.generation.length > 100 ||
      !Array.isArray(arg.events) || arg.events.length > 100 ||
      !['watching', 'waiting'].includes(arg.sourceStatus)) throw new Error('채팅 감지 정보가 올바르지 않습니다.');
  for (const event of arg.events) if (!event || typeof event.id !== 'string' || !event.id || event.id.length > 128 ||
      typeof event.text !== 'string' || event.text.length > 500) throw new Error('채팅 감지 정보가 올바르지 않습니다.');
  return arg;
}

module.exports = { ChatTrigger, validateBatch };
