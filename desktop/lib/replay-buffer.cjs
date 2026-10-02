'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SLOT_IDS, validSlot } = require('./channels.cjs');

const RETAIN_SECONDS = 90;
const MAX_BYTES = 512 * 1024 * 1024;
const MIN_SECONDS = 4;

function validateSlot(slotId) {
  validSlot(slotId);
}

// Ignore an unterminated line: FFmpeg may be in the middle of publishing it.
function parseManifest(csv) {
  const result = [];
  const seen = new Set();
  for (const line of String(csv).split('\n').slice(0, -1)) {
    const match = line.trim().match(/^(?:"((?:[^"]|"")*)"|([^,]+)),\s*([\d.eE+-]+),\s*([\d.eE+-]+)$/);
    if (!match) continue;
    const fileName = (match[1] || match[2]).replace(/""/g, '"');
    const start = Number(match[3]);
    const end = Number(match[4]);
    if (!/^segment-\d{9}\.ts$/.test(fileName) || seen.has(fileName)
      || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    seen.add(fileName);
    result.push({ fileName, start, end, duration: end - start });
  }
  return result.sort((a, b) => a.start - b.start);
}

function selectSegments(segments, seconds) {
  if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > RETAIN_SECONDS) {
    throw new Error('저장 길이는 4초 이상 90초 이하여야 합니다.');
  }
  const selected = [];
  let duration = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    // A missing segment must not silently produce a clip spanning a gap.
    if (selected.length && Math.abs(selected[0].start - segment.end) > 0.25) break;
    selected.unshift(segment);
    duration += segment.duration;
    if (duration >= seconds) break;
  }
  if (duration < MIN_SECONDS) throw new Error('완료된 영상이 최소 4초 쌓인 뒤 저장할 수 있습니다.');
  return { segments: selected, duration: Math.round(duration * 1000) / 1000 };
}

function safeTitle(value) {
  return String(value || 'replay').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '').slice(0, 60) || 'replay';
}

function validateInput(url, headers, allowLocalFiles) {
  if (typeof url !== 'string' || !url || /[\r\n\0]/.test(url)) throw new Error('녹화 주소가 올바르지 않습니다.');
  let protocol;
  try { protocol = new URL(url).protocol; } catch { /* A local fixture may be allowed explicitly. */ }
  if (protocol !== 'https:' && protocol !== 'http:') {
    if (!allowLocalFiles || !path.isAbsolute(url)) throw new Error('HTTP 또는 HTTPS 녹화 주소만 사용할 수 있습니다.');
  }
  if (headers !== undefined && (!headers || typeof headers !== 'object' || Array.isArray(headers))) {
    throw new Error('녹화 요청 헤더가 올바르지 않습니다.');
  }
  const headerText = Object.entries(headers || {}).map(([key, value]) => {
    if (!/^[A-Za-z0-9-]+$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value)) {
      throw new Error('녹화 요청 헤더가 올바르지 않습니다.');
    }
    return `${key}: ${value}\r\n`;
  }).join('');
  return { remote: protocol === 'https:' || protocol === 'http:', headerText };
}

class ReplayBuffer extends EventEmitter {
  constructor({ ffmpegPath, rootDir, clipsDir, spawnImpl = spawn, allowLocalFiles = false,
    pollIntervalMs = 1000, stallTimeoutMs = 45000, exportTimeoutMs = 120000 } = {}) {
    super();
    if (!ffmpegPath || !rootDir || !clipsDir) throw new Error('FFmpeg와 저장 폴더 경로가 필요합니다.');
    this.ffmpegPath = ffmpegPath;
    this.rootDir = path.resolve(rootDir);
    this.clipsDir = path.resolve(clipsDir);
    this.spawnImpl = spawnImpl;
    this.allowLocalFiles = allowLocalFiles;
    this.pollIntervalMs = pollIntervalMs;
    this.stallTimeoutMs = stallTimeoutMs;
    this.exportTimeoutMs = exportTimeoutMs;
    this.slots = SLOT_IDS.map(() => null);
    this.operations = SLOT_IDS.map(() => Promise.resolve());
  }

  status(slotId) {
    validateSlot(slotId);
    const session = this.slots[slotId];
    return session ? { ...session.status } : { state: 'idle', bufferedSeconds: 0 };
  }

