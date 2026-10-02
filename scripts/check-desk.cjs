'use strict';

// Repository checks only: never starts Electron, Chrome, or live account requests.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const excluded = new Set(['node_modules', '.artifacts', 'dist', '.git']);

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) return [];
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return entry.isFile() && /\.(?:cjs|mjs|js)$/.test(entry.name) ? [target] : [];
  }).sort();
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

const sources = ['desktop', 'browser-extension', 'scripts'].flatMap(name => sourceFiles(path.join(root, name)));
console.log(`Checking syntax for ${sources.length} JavaScript files.`);
for (const source of sources) run(['--check', source]);
for (const project of ['desktop', 'browser-extension']) {
  console.log(`Running ${project} tests without opening apps.`);
  const tests = sourceFiles(path.join(root, project, 'tests')).filter(file => file.endsWith('.test.cjs'));
  if (!tests.length) throw new Error(`No tests found for ${project}`);
  run(['--test', '--test-reporter=spec', ...tests]);
}
console.log('All syntax and unit checks passed. Live UI checks remain manual.');
