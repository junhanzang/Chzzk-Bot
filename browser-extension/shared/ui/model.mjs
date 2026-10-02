import '../channels.js';
import '../presentation.js';

// These adapters expose the existing dual-runtime libraries to UI ES modules.
export const presentation = globalThis.DeskPresentation;
export const model = globalThis.DeskChannels;
export const slotIds = model.SLOT_IDS;
export const layouts = model.LAYOUTS;
export const letters = ['A', 'B', 'C', 'D'];
export const ordinals = ['첫', '두', '세', '네'];
export const slotKey = slotId => `slot-${slotId}`;
export const getSlot = (state, slotId) => state.slots.find(slot => Number(slot.slotId) === slotId) || { slotId };
export const errorMessage = error => error && typeof error.message === 'string' ? error.message : '요청을 처리하지 못했어요. 다시 시도해 주세요.';
