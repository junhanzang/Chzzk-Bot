import './shared/channels.js';
import { DeskController, panelSenderAllowed } from './lib/core.js';

const controller = new DeskController({ chromeApi: chrome, model: globalThis.DeskChannels });
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'desk-chat') {
    controller.handleChatMessage(message, sender).then(value => sendResponse({ ok: true, value }),
      () => sendResponse({ ok: false, error: '채팅 전달 조건이 바뀌었어요. 연결과 방송 설정을 다시 확인합니다.' }));
    return true;
  }
  if (message?.target === 'desk-rewards') {
    controller.handleRewardMessage(message, sender).then(value => sendResponse({ ok: true, value }),
      error => sendResponse({ ok: false, error: error.message || '통나무 상태를 확인하지 못했어요.' }));
    return true;
  }
  if (message?.target !== 'desk') return false;
  if (!panelSenderAllowed(sender, chrome)) {
    sendResponse({ ok: false, error: '확장 프로그램 패널에서만 사용할 수 있는 요청입니다.' });
    return false;
  }
  controller.handle(message.method, message.arg).then(value => sendResponse({ ok: true, value }),
    error => sendResponse({ ok: false, error: error.message || '요청을 처리하지 못했어요.' }));
  return true;
});

chrome.tabs.onUpdated.addListener(tabId => { controller.onTabChanged(tabId).catch(() => {}); });
chrome.tabs.onRemoved.addListener(tabId => { controller.onTabChanged(tabId).catch(() => {}); });
chrome.commands.onCommand.addListener(command => {
  let request;
  if (command === 'listen-a') request = controller.handle('selectAudio', 0);
  else if (command === 'listen-b') request = controller.handle('selectAudio', 1);
  else if (command === 'mute-all') request = controller.handle('selectAudio', null);
  else if (command === 'save-recent') request = controller.handle('getState').then(state =>
    controller.handle('saveClip', { slotId: state.audioSlot ?? state.mainSlot ?? 0, seconds: state.clipSeconds }));
  request?.catch(error => controller.recordNotice(error));
});
