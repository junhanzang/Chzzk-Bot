'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// Owns the profile's two fixed JSON documents. A save captures a snapshot before
// entering the queue, so later UI changes cannot overwrite an earlier operation.
class ProfileStore {
  constructor(directory, { fileSystem = fs } = {}) {
    if (!path.isAbsolute(directory)) throw new Error('프로필 저장 경로가 올바르지 않습니다.');
    this.directory = directory;
    this.fs = fileSystem;
    this.pending = Promise.resolve();
  }

  async load() {
    const read = async (name, fallback) => {
      try { return JSON.parse(await this.fs.readFile(path.join(this.directory, name), 'utf8')); }
      catch { return fallback; }
    };
    const [settings, clips] = await Promise.all([read('settings.json', {}), read('clips.json', [])]);
    return { settings, clips };
  }

  save({ settings, clips }) {
    const documents = [['settings.json', JSON.stringify(settings, null, 2)], ['clips.json', JSON.stringify(clips, null, 2)]];
    const operation = this.pending.catch(() => {}).then(async () => {
      for (const [name, text] of documents) {
        const target = path.join(this.directory, name), temporary = `${target}.tmp`;
        try {
          await this.fs.writeFile(temporary, text, 'utf8');
          await this.fs.rename(temporary, target);
        } catch (error) {
          await this.fs.rm(temporary, { force: true }).catch(() => {});
          throw error;
        }
      }
    });
    this.pending = operation;
    return operation;
  }

  flush() { return this.pending; }
}

module.exports = { ProfileStore };
