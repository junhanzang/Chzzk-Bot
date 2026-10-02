'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveProfilePath } = require('../lib/profile-path.cjs');

const root = path.resolve('synthetic-profile-fixture');
const defaultPath = path.join(root, 'Roaming', 'Chzzk Desk');
const localAppData = path.join(root, 'Local');
const packageRoot = path.join(localAppData, 'Packages');
const profile = (name = 'OpenAI.Codex_test') => path.join(packageRoot, name, 'LocalCache', 'Roaming', 'Chzzk Desk');
const options = { defaultPath, localAppData, platform: 'win32' };

// This fake filesystem exposes only metadata calls. Content reads or writes fail.
function fixture() {
  const entries = new Map();
  const aliases = new Map();
  const denied = new Set();
  const calls = [];
  const absolute = value => path.resolve(value);
  const fail = code => { const error = new Error(code); error.code = code; throw error; };
  const inspect = value => {
    const target = absolute(value);
    if (denied.has(target)) return fail('EACCES');
    return entries.get(target) || fail('ENOENT');
  };
  function mkdir(value) {
    const target = absolute(value);
    if (!entries.has(target)) {
      const parent = path.dirname(target);
      if (parent !== target) mkdir(parent);
      entries.set(target, { directory: true, size: 0 });
    }
    return target;
  }
  function file(value, size = 1) {
    const target = absolute(value);
    mkdir(path.dirname(target));
    entries.set(target, { directory: false, size });
    return target;
  }
  const io = {
    statSync(value) {
      calls.push(['stat', absolute(value)]);
      const entry = inspect(value);
      return { size: entry.size, isDirectory: () => entry.directory, isFile: () => !entry.directory };
    },
    readdirSync(value) {
      const target = absolute(value);
      calls.push(['readdir', target]);
      if (!inspect(target).directory) return fail('ENOTDIR');
      return [...entries].filter(([name]) => name !== target && path.dirname(name) === target)
        .map(([name, entry]) => ({ name: path.basename(name), isDirectory: () => entry.directory, isFile: () => !entry.directory }));
    },
    realpathSync: { native(value) {
      const target = absolute(value);
      calls.push(['realpath', target]);
      inspect(target);
      return aliases.get(target) || target;
    } }
  };
  return { io, mkdir, file, aliases, denied, calls };
}

test('explicit profile wins, resolves existing redirects, and never discovers packages', () => {
  const f = fixture();
  const explicit = f.mkdir(path.join(root, 'override'));
  const physical = path.join(root, 'physical-override');
  f.aliases.set(explicit, physical);
  f.file(path.join(profile(), 'settings.json'));
  assert.equal(resolveProfilePath({ ...options, explicitPath: explicit }, f.io), physical);
  assert.deepEqual(f.calls, [['realpath', explicit]]);
  assert.equal(resolveProfilePath({ ...options, explicitPath: path.join(root, 'new-override') }, f.io), path.join(root, 'new-override'));
});

test('established default profile remains selected and is canonicalized', () => {
  const f = fixture();
  f.file(path.join(defaultPath, 'settings.json'), 0);
  const physical = profile();
  f.aliases.set(defaultPath, physical);
  f.file(path.join(physical, 'settings.json'));
  assert.equal(resolveProfilePath(options, f.io), physical);
  assert.ok(!f.calls.some(([operation, target]) => operation === 'readdir' && target === packageRoot));
});

test('existing browser profile metadata preserves default even without settings', () => {
  for (const dataFile of ['Preferences', path.join('Partitions', 'chzzk-viewer', 'Preferences')]) {
    const f = fixture();
    f.file(path.join(defaultPath, dataFile));
    f.file(path.join(profile(), 'settings.json'));
    assert.equal(resolveProfilePath(options, f.io), defaultPath);
    assert.ok(!f.calls.some(([operation, target]) => operation === 'readdir' && target === packageRoot));
  }
});

test('empty startup directory and empty cache placeholders allow one legacy profile', () => {
  const f = fixture();
  f.mkdir(path.join(defaultPath, 'Cache'));
  f.file(path.join(defaultPath, 'empty-placeholder'), 0);
  const recovered = profile();
  f.file(path.join(recovered, 'settings.json'));
  assert.equal(resolveProfilePath(options, f.io), recovered);
});

test('legacy session metadata is recognized without reading cookie or settings content', () => {
  const f = fixture();
  const recovered = profile();
  f.file(path.join(recovered, 'Partitions', 'chzzk-viewer', 'Preferences'));
  assert.equal(resolveProfilePath(options, f.io), recovered);
  assert.ok(f.calls.every(([operation]) => ['stat', 'readdir', 'realpath'].includes(operation)));
});

test('multiple legacy profiles never select an account by name or recency', () => {
  const f = fixture();
  f.file(path.join(profile('OpenAI.Codex_first'), 'settings.json'));
  f.file(path.join(profile('OpenAI.Codex_second'), 'settings.json'));
  assert.equal(resolveProfilePath(options, f.io), defaultPath);
});

test('package search only inspects the exact app path inside Codex package directories', () => {
  const f = fixture();
  const unrelated = profile('Other.App_test');
  f.file(path.join(unrelated, 'settings.json'));
  f.mkdir(profile());
  f.file(path.join(packageRoot, 'OpenAI.Codex_test', 'LocalCache', 'Roaming', 'Another App', 'settings.json'));
  assert.equal(resolveProfilePath(options, f.io), defaultPath);
  assert.ok(!f.calls.some(([, target]) => target.startsWith(path.join(packageRoot, 'Other.App_test')) || target.includes(`${path.sep}Another App`)));
});

test('non-Windows or missing LOCALAPPDATA never triggers package discovery', () => {
  for (const overrides of [{ platform: 'linux' }, { localAppData: '' }]) {
    const f = fixture();
    f.file(path.join(profile(), 'settings.json'));
    assert.equal(resolveProfilePath({ ...options, ...overrides }, f.io), defaultPath);
    assert.ok(!f.calls.some(([operation, target]) => operation === 'readdir' && target === packageRoot));
  }
});

test('unreadable established default is not silently replaced with another profile', () => {
  const f = fixture();
  f.mkdir(defaultPath);
  f.denied.add(defaultPath);
  f.file(path.join(profile(), 'settings.json'));
  assert.equal(resolveProfilePath(options, f.io), defaultPath);
  assert.ok(!f.calls.some(([operation, target]) => operation === 'readdir' && target === packageRoot));
});

test('missing or inaccessible package directory falls back to the normal profile', () => {
  const f = fixture();
  assert.equal(resolveProfilePath(options, f.io), defaultPath);
  f.mkdir(packageRoot);
  f.denied.add(packageRoot);
  assert.equal(resolveProfilePath(options, f.io), defaultPath);
});

test('an inaccessible alternative profile prevents guessing among package accounts', () => {
  const f = fixture();
  f.file(path.join(profile('OpenAI.Codex_first'), 'settings.json'));
  const blocked = f.mkdir(profile('OpenAI.Codex_second'));
  f.denied.add(blocked);
  assert.equal(resolveProfilePath(options, f.io), defaultPath);
});
