'use strict';
const { randomUUID } = require('node:crypto');
const { SLOT_IDS, createWatchPreset, normalizeWatchPresets } = require('./channels.cjs');

// Owns portable viewing presets and coordinated replacement. Recordings, sound,
// accounts and page objects are intentionally outside the stored snapshot.
class WatchWorkspace {
  #metadata = Promise.resolve();

  constructor({ settings, persist, exclusive, closeSlot, openSlot, isQuitting }) {
    Object.assign(this, { settings, persist, exclusive, closeSlot, openSlot, isQuitting });
    settings.watchPresets ||= [];
  }
  async save({ name } = {}) {
    // Capture the requested view now; another queued save or player transition
    // must not turn it into a snapshot of a later, partially changed layout.
    const requested = { id: randomUUID(), name, slots: [...this.settings.slots],
      layout: this.settings.layout, mainSlot: this.settings.mainSlot };
    return this.#changePresets(before => [...before, createWatchPreset(requested, this.settings.channels, before)]);
  }
  async remove(id) {
    return this.#changePresets(before => {
      if (!before.some(preset => preset.id === id)) throw new Error('저장한 방송 조합을 찾지 못했어요.');
      return before.filter(preset => preset.id !== id);
    });
  }
  #changePresets(update) {
    const operation = this.#metadata.then(async () => {
      if (this.isQuitting?.()) throw new Error('앱을 종료하고 있습니다.');
      const before = this.settings.watchPresets;
      this.settings.watchPresets = update(before);
      try { await this.persist(); }
      catch (error) {
        // Channel deletion can prune presets while disk I/O is pending. Restoring
        // the old list must not restore references to those removed favorites.
        this.settings.watchPresets = normalizeWatchPresets(before, this.settings.channels);
        throw error;
      }
    });
    this.#metadata = operation.catch(() => {});
    return operation;
  }
  prune() { this.settings.watchPresets = normalizeWatchPresets(this.settings.watchPresets, this.settings.channels); }
  async apply(id, playbackMode) {
    const saved = this.settings.watchPresets.find(preset => preset.id === id);
    if (!saved) throw new Error('저장한 방송 조합을 찾지 못했어요.');
    if (!['desktop', 'browser'].includes(playbackMode)) throw new Error('시청 방식이 올바르지 않습니다.');
    const preset = normalizeWatchPresets([saved], this.settings.channels)[0];
    if (!preset) throw new Error('조합의 채널이 삭제되었어요. 방송 조합을 다시 저장해 주세요.');
    return this.exclusive(async () => {
      const changed = SLOT_IDS.filter(slotId => this.settings.slots[slotId] !== preset.slots[slotId] ||
        (preset.slots[slotId] && (this.settings.playbackModes?.[slotId] || 'desktop') !== playbackMode));
      try {
        // Close old owners first so a swap never plays the same channel twice.
        for (const slotId of changed) await this.closeSlot(slotId);
        if (this.isQuitting()) throw new Error('앱을 종료하고 있습니다.');
        for (const slotId of changed) if (preset.slots[slotId]) this.openSlot(slotId, preset.slots[slotId], playbackMode);
        this.settings.layout = preset.layout; this.settings.mainSlot = preset.mainSlot;
      } finally { await this.persist(); }
    });
  }
}
module.exports = { WatchWorkspace };
