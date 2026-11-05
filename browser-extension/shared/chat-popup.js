'use strict';

// The official website opens this chat route separately from its video player.
// Verified in https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-BcgE118t.js
// (router /live/:channelId/chat and the official window.open callback).
((root, factory) => {
  const model = factory();
  root.DeskChatPopup = model;
  if (typeof module === 'object' && module.exports) module.exports = model;
})(globalThis, () => {
  const ORIGIN = 'https://chzzk.naver.com';

  function normalizeChatChannelId(value) {
    if (typeof value !== 'string' || !/^[a-f\d]{32}$/i.test(value)) {
      throw new Error('채팅창을 열 채널 ID가 올바르지 않습니다.');
    }
    return value.toLowerCase();
  }

  function chatPopupUrl(channelId) {
    return `${ORIGIN}/live/${normalizeChatChannelId(channelId)}/chat`;
  }

  function chatPopupChannelId(value) {
    try {
      const url = new URL(value);
      if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash) return null;
      return url.pathname.match(/^\/live\/([a-f\d]{32})\/chat\/?$/i)?.[1].toLowerCase() || null;
    } catch { return null; }
  }

  function isChatPopupUrl(value, channelId) {
    return chatPopupChannelId(value) === normalizeChatChannelId(channelId);
  }

  return Object.freeze({ normalizeChatChannelId, chatPopupUrl, chatPopupChannelId, isChatPopupUrl });
});
