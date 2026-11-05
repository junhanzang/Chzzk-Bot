import { createPanelController } from './ui/controller.mjs';
import { createNoticeView } from './ui/notice.mjs';
import { createConnectionView } from './ui/connection.mjs';
import { createFavoritesView } from './ui/favorites.mjs';
import { createClipsView } from './ui/clips.mjs';
import { createSlotsView } from './ui/slots.mjs';
import { createWatchToolsView } from './ui/watch-tools.mjs';
import { createSectionNavigation } from './shared/ui/navigation.mjs';
import { createBotView } from './shared/ui/bot-view.mjs';
import { createPanelNavigationView } from './ui/navigation.mjs';
import { createChannelDiscovery } from './shared/ui/channel-discovery.mjs';

const notice = createNoticeView({ document });
const controller = createPanelController({ document, timers: window, sendMessage: message => chrome.runtime.sendMessage(message), onNotice: notice.show });
const navigation = createSectionNavigation({ document });
const views = [
  createChannelDiscovery({ document, root: document.querySelector('#channel-discovery'), run: controller.execute }),
  createBotView({ document, root: document.querySelector('#bot-workspace'), run: controller.execute }),
  createPanelNavigationView({ document, run: controller.execute }),
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
  navigation.dispose();
  notice.dispose();
}, { once: true });
controller.start();
