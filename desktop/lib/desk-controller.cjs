'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');
const { parseChannel, cleanTitle, normalizeSettings, validSlot, SLOT_IDS, LAYOUTS, validClipSeconds } = require('./channels.cjs');
const { prepareClipStorage, validFileName } = require('./clip-storage.cjs');
const { openLocalPath } = require('./open-local-path.cjs');

async function loadDeskProfile({ store, dataDir, preferredClipsDir }) {
  const stored = await store.load();
  const settings = normalizeSettings(stored.settings);
  const indexedClips = (Array.isArray(stored.clips) ? stored.clips : []).filter(clip => clip && typeof clip.id === 'string' && validFileName(clip.fileName));
  const storage = await prepareClipStorage({ preferredClipsDir, sources: [
    { clipsDir: preferredClipsDir, clips: indexedClips }, { clipsDir: path.join(dataDir, 'clips'), clips: indexedClips }
  ] });
  const legacyFiles = new Map();
  const clips = storage.clips.map(clip => {
    if (clip.storagePath) legacyFiles.set(clip.id, clip.storagePath);
    return { id: clip.id, fileName: clip.fileName, title: cleanTitle(clip.title, '방송'),
      originalId: typeof clip.originalId === 'string' && clip.originalId ? clip.originalId : undefined,
      channelId: clip.channelId, createdAt: clip.createdAt, duration: clip.duration };
  });
  await store.save({ settings, clips });
  const notice = !storage.ready ? '동영상 폴더에 접근하지 못했습니다. 폴더 권한을 확인한 뒤 앱을 다시 열어 주세요.'
    : storage.warnings.length ? '일부 이전 클립을 복사하지 못했습니다. 기존 파일은 보존되어 있습니다.' : null;
  return { settings, clips, legacyFiles, clipsDir: storage.clipsDir, storageReady: storage.ready, notice };
}

const COMMANDS = Object.freeze(['getState', 'refreshAuth', 'login', 'setClipSeconds', 'setAutoRewards', 'setLayout',
  'addChannel', 'removeChannel', 'assignSlot', 'clearSlot', 'selectAudio', 'setBuffer', 'saveClip', 'reloadSlot',
  'openExternal', 'openClip', 'showClipsFolder', 'setPlayerBounds']);

class DeskController extends EventEmitter {
  constructor({ profile, store, players, recordings, auth, version, browserAvailable, openExternal, openPath }) {
    super();
    this.settings = profile.settings;
    this.clips = profile.clips;
    this.clipsDir = profile.clipsDir;
    this.legacyFiles = profile.legacyFiles;
    this.store = store;
    this.players = players;
    this.recordings = recordings;
    this.auth = auth;
    this.version = version;
    this.browserAvailable = browserAvailable;
    this.openExternalUrl = openExternal;
    this.openPath = openPath;
    this.busy = new Set();
    this.removingChannels = new Set();
    for (const service of [players, recordings, auth]) service.on('change', () => this.emit('change'));
    for (const service of [players, auth]) service.on('notice', (...args) => this.emit('notice', ...args));
    players.on('shortcut', command => {
      Promise.resolve().then(async () => {
        if (command.method === 'saveClip') {
          await this.saveClip({ slotId: command.slotId, seconds: this.settings.clipSeconds });
          this.emit('notice', '클립을 내 컴퓨터에 저장했어요.');
        } else this.selectAudio(command.arg);
      }).catch(error => this.emit('notice', error.message, true));
    });
  }

  commands() { return Object.fromEntries(COMMANDS.map(name => [name, arg => this[name](arg)])); }
  persist() { return this.store.save({ settings: this.settings, clips: this.clips }); }
  publish() { this.emit('change'); }

