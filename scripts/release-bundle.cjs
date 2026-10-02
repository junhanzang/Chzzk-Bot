'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const json = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

function metadata({ requireTag = false, environment = process.env } = {}) {
  const version = json('desktop/package.json').version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use a numeric major.minor.patch distribution version.');
  for (const file of ['desktop/package-lock.json', 'browser-extension/package.json', 'browser-extension/manifest.json']) {
    if (json(file).version !== version) throw new Error(`Version mismatch: ${file}`);
  }
  if (json('desktop/package-lock.json').packages[''].version !== version) throw new Error('Lockfile root version differs.');
  const tag = `desk-v${version}`;
  if (requireTag && environment.GITHUB_REF_TYPE !== 'tag') throw new Error('Release publishing requires an existing desk-v tag.');
  if (environment.GITHUB_REF_TYPE === 'tag' && environment.GITHUB_REF_NAME !== tag) throw new Error(`Expected tag ${tag}.`);
  const notes = path.join(root, 'docs', 'releases', `${version}.md`);
  if (!fs.existsSync(notes) || !fs.readFileSync(notes, 'utf8').trim()) throw new Error(`Release notes are missing: ${version}.md`);
  return { version, tag };
}

function assetNames(version) {
  return [`Chzzk-Desk-${version}-Setup-x64.exe`, `Chzzk-Desk-${version}-win-x64.zip`, `chzzk-desk-chrome-${version}.zip`];
}
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function verify(directory, names) {
  const actual = fs.readdirSync(directory).sort();
  const expected = [...names, 'SHA256SUMS.txt'].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Release directory has missing or unexpected files.');
  const expectedSums = names.map(name => {
    const target = path.join(directory, name);
    const info = fs.lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error(`Invalid release asset: ${name}`);
    return `${digest(target)}  ${name}`;
  }).join('\n') + '\n';
  if (fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8') !== expectedSums) throw new Error('Release checksum mismatch.');
}

function pack(directory, names) {
  fs.mkdirSync(directory, { recursive: true });
  if (fs.readdirSync(directory).some(name => ![...names, 'SHA256SUMS.txt'].includes(name))) {
    throw new Error('Release directory contains another version; choose a clean output directory.');
  }
  const sources = names.map(name => path.join(root, name.startsWith('chzzk-desk-chrome-') ? 'browser-extension/dist' : 'desktop/dist', name));
  for (const source of sources) {
    const info = fs.lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error(`Missing release asset: ${path.basename(source)}`);
  }
  sources.forEach((source, index) => fs.copyFileSync(source, path.join(directory, names[index])));
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), names.map(name => `${digest(path.join(directory, name))}  ${name}`).join('\n') + '\n');
  verify(directory, names);
}

if (require.main === module) {
  try {
    const [command, option] = process.argv.slice(2);
    const details = metadata({ requireTag: option === '--require-tag' });
    const directory = path.join(root, 'release');
    if (command === 'metadata') {
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${details.version}\ntag=${details.tag}\n`);
      console.log(JSON.stringify(details));
    } else if (command === 'pack') { pack(directory, assetNames(details.version)); console.log(`Release files prepared for ${details.tag}.`); }
    else if (command === 'verify') { verify(directory, assetNames(details.version)); console.log(`Release files verified for ${details.tag}.`); }
    else throw new Error('Usage: node scripts/release-bundle.cjs metadata [--require-tag] | pack | verify');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { metadata, assetNames, verify };
