import { slotIds, getSlot } from '../shared/ui/model.mjs';

export function initialState() {
  return { channels: [], slots: slotIds.map(slotId => ({ slotId })), audioSlot: null, clips: [], savingSlots: [], ffmpegAvailable: false, connection: { status: 'standalone' }, auth: { status: 'unknown' }, layout: 'side-by-side', mainSlot: 0, rewardSettings: { enabled: false }, rewards: [], clipSeconds: 30 };
}
export const connected = state => state.connection.status === 'connected';
export const paired = state => state.connection.status !== 'standalone';
export const unavailable = state => state.connection.status === 'unavailable';
export const saving = (state, slotId) => state.savingSlots.some(id => Number(id) === slotId);
export function canSave({ state, pending }, slotId) {
  const item = getSlot(state, slotId);
  return !pending && connected(state) && state.ffmpegAvailable && Boolean(item.channelId)
    && Number(item.replay?.bufferedSeconds || 0) >= 4 && ['buffering', 'error'].includes(item.replay?.state) && !saving(state, slotId);
}
