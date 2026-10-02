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

  function normalizeAutoClipConfig(raw = {}) {
    const keywords = [...new Set((Array.isArray(raw?.keywords) ? raw.keywords : []).slice(0, 10)
      .filter(value => typeof value === 'string').map(value => cleanTitle(value).slice(0, 40)).filter(Boolean))];
    return { enabled: raw?.enabled === true, keywords, chatSpike: raw?.chatSpike === true };
  }

  function normalizeAutoClipSettings(raw, channels) {
    const result = {};
    for (const channel of channels) if (raw && Object.hasOwn(raw, channel.id)) result[channel.id] = normalizeAutoClipConfig(raw[channel.id]);
    return result;
  }

  function displayName(value, max, label) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error(`${label}은 1–${max}자로 입력해 주세요.`);
    }
    return value.trim();
  }

  function updateChannel(channels, method, arg) {
    const id = parseChannel(arg?.channelId);
    if (!channels.some(channel => channel.id === id)) throw new Error('즐겨찾기에 없는 채널입니다.');
    const name = method === 'renameChannel' ? displayName(arg?.name, 60, '채널 이름') : null;
    if (method !== 'renameChannel' && (method !== 'setChannelPinned' || typeof arg?.pinned !== 'boolean')) throw new Error('고정 설정이 올바르지 않습니다.');
    return channels.map(channel => {
      if (channel.id !== id) return channel;
      const updated = { ...channel };
      if (name !== null) updated.name = name;
      else if (arg.pinned) updated.pinned = true;
      else delete updated.pinned;
      return updated;
    });
  }

  function normalizeWatchPresets(raw, channels) {
    const ids = new Set(channels.map(channel => channel.id)), result = [];
    for (const item of Array.isArray(raw) ? raw.slice(0, 10) : []) {
      if (!item || typeof item.id !== 'string' || !/^[\w-]{1,80}$/.test(item.id) || result.some(preset => preset.id === item.id)) continue;
      const name = cleanTitle(item.name).slice(0, 40);
      if (!name || result.some(preset => preset.name.toLocaleLowerCase() === name.toLocaleLowerCase())) continue;
      const used = new Set();
      const slots = SLOT_IDS.map(slotId => {
        const id = item.slots?.[slotId];
        if (!ids.has(id) || used.has(id)) return null;
        used.add(id); return id;
      });
      if (slots.some(Boolean)) result.push({ id: item.id, name, slots, ...normalizeLayout(item) });
    }
    return result;
  }

  function createWatchPreset({ id, name, slots, layout, mainSlot }, channels, existing = []) {
    name = displayName(name, 40, '조합 이름');
    if (existing.length >= 10) throw new Error('방송 조합은 최대 10개까지 저장할 수 있어요.');
    if (existing.some(preset => preset.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('같은 이름의 조합이 있어요. 다른 이름을 입력해 주세요.');
    if (!Array.isArray(slots) || slots.length !== 4 || !slots.some(Boolean) ||
        slots.some(value => value !== null && !channels.some(channel => channel.id === value))) throw new Error('시청할 방송을 먼저 A–D에 열어 주세요.');
    const assigned = slots.filter(Boolean);
    if (new Set(assigned).size !== assigned.length) throw new Error('같은 방송을 여러 자리에 둔 조합은 저장할 수 없어요.');
    return { id, name, slots: [...slots], ...normalizeLayout({ layout, mainSlot }) };
  }

  function normalizeSettings(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
    const channels = [];
    for (const item of Array.isArray(raw.channels) ? raw.channels.slice(0, 100) : []) {
      if (!item || typeof item.id !== 'string' || !CHANNEL_ID.test(item.id) || channels.some(channel => channel.id === item.id.toLowerCase())) continue;
      channels.push({ id: item.id.toLowerCase(), name: cleanTitle(item.name, `채널 ${item.id.slice(0, 6)}`), ...(item.pinned === true ? { pinned: true } : {}) });
    }
    const slots = SLOT_IDS.map(slotId => {
      const id = Array.isArray(raw.slots) ? raw.slots[slotId] : null;
      return channels.some(channel => channel.id === id) ? id : null;
    });
    const normalized = { channels, slots, ...normalizeLayout(raw), clipSeconds: normalizeClipSeconds(raw.clipSeconds),
      rewardSettings: { enabled: raw.rewardSettings?.enabled === true },
      autoClipSettings: normalizeAutoClipSettings(raw.autoClipSettings, channels),
      watchPresets: normalizeWatchPresets(raw.watchPresets, channels) };
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
    CLIP_DURATIONS, normalizeClipSeconds, validClipSeconds, normalizeAutoClipConfig, normalizeAutoClipSettings,
    displayName, updateChannel, normalizeWatchPresets, createWatchPreset };
});
