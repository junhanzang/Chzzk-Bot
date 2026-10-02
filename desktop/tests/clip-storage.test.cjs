'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { prepareClipStorage, validFileName } = require('../lib/clip-storage.cjs');

async function fixture(t) {
  const artifacts = path.resolve(__dirname, '..', '.artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const root = await fs.mkdtemp(path.join(artifacts, 'clip-storage-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const preferredClipsDir = path.join(root, 'Videos', 'Chzzk Desk');
  async function source(name, records) {
    const clipsDir = path.join(root, name);
    await fs.mkdir(clipsDir, { recursive: true });
    for (const [fileName, contents] of Object.entries(records)) await fs.writeFile(path.join(clipsDir, fileName), contents);
    return clipsDir;
  }
  return { root, preferredClipsDir, source };
}

test('copies legacy clips to the preferred directory, preserving originals and user metadata', async t => {
  const f = await fixture(t);
  const clipsDir = await f.source('legacy', { '한글 clip.mp4': 'complete video' });
  const record = { id: 'one', fileName: '한글 clip.mp4', title: '방송', note: 'keep this', duration: 30 };
  const result = await prepareClipStorage({ preferredClipsDir: f.preferredClipsDir, sources: [{ clipsDir, clips: [record] }] });
  assert.equal(result.ready, true);
  assert.deepEqual(result.clips, [record]);
  assert.deepEqual(result.warnings, []);
  assert.equal(await fs.readFile(path.join(f.preferredClipsDir, record.fileName), 'utf8'), 'complete video');
  assert.equal(await fs.readFile(path.join(clipsDir, record.fileName), 'utf8'), 'complete video');
  assert.equal(record.storageStatus, undefined);
});

test('same-name, same-size different files do not overwrite and repeated imports remain idempotent', async t => {
  const f = await fixture(t);
  const a = await f.source('a', { 'clip.mp4': 'AAAA' });
  const b = await f.source('b', { 'clip.mp4': 'BBBB' });
  const sources = [{ clipsDir: a, clips: [{ id: 'a', fileName: 'clip.mp4' }] },
    { clipsDir: b, clips: [{ id: 'b', fileName: 'clip.mp4' }] }];
  const first = await prepareClipStorage({ preferredClipsDir: f.preferredClipsDir, sources });
  assert.notEqual(first.clips[0].fileName, first.clips[1].fileName);
  assert.equal(await fs.readFile(path.join(f.preferredClipsDir, first.clips[0].fileName), 'utf8'), 'AAAA');
  assert.equal(await fs.readFile(path.join(f.preferredClipsDir, first.clips[1].fileName), 'utf8'), 'BBBB');
  const second = await prepareClipStorage({ preferredClipsDir: f.preferredClipsDir, sources });
  assert.deepEqual(second.clips, first.clips);
  assert.equal((await fs.readdir(f.preferredClipsDir)).length, 2);
  const merged = await prepareClipStorage({ preferredClipsDir: f.preferredClipsDir,
    sources: [{ clipsDir: f.preferredClipsDir, clips: first.clips }, ...sources] });
  assert.deepEqual(merged.clips, first.clips);
});

test('does not overwrite a pre-existing destination and reuses an identical destination', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.preferredClipsDir, { recursive: true });
  await fs.writeFile(path.join(f.preferredClipsDir, 'clip.mp4'), 'existing-user-file');
  const clipsDir = await f.source('legacy', { 'clip.mp4': 'legacy-file' });
  const input = { preferredClipsDir: f.preferredClipsDir, sources: [{ clipsDir, clips: [{ id: 'one', fileName: 'clip.mp4' }] }] };
  const result = await prepareClipStorage(input);
  assert.notEqual(result.clips[0].fileName, 'clip.mp4');
  assert.equal(await fs.readFile(path.join(f.preferredClipsDir, 'clip.mp4'), 'utf8'), 'existing-user-file');
  assert.deepEqual((await prepareClipStorage(input)).clips, result.clips);
  assert.equal((await fs.readdir(f.preferredClipsDir)).length, 2);
});

test('missing and copy-failed entries retain metadata and source paths while other clips migrate', async t => {
  const f = await fixture(t);
  const clipsDir = await f.source('legacy', { 'good.mp4': 'good', 'blocked.mp4': 'blocked' });
  const records = ['good', 'missing', 'blocked'].map(id => ({ id, fileName: `${id}.mp4`, note: `keep ${id}` }));
  const result = await prepareClipStorage({ preferredClipsDir: f.preferredClipsDir, sources: [{ clipsDir, clips: records }],
    copyFileImpl: async (from, to, flags) => {
      if (from.endsWith('blocked.mp4')) {
        await fs.writeFile(to, 'partial');
        throw Object.assign(new Error('injected write failure'), { code: 'ENOSPC' });
      }
      return fs.copyFile(from, to, flags);
    } });
  assert.equal(result.clips.length, 3);
  assert.equal(result.clips[0].storageStatus, undefined);
  assert.equal(result.clips[1].storageStatus, 'missing');
  assert.equal(result.clips[2].storageStatus, 'unmigrated');
  for (const index of [1, 2]) {
    assert.equal(result.clips[index].note, records[index].note);
    assert.equal(result.clips[index].storagePath, path.join(clipsDir, records[index].fileName));
  }
  assert.deepEqual(await fs.readdir(f.preferredClipsDir), ['good.mp4']);
  assert.equal(await fs.readFile(path.join(clipsDir, 'blocked.mp4'), 'utf8'), 'blocked');
  const retry = await prepareClipStorage({ preferredClipsDir: f.preferredClipsDir,
    sources: [{ clipsDir: f.preferredClipsDir, clips: result.clips }, { clipsDir, clips: result.clips }] });
  assert.equal(retry.clips.length, 3);
  assert.equal(retry.clips[2].storageStatus, undefined);
  assert.deepEqual(retry.warnings.map(warning => warning.code), ['missing']);
  assert.equal(await fs.readFile(path.join(f.preferredClipsDir, retry.clips[2].fileName), 'utf8'), 'blocked');
});

