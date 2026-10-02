'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function safeTitle(value) {
  return String(value || 'replay').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 60) || 'replay';
}

// Receives a pinned snapshot and a narrow managed-process factory. It never
// reads/prunes the live recorder files or receives the mutable recording session.
class ClipExporter {
  constructor({ clipsDir, spawnProcess, timeoutMs }) {
    this.clipsDir = clipsDir;
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
  }

  async export(snapshot, { channelId, title }, signal) {
    const id = randomUUID(), createdAt = new Date().toISOString();
    const fileName = `${createdAt.replace(/[:.]/g, '-')}_${safeTitle(title)}_${id.slice(0, 8)}.mp4`;
    const target = path.join(this.clipsDir, fileName), staging = path.join(this.clipsDir, `.replay-${id}.partial.mp4`);
    const check = () => { if (signal.aborted) throw new Error('영상 저장이 취소되었습니다.'); };
    let process, timer;
    const cancel = () => { void process?.terminate(); };
    try {
      check();
      process = this.spawnProcess(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-map', '0:v:0?', '-map', '0:a:0?',
        '-c', 'copy', '-movflags', '+faststart', staging], snapshot.directory);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      await process.ready;
      const result = await Promise.race([process.done, new Promise(resolve => {
        timer = setTimeout(() => { process.terminate().then(() => resolve({ error: true })); }, this.timeoutMs);
        timer.unref?.();
      })]);
      check();
      if (result.error || result.code !== 0 || !(await fs.stat(staging)).size) throw new Error('영상을 저장하지 못했습니다.');
      check();
      await fs.rename(staging, target);
      if (signal.aborted) { await fs.rm(target, { force: true }); check(); }
      return { id, fileName, path: target, createdAt, duration: snapshot.duration, channelId, title };
    } catch {
      check();
      throw new Error('영상을 저장하지 못했습니다. 저장 공간을 확인한 뒤 다시 시도해 주세요.');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) await process?.terminate();
      await fs.rm(staging, { force: true }).catch(() => {});
    }
  }
}

module.exports = { ClipExporter, safeTitle };
