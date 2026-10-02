import { slotIds, getSlot } from '../../browser-extension/shared/ui/model.mjs';

export function initialState() {
  return { channels: [], slots: slotIds.map(slotId => ({ slotId })), audioSlot: null, clips: [], savingSlots: [], ffmpegAvailable: false, version: '', layout: 'side-by-side', mainSlot: 0, rewardSettings: { enabled: false }, rewards: [], clipSeconds: 30, autoClipSettings: {}, autoClips: [] };
}

export function isSaving(snapshot, slotId) {
  return snapshot.pendingSaves.has(slotId) || snapshot.state.savingSlots.some(id => Number(id) === slotId);
}

export function canSave(snapshot, slotId) {
  const { state, pending } = snapshot;
  const slot = getSlot(state, slotId);
  return Boolean(slot.channelId) && state.ffmpegAvailable && ['buffering', 'error'].includes(slot.replay?.state)
    && Number(slot.replay?.bufferedSeconds || 0) >= 4 && !isSaving(snapshot, slotId)
    && !pending.has(`slot-${slotId}`) && !pending.has('clip-seconds');
}
