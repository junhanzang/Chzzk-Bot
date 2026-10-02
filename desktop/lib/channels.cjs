'use strict';

const model = require('../../browser-extension/shared/channels.js');
const { cleanTitle } = model;

function selectPlayback(content) {
  if (!content || content.status !== 'OPEN') throw new Error('방송이 오프라인이거나 재생 정보를 받을 수 없습니다.');
  let playback;
  try { playback = JSON.parse(content.livePlaybackJson); } catch {
    throw new Error('이 방송의 재생 정보를 읽을 수 없습니다. 로그인·연령 인증 또는 플랫폼 변경을 확인해 주세요.');
  }
  const media = (Array.isArray(playback.media) ? playback.media : []).filter(item => {
    if (!item || typeof item.path !== 'string') return false;
    try {
      const url = new URL(item.path);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        !/^(localhost|.*\.localhost|.*\.local|[\d.]+)$/i.test(url.hostname) && !url.hostname.includes(':') &&
        (String(item.protocol).toUpperCase() === 'HLS' || url.pathname.endsWith('.m3u8'));
    } catch { return false; }
  });
  const selected = media.find(item => item.mediaId === 'HLS') || media.find(item => item.mediaId !== 'LLHLS') || media[0];
  if (!selected) throw new Error('저장 가능한 HLS 영상을 찾지 못했습니다. 이 방송에서는 임시 보관을 사용할 수 없습니다.');
  return { url: selected.path, title: cleanTitle(content.liveTitle), name: cleanTitle(content.channel?.channelName) };
}

module.exports = { ...model, selectPlayback };