  getState() {
    const settings = this.settings;
    return {
      version: this.version, channels: settings.channels, audioSlot: this.players.audioSlot, clips: this.clips.slice(0, 100),
      layout: settings.layout, mainSlot: settings.mainSlot, clipSeconds: settings.clipSeconds,
      rewardSettings: { enabled: settings.rewardSettings.enabled },
      rewards: SLOT_IDS.map(slotId => ({ slotId, ...(this.players.rewardStatus(slotId) || {
        channelId: settings.slots[slotId], balance: null,
        status: settings.playbackModes?.[slotId] === 'browser' ? 'unavailable' : settings.rewardSettings.enabled ? 'watching' : 'disabled',
        ...(settings.playbackModes?.[slotId] === 'browser' ? { message: '크롬 확장에서 통나무를 확인해 주세요.' } : {})
      }) })),
      savingSlots: this.recordings.savingSlots, ffmpegAvailable: this.recordings.ffmpegAvailable, auth: this.auth.state,
      browserConnection: { available: this.browserAvailable() },
      slots: SLOT_IDS.map(slotId => ({
        slotId, channelId: settings.slots[slotId], title: settings.channels.find(c => c.id === settings.slots[slotId])?.name || '',
        playbackMode: settings.playbackModes?.[slotId] || 'desktop',
        pageStatus: settings.slots[slotId] ? (settings.playbackModes?.[slotId] === 'browser' ? 'browser' : 'loading') : 'empty',
        ...this.players.status(slotId), replay: this.recordings.status(slotId)
      }))
    };
  }

