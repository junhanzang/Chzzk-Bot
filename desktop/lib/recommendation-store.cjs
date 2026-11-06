'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { ActivityHistory } = require('../../browser-extension/shared/recommendations.js');

// Independent, fixed local document: no account identifier or chat content.
async function loadRecommendationHistory(directory, { fileSystem = fs, onChange, clock } = {}) {
  const target = path.join(directory, 'recommendations.json');
  let initial;
  try { initial = JSON.parse(await fileSystem.readFile(target, 'utf8')); } catch { initial = {}; }
  return new ActivityHistory({ initial, onChange, clock, persist: async value => {
    const temporary = `${target}.tmp`;
    try {
      await fileSystem.writeFile(temporary, JSON.stringify(value), 'utf8');
      await fileSystem.rename(temporary, target);
    } catch (error) {
      await fileSystem.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  } });
}
module.exports = { loadRecommendationHistory };
