'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ProfileStore } = require('../lib/profile-store.cjs');
const directory = path.resolve('VIRTUAL-profile-store');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const files = new Map(), effects = [];
  const fileSystem = {
    async readFile(file) { if (!files.has(file)) throw new Error('Missing'); return files.get(file); },
    async writeFile(file, text) { effects.push(['write', path.basename(file), text]); files.set(file, text); },
    async rename(from, to) { effects.push(['rename', path.basename(from), path.basename(to)]); files.set(to, files.get(from)); files.delete(from); },
    async rm(file) { files.delete(file); }
  };
  const store = new ProfileStore(directory, { fileSystem });
  return { files, effects, fileSystem, store };
}

test('store loads fixed documents and defaults independently when one is damaged', async () => {
  const f = fixture();
  f.files.set(path.join(directory, 'settings.json'), '{corrupt');
  f.files.set(path.join(directory, 'clips.json'), '[{"id":"kept"}]');
  assert.deepEqual(await f.store.load(), { settings: {}, clips: [{ id: 'kept' }] });
  assert.throws(() => new ProfileStore('../relative'), /경로/);
});

test('queued saves snapshot at request time and never interleave document replacements', async () => {
  const f = fixture(), gate = deferred();
  const write = f.fileSystem.writeFile;
  let first = true;
  f.fileSystem.writeFile = async (...args) => { if (first) { first = false; await gate.promise; } return write(...args); };
  const state = { settings: { clipSeconds: 15 }, clips: [] };
  const one = f.store.save(state);
  state.settings.clipSeconds = 60;
  const two = f.store.save(state);
  state.settings.clipSeconds = 30;
  gate.resolve(); await Promise.all([one, two]); await f.store.flush();
  assert.deepEqual(f.effects.map(effect => effect.slice(0, 2)), [
    ['write', 'settings.json.tmp'], ['rename', 'settings.json.tmp'], ['write', 'clips.json.tmp'], ['rename', 'clips.json.tmp'],
    ['write', 'settings.json.tmp'], ['rename', 'settings.json.tmp'], ['write', 'clips.json.tmp'], ['rename', 'clips.json.tmp']
  ]);
  assert.equal(JSON.parse(f.effects[0][2]).clipSeconds, 15);
  assert.equal(JSON.parse(f.files.get(path.join(directory, 'settings.json'))).clipSeconds, 60);
});

test('failed atomic replacement preserves the previous document and subsequent saves recover', async () => {
  const f = fixture(); await f.store.save({ settings: { clipSeconds: 30 }, clips: [] });
  const rename = f.fileSystem.rename;
  f.fileSystem.rename = async () => { throw new Error('Disk busy'); };
  await assert.rejects(f.store.save({ settings: { clipSeconds: 60 }, clips: [] }), /Disk busy/);
  assert.equal(JSON.parse(f.files.get(path.join(directory, 'settings.json'))).clipSeconds, 30);
  assert.equal(f.files.has(path.join(directory, 'settings.json.tmp')), false);
  f.fileSystem.rename = rename;
  await f.store.save({ settings: { clipSeconds: 15 }, clips: [{ id: 'saved' }] });
  assert.deepEqual(await f.store.load(), { settings: { clipSeconds: 15 }, clips: [{ id: 'saved' }] });
});
