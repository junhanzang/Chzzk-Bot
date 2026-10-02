'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ClipLibrary, clipRecord, loadClipLibrary } = require('../lib/clip-library.cjs');
const { DeskController } = require('../lib/desk-controller.cjs');

const clip = (id, extra = {}) => ({ id, fileName: `${id}.mp4`, title: `장면 ${id}`, channelId: 'one', createdAt: '2026-10-01T01:00:00Z', duration: 30, ...extra });
function library(clips, options = {}) {
  return new ClipLibrary({ clips, clipsDir: path.resolve('unused-clips'), legacyFiles: new Map(), persist: async () => {}, ...options });
}

test('metadata changes persist without changing the MP4 name and survive library reload', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-library-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const clipsDir = path.join(directory, 'videos'); await fs.mkdir(clipsDir);
  const records = [clip('one', { trigger: 'keyword' })], snapshots = [];
  await fs.writeFile(path.join(clipsDir, 'one.mp4'), 'synthetic file');
  const source = library(records, { clipsDir, persist: async () => snapshots.push(JSON.parse(JSON.stringify(records))) });
  const result = await source.update({ id: 'one', title: '  바꾼 제목 <장면>  ', favorite: true });
  assert.equal(result.title, '바꾼 제목 <장면>'); assert.equal(result.favorite, true);
  assert.equal(result.fileName, 'one.mp4'); assert.equal(result.trigger, 'keyword');
  assert.deepEqual(await fs.readdir(clipsDir), ['one.mp4']);
  const loaded = await loadClipLibrary({ indexed: snapshots[0], dataDir: directory, preferredClipsDir: clipsDir });
  assert.equal(loaded.clips.length, 1); assert.equal(loaded.clips[0].title, result.title); assert.equal(loaded.clips[0].favorite, true);
  assert.equal(clipRecord(clip('old')).favorite, false);
  assert.equal(clipRecord(clip('invalid', { favorite: 'true' })).favorite, false);
});

test('metadata accepts only known IDs and a strictly validated title/favorite patch', async () => {
  let persisted = 0; const source = library([clip('one')], { persist: async () => { persisted++; } });
  for (const argument of [null, [], {}, { id: 'one' }, { id: 1, favorite: true }, { id: 'one', title: '' },
    { id: 'one', title: ' ' }, { id: 'one', title: 'x'.repeat(101) }, { id: 'one', title: 'line\nbreak' },
    { id: 'one', title: null }, { id: 'one', favorite: 1 }, { id: 'one', favorite: false, fileName: '../outside.mp4' }]) {
    assert.throws(() => source.update(argument));
  }
  await assert.rejects(source.update({ id: 'missing', favorite: true }), /찾지/);
  assert.equal(persisted, 0); assert.equal(source.clips[0].title, '장면 one');
});

test('serialized metadata writes preserve simultaneous title and favorite edits and recover from failure', async () => {
  let release, saves = 0;
  const source = library([clip('one')], { persist: () => ++saves === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve() });
  const rename = source.update({ id: 'one', title: 'new title' });
  const star = source.update({ id: 'one', favorite: true });
  await Promise.resolve(); assert.equal(saves, 1); release(); await Promise.all([rename, star]);
  assert.equal(source.clips[0].title, 'new title'); assert.equal(source.clips[0].favorite, true);
  source.persist = async () => { throw new Error('disk full'); };
  await assert.rejects(source.update({ id: 'one', title: 'lost' }), /disk full/);
  assert.equal(source.clips[0].title, 'new title');
  source.persist = async () => {};
  await source.update({ id: 'one', favorite: false }); assert.equal(source.clips[0].favorite, false);
});

test('query searches the entire index, normalizes terms and paginates within a bounded page', () => {
  const records = Array.from({ length: 235 }, (_, index) => clip(String(index), {
    title: index === 220 ? 'ＦＵＬＬ 너머의 장면' : '평범한 장면', createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
  }));
  const source = library(records);
  const first = source.query(); assert.equal(first.items.length, 50); assert.equal(first.total, 235); assert.equal(first.items[0].id, '234');
  const second = source.query({ offset: 50, limit: 100 }); assert.equal(second.items.length, 100); assert.equal(second.items[0].id, '184');
  const found = source.query({ query: 'FULL 방송이름 장면' }, [{ id: 'one', name: '방송이름' }]);
  assert.equal(found.total, 1); assert.equal(found.items[0].id, '220');
  assert.equal(source.query({ offset: 999 }).items.length, 0);
  first.items[0].title = 'client mutation'; assert.notEqual(source.clips.at(-1).title, 'client mutation');
});

