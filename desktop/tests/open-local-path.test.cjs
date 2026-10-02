'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openLocalPath } = require('../lib/open-local-path.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-open-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const actual = path.join(root, '실제 보관 폴더');
  await fs.mkdir(actual);
  const virtual = path.join(root, 'virtual-appdata');
  await fs.symlink(actual, virtual, process.platform === 'win32' ? 'junction' : 'dir');
  const fileName = '[방송] 등 장.mp4';
  await fs.writeFile(path.join(actual, fileName), 'fixture');
  return { actual, virtual, fileName };
}

test('folder and clip shell handoffs use physical paths, preserving spaces and Korean names', async t => {
  const { actual, virtual, fileName } = await fixture(t);
  const opened = [];
  const openPath = async target => { opened.push(target); return ''; };
  await openLocalPath(virtual, { kind: 'directory', openPath });
  await openLocalPath(path.join(virtual, fileName), { kind: 'file', openPath });
  assert.deepEqual(opened, [await fs.realpath(actual), await fs.realpath(path.join(actual, fileName))]);
});

test('missing targets and wrong file types never reach the shell', async t => {
  const { actual, virtual, fileName } = await fixture(t);
  const openPath = () => assert.fail('Shell must not run for an invalid target');
  await assert.rejects(openLocalPath(path.join(virtual, 'missing.mp4'), { kind: 'file', openPath }), /클립 파일/);
  await assert.rejects(openLocalPath(actual, { kind: 'file', openPath }), /클립 파일/);
  await assert.rejects(openLocalPath(path.join(actual, fileName), { kind: 'directory', openPath }), /보관 폴더/);
});

test('shell association failures are reported instead of treated as a successful open', async t => {
  const { actual, fileName } = await fixture(t);
  await assert.rejects(openLocalPath(path.join(actual, fileName), {
    kind: 'file', openPath: async () => 'No application associated'
  }), /기본 동영상 앱/);
});
