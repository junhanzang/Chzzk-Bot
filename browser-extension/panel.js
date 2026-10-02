import { createPanelController } from './ui/controller.mjs';
import { createNoticeView } from './ui/notice.mjs';
import { createConnectionView } from './ui/connection.mjs';
import { createFavoritesView } from './ui/favorites.mjs';
import { createClipsView } from './ui/clips.mjs';
import { createSlotsView } from './ui/slots.mjs';
import { createWatchToolsView } from './ui/watch-tools.mjs';

const notice = createNoticeView({ document });
const controller = createPanelController({ document, timers: window, sendMessage: message => chrome.runtime.sendMessage(message), onNotice: notice.show });
const views = [
  createConnectionView({ document, run: controller.execute, notify: notice.show }),
  createFavoritesView({ document, run: controller.execute }),
  createSlotsView({ document, run: controller.execute }),
  createClipsView({ document, run: controller.execute, queryClips: async arg => {
    const result = await chrome.runtime.sendMessage({ target: 'desk', method: 'queryClips', arg });
    if (!result?.ok) throw new Error(result?.error || '클립 목록을 읽지 못했어요.');
    return result.value;
  } }),
  createWatchToolsView({ document, run: controller.execute, notify: notice.show })
];
const unsubscribe = controller.subscribe(snapshot => {
  for (const view of views) view.render(snapshot);
});
window.addEventListener('pagehide', () => {
  unsubscribe();
  controller.dispose();
  for (const view of views) view.dispose();
  notice.dispose();
}, { once: true });
controller.start();