  _setStatus(session, state, error) {
    if (this.slots[session.slotId] !== session) return;
    const status = { state, bufferedSeconds: Math.round(session.segments.reduce((sum, s) => sum + s.duration, 0) * 1000) / 1000 };
    if (error) status.error = error;
    if (JSON.stringify(session.status) === JSON.stringify(status)) return;
    session.status = status;
    this.emit('status', { slotId: session.slotId, status: { ...status } });
  }

  _queue(slotId, action) {
    validateSlot(slotId);
    const task = this.operations[slotId].then(action);
    this.operations[slotId] = task.catch(() => {});
    return task;
  }

  _files(session, action) {
    const task = session.fileQueue.then(action);
    session.fileQueue = task.catch(() => {});
    return task;
  }

  async start(slotId, options = {}) {
    validateSlot(slotId);
    const input = validateInput(options.url, options.headers, this.allowLocalFiles);
    return this._queue(slotId, async () => {
      await this._stop(slotId);
      const session = {
        slotId, dir: path.join(this.rootDir, `replay-${slotId}-${randomUUID()}`),
        channelId: String(options.channelId || ''), title: String(options.title || 'Replay'),
        segments: [], status: { state: 'idle', bufferedSeconds: 0 }, stopping: false,
        fileQueue: Promise.resolve(), jobs: new Set(), processes: new Set(),
        lastProgressAt: Date.now(), lastFile: null, poll: null, timer: null,
      };
      this.slots[slotId] = session;
      this._setStatus(session, 'starting');
      try {
        await fs.mkdir(session.dir, { recursive: true });
        await fs.mkdir(this.clipsDir, { recursive: true });
        if (session.stopping) return this.status(slotId);
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
        if (input.remote) {
          args.push('-rw_timeout', '15000000', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
          if (input.headerText) args.push('-headers', input.headerText);
          args.push('-protocol_whitelist', 'http,https,tcp,tls,crypto');
        }
        args.push('-i', options.url, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy',
          '-f', 'segment', '-segment_format', 'mpegts', '-segment_time', '2',
          '-reset_timestamps', '1', '-segment_list', 'manifest.csv', '-segment_list_type', 'csv',
          '-segment_list_size', '64', '-segment_list_flags', '+live', 'segment-%09d.ts');
        const process = this._spawn(session, args, session.dir, { recorder: true });
        session.recorder = process;
        process.done.then(({ code, error }) => {
          if (!session.stopping && this.slots[slotId] === session) {
            this._fail(session, error ? '녹화를 시작하지 못했습니다. FFmpeg 설치 상태를 확인해 주세요.' : '녹화 연결이 종료되었습니다. 다시 시작해 주세요.');
          }
        });
        await process.ready;
        if (session.stopping) return this.status(slotId);
        if (session.status.state === 'error') throw new Error(session.status.error);
        session.timer = setInterval(() => this._poll(session), this.pollIntervalMs);
        session.timer.unref?.();
        this._poll(session);
        return this.status(slotId);
      } catch {
        if (session.stopping) return this.status(slotId);
        this._fail(session, '녹화를 시작하지 못했습니다. FFmpeg와 방송 연결을 확인해 주세요.');
        throw new Error(session.status.error);
      }
    });
  }

  _spawn(session, args, cwd, { recorder = false } = {}) {
    let child;
    try {
      child = this.spawnImpl(this.ffmpegPath, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      throw new Error('FFmpeg를 실행하지 못했습니다. 설치 상태를 확인해 주세요.');
    }
    const process = { child, exited: false };
    session.processes.add(process);
    let rejectReady;
    let readyTimer;
    process.ready = new Promise((resolve, reject) => {
      rejectReady = () => { clearTimeout(readyTimer); reject(new Error('FFmpeg를 실행하지 못했습니다. 설치 상태를 확인해 주세요.')); };
      child.once('spawn', () => { clearTimeout(readyTimer); resolve(); });
      child.once('error', rejectReady);
      readyTimer = setTimeout(() => { rejectReady(); this._terminate(process).catch(() => {}); }, 10000);
      readyTimer.unref?.();
    });
    // Examine each chunk transiently, never buffering/logging FFmpeg output:
    // it can contain signed URLs and cookies. Export errors use their existing path.
    child.stderr?.on('data', chunk => {
      if (recorder && /\bHTTP\s+error\s+(?:401|403)\b|Unable\s+to\s+open\s+key\s+file/i.test(String(chunk))) {
        this._fail(session, '방송 서버가 영상 접근을 거부했습니다. 이 방송의 로그인·재생 권한 또는 앱 호환성을 확인해 주세요.');
      }
    });
    process.done = new Promise(resolve => {
      const finish = result => {
        if (process.exited) return;
        rejectReady();
        process.exited = true;
        session.processes.delete(process);
        resolve(result);
      };
      process.finish = finish;
      child.once('error', () => finish({ code: null, error: true }));
      child.once('close', code => finish({ code, error: false }));
    });
    return process;
  }

  _fail(session, message) {
    if (session.stopping || session.status.state === 'error') return;
    clearInterval(session.timer);
    this._setStatus(session, 'error', message);
    if (session.recorder && !session.recorder.exited) this._terminate(session.recorder).catch(() => {});
  }

  async _readSegments(session) {
    let manifest;
    try { manifest = await fs.readFile(path.join(session.dir, 'manifest.csv'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const segments = [];
    for (const segment of parseManifest(manifest)) {
      try {
        const info = await fs.stat(path.join(session.dir, segment.fileName));
        if (info.isFile() && info.size > 0) segments.push({ ...segment, bytes: info.size });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return segments;
  }

  async _refresh(session) {
    let segments = await this._readSegments(session);
    const newest = segments.at(-1)?.fileName;
    if (newest && newest !== session.lastFile) {
      session.lastFile = newest;
      session.lastProgressAt = Date.now();
    }
    let duration = segments.reduce((n, segment) => n + segment.duration, 0);
    let bytes = segments.reduce((n, segment) => n + segment.bytes, 0);
    while (segments.length > 1 && (duration - segments[0].duration >= RETAIN_SECONDS || bytes > MAX_BYTES)) {
      const removed = segments.shift();
      duration -= removed.duration;
      bytes -= removed.bytes;
    }
    const keep = new Set(segments.map(segment => segment.fileName));
    // Only remove files older than the newest completed file. The active output is never exported or pruned.
    for (const name of await fs.readdir(session.dir)) {
      if (!/^segment-\d{9}\.ts$/.test(name)) continue;
      const filename = path.join(session.dir, name);
      if (newest && name <= newest && !keep.has(name)) await fs.rm(filename, { force: true });
      else {
        const stat = await fs.stat(filename);
        if (stat.size > MAX_BYTES) throw new Error('임시 녹화 파일의 용량 제한에 도달했습니다.');
      }
    }
    session.segments = segments;
    if (!session.stopping && session.status.state !== 'error') this._setStatus(session, segments.length ? 'buffering' : 'starting');
    return segments;
  }

  _poll(session) {
    if (session.poll || session.stopping || session.status.state === 'error') return;
    session.poll = this._files(session, async () => {
      if (session.stopping) return;
      await this._refresh(session);
      if (!session.stopping && Date.now() - session.lastProgressAt > this.stallTimeoutMs) {
        this._fail(session, '녹화 데이터가 더 이상 들어오지 않습니다. 다시 시작해 주세요.');
      }
    }).catch(() => this._fail(session, '임시 녹화를 유지하지 못했습니다. 저장 공간을 확인해 주세요.'))
      .finally(() => { session.poll = null; });
  }

  async save(slotId, seconds = 30) {
    validateSlot(slotId);
    if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > RETAIN_SECONDS) {
      throw new Error('저장 길이는 4초 이상 90초 이하여야 합니다.');
    }
    const session = this.slots[slotId];
    // A disconnected/ended broadcast may still have a useful final moment on disk.
    // _save validates completed segments; an error status itself does not invalidate them.
    if (!session || session.stopping) throw new Error('임시 녹화를 먼저 시작해 주세요.');
    if (session.jobs.size) throw new Error('이 방송의 영상을 이미 저장하고 있습니다. 잠시 기다려 주세요.');
    const job = this._save(session, seconds);
    session.jobs.add(job);
    try { return await job; } finally { session.jobs.delete(job); }
  }

  async _save(session, seconds) {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const tempDir = path.join(session.dir, `export-${id}`);
    const fileName = `${createdAt.replace(/[:.]/g, '-')}_${safeTitle(session.title)}_${id.slice(0, 8)}.mp4`;
    const target = path.join(this.clipsDir, fileName);
    const staging = path.join(this.clipsDir, `.replay-${id}.partial.mp4`);
    let duration;
    try {
      await this._files(session, async () => {
        if (session.stopping) throw new Error('영상 저장이 취소되었습니다.');
        const selection = selectSegments(await this._refresh(session), seconds);
        duration = selection.duration;
        await fs.mkdir(tempDir, { recursive: true });
        const lines = [];
        for (let i = 0; i < selection.segments.length; i++) {
          if (session.stopping) throw new Error('영상 저장이 취소되었습니다.');
          const name = `part-${i}.ts`;
          await fs.copyFile(path.join(session.dir, selection.segments[i].fileName), path.join(tempDir, name));
          lines.push(`file '${name}'`);
        }
        await fs.writeFile(path.join(tempDir, 'concat.txt'), `${lines.join('\n')}\n`);
      });
      if (session.stopping) throw new Error('영상 저장이 취소되었습니다.');
      const process = this._spawn(session, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-map', '0:v:0?', '-map', '0:a:0?',
        '-c', 'copy', '-movflags', '+faststart', staging], tempDir);
      await process.ready;
      let timeout;
      const result = await Promise.race([process.done, new Promise(resolve => {
        timeout = setTimeout(() => {
          this._terminate(process).then(() => resolve({ error: true }));
        }, this.exportTimeoutMs);
        timeout.unref?.();
      })]).finally(() => clearTimeout(timeout));
      if (session.stopping) throw new Error('영상 저장이 취소되었습니다.');
      if (result.error || result.code !== 0) throw new Error('영상을 저장하지 못했습니다.');
      const info = await fs.stat(staging);
      if (!info.size) throw new Error('영상을 저장하지 못했습니다.');
      if (session.stopping) throw new Error('영상 저장이 취소되었습니다.');
      await fs.rename(staging, target);
      return { id, fileName, path: target, createdAt, duration, channelId: session.channelId, title: session.title };
    } catch (error) {
      if (session.stopping) throw new Error('영상 저장이 취소되었습니다.');
      if (/^완료된 영상이 최소 4초/.test(error.message)) throw error;
      throw new Error('영상을 저장하지 못했습니다. 저장 공간을 확인한 뒤 다시 시도해 주세요.');
    } finally {
      await fs.rm(staging, { force: true }).catch(() => {});
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async _terminate(process) {
    if (!process || process.exited) return;
    try { process.child.kill('SIGTERM'); } catch { /* Already exited. */ }
    const wait = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
    await Promise.race([process.done, wait(1500)]);
    if (!process.exited) {
      try { process.child.kill('SIGKILL'); } catch { /* Already exited. */ }
      await Promise.race([process.done, wait(1000)]);
      if (!process.exited) process.finish({ code: null, error: true });
    }
  }

  stop(slotId) {
    validateSlot(slotId);
    // Mark cancellation immediately, even if a preceding start is still awaiting spawn.
    const session = this.slots[slotId];
    if (session) {
      session.stopping = true;
      clearInterval(session.timer);
      for (const process of session.processes) this._terminate(process).catch(() => {});
    }
    return this._queue(slotId, () => this._stop(slotId));
  }

  async _stop(slotId) {
    const session = this.slots[slotId];
    if (!session) return;
    session.stopping = true;
    clearInterval(session.timer);
    await Promise.all([...session.processes].map(process => this._terminate(process)));
    await Promise.allSettled([...session.jobs]);
    await session.fileQueue;
    await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
    if (this.slots[slotId] === session) {
      this.slots[slotId] = null;
      this.emit('status', { slotId, status: this.status(slotId) });
    }
  }

  async stopAll() { await Promise.all(SLOT_IDS.map(slotId => this.stop(slotId))); }
}

module.exports = { ReplayBuffer, parseManifest, selectSegments, safeTitle, validateInput };
