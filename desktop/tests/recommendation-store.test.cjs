'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadRecommendationHistory } = require('../lib/recommendation-store.cjs');
const A = 'a'.repeat(32);
test('local history file persists numeric counters, restores and clears without touching other profile documents', async () => {
  const files = new Map(), directory = path.resolve('VIRTUAL-ONLY-recommendations'), target = path.join(directory, 'recommendations.json');
  const fileSystem = {
    readFile: async name => { if (!files.has(name)) throw new Error('missing'); return files.get(name); },
    writeFile: async (name, text) => { files.set(name, text); },
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    rm: async name => files.delete(name)
  };
  const history = await loadRecommendationHistory(directory, { fileSystem, clock: () => 100000 });
  history.recordVisit(A); history.recordActivity(A, { watchSeconds: 20, chatCount: 1, text: 'private' }); await history.flush();
  assert.deepEqual([...files.keys()], [target]); assert(!files.get(target).includes('private'));
  const restored = await loadRecommendationHistory(directory, { fileSystem, clock: () => 100000 });
  assert.equal(restored.snapshot().channels[A].watchSeconds, 20);
  restored.clear(); await restored.flush(); assert.deepEqual(JSON.parse(files.get(target)).channels, {});
});
