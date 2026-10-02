'use strict';

// One model for Node/Electron and the extension service worker. No platform APIs.
((root, factory) => {
  const model = factory();
  root.DeskChannels = model;
  if (typeof module === 'object' && module.exports) module.exports = model;
})(globalThis, () => {
  const CHANNEL_ID = /^[a-f\d]{32}$/i;
  const SLOT_IDS = Object.freeze([0, 1, 2, 3]);
  const LAYOUTS = Object.freeze(['side-by-side', 'stacked', 'grid', 'focus']);
  const CLIP_DURATIONS = Object.freeze([15, 30, 60]);

  function normalizeClipSeconds(value) { return CLIP_DURATIONS.includes(value) ? value : 30; }

  function validClipSeconds(value) {
    if (!CLIP_DURATIONS.includes(value)) throw new Error('저장 길이는 15초, 30초 또는 60초로 선택해 주세요.');
    return value;
  }

  function normalizeLayout(raw = {}) {
    return { layout: LAYOUTS.includes(raw?.layout) ? raw.layout : 'side-by-side',
      mainSlot: SLOT_IDS.includes(raw?.mainSlot) ? raw.mainSlot : 0 };
  }

  function parseChannel(input) {
    if (typeof input !== 'string' || input.length > 2048) throw new Error('치지직 방송 주소를 입력해 주세요.');
    const value = input.trim();
    if (CHANNEL_ID.test(value)) return value.toLowerCase();
    let url;
    try { url = new URL(value); } catch { throw new Error('치지직 방송 URL 또는 32자리 채널 ID가 필요합니다.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'chzzk.naver.com' || url.port || url.username || url.password) {
      throw new Error('https://chzzk.naver.com 방송 주소만 추가할 수 있습니다.');
    }
    const match = url.pathname.match(/^\/(?:live\/)?([a-f\d]{32})\/?$/i);
    if (!match) throw new Error('다시보기나 클립 주소 대신 생방송 채널 주소를 입력해 주세요.');
    return match[1].toLowerCase();
  }

  function cleanTitle(value, fallback = '') {
    return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100) || fallback : fallback;
  }

  function normalizeSettings(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
    const channels = [];
    for (const item of Array.isArray(raw.channels) ? raw.channels.slice(0, 100) : []) {
      if (!item || typeof item.id !== 'string' || !CHANNEL_ID.test(item.id) || channels.some(channel => channel.id === item.id.toLowerCase())) continue;
      channels.push({ id: item.id.toLowerCase(), name: cleanTitle(item.name, `채널 ${item.id.slice(0, 6)}`) });
    }
    const slots = SLOT_IDS.map(slotId => {
      const id = Array.isArray(raw.slots) ? raw.slots[slotId] : null;
      return channels.some(channel => channel.id === id) ? id : null;
    });
    const normalized = { channels, slots, ...normalizeLayout(raw), clipSeconds: normalizeClipSeconds(raw.clipSeconds),
      rewardSettings: { enabled: raw.rewardSettings?.enabled === true } };
    if (Array.isArray(raw.playbackModes)) {
      normalized.playbackModes = SLOT_IDS.map(slotId => slots[slotId] && raw.playbackModes[slotId] === 'browser' ? 'browser' : 'desktop');
    }
    // Audio and recording are intentionally never restored on startup.
    return normalized;
  }

  function validSlot(slotId) {
    if (!SLOT_IDS.includes(slotId)) throw new Error('잘못된 방송 슬롯입니다.');
    return slotId;
  }

  return { parseChannel, cleanTitle, normalizeSettings, validSlot, SLOT_IDS, LAYOUTS, normalizeLayout,
    CLIP_DURATIONS, normalizeClipSeconds, validClipSeconds };
});
