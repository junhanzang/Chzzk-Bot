'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');
const { selectPlayback, cleanTitle, validClipSeconds } = require('./channels.cjs');

class RecordingService extends EventEmitter {
  constructor({ replay, gateway, session, ffmpegAvailable, storageReady }) {
    super();
    this.replay = replay;
    this.gateway = gateway;
    this.session = session;
    this.ffmpegAvailable = ffmpegAvailable;
    this.storageReady = storageReady;
    this.leases = new Map();
    this.preparing = new Set();
    this.saving = new Set();
    this.quitting = false;
    replay.on('status', ({ slotId, status }) => {
      if (status.state === 'error') this.release(slotId);
      this.emit('change');
    });
  }

  status(slotId) { return this.preparing.has(slotId) ? { state: 'starting', bufferedSeconds: 0 } : this.replay.status(slotId); }
  get savingSlots() { return [...this.saving]; }
  release(slotId) { this.leases.get(slotId)?.close(); this.leases.delete(slotId); }

  async playbackInfo(channelId) {
    const response = await this.session.fetch(`https://api.chzzk.naver.com/service/v3/channels/${channelId}/live-detail`, {
      credentials: 'include', headers: { Accept: 'application/json', Referer: 'https://chzzk.naver.com/', Origin: 'https://chzzk.naver.com' }, signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`재생 정보를 받을 수 없습니다 (${response.status}). 로그인 상태를 확인해 주세요.`);
    const body = await response.json();
    return selectPlayback(body.content);
  }

  async setBuffer(slotId, enabled, channelId) {
    if (typeof enabled !== 'boolean') throw new Error('잘못된 보관 설정입니다.');
    if (!enabled) { await this.replay.stop(slotId); this.release(slotId); return; }
    if (!this.ffmpegAvailable) throw new Error('FFmpeg가 설치되지 않았습니다. desktop 폴더에서 npm install을 실행해 주세요.');
    if (!channelId) throw new Error('먼저 방송을 열어 주세요.');
    this.preparing.add(slotId); this.emit('change');
    try {
      const info = await this.playbackInfo(channelId);
      if (this.quitting) return;
      await this.replay.stop(slotId); this.release(slotId);
      if (this.quitting) return;
      const stream = this.gateway.createStream(info.url, { referer: `https://chzzk.naver.com/live/${channelId}` });
      this.leases.set(slotId, stream);
      try { await this.replay.start(slotId, { url: stream.url, channelId, title: info.title || info.name || '방송' }); }
      catch (error) { this.release(slotId); throw error; }
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('방송 정보 요청 시간이 초과되었습니다. 다시 시도해 주세요.');
      if (error.message === 'Failed to fetch' || error instanceof TypeError) throw new Error('방송 서버에 연결하지 못했습니다. 네트워크와 로그인 상태를 확인해 주세요.');
      throw error;
    } finally { this.preparing.delete(slotId); this.emit('change'); }
  }

  async save(slotId, seconds, commit) {
    validClipSeconds(seconds);
    if (!this.storageReady) throw new Error('동영상 폴더에 접근할 수 없어 저장하지 못했습니다. 폴더 접근 권한을 확인한 뒤 앱을 다시 열어 주세요.');
    this.saving.add(slotId); this.emit('change');
    try {
      const clip = await this.replay.save(slotId, seconds);
      const record = { id: clip.id, fileName: path.basename(clip.fileName || clip.path), title: cleanTitle(clip.title, '방송'),
        channelId: clip.channelId, createdAt: clip.createdAt, duration: clip.duration };
      await commit(record);
      return record;
    } finally { this.saving.delete(slotId); this.emit('change'); }
  }

  async stop(slotId) { try { await this.replay.stop(slotId); } finally { this.release(slotId); } }
  beginShutdown() { this.quitting = true; }
  async shutdown() {
    this.beginShutdown();
    await this.replay.stopAll();
    for (const slotId of this.leases.keys()) this.release(slotId);
    await this.gateway.close();
  }
}

module.exports = { RecordingService };
