'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { allowedAppFile, checkRelativeReferences } = require('../scripts/verify-package.cjs');

test('distribution rejects profiles, recordings, development tools and unintended extension files', () => {
  for (const file of ['desktop/.artifacts/profile/Cookies', 'desktop/settings.json', 'desktop/clips.json',
    'desktop/ui/.env', 'desktop/lib/.env.cjs', 'desktop/clips/live.mp4', 'desktop/tests/auth-session.test.cjs',
    'node_modules/electron/index.js', 'browser-extension/background.js', 'browser-extension/shared/private.json']) {
    assert.equal(allowedAppFile(file), false, file);
  }
  for (const file of ['desktop/main.cjs', 'desktop/lib/rewards-host.cjs', 'desktop/ui/index.html',
    'browser-extension/shared/rewards.js', 'browser-extension/shared/ui/model.mjs']) assert(allowedAppFile(file), file);
});

test('distribution resolves CommonJS, shared ES module and HTML asset references across the preserved tree', () => {
  const contents = new Map([
    ['desktop/lib/channels.cjs', "module.exports = require('../../browser-extension/shared/channels.js');"],
    ['browser-extension/shared/channels.js', 'module.exports = {};'],
    ['desktop/ui/index.html', '<script src="renderer.mjs"></script><a href="#">home</a>'],
    ['desktop/ui/renderer.mjs', "import '../../browser-extension/shared/channels.js';"],
    ['browser-extension/shared/package.json', '{"type":"commonjs"}']
  ]);
  checkRelativeReferences([...contents.keys()], file => contents.get(file));
  contents.delete('browser-extension/shared/channels.js');
  assert.throws(() => checkRelativeReferences([...contents.keys()], file => contents.get(file)), /Missing packaged reference/);
});
