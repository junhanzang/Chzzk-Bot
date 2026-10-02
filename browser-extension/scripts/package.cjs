'use strict';

// No bundler or ZIP dependency: package only the manifest's reachable runtime files.
const fs = require('node:fs');
const path = require('node:path');

const DENIED_PARTS = /^(?:\..*|tests?|scripts?|docs?|dist|node_modules|package(?:-lock)?\.json|.*\.(?:test|spec)\.[cm]?js)$/i;
const DENIED_NAMES = /(?:^|[._-])(?:secrets?|credentials?|cookies?|tokens?)(?:[._-]|$)/i;
const RUNTIME_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf']);

function checkVersion(version) {
  if (typeof version !== 'string' || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(version) ||
      version.split('.').some(value => Number(value) > 65535) || version.split('.').every(value => Number(value) === 0)) {
    throw new Error(`Invalid Chrome extension version: ${version}`);
  }
}

function manifestFiles(manifest) {
  if (manifest.manifest_version !== 3) throw new Error('Expected a Manifest V3 extension');
  const files = [manifest.background?.service_worker, manifest.side_panel?.default_path,
    manifest.action?.default_popup, manifest.options_page, manifest.options_ui?.page, manifest.devtools_page];
  const icons = value => typeof value === 'string' ? [value] : Object.values(value || {});
  files.push(...icons(manifest.icons), ...icons(manifest.action?.default_icon));
  for (const content of manifest.content_scripts || []) files.push(...(content.js || []), ...(content.css || []));
  files.push(...Object.values(manifest.chrome_url_overrides || {}), ...(manifest.sandbox?.pages || []));
  for (const resource of manifest.web_accessible_resources || []) files.push(...(resource.resources || []));
  if (manifest.default_locale) throw new Error('Locale packaging must be declared explicitly before adding default_locale');
  return files.filter(value => value !== undefined);
}

