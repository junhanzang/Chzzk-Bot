'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { botSourceResources, ROOT_FILES } = require('../scripts/bot-resources.cjs');

test('Python packaging uses individual files and never scans the repository or nested caches', () => {
  const root = path.resolve(__dirname, '../..');
  const scanned = [];
  const fileSystem = {
    lstatSync: file => fs.lstatSync(file),
    readdirSync(folder, options) {
      assert([path.join(root, 'bot'), path.join(root, 'memory')].includes(folder), `Unexpected traversal: ${folder}`);
      scanned.push(folder);
      return fs.readdirSync(folder, options);
    }
  };
  const resources = botSourceResources(root, fileSystem);
  assert.equal(scanned.length, 2);
  assert(resources.every(entry => fs.lstatSync(entry.from).isFile() && !entry.filter));
  assert(resources.every(entry => entry.to.startsWith('bot/') && !/\.pytest_cache|__pycache__|node_modules|\/data\//.test(entry.to)));
  assert(!resources.some(entry => entry.to === 'bot/.env'));
  const expected = [...ROOT_FILES, ...['bot', 'memory'].flatMap(directory => fs.readdirSync(path.join(root, directory), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.py')).map(entry => `${directory}/${entry.name}`))].sort();
  assert.deepEqual(resources.map(entry => entry.to.slice(4)).sort(), expected);
  assert(resources.some(entry => entry.to === 'bot/bot/model_transport.py'));
  assert(resources.some(entry => entry.to === 'bot/bot/control.py'));
});

test('missing required runtime aborts before invoking electron-builder', () => {
  const root = path.resolve(__dirname, '../..');
  const fileSystem = {
    lstatSync: file => fs.lstatSync(file),
    readdirSync: (folder, options) => fs.readdirSync(folder, options).filter(entry => entry.name !== 'control.py')
  };
  assert.throws(() => botSourceResources(root, fileSystem), /Missing bot source: bot\/control.py/);
});
