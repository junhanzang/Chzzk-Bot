'use strict';

// Pure presentation helpers shared by the app and extension. DOM ownership and
// privileged actions stay in each client. This file never reads storage or URLs.
((root, factory) => {
  const channels = typeof module === 'object' && module.exports ? require('./channels.js') : root.DeskChannels;
  const presentation = factory(channels);
  root.DeskPresentation = presentation;
  if (typeof module === 'object' && module.exports) module.exports = presentation;
})(globalThis, channels => {
  const clipSeconds = channels.normalizeClipSeconds;
  const searchable = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('ko-KR').trim();
  const terms = query => searchable(query).split(/\s+/).filter(Boolean);
  const matches = (values, queryTerms) => {
    const haystack = values.map(searchable).join(' ');
    return queryTerms.every(term => haystack.includes(term));
  };
  const timestamp = value => {
    const parsed = value ? new Date(value).valueOf() : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };

  function filterChannels(items, query = '') {
    const queryTerms = terms(query);
    return items.filter(item => matches([item.name, item.id], queryTerms));
  }

  function filterClips(items, query = '', favorites = []) {
    const queryTerms = terms(query);
    const names = new Map(favorites.map(item => [item.id, item.name]));
    return items.filter(item => matches([item.title, item.fileName, item.channelId, names.get(item.channelId)], queryTerms))
      .sort((a, b) => (timestamp(b.createdAt) ?? -Infinity) - (timestamp(a.createdAt) ?? -Infinity));
  }

  function resultCount(filtered, total, query) {
    return terms(query).length ? `${filtered} / ${total}` : String(total);
  }

  function formatClipMeta(clip) {
    const time = timestamp(clip.createdAt);
    const when = time === null ? '' : new Date(time).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const duration = Number(clip.duration);
    const length = Number.isFinite(duration) && duration > 0 ? `약 ${Math.max(1, Math.round(duration))}초` : '';
    return [when, length].filter(Boolean).join(' · ');
  }

  function saveLabel(value, { compact = false, saving = false } = {}) {
    if (saving) return compact ? '저장 중…' : '클립 저장 중…';
    return `${compact ? '' : '최근 '}약 ${clipSeconds(value)}초 저장`;
  }
  function saveNote(value, bufferedSeconds) {
    const selected = clipSeconds(value);
    const available = Math.floor(Number(bufferedSeconds));
    const partial = Number.isFinite(available) && available >= 4 && available < selected
      ? `지금은 모인 약 ${available}초만 저장돼요. ` : '';
    return `최근 약 ${selected}초를 저장해요. ${partial}실제 길이는 구간 경계에 따라 달라요.`;
  }
  function saveHint(value, bufferedSeconds) { return `${saveNote(value, bufferedSeconds)} · Ctrl+Shift+S`; }
  function bufferEnabled(replay = {}) {
    return Boolean(replay.enabled) || ['starting', 'buffering', 'recording', 'ready', 'running'].includes(replay.state);
  }

  function rewardForSlot(rewards, slot) {
    return Array.isArray(rewards) ? rewards.find(item => Number(item.slotId) === Number(slot.slotId) && (!item.channelId || item.channelId === slot.channelId)) : undefined;
  }

  function formatReward(reward, { enabled = false, external = false } = {}) {
    if (external) {
      const summary = '크롬 통나무는 확장에서 확인하세요.';
      return { summary, title: summary, claimed: false };
    }
    const labels = { disabled: '자동 받기 꺼짐', watching: '다음 보상 기다리는 중', claiming: '보상 받는 중…', claimed: '보상 받았어요', unavailable: '보상 확인 불가' };
    const balance = Number.isSafeInteger(reward?.balance) && reward.balance >= 0
      ? `통나무 ${reward.balance.toLocaleString('ko-KR')}개` : '통나무 보유량 확인 안 됨';
    const time = timestamp(reward?.lastClaimAt);
    const claimTime = time === null ? '' : `최근 수령 ${new Date(time).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
    const summary = [balance, labels[reward?.status] || (enabled ? '보상 확인 중' : '자동 받기 꺼짐'), claimTime].filter(Boolean).join(' · ');
    return { summary, title: [summary, reward?.message].filter(Boolean).join('\n'), claimed: reward?.status === 'claimed' };
  }

  return { filterChannels, filterClips, resultCount, formatClipMeta, clipSeconds, saveLabel, saveHint, saveNote, bufferEnabled, rewardForSlot, formatReward };
});
