'use strict';

// Inspect the real bundle without executing Electron or opening a window.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const asar = require('@electron/asar');

function allowedAppFile(file) {
  return ['package.json', 'LICENSE', 'desktop/main.cjs', 'desktop/preload.cjs'].includes(file) ||
    /^desktop\/lib\/[a-z0-9-]+\.cjs$/.test(file) ||
    /^desktop\/ui\/[a-z0-9-]+\.(?:mjs|html|css)$/.test(file) ||
    /^browser-extension\/shared\/(?:channels\.js|presentation\.js|rewards\.js|chat-observer\.js|package\.json|REWARDS-SOURCES\.md|ui\/[a-z0-9-]+\.mjs)$/.test(file);
}

function checkRelativeReferences(files, readFile) {
  const existing = new Set(files);
  for (const file of files) {
    const source = readFile(file);
    const references = [];
    if (/\.(?:cjs|mjs|js)$/.test(file)) {
      for (const expression of [/\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g, /(?:\bfrom\s*|\bimport\s*)['"](\.[^'"]+)['"]/g]) {
        for (const match of source.matchAll(expression)) references.push(match[1]);
      }
    } else if (file.endsWith('.html')) {
      for (const match of source.matchAll(/\b(?:src|href)=["']([^"'#]+)["']/g)) {
        if (!/^(?:https?:|data:)/.test(match[1])) references.push(match[1]);
      }
    }
    for (const reference of references) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), reference));
      assert(existing.has(resolved), `Missing packaged reference: ${file} -> ${reference}`);
    }
  }
}

function assertWindowsX64(file) {
  const binary = fs.readFileSync(file);
  assert(binary.length > 64 && binary.toString('ascii', 0, 2) === 'MZ', `Not a Windows executable: ${file}`);
  const pe = binary.readUInt32LE(0x3c);
  assert(pe + 6 <= binary.length && binary.toString('ascii', pe, pe + 4) === 'PE\0\0', `Invalid PE header: ${file}`);
  assert.equal(binary.readUInt16LE(pe + 4), 0x8664, `Executable is not Windows x64: ${file}`);
}

function verifyPackage(appDirectory = path.resolve(__dirname, '..', 'dist', 'win-unpacked')) {
  const archive = path.join(appDirectory, 'resources', 'app.asar');
  const files = asar.listPackage(archive).map(file => file.replace(/\\/g, '/').replace(/^\//, ''))
    .filter(file => !asar.statFile(archive, file.split('/').join(path.sep)).files);
  assert(files.length > 0, 'Application archive is empty');
  for (const file of files) assert(allowedAppFile(file), `Unexpected file in app.asar: ${file}`);
  for (const file of ['package.json', 'desktop/main.cjs', 'desktop/preload.cjs', 'desktop/ui/index.html',
    'browser-extension/shared/channels.js', 'browser-extension/shared/chat-observer.js', 'browser-extension/shared/rewards.js', 'browser-extension/shared/REWARDS-SOURCES.md']) {
    assert(files.includes(file), `Required package file is missing: ${file}`);
  }
  const readFile = file => asar.extractFile(archive, file.split('/').join(path.sep)).toString('utf8');
  const metadata = JSON.parse(readFile('package.json'));
  assert.equal(metadata.main, 'desktop/main.cjs');
  assert.equal(metadata.version, require('../package.json').version);
  assert.equal(JSON.parse(readFile('browser-extension/shared/package.json')).type, 'commonjs');
  checkRelativeReferences(files, readFile);
  assert.equal(fs.readFileSync(path.join(appDirectory, 'resources', 'LICENSE'), 'utf8'), fs.readFileSync(path.resolve(__dirname, '..', '..', 'LICENSE'), 'utf8'));
  assertWindowsX64(path.join(appDirectory, 'Chzzk Desk.exe'));
  const ffmpeg = path.join(appDirectory, 'resources', 'ffmpeg');
  assertWindowsX64(path.join(ffmpeg, 'ffmpeg.exe'));
  for (const file of ['ffmpeg.exe', 'ffmpeg.exe.LICENSE', 'ffmpeg.exe.README']) {
    const digest = target => createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    assert.equal(digest(path.join(ffmpeg, file)), digest(path.resolve(__dirname, '..', 'node_modules', 'ffmpeg-static', file)),
      `Bundled FFmpeg file differs from the locked dependency: ${file}`);
  }
  console.log(`Verified Windows x64 package: ${files.length} application files, relative imports, FFmpeg and licenses.`);
  return { files, version: metadata.version };
}

if (require.main === module) verifyPackage(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
module.exports = { verifyPackage, allowedAppFile, checkRelativeReferences, assertWindowsX64 };