test('destination initialization failure never discards the legacy index', async t => {
  const f = await fixture(t);
  const clipsDir = await f.source('legacy', { 'clip.mp4': 'original' });
  const blockedDir = path.join(f.root, 'not-a-directory');
  await fs.writeFile(blockedDir, 'user file');
  const result = await prepareClipStorage({ preferredClipsDir: blockedDir,
    sources: [{ clipsDir, clips: [{ id: 'one', fileName: 'clip.mp4', title: 'saved title' }] }] });
  assert.equal(result.ready, false);
  assert.equal(result.clips.length, 1);
  assert.equal(result.clips[0].storagePath, path.join(clipsDir, 'clip.mp4'));
  assert.equal(result.clips[0].title, 'saved title');
  assert.equal(await fs.readFile(blockedDir, 'utf8'), 'user file');
});

test('different content with the same legacy id is retained with stable unique ids', async t => {
  const f = await fixture(t);
  const a = await f.source('a', { 'clip.mp4': 'AAAA' });
  const b = await f.source('b', { 'clip.mp4': 'BBBB' });
  const sources = [a, b].map(clipsDir => ({ clipsDir, clips: [{ id: 'same', fileName: 'clip.mp4' }] }));
  const input = { preferredClipsDir: f.preferredClipsDir, sources };
  const first = await prepareClipStorage(input);
  assert.equal(first.clips.length, 2);
  assert.notEqual(first.clips[0].id, first.clips[1].id);
  assert.equal(first.clips[1].originalId, 'same');
  assert.deepEqual((await prepareClipStorage(input)).clips, first.clips);
  const merged = await prepareClipStorage({ preferredClipsDir: f.preferredClipsDir,
    sources: [{ clipsDir: f.preferredClipsDir, clips: first.clips }, ...sources] });
  assert.deepEqual(merged.clips, first.clips);
});

test('preferred and legacy candidates merge without bogus missing records before and after migration', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.preferredClipsDir, { recursive: true });
  await fs.writeFile(path.join(f.preferredClipsDir, 'new.mp4'), 'new clip');
  const legacy = await f.source('legacy', { 'old.mp4': 'old clip' });
  const records = [{ id: 'old', fileName: 'old.mp4', note: 'old metadata' },
    { id: 'new', fileName: 'new.mp4', note: 'new metadata' }];
  const sources = [{ clipsDir: f.preferredClipsDir, clips: records }, { clipsDir: legacy, clips: records }];
  const first = await prepareClipStorage({ preferredClipsDir: f.preferredClipsDir, sources });
  assert.deepEqual(first.clips, records);
  assert.ok(first.clips.every(clip => !clip.storageStatus));
  assert.deepEqual(first.warnings, []);
  const next = await prepareClipStorage({ preferredClipsDir: f.preferredClipsDir,
    sources: [f.preferredClipsDir, legacy].map(clipsDir => ({ clipsDir, clips: first.clips })) });
  assert.deepEqual(next.clips, records);
  assert.deepEqual(next.warnings, []);
});

test('an index cannot inject an arbitrary source path or override generated migration status', async t => {
  const f = await fixture(t);
  const legacy = await f.source('legacy', {});
  const outside = path.join(f.root, 'private.mp4');
  await fs.writeFile(outside, 'must not read or copy');
  const result = await prepareClipStorage({ preferredClipsDir: f.preferredClipsDir,
    sources: [{ clipsDir: legacy, clips: [{ id: 'one', fileName: 'missing.mp4', storagePath: outside, storageStatus: 'ready' }] }] });
  assert.equal(result.clips[0].storageStatus, 'missing');
  assert.equal(result.clips[0].storagePath, path.join(legacy, 'missing.mp4'));
  assert.deepEqual(await fs.readdir(f.preferredClipsDir), []);
});

test('rejects unsafe Windows file names without reading outside a source directory', async t => {
  const f = await fixture(t);
  const unsafe = ['../outside.mp4', '..\\outside.mp4', 'C:\\outside.mp4', 'clip.mp4:stream.mp4',
    'NUL.mp4', 'con.mp4', 'LPT1.mp4', 'clip.mp4 ', 'clip.mp4.', 'bad\0.mp4'];
  for (const name of unsafe) assert.equal(validFileName(name), false);
  const result = await prepareClipStorage({ preferredClipsDir: f.preferredClipsDir,
    sources: [{ clipsDir: f.root, clips: unsafe.map((fileName, i) => ({ id: String(i), fileName })) }] });
  assert.equal(result.clips.length, unsafe.length);
  assert.ok(result.clips.every(clip => clip.storageStatus === 'invalid' && !clip.storagePath));
  assert.deepEqual(await fs.readdir(f.preferredClipsDir), []);
});
