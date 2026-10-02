'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { metadata, assetNames, verify } = require('../../scripts/release-bundle.cjs');

test('release metadata rejects branch publishing and mismatched version tags', () => {
  const current = metadata({ environment: {} });
  assert.deepEqual(metadata({ requireTag: true, environment: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: current.tag } }), current);
  assert.throws(() => metadata({ requireTag: true, environment: { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' } }), /requires/);
  assert.throws(() => metadata({ environment: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'desk-v99.99.99' } }), /Expected tag/);
});

test('release verification rejects missing, extra and corrupted assets before publishing', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const names = assetNames('0.3.0');
  for (const name of names) fs.writeFileSync(path.join(directory, name), `fixture:${name}`);
  const sums = names.map(name => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')}  ${name}`).join('\n') + '\n';
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), sums);
  assert.doesNotThrow(() => verify(directory, names));
  const extra = path.join(directory, 'profile.json');
  fs.writeFileSync(extra, '{}');
  assert.throws(() => verify(directory, names), /unexpected/);
  fs.unlinkSync(extra);
  fs.appendFileSync(path.join(directory, names[0]), 'corrupt');
  assert.throws(() => verify(directory, names), /checksum/);
  fs.unlinkSync(path.join(directory, names[0]));
  assert.throws(() => verify(directory, names), /missing/);
});
