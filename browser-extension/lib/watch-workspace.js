/** Coordinates portable presets through existing tab/storage/desktop owners. */
export class WatchWorkspace {
  constructor({ model, storage, desktop, tabs, linkedMutation }) {
    Object.assign(this, { model, storage, desktop, tabs, linkedMutation });
  }
  get presets() { return this.desktop.paired ? this.desktop.remote.watchPresets : this.storage.watchPresets; }
  async save(arg) {
    if (this.desktop.paired) return this.linkedMutation('saveWatchPreset', { name: arg?.name });
    const preset = this.model.createWatchPreset({ ...this.storage.preferences,
      id: globalThis.crypto.randomUUID(), name: arg?.name, slots: this.tabs.assignments() }, this.storage.channels, this.presets);
    await this.storage.savePresets([...this.presets, preset]);
  }
  async remove(id) {
    if (this.desktop.paired) return this.linkedMutation('removeWatchPreset', id);
    if (!this.presets.some(preset => preset.id === id)) throw new Error('방송 조합을 찾지 못했어요.');
    await this.storage.savePresets(this.presets.filter(preset => preset.id !== id));
  }
  async apply(id) {
    if (this.desktop.paired) await this.desktop.refresh();
    const preset = this.presets.find(item => item.id === id);
    if (!preset) throw new Error('방송 조합을 찾지 못했어요.');
    const channels = this.desktop.paired ? this.desktop.remote.channels : this.storage.channels;
    const normalized = this.model.normalizeWatchPresets([preset], channels)[0];
    if (!normalized) throw new Error('조합의 채널이 삭제되었어요. 조합을 다시 저장해 주세요.');
    if (this.desktop.paired) await this.linkedMutation('applyWatchPreset', id);
    await this.tabs.prepareAssignments(normalized.slots);
    const failures = [];
    let hasTargetTab = false;
    for (const slotId of this.model.SLOT_IDS) {
      const channelId = normalized.slots[slotId];
      if (!channelId) continue;
      try {
        if (this.tabs.channelId(slotId) !== channelId || !await this.tabs.getTab(slotId)) {
          await this.tabs.open(slotId, channels.find(channel => channel.id === channelId));
        }
        if (!await this.tabs.getTab(slotId)) throw new Error('방송 탭이 닫혔어요.');
        hasTargetTab = true;
      }
      catch { failures.push(String.fromCharCode(65 + slotId)); }
    }
    // Closing the final owned tab closes its Chrome window. Keep it available
    // until at least one nonempty replacement has actually been established.
    if (hasTargetTab) {
      for (const slotId of this.model.SLOT_IDS) {
        if (!normalized.slots[slotId]) await this.tabs.release(slotId);
      }
    }
    if (!this.desktop.paired) await this.storage.updatePreferences({ layout: normalized.layout, mainSlot: normalized.mainSlot });
    if (failures.length) throw new Error(`${failures.join(' · ')} 방송 탭을 열지 못했어요. 해당 자리에서 다시 열어 주세요.`);
  }
}
