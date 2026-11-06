'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const methods = ['getState', 'addChannel', 'removeChannel', 'assignSlot', 'clearSlot', 'selectAudio',
  'setAudioEnabled', 'openChat', 'refreshFollowing', 'pinFollowedChannel',
  'setRecommendationSort', 'clearRecommendationHistory',
  'setBuffer', 'saveClip', 'reloadSlot', 'login', 'refreshAuth', 'openExternal', 'openClip', 'showClipsFolder', 'setPlayerBounds',
  'copyBrowserConnectionCode', 'resetBrowserConnection', 'setLayout', 'setAutoRewards', 'setClipSeconds', 'setAutoClipSettings',
  'renameChannel', 'setChannelPinned', 'saveWatchPreset', 'applyWatchPreset', 'removeWatchPreset', 'setAllBuffers',
  'queryClips', 'updateClip', 'showClipInFolder', 'getBotState', 'configureBot', 'previewBot', 'startBot', 'stopBot', 'approveBot', 'openDeskSection'];
const bridge = {};
for (const method of methods) {
  bridge[method] = async arg => {
    const result = await ipcRenderer.invoke(`desk:${method}`, arg);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
}
bridge.onState = callback => {
  const listener = (_event, state) => callback(state);
  ipcRenderer.on('desk:state', listener);
  return () => ipcRenderer.removeListener('desk:state', listener);
};
bridge.onNotice = callback => {
  const listener = (_event, notice) => callback(notice);
  ipcRenderer.on('desk:notice', listener);
  return () => ipcRenderer.removeListener('desk:notice', listener);
};
bridge.onNavigate = callback => {
  const listener = (_event, section) => { if (['clips', 'bot', 'settings'].includes(section)) callback(section); };
  ipcRenderer.on('desk:navigate', listener);
  return () => ipcRenderer.removeListener('desk:navigate', listener);
};
contextBridge.exposeInMainWorld('desk', bridge);
