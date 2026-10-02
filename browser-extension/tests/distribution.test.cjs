'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectRuntimeFiles, packageExtension, crc32 } = require('../scripts/package.cjs');
const extensionRoot = path.resolve(__dirname, '..');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-extension-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, name, text) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

function fixture(t) {
  const root = path.join(temporary(t), 'extension');
  write(root, '../LICENSE', 'Test distribution license');
  write(root, 'package.json', JSON.stringify({ version: '1.2.3' }));
  write(root, 'manifest.json', JSON.stringify({ manifest_version: 3, version: '1.2.3',
    background: { service_worker: 'background.js', type: 'module' }, side_panel: { default_path: 'panel.html' } }));
  write(root, 'background.js', "import './lib/core.js'; import './lib/extra.js';\nchrome.runtime.getURL('panel.html');\n");
  write(root, 'lib/core.js', "export { value } from './value.mjs';\n");
  write(root, 'lib/extra.js', 'export const extra = true;\n');
  write(root, 'lib/value.mjs', 'export const value = 1;\n');
  write(root, 'panel.html', '<link rel="stylesheet" href="panel.css"><script src="panel.js" type="module"></script>');
  write(root, 'panel.css', '@import "assets/theme.css"; .logo { background: url("assets/mark.svg"); }');
  write(root, 'assets/theme.css', ':root { color: black; }');
  write(root, 'assets/mark.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  write(root, 'panel.js', "import('./lib/value.mjs');\n");
  return root;
}

// Read the emitted ZIP independently from the writer using its central directory.
function unzipStored(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 20), 0);
  const count = bytes.readUInt16LE(end + 10);
  let position = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(position), 0x02014b50);
    assert.equal(bytes.readUInt16LE(position + 10), 0, 'Only STORE entries are emitted');
    const size = bytes.readUInt32LE(position + 24);
    assert.equal(size, bytes.readUInt32LE(position + 20));
    const nameSize = bytes.readUInt16LE(position + 28);
    const extraSize = bytes.readUInt16LE(position + 30);
    const commentSize = bytes.readUInt16LE(position + 32);
    const name = bytes.subarray(position + 46, position + 46 + nameSize).toString('utf8');
    const local = bytes.readUInt32LE(position + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt32LE(local + 22), size);
    assert.equal(bytes.readUInt32LE(local + 14), bytes.readUInt32LE(position + 16));
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    assert.equal(bytes.subarray(local + 30, local + 30 + nameSize).toString('utf8'), name);
    const content = bytes.subarray(dataStart, dataStart + size);
    assert.equal(crc32(content), bytes.readUInt32LE(position + 16), `CRC mismatch: ${name}`);
    assert.ok(!entries.has(name), `Duplicate ZIP entry: ${name}`);
    entries.set(name, content);
    position += 46 + nameSize + extraSize + commentSize;
  }
  assert.equal(position, end);
  return entries;
}

test('actual extension ZIP contains every runtime module and no development files', t => {
  const outputDir = temporary(t);
  const result = packageExtension({ root: extensionRoot, outputDir });
  const entries = unzipStored(fs.readFileSync(result.output));
  const expected = ['LICENSE', 'manifest.json', 'background.js', 'panel.html', 'panel.css', 'panel.js'];
  for (const directory of ['lib', 'ui', 'shared', 'content']) {
    const walk = current => {
      for (const entry of fs.readdirSync(path.join(extensionRoot, current), { withFileTypes: true })) {
        const relative = `${current}/${entry.name}`;
        if (entry.isDirectory()) walk(relative);
        else if (/\.m?js$/.test(entry.name)) expected.push(relative);
      }
    };
    walk(directory);
  }
  assert.deepEqual([...entries.keys()], expected.sort());
  for (const [name, bytes] of entries) assert.deepEqual(bytes, fs.readFileSync(path.join(extensionRoot, name === 'LICENSE' ? '../LICENSE' : name)), name);
  const manifest = JSON.parse(entries.get('manifest.json'));
  assert.equal(path.basename(result.output), `chzzk-desk-chrome-${manifest.version}.zip`);
  assert.equal(result.bytes, fs.statSync(result.output).size);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'Standard CRC-32 known answer');
});

test('ZIP follows nested imports and CSS assets, excludes unrelated private files, and is reproducible', t => {
  const root = fixture(t);
  for (const name of ['.env', 'secrets.json', 'README.md', 'tests/leak.test.cjs', 'scripts/dev.js', 'unused.js']) write(root, name, 'must not ship');
  const first = packageExtension({ root, outputDir: path.join(root, 'first') });
  const second = packageExtension({ root, outputDir: path.join(root, 'second') });
  const firstBytes = fs.readFileSync(first.output);
  assert.deepEqual(firstBytes, fs.readFileSync(second.output));
  assert.deepEqual([...unzipStored(firstBytes).keys()], ['LICENSE', 'assets/mark.svg', 'assets/theme.css', 'background.js',
    'lib/core.js', 'lib/extra.js', 'lib/value.mjs', 'manifest.json', 'panel.css', 'panel.html', 'panel.js']);
});

test('invalid or mismatched versions fail before an artifact is created', t => {
  const root = fixture(t);
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  for (const version of ['01.2.3', '1.2.3-beta', '65536.0', '0.0.0', '1.2.3.4.5', '2.0.0']) {
    write(root, 'manifest.json', JSON.stringify({ ...manifest, version }));
    assert.throws(() => packageExtension({ root }), /version/i);
    assert.equal(fs.existsSync(path.join(root, 'dist')), false);
  }
});

test('missing, external, private, computed and escaping dependencies fail closed', t => {
  const root = fixture(t);
  const cases = [
    ["import './missing.js';", /ENOENT/],
    ["import 'https://example.com/remote.js';", /local asset/],
    ["import '../../outside.js';", /escapes/],
    ["import '../tests/source.js';", /non-runtime/],
    ["import '../secret.js';", /private/],
    ["import(moduleName);", /computed/]
  ];
  for (const [source, expected] of cases) {
    write(root, 'lib/core.js', source);
    assert.throws(() => collectRuntimeFiles(root), expected);
  }
});

test('directory symlinks cannot pull files from outside the extension into the ZIP', t => {
  const root = fixture(t), outside = temporary(t);
  write(outside, 'entry.js', 'export const unexpected = true;');
  fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  write(root, 'lib/core.js', "import '../linked/entry.js';");
  assert.throws(() => collectRuntimeFiles(root), /Symlinks/);
});
