'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('unpacked extension entrypoints and their local assets are included in the folder', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  const paths = [manifest.background.service_worker, manifest.side_panel.default_path, 'shared/channels.js', 'lib/core.js'];
  for (const content of manifest.content_scripts || []) paths.push(...(content.js || []), ...(content.css || []));
  const panel = await fs.readFile(path.join(root, manifest.side_panel.default_path), 'utf8');
  for (const match of panel.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) paths.push(match[1]);
  const visited = new Set();
  for (const relative of paths) {
    const target = path.resolve(root, relative);
    assert.ok(target.startsWith(root + path.sep), 'Packaged assets must remain inside the extension folder');
    if (visited.has(target)) continue;
    visited.add(target);
    assert.equal((await fs.stat(target)).isFile(), true, relative);
    if (/\.(?:m?js)$/.test(target)) {
      const source = await fs.readFile(target, 'utf8');
      // Follow static imports and re-exports, so extracting a module cannot silently omit it from the unpacked folder.
      for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"](\.[^'"]+)['"]/g)) {
        paths.push(path.relative(root, path.resolve(path.dirname(target), match[1])));
      }
    }
  }
  assert.ok(!/<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(panel), 'MV3 does not permit inline script execution');
});

test('suggested shortcuts follow Chrome command constraints and request no broad browsing access', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  const suggested = Object.values(manifest.commands).filter(command => command.suggested_key);
  assert.ok(suggested.length <= 4);
  for (const command of suggested) {
    const keys = typeof command.suggested_key === 'string' ? [command.suggested_key] : Object.values(command.suggested_key);
    for (const value of keys) {
      assert.ok(!value.includes('Ctrl+Alt'), 'Chrome rejects Ctrl+Alt to avoid AltGr conflicts');
      assert.match(value, /^(?:Ctrl|Alt)(?:\+Shift)?\+[A-Z0-9]$/);
    }
  }
  assert.ok(!manifest.host_permissions.includes('<all_urls>'));
  assert.ok(!manifest.permissions.includes('cookies'));
  assert.ok(!manifest.permissions.includes('debugger'));
  assert.equal(manifest.incognito, 'not_allowed');
  for (const content of manifest.content_scripts || []) {
    assert.deepEqual(content.matches, ['https://chzzk.naver.com/*']);
    assert.equal(content.all_frames, false);
    assert.notEqual(content.world, 'MAIN');
  }
});
