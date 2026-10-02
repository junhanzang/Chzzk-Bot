'use strict';

const path = require('node:path');
const { cleanTitle } = require('./channels.cjs');
const { validFileName, prepareClipStorage } = require('./clip-storage.cjs');
const { openLocalPath } = require('./open-local-path.cjs');

function clipRecord(clip) {
  return { id: clip.id, fileName: clip.fileName, title: cleanTitle(clip.title, '방송'),
    originalId: typeof clip.originalId === 'string' && clip.originalId ? clip.originalId : undefined,
    channelId: clip.channelId, createdAt: clip.createdAt, duration: clip.duration,
    ...(['keyword', 'chat-spike'].includes(clip.trigger) ? { trigger: clip.trigger } : {}) };
}

async function loadClipLibrary({ indexed, dataDir, preferredClipsDir }) {
  const clips = (Array.isArray(indexed) ? indexed : []).filter(clip => clip && typeof clip.id === 'string' && validFileName(clip.fileName));
  const storage = await prepareClipStorage({ preferredClipsDir, sources: [
    { clipsDir: preferredClipsDir, clips }, { clipsDir: path.join(dataDir, 'clips'), clips }
  ] });
  const legacyFiles = new Map();
  for (const clip of storage.clips) if (clip.storagePath) legacyFiles.set(clip.id, clip.storagePath);
  return { ...storage, clips: storage.clips.map(clipRecord), legacyFiles };
}

class ClipLibrary {
  constructor({ clips, clipsDir, legacyFiles, openPath, persist }) {
    Object.assign(this, { clips, clipsDir, legacyFiles, openPath, persist });
  }
  async register(clip) {
    const record = clipRecord(clip);
    if (!record.id || !validFileName(record.fileName)) throw new Error('클립 파일 정보가 올바르지 않습니다.');
    this.clips.unshift(record);
    await this.persist();
    return record;
  }
  async open(id) {
    const clip = this.clips.find(item => item.id === id);
    if (!clip || !validFileName(clip.fileName)) throw new Error('클립을 찾지 못했습니다.');
    return openLocalPath(this.legacyFiles.get(id) || path.join(this.clipsDir, clip.fileName), { kind: 'file', openPath: this.openPath });
  }
  showFolder() { return openLocalPath(this.clipsDir, { kind: 'directory', openPath: this.openPath }); }
}

module.exports = { ClipLibrary, loadClipLibrary, clipRecord };
