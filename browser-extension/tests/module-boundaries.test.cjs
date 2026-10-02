'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const excluded = new Set(['node_modules', '.artifacts', 'dist', 'tests', 'scripts']);
const relative = file => path.relative(root, file).replaceAll(path.sep, '/');

function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) return [];
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(file);
    return entry.isFile() && /\.[cm]?js$/.test(file) ? [file] : [];
  });
}

// Production modules use literal relative imports/requires; no bundler aliases.
// Check those declared edges without executing Electron or a browser entrypoint.
function imports(source) {
  const found = new Set();
  for (const pattern of [
    /^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"\n]+)['"]/gm,
    /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g
  ]) for (const match of source.matchAll(pattern)) found.add(match[1]);
  return [...found];
}

function graph() {
  const result = new Map();
  for (const file of ['desktop', 'browser-extension'].flatMap(name => sources(path.join(root, name)))) {
    result.set(file, imports(fs.readFileSync(file, 'utf8')));
  }
  return result;
}

test('production modules resolve their declared imports without circular dependencies', () => {
  const modules = graph();
  const visiting = new Set(), visited = new Set();
  function visit(file, chain = []) {
    assert.ok(!visiting.has(file), `Circular dependency: ${[...chain, file].map(relative).join(' -> ')}`);
    if (visited.has(file)) return;
    visiting.add(file);
    for (const specifier of modules.get(file) || []) {
      if (!specifier.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), specifier);
      assert.ok(target.startsWith(root + path.sep), `${relative(file)} imports outside the repository`);
      assert.ok(fs.existsSync(target) && fs.statSync(target).isFile(), `${relative(file)}: missing ${specifier}`);
      if (modules.has(target)) visit(target, [...chain, file]);
    }
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of modules.keys()) visit(file);
});

test('shared rules, platform services and UI keep one-way module boundaries', () => {
  for (const [file, dependencies] of graph()) {
    const source = relative(file);
    for (const specifier of dependencies) {
      const target = specifier.startsWith('.') ? relative(path.resolve(path.dirname(file), specifier)) : specifier;
      if (source.startsWith('browser-extension/shared/')) {
        assert.ok(target.startsWith('browser-extension/shared/'), `${source} must remain platform independent: ${target}`);
      }
      if (source.startsWith('browser-extension/')) {
        assert.ok(!target.startsWith('desktop/'), `${source} cannot depend on the desktop package: ${target}`);
      }
      if (source.startsWith('desktop/lib/')) {
        assert.ok(!target.startsWith('desktop/ui/') && target !== 'desktop/main.cjs', `${source} must not depend on its entrypoint or UI: ${target}`);
      }
      if (source.startsWith('browser-extension/lib/')) {
        assert.ok(!target.startsWith('browser-extension/ui/') && !['browser-extension/panel.js', 'browser-extension/background.js'].includes(target),
          `${source} must not depend on its entrypoint or UI: ${target}`);
      }
      const ui = source.startsWith('desktop/ui/') || source.startsWith('browser-extension/ui/') || source === 'browser-extension/panel.js';
      if (ui) {
        assert.ok(specifier.startsWith('.'), `${source} must access platform capabilities through its adapter: ${target}`);
        assert.ok(!target.startsWith('desktop/lib/') && !target.startsWith('browser-extension/lib/'), `${source} cannot import privileged services: ${target}`);
      }
    }
  }
});
