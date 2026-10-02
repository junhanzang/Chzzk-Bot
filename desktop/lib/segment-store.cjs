'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const RETAIN_SECONDS = 90, MAX_BYTES = 512 * 1024 * 1024, MIN_SECONDS = 4;
const EPSILON = 0.000001;

// An unterminated line still belongs to FFmpeg's active segment.
function parseManifest(csv) {
  const result = [], seen = new Set();
  for (const line of String(csv).split('\n').slice(0, -1)) {
    const match = line.trim().match(/^(?:"((?:[^"]|"")*)"|([^,]+)),\s*([\d.eE+-]+),\s*([\d.eE+-]+)$/);
    if (!match) continue;
    const fileName = (match[1] || match[2]).replace(/""/g, '"');
    const start = Number(match[3]), end = Number(match[4]);
    if (!/^segment-\d{9}\.ts$/.test(fileName) || seen.has(fileName) ||
        !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    seen.add(fileName); result.push({ fileName, start, end, duration: end - start });
  }
  return result.sort((a, b) => a.start - b.start);
}

function validateSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > RETAIN_SECONDS) {
    throw new Error('저장 길이는 4초 이상 90초 이하여야 합니다.');
  }
}

function selected(segments) {
  return { segments, duration: Math.round(segments.reduce((sum, item) => sum + item.duration, 0) * 1000) / 1000 };
}

function selectSegments(segments, seconds) {
  validateSeconds(seconds);
  const result = [];
  let duration = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (result.length && Math.abs(result[0].start - segment.end) > 0.25) break;
    result.unshift(segment); duration += segment.duration;
    if (duration >= seconds) break;
  }
  if (duration < MIN_SECONDS) throw new Error('완료된 영상이 최소 4초 쌓인 뒤 저장할 수 있습니다.');
  return selected(result);
}

function validateRange({ start, end } = {}) {
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end)) throw new Error('저장할 영상 구간이 올바르지 않습니다.');
  validateSeconds(end - start);
}

function contiguousTail(segments) {
  if (!segments.length) return null;
  let first = segments.length - 1;
  while (first > 0 && Math.abs(segments[first].start - segments[first - 1].end) <= EPSILON) first--;
  return { start: segments[first].start, end: segments.at(-1).end };
}

function selectRange(segments, range) {
  validateRange(range);
  const { start, end } = range;
  const first = segments.findIndex(segment => segment.start <= start + EPSILON && segment.end > start);
  const unavailable = () => new Error('요청한 영상 구간이 완전히 보관되어 있지 않습니다.');
  if (first === -1) throw unavailable();
  const result = [];
  for (let i = first; i < segments.length; i++) {
    const segment = segments[i];
    if (result.length && Math.abs(result.at(-1).end - segment.start) > EPSILON) throw unavailable();
    result.push(segment);
    if (segment.end + EPSILON >= end) return selected(result);
  }
  throw unavailable();
}

class SegmentStore {
  constructor(directory) {
    this.directory = directory;
    this.segments = [];
    this.lastFile = null;
    this.lastProgressAt = Date.now();
    this.queue = Promise.resolve();
    this.closed = false;
  }

  get bufferedSeconds() { return Math.round(this.segments.reduce((sum, item) => sum + item.duration, 0) * 1000) / 1000; }
  mark() { return this.closed ? null : contiguousTail(this.segments); }
  _run(action) {
    const operation = this.queue.then(() => { if (this.closed) throw new Error('영상 저장이 취소되었습니다.'); return action(); });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async _read() {
    let manifest;
    try { manifest = await fs.readFile(path.join(this.directory, 'manifest.csv'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const segment of parseManifest(manifest)) {
      try {
        const stat = await fs.stat(path.join(this.directory, segment.fileName));
        if (stat.isFile() && stat.size > 0) result.push({ ...segment, bytes: stat.size });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return result;
  }

  async _refresh() {
    const segments = await this._read();
    const newest = segments.at(-1)?.fileName;
    if (newest && newest !== this.lastFile) { this.lastFile = newest; this.lastProgressAt = Date.now(); }
    let duration = segments.reduce((sum, item) => sum + item.duration, 0);
    let bytes = segments.reduce((sum, item) => sum + item.bytes, 0);
    while (segments.length > 1 && (duration - segments[0].duration >= RETAIN_SECONDS || bytes > MAX_BYTES)) {
      const removed = segments.shift(); duration -= removed.duration; bytes -= removed.bytes;
    }
    const keep = new Set(segments.map(item => item.fileName));
    for (const name of await fs.readdir(this.directory)) {
      if (!/^segment-\d{9}\.ts$/.test(name)) continue;
      const file = path.join(this.directory, name);
      if (newest && name <= newest && !keep.has(name)) await fs.rm(file, { force: true });
      else if ((await fs.stat(file)).size > MAX_BYTES) throw new Error('임시 녹화 파일의 용량 제한에 도달했습니다.');
    }
    this.segments = segments;
    return segments;
  }

  refresh() { return this._run(() => this._refresh()); }

  snapshot(selection, signal) {
    return this._run(async () => {
      const check = () => { if (signal.aborted || this.closed) throw new Error('영상 저장이 취소되었습니다.'); };
      check();
      const segments = await this._refresh();
      check();
      const chosen = selection.range ? selectRange(segments, selection.range) : selectSegments(segments, selection.seconds);
      const directory = path.join(this.directory, `export-${randomUUID()}`);
      const release = () => fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      try {
        await fs.mkdir(directory, { recursive: true });
        const lines = [];
        for (let i = 0; i < chosen.segments.length; i++) {
          check();
          const name = `part-${i}.ts`;
          await fs.copyFile(path.join(this.directory, chosen.segments[i].fileName), path.join(directory, name));
          lines.push(`file '${name}'`);
        }
        check();
        await fs.writeFile(path.join(directory, 'concat.txt'), `${lines.join('\n')}\n`);
        return { directory, duration: chosen.duration, release };
      } catch (error) { await release(); throw error; }
    });
  }

  async close() {
    this.closed = true;
    await this.queue;
    await fs.rm(this.directory, { recursive: true, force: true }).catch(() => {});
    this.segments = [];
  }
}

module.exports = { SegmentStore, parseManifest, selectSegments, selectRange, contiguousTail, validateSeconds, validateRange };
