'use strict';

const { validSlot } = require('./channels.cjs');

function publicState(value) {
  return { version: value.version, channels: value.channels, slots: value.slots, clips: value.clips,
    layout: value.layout, mainSlot: value.mainSlot, clipSeconds: value.clipSeconds,
    autoClipSettings: value.autoClipSettings || {}, autoClips: value.autoClips || [],
    watchPresets: value.watchPresets || [], clipRevision: value.clipRevision, clipTotal: value.clipTotal,
    actionSummary: value.actionSummary || null,
    audioSlot: null, savingSlots: value.savingSlots, ffmpegAvailable: value.ffmpegAvailable,
    auth: { status: value.auth?.status || 'checking' } };
}

function createBrowserHandlers({ actions, isQuitting = () => false }) {
  function browserSlot(arg) {
    validSlot(arg?.slotId);
    const slot = actions.getState().slots.find(slot => slot.slotId === arg.slotId);
    if (!slot?.channelId || slot.playbackMode !== 'browser') throw new Error('확장에서 A–D 자리에 방송을 먼저 열어 주세요.');
    if (arg.channelId !== undefined && arg.channelId !== slot.channelId) throw new Error('시청 방송이 변경되었습니다. 방송을 다시 선택해 주세요.');
    return arg.slotId;
  }
  const methods = {
    getState: () => publicState(actions.getState()),
    addChannel: arg => actions.addChannel({ input: arg?.input, name: arg?.name, playbackMode: 'browser' }),
    removeChannel: id => actions.removeChannel(id),
    assignSlot: arg => actions.assignSlot({ slotId: arg?.slotId, channelId: arg?.channelId, playbackMode: 'browser' }),
    clearSlot: slotId => { validSlot(slotId); return actions.clearSlot(slotId); },
    setLayout: arg => actions.setLayout({ layout: arg?.layout, mainSlot: arg?.mainSlot }),
    setClipSeconds: seconds => actions.setClipSeconds(seconds),
    renameChannel: arg => actions.renameChannel(arg),
    setChannelPinned: arg => actions.setChannelPinned(arg),
    saveWatchPreset: arg => actions.saveWatchPreset({ name: arg?.name }),
    removeWatchPreset: id => actions.removeWatchPreset(id),
    applyWatchPreset: id => actions.applyWatchPreset({ id, playbackMode: 'browser' }),
    setAllBuffers: arg => {
      if (!Array.isArray(arg?.slots) || arg.slots.length > 4) throw new Error('보관할 방송을 먼저 선택해 주세요.');
      arg.slots.forEach(slot => browserSlot(slot));
      return actions.setAllBuffers({ enabled: arg.enabled, slots: arg.slots.map(({ slotId, channelId }) => ({ slotId, channelId })) });
    },
    queryClips: arg => actions.queryClips(arg),
    updateClip: arg => actions.updateClip(arg),
    showClipInFolder: id => actions.showClipInFolder(id),
    setAutoClipSettings: arg => actions.setAutoClipSettings(arg),
    submitChatBatch: arg => { browserSlot(arg); return actions.submitChatBatch(arg); },
    setBuffer: arg => actions.setBuffer({ slotId: browserSlot(arg), enabled: arg?.enabled }),
    saveClip: arg => actions.saveClip({ slotId: browserSlot(arg), seconds: arg?.seconds }),
    openClip: id => actions.openClip(id),
    showClipsFolder: () => actions.showClipsFolder()
  };
  return Object.fromEntries(Object.entries(methods).map(([method, handler]) => [method, async arg => {
    if (isQuitting()) throw Object.assign(new Error('앱을 종료하고 있습니다.'), { expose: true });
    try {
      const value = await handler(arg);
      return value && Array.isArray(value.slots) && Array.isArray(value.channels) ? publicState(value) : value;
    } catch (error) {
      // Only messages from our fixed user actions are exposed; no arbitrary handler/API.
      const internal = error.code || error instanceof TypeError || error instanceof SyntaxError;
      throw Object.assign(new Error(!internal && error.message ? error.message : '앱에서 요청을 처리하지 못했습니다. 앱의 상태와 저장 폴더를 확인해 주세요.'), { expose: true });
    }
  }]));
}

module.exports = { createBrowserHandlers, publicState };
