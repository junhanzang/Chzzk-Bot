'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const methods = ['getState', 'addChannel', 'removeChannel', 'assignSlot', 'clearSlot', 'selectAudio',
  'setBuffer', 'saveClip', 'reloadSlot', 'login', 'refreshAuth', 'openExternal', 'openClip', 'showClipsFolder', 'setPlayerBounds',
  'copyBrowserConnectionCode', 'resetBrowserConnection', 'setLayout', 'setAutoRewards', 'setClipSeconds', 'setAutoClipSettings'];
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
contextBridge.exposeInMainWorld('desk', bridge);
