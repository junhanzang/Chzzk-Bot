'use strict';

const path = require('node:path');
const { cleanTitle } = require('./channels.cjs');
const { validFileName, prepareClipStorage } = require('./clip-storage.cjs');
const { openLocalPath } = require('./open-local-path.cjs');

function clipRecord(clip) {
  return { id: clip.id, fileName: clip.fileName, title: cleanTitle(clip.title, '방송'),
    originalId: typeof clip.originalId === 'string' && clip.originalId ? clip.originalId : undefined,
    channelId: clip.channelId, createdAt: clip.createdAt, duration: clip.duration,
    favorite: clip.favorite === true,
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
  constructor({ clips, clipsDir, legacyFiles, openPath, revealPath, persist }) {
    Object.assign(this, { clips, clipsDir, legacyFiles, openPath, revealPath, persist });
    this.mutations = Promise.resolve();
    this.pendingUpdate = null;
    this.pendingAddition = null;
  }
  get committedClips() {
    return this.clips.filter(clip => clip !== this.pendingAddition)
      .map(clip => clip === this.pendingUpdate?.updated ? this.pendingUpdate.original : clip);
  }
  enqueue(action) {
    const operation = this.mutations.then(action);
    this.mutations = operation.catch(() => {});
    return operation;
  }
  async register(clip) {
    const record = clipRecord(clip);
    if (!record.id || !validFileName(record.fileName)) throw new Error('클립 파일 정보가 올바르지 않습니다.');
    return this.enqueue(async () => {
      this.clips.unshift(record);
      this.pendingAddition = record;
      // The completed MP4 remains recoverable even if writing its index fails.
      // Either outcome exposes it only when the controller can advance revision.
      try { await this.persist(); }
      finally { this.pendingAddition = null; }
      return record;
    });
  }

  update(arg) {
    if (!arg || typeof arg !== 'object' || Array.isArray(arg) || typeof arg.id !== 'string' || !arg.id ||
        Object.keys(arg).some(key => !['id', 'title', 'favorite'].includes(key)) ||
        (!Object.hasOwn(arg, 'title') && !Object.hasOwn(arg, 'favorite'))) throw new Error('클립 수정 정보가 올바르지 않습니다.');
    const patch = {};
    if (Object.hasOwn(arg, 'title')) {
      if (typeof arg.title !== 'string' || !arg.title.trim() || arg.title.length > 100 || /[\x00-\x1f\x7f]/.test(arg.title)) {
        throw new Error('클립 제목은 1자 이상 100자 이하로 입력해 주세요.');
      }
      patch.title = arg.title.trim();
    }
    if (Object.hasOwn(arg, 'favorite')) {
      if (typeof arg.favorite !== 'boolean') throw new Error('즐겨찾기 설정이 올바르지 않습니다.');
      patch.favorite = arg.favorite;
    }
    const id = arg.id;
    return this.enqueue(async () => {
      const index = this.clips.findIndex(clip => clip.id === id);
      if (index < 0) throw new Error('클립을 찾지 못했습니다.');
      const original = this.clips[index], updated = clipRecord({ ...original, ...patch });
      this.clips[index] = updated;
      this.pendingUpdate = { original, updated };
      try { await this.persist(); }
      catch (error) {
        const current = this.clips.indexOf(updated);
        if (current !== -1) this.clips[current] = original;
        throw error;
      }
      finally { this.pendingUpdate = null; }
      return { ...updated };
    });
  }

  query(arg = {}, channels = []) {
    if (!arg || typeof arg !== 'object' || Array.isArray(arg) ||
        Object.keys(arg).some(key => !['query', 'filter', 'sort', 'offset', 'limit'].includes(key))) throw new Error('클립 검색 조건이 올바르지 않습니다.');
    const { query = '', filter = 'all', sort = 'newest', offset = 0, limit = 50 } = arg;
    if (typeof query !== 'string' || query.length > 200 || !['all', 'starred', 'manual', 'auto', 'keyword', 'chat-spike'].includes(filter) ||
        !['newest', 'oldest'].includes(sort) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('클립 검색 조건이 올바르지 않습니다.');
    }
    const searchable = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('ko-KR');
    const terms = searchable(query).trim().split(/\s+/).filter(Boolean);
    const names = new Map(channels.map(channel => [channel.id, channel.name]));
    // A read can arrive while the index is being written. Expose the committed
    // collection until the mutation settles and the controller bumps revision.
    const matches = this.committedClips.map((clip, index) => ({ clip, index })).filter(({ clip }) => {
      const automatic = ['keyword', 'chat-spike'].includes(clip.trigger);
      if ((filter === 'starred' && !clip.favorite) || (filter === 'manual' && automatic) ||
          (filter === 'auto' && !automatic) || (['keyword', 'chat-spike'].includes(filter) && clip.trigger !== filter)) return false;
      const text = searchable([clip.title, clip.fileName, clip.channelId, names.get(clip.channelId)].join(' '));
      return terms.every(term => text.includes(term));
    });
    const timestamp = clip => { const time = Date.parse(clip.createdAt); return Number.isFinite(time) ? time : null; };
    matches.sort((a, b) => {
      const left = timestamp(a.clip), right = timestamp(b.clip);
      if (left === null || right === null) return left === right ? a.index - b.index : left === null ? 1 : -1;
      return (sort === 'oldest' ? left - right : right - left) || a.index - b.index;
    });
    return { items: matches.slice(offset, offset + limit).map(({ clip }) => clipRecord(clip)), total: matches.length, offset, limit };
  }
  async open(id) {
    const clip = this.clips.find(item => item.id === id);
    if (!clip || !validFileName(clip.fileName)) throw new Error('클립을 찾지 못했습니다.');
    return openLocalPath(this.legacyFiles.get(id) || path.join(this.clipsDir, clip.fileName), { kind: 'file', openPath: this.openPath });
  }
  async reveal(id) {
    const clip = this.clips.find(item => item.id === id);
    if (!clip || !validFileName(clip.fileName)) throw new Error('클립을 찾지 못했습니다.');
    if (typeof this.revealPath !== 'function') throw new Error('폴더에서 파일을 표시할 수 없습니다.');
    return openLocalPath(this.legacyFiles.get(id) || path.join(this.clipsDir, clip.fileName), { kind: 'file', openPath: this.revealPath });
  }
  showFolder() { return openLocalPath(this.clipsDir, { kind: 'directory', openPath: this.openPath }); }
}

module.exports = { ClipLibrary, loadClipLibrary, clipRecord };