  async slotAction(slotId, operation) {
    validSlot(slotId);
    if (this.busy.has(slotId)) throw new Error('이 방송의 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
    this.busy.add(slotId);
    try { return await operation(); } finally { this.busy.delete(slotId); this.publish(); }
  }

  async closeSlot(slotId) {
    try { await this.players.close(slotId, () => this.recordings.stop(slotId)); }
    finally {
      this.settings.slots[slotId] = null;
      if (this.settings.playbackModes) this.settings.playbackModes[slotId] = 'desktop';
    }
  }

  restorePlayers() {
    for (const slotId of SLOT_IDS) if (!this.busy.has(slotId) && this.settings.slots[slotId] && this.settings.playbackModes?.[slotId] !== 'browser' && !this.players.has(slotId)) {
      this.players.open(slotId, this.settings.slots[slotId]);
    }
  }

  refreshAuth() { return this.auth.refresh(); }
  login() { return this.auth.open(); }

  async setClipSeconds(seconds) {
    validClipSeconds(seconds); this.settings.clipSeconds = seconds;
    await this.persist(); this.publish(); return this.getState();
  }

  async setAutoRewards(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('자동 수령 설정이 올바르지 않습니다.');
    this.settings.rewardSettings.enabled = enabled;
    await this.players.setAutoRewards(enabled);
    await this.persist(); this.publish(); return this.getState();
  }

  async setLayout({ layout, mainSlot = this.settings.mainSlot } = {}) {
    if (!LAYOUTS.includes(layout)) throw new Error('올바른 화면 배치를 선택해 주세요.');
    validSlot(mainSlot); this.settings.layout = layout; this.settings.mainSlot = mainSlot;
    await this.persist(); this.publish(); return this.getState();
  }

  async addChannel({ input, name, playbackMode = 'desktop' } = {}) {
    if (!['desktop', 'browser'].includes(playbackMode)) throw new Error('올바른 시청 방식을 선택해 주세요.');
    const id = parseChannel(input);
    if (this.settings.channels.some(c => c.id === id)) throw new Error('이미 즐겨찾기에 있는 채널입니다. A–D 자리에 열어 주세요.');
    if (this.settings.channels.length >= 100) throw new Error('즐겨찾기는 최대 100개까지 저장할 수 있습니다.');
    this.settings.channels.push({ id, name: cleanTitle(name, `채널 ${id.slice(0, 6)}`) });
    await this.persist();
    const empty = this.settings.slots.findIndex(value => !value);
    if (empty !== -1) await this.assignSlot({ slotId: empty, channelId: id, playbackMode });
    this.publish(); return this.getState();
  }

  async removeChannel(id) {
    if (this.removingChannels.has(id)) throw new Error('이미 이 채널을 삭제 중입니다.');
    const slots = SLOT_IDS.filter(slotId => this.settings.slots[slotId] === id);
    if (slots.some(slotId => this.busy.has(slotId))) throw new Error('이 채널의 저장·준비 작업이 끝난 뒤 삭제해 주세요.');
    this.removingChannels.add(id); slots.forEach(slotId => this.busy.add(slotId));
    try {
      for (const slotId of slots) await this.closeSlot(slotId);
      this.settings.channels = this.settings.channels.filter(c => c.id !== id);
      await this.persist(); return this.getState();
    } finally {
      slots.forEach(slotId => this.busy.delete(slotId)); this.removingChannels.delete(id); this.publish();
    }
  }

  assignSlot({ slotId, channelId, playbackMode = 'desktop' }) {
    return this.slotAction(slotId, async () => {
      if (!['desktop', 'browser'].includes(playbackMode)) throw new Error('올바른 시청 방식을 선택해 주세요.');
      if (this.removingChannels.has(channelId)) throw new Error('삭제 중인 채널입니다. 잠시 후 다시 시도해 주세요.');
      if (!this.settings.channels.some(c => c.id === channelId)) throw new Error('먼저 즐겨찾기에 채널을 추가해 주세요.');
      if (this.settings.slots[slotId] === channelId && (this.settings.playbackModes?.[slotId] || 'desktop') === playbackMode &&
          (playbackMode === 'browser' || this.players.has(slotId))) return this.getState();
      await this.closeSlot(slotId);
      this.settings.slots[slotId] = channelId;
      this.settings.playbackModes ||= SLOT_IDS.map(() => 'desktop');
      this.settings.playbackModes[slotId] = playbackMode;
      if (playbackMode === 'desktop') this.players.open(slotId, channelId);
      await this.persist(); return this.getState();
    });
  }

  clearSlot(slotId) { return this.slotAction(slotId, async () => { await this.closeSlot(slotId); await this.persist(); return this.getState(); }); }
  selectAudio(slotId) { this.players.selectAudio(slotId); return this.getState(); }

  setBuffer({ slotId, enabled } = {}) {
    return this.slotAction(slotId, async () => {
      await this.recordings.setBuffer(slotId, enabled, this.settings.slots[slotId]);
      return this.getState();
    });
  }

  saveClip({ slotId, seconds = this.settings.clipSeconds } = {}) {
    return this.slotAction(slotId, () => this.recordings.save(slotId, seconds, async record => {
      this.clips.unshift(record); await this.persist(); this.publish();
    }));
  }

  reloadSlot(slotId) {
    validSlot(slotId);
    if (this.busy.has(slotId)) throw new Error('이 방송의 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
    if (this.settings.playbackModes?.[slotId] === 'browser') throw new Error('크롬의 방송 탭에서 새로고침해 주세요.');
    this.players.reload(slotId, this.settings.slots[slotId]);
  }

  async openExternal(slotId) {
    validSlot(slotId);
    const id = this.settings.slots[slotId];
    if (id) await this.openExternalUrl(`https://chzzk.naver.com/live/${id}`);
  }

  async openClip(id) {
    const clip = this.clips.find(item => item.id === id);
    if (!clip || !validFileName(clip.fileName)) throw new Error('클립을 찾지 못했습니다.');
    const file = this.legacyFiles.get(id) || path.join(this.clipsDir, clip.fileName);
    await openLocalPath(file, { kind: 'file', openPath: this.openPath });
  }

  showClipsFolder() { return openLocalPath(this.clipsDir, { kind: 'directory', openPath: this.openPath }); }
  setPlayerBounds(bounds) { this.players.setBounds(bounds); }
  beginShutdown() { this.players.beginShutdown(); this.recordings.beginShutdown(); }
  async shutdown() {
    await this.recordings.shutdown();
    await this.store.flush().catch(() => {});
    this.players.destroyAll();
  }
}

module.exports = { DeskController, loadDeskProfile };