test('queries see committed metadata while persistence is pending and registration waits for the same queue', async () => {
  const writes = []; let fail;
  const records = [clip('one')];
  const source = library(records, { persist: () => {
    writes.push(JSON.parse(JSON.stringify(records)));
    return writes.length === 1 ? new Promise((_, reject) => { fail = reject; }) : Promise.resolve();
  } });
  const rename = source.update({ id: 'one', title: 'uncommitted', favorite: true });
  await Promise.resolve();
  assert.equal(source.query().items[0].title, '장면 one');
  assert.equal(source.query({ query: 'uncommitted' }).total, 0);
  assert.equal(source.query({ filter: 'starred' }).total, 0);
  const registered = source.register(clip('two'));
  await Promise.resolve(); assert.equal(writes.length, 1); assert.equal(records.length, 1);
  const failed = assert.rejects(rename, /disk full/); fail(new Error('disk full')); await failed; await registered;
  assert.equal(writes.length, 2); assert.equal(writes[1].find(item => item.id === 'one').title, '장면 one');
  assert.equal(source.query({ query: 'uncommitted' }).total, 0);
  assert.equal(source.query().total, 2);
});

for (const succeeds of [true, false]) test(`pending registration preserves page snapshots and publishes retained clips after ${succeeds ? 'successful' : 'failed'} persistence`, async () => {
  let finish, fail, published = 0;
  const source = library(Array.from({ length: 52 }, (_, index) => clip(String(index))), {
    persist: () => new Promise((resolve, reject) => { finish = resolve; fail = reject; })
  });
  const controller = Object.assign(Object.create(DeskController.prototype), {
    library: source, settings: { channels: [] }, clipSession: 'test', clipCounter: 0, publish: () => { published++; }
  });
  const before = controller.queryClips({ offset: 0, limit: 50 });
  const operation = controller.registerClip(clip('new', { createdAt: '2026-11-01' }));
  await Promise.resolve();
  assert.equal(source.clips.length, 53, 'The index writer can see the completed file');
  const whileWriting = controller.queryClips({ offset: 50, limit: 50 });
  assert.equal(whileWriting.revision, before.revision); assert.equal(whileWriting.total, 52);
  assert.deepEqual(whileWriting.items.map(item => item.id), ['50', '51']);
  assert.equal(controller.queryClips({ query: 'new' }).total, 0);
  assert.equal(published, 0);
  if (succeeds) { finish(); await operation; }
  else { const rejected = assert.rejects(operation, /disk full/); fail(new Error('disk full')); await rejected; }
  const after = controller.queryClips({ offset: 0, limit: 50 });
  assert.notEqual(after.revision, before.revision); assert.equal(after.total, 53); assert.equal(after.items[0].id, 'new');
  assert.equal(source.clips[0].fileName, 'new.mp4', 'Completed MP4 recovery metadata is retained after index failure');
  assert.equal(published, 1);
});

test('filters distinguish manual, keyword and chat-spike clips and sort invalid dates last', () => {
  const source = library([clip('manual', { createdAt: '2026-01-02', favorite: true }),
    clip('keyword', { createdAt: '2026-01-01', trigger: 'keyword', favorite: true }),
    clip('spike', { createdAt: '2026-01-03', trigger: 'chat-spike' }), clip('unknown-date', { createdAt: null })]);
  const ids = args => source.query(args).items.map(item => item.id);
  assert.deepEqual(ids({ filter: 'starred' }), ['manual', 'keyword']);
  assert.deepEqual(ids({ filter: 'manual' }), ['manual', 'unknown-date']);
  assert.deepEqual(ids({ filter: 'auto', sort: 'oldest' }), ['keyword', 'spike']);
  assert.deepEqual(ids({ filter: 'keyword' }), ['keyword']); assert.deepEqual(ids({ filter: 'chat-spike' }), ['spike']);
  assert.deepEqual(ids({ sort: 'oldest' }), ['keyword', 'manual', 'spike', 'unknown-date']);
});

test('query rejects unbounded and malformed requests', () => {
  const source = library([]);
  for (const argument of [null, [], { unknown: true }, { query: 1 }, { query: 'x'.repeat(201) },
    { filter: 'any' }, { sort: 'random' }, { offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 }, { limit: 101 }, { limit: Infinity }, { limit: '50' }]) assert.throws(() => source.query(argument));
});

test('reveal resolves only indexed validated existing files and keeps physical paths out of records', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-reveal-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'one.mp4'); await fs.writeFile(file, 'synthetic file');
  const revealed = [], source = library([clip('one'), clip('missing'), clip('unsafe', { fileName: '../outside.mp4' })], {
    clipsDir: directory, revealPath: async target => { revealed.push(target); }
  });
  await source.reveal('one'); assert.equal(revealed.length, 1); assert.equal(revealed[0], await fs.realpath(file));
  await assert.rejects(source.reveal('missing'), /이동되거나/); await assert.rejects(source.reveal('unknown'), /찾지/);
  await assert.rejects(source.reveal('unsafe'), /찾지/); assert.equal(revealed.length, 1);
  assert.equal(source.query().items.some(record => Object.hasOwn(record, 'storagePath')), false);
});
