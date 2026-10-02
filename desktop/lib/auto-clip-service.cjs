'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { ChatTrigger, validateBatch } = require('./chat-trigger.cjs');
const { SLOT_IDS, normalizeAutoClipConfig } = require('./channels.cjs');

const PRE_SECONDS = 20, POST_SECONDS = 10, COOLDOWN_MS = 120000, MAX_PER_HOUR = 10;

// This service owns detection and pending ranges, never page objects or files.
// The recorder's media clock, rather than a wall-clock delay, completes a range.
class AutoClipService extends EventEmitter {
  constructor({ recordings, assignment, config, save, isBusy = () => false, now = Date.now, intervalMs = 1000 }) {
    super();
    Object.assign(this, { recordings, assignment, config, save, isBusy, now });
    this.entries = new Map(); this.limits = new Map(); this.closed = false;
    this.lastSnapshot = '';
    this.onRecordingChange = () => this.tick();
    recordings.on('change', this.onRecordingChange);
    if (intervalMs) { this.timer = setInterval(() => this.tick(), intervalMs); this.timer.unref?.(); }
  }

  reconcile(slotId) {
    const { channelId } = this.assignment(slotId);
    const config = normalizeAutoClipConfig(this.config(channelId));
    const mark = !this.closed && config.enabled ? this.recordings.mark?.(slotId) : null;
    let entry = this.entries.get(slotId);
    if (!mark || mark.channelId !== channelId) { this.entries.delete(slotId); return null; }
    const key = JSON.stringify(config);
    if (!entry || entry.recording !== mark.generation || entry.channelId !== channelId || entry.key !== key) {
      entry = { slotId, channelId, generation: randomUUID(), recording: mark.generation, key, config,
        detector: new ChatTrigger({ now: this.now }), sourceAt: null, sourceStatus: 'waiting', pending: null,
        saving: false, savedCount: 0, error: null };
      this.entries.set(slotId, entry);
    }
    entry.mark = mark;
    return entry;
  }

  state(slotId) {
    const { channelId } = this.assignment(slotId), config = normalizeAutoClipConfig(this.config(channelId));
    const entry = this.entries.get(slotId);
    const base = { slotId, channelId, generation: entry?.generation || null, savedCount: entry?.savedCount || 0 };
    const result = (status, message) => ({ ...base, status, message });
    if (!config.enabled || !channelId) return result('disabled', '자동 저장 꺼짐');
    if (!entry) return result('needs-buffer', '최근 구간 보관을 켜 주세요.');
    if (entry.saving) return result('saving', '자동 클립 파일을 저장하고 있어요.');
    if (entry.pending) return result('pending', '감지한 장면 뒤의 영상 10초를 기다리고 있어요.');
    if (entry.error) return result('error', entry.error);
    if (entry.sourceAt === null || this.now() - entry.sourceAt > 15000 || entry.sourceStatus !== 'watching') {
      return result('waiting', '방송의 채팅창을 열어 주세요. 새 채팅만 감지합니다.');
    }
    if (entry.mark.end - entry.mark.start < PRE_SECONDS) return result('warming', '앞부분 영상 20초를 모으고 있어요.');
    const limit = this.limit(entry.channelId);
    if (limit.at.length >= MAX_PER_HOUR) return result('cooldown', '자동 저장은 채널마다 시간당 최대 10개입니다.');
    if (this.now() < limit.nextAt) return result('cooldown', '중복 장면 방지를 위해 2분 간격으로 저장합니다.');
    if (config.chatSpike && this.now() - (entry.detector.startedAt ?? this.now()) < 35000) return result('warming', '채팅 급증 기준을 모으고 있어요.');
    return result('watching', '새 채팅에서 설정한 반응을 감지하고 있어요.');
  }

  snapshot() { return SLOT_IDS.map(slotId => this.state(slotId)); }
  context(slotId) {
    const entry = this.reconcile(slotId);
    return entry ? { slotId, channelId: entry.channelId, generation: entry.generation } : null;
  }
  limit(channelId) {
    const limit = this.limits.get(channelId) || { at: [], nextAt: 0 };
    limit.at = limit.at.filter(at => this.now() - at < 3600000);
    this.limits.set(channelId, limit);
    return limit;
  }
  publish() {
    const snapshot = JSON.stringify(this.snapshot());
    if (snapshot !== this.lastSnapshot) { this.lastSnapshot = snapshot; this.emit('change'); }
  }

  submit(arg) {
    validateBatch(arg);
    const entry = this.reconcile(arg.slotId);
    if (!entry || entry.channelId !== arg.channelId || entry.generation !== arg.generation) return { accepted: false };
    // After a disconnected/hidden source returns, collect a new baseline.
    if (entry.sourceAt !== null && this.now() - entry.sourceAt > 15000) entry.detector = new ChatTrigger({ now: this.now });
    entry.sourceAt = this.now(); entry.sourceStatus = arg.sourceStatus;
    const trigger = entry.detector.observe(arg.events, entry.config, arg.sourceStatus === 'watching');
    const limit = this.limit(entry.channelId);
    if (trigger && !entry.pending && !entry.saving && !this.isBusy(entry.slotId) &&
        entry.mark.end - entry.mark.start >= PRE_SECONDS && this.now() >= limit.nextAt && limit.at.length < MAX_PER_HOUR) {
      entry.error = null;
      entry.pending = { generation: entry.recording, start: entry.mark.end - PRE_SECONDS,
        end: entry.mark.end + POST_SECONDS, trigger, expiresAt: this.now() + 45000 };
      limit.nextAt = this.now() + COOLDOWN_MS; limit.at.push(this.now());
    }
    this.tick();
    return { accepted: true };
  }

  tick() {
    if (this.closed) return;
    for (const slotId of SLOT_IDS) {
      const entry = this.reconcile(slotId), pending = entry?.pending;
      if (!pending || entry.saving) continue;
      if (this.now() > pending.expiresAt || entry.mark.start > pending.start + 0.01) {
        entry.pending = null; entry.error = '영상이 충분히 모이지 않아 이번 자동 저장을 건너뛰었어요.';
      } else if (entry.mark.end >= pending.end && !this.isBusy(slotId)) {
        entry.pending = null; entry.saving = true;
        Promise.resolve().then(() => {
          // Settings, channel and recording can change before the microtask runs.
          if (this.closed || this.reconcile(slotId) !== entry) return null;
          return this.save(slotId, pending, pending.trigger);
        }).then(record => { if (record) entry.savedCount++; })
          .catch(() => { entry.error = '자동 저장에 실패했어요. 보관 상태와 저장 폴더를 확인해 주세요.'; })
          .finally(() => { entry.saving = false; this.publish(); });
      }
    }
    this.publish();
  }

  reset(slotId) { this.entries.delete(slotId); this.publish(); }
  close() {
    this.closed = true; clearInterval(this.timer);
    this.recordings.removeListener('change', this.onRecordingChange);
    this.entries.clear();
  }
}

module.exports = { AutoClipService, PRE_SECONDS, POST_SECONDS, COOLDOWN_MS, MAX_PER_HOUR };