function localReference(file, value, { root = false, module = false } = {}) {
  if (typeof value !== 'string' || !value || /[\\\0*]/.test(value) || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) {
    throw new Error(`${file}: expected a literal local asset, got ${String(value)}`);
  }
  if (module && !value.startsWith('.')) throw new Error(`${file}: module imports must be relative: ${value}`);
  const clean = value.split(/[?#]/, 1)[0];
  if (!clean || clean.includes('%')) throw new Error(`${file}: ambiguous asset path: ${value}`);
  const resolved = path.posix.normalize(root || clean.startsWith('/') ? clean.replace(/^\/+/, '') : path.posix.join(path.posix.dirname(file), clean));
  if (resolved === '..' || resolved.startsWith('../')) throw new Error(`${file}: asset escapes the extension: ${value}`);
  return resolved;
}

function dependencies(file, source) {
  const result = [];
  const add = (value, options) => result.push(localReference(file, value, options));
  if (/\.m?js$/.test(file)) {
    for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"\n]+)['"]/g)) add(match[1], { module: true });
    for (const match of source.matchAll(/\b(?:import|require)\(\s*([^)]*)\)/g)) {
      const literal = match[1].match(/^(['"])([^'"\n]+)\1\s*$/);
      if (!literal) throw new Error(`${file}: computed module imports cannot be packaged`);
      add(literal[2], { module: true });
    }
    for (const match of source.matchAll(/\bruntime\.getURL\(\s*['"]([^'"\n]+)['"]\s*\)/g)) add(match[1], { root: true });
    for (const match of source.matchAll(/\bnew URL\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) add(match[1]);
  } else if (file.endsWith('.html')) {
    for (const match of source.matchAll(/<(?:script|link|img|source|audio|video|iframe)\b[^>]*>/gi)) {
      for (const attribute of match[0].matchAll(/\b(?:src|href|poster)\s*=\s*(['"])([^'"]+)\1/gi)) add(attribute[2]);
      if (/\bsrcset\s*=/i.test(match[0])) throw new Error(`${file}: srcset packaging is not supported; use explicit asset references`);
    }
  } else if (file.endsWith('.css')) {
    for (const match of source.matchAll(/url\(\s*(?:['"]([^'"]+)['"]|([^\s)]+))\s*\)/gi)) {
      const value = match[1] || match[2];
      if (!value.startsWith('data:') && !value.startsWith('#')) add(value);
    }
    for (const match of source.matchAll(/@import\s+['"]([^'"]+)['"]/gi)) add(match[1]);
  }
  return result;
}

function readRuntimeFile(root, relative) {
  const parts = relative.split('/');
  if (parts.some(part => !part || DENIED_PARTS.test(part)) || DENIED_NAMES.test(parts.at(-1)) ||
      (relative !== 'manifest.json' && !RUNTIME_EXTENSIONS.has(path.extname(relative)))) {
    throw new Error(`Refusing a non-runtime or private file: ${relative}`);
  }
  let absolute = root;
  for (let index = 0; index < parts.length; index++) {
    absolute = path.join(absolute, parts[index]);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed in the package: ${relative}`);
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Not a runtime file: ${relative}`);
  }
  return fs.readFileSync(absolute);
}

function collectRuntimeFiles(root) {
  root = path.resolve(root);
  const manifestBytes = readRuntimeFile(root, 'manifest.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  checkVersion(manifest.version);
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== packageInfo.version) throw new Error('manifest.json and package.json versions must match');
  const files = new Map([['manifest.json', manifestBytes]]);
  const pending = manifestFiles(manifest).map(value => localReference('manifest.json', value, { root: true }));
  for (const relative of pending) {
    if (files.has(relative)) continue;
    const bytes = readRuntimeFile(root, relative);
    files.set(relative, bytes);
    pending.push(...dependencies(relative, bytes.toString('utf8')));
  }
  return { version: manifest.version, files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) };
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

// STORE entries are sufficient for this small extension. Fixed metadata makes
// the archive deterministic without depending on host time, locale or ZIP tools.
function createZip(files) {
  if (files.length > 65535) throw new Error('ZIP64 is not supported');
  const local = [], central = [];
  let offset = 0;
  for (const [file, data] of files) {
    const name = Buffer.from(file, 'utf8');
    if (name.length > 65535 || data.length > 0xffffffff) throw new Error('ZIP64 is not supported');
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(33, 12); // 1980-01-01, 00:00:00
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    header.copy(directory, 6, 4, 30);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const directoryBytes = Buffer.concat(central);
  if (offset + directoryBytes.length > 0xffffffff) throw new Error('ZIP64 is not supported');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}

function packageExtension({ root = path.resolve(__dirname, '..'), outputDir = path.join(root, 'dist'), licensePath = path.resolve(root, '../LICENSE') } = {}) {
  const { version, files } = collectRuntimeFiles(root);
  // The repository license is the sole deliberate non-runtime file in the ZIP.
  // Read this exact named file, never discover or traverse parent directories.
  if (!fs.lstatSync(licensePath).isFile()) throw new Error('The distribution license must be a regular file');
  files.push(['LICENSE', fs.readFileSync(licensePath)]);
  files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const zip = createZip(files);
  fs.mkdirSync(outputDir, { recursive: true });
  const output = path.resolve(outputDir, `chzzk-desk-chrome-${version}.zip`);
  fs.writeFileSync(output, zip);
  return { output, version, files: files.map(([name]) => name), bytes: zip.length };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--output-dir')) throw new Error('Usage: node scripts/package.cjs [--output-dir PATH]');
    const result = packageExtension(args.length ? { outputDir: path.resolve(args[1]) } : undefined);
    console.log(`Packaged ${result.files.length - 1} runtime files + LICENSE (${result.bytes} bytes): ${result.output}`);
  } catch (error) {
    console.error(`Extension packaging failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { collectRuntimeFiles, packageExtension, createZip, crc32 };
