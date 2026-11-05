import { createDesktopController } from './controller.mjs';
import { createNoticeView } from './notice.mjs';
import { createFavoritesView } from './favorites.mjs';
import { createClipsView } from './clips.mjs';
import { createPlayersView } from './players.mjs';
import { createToolbarView } from './toolbar.mjs';
import { createPlayerBounds } from './bounds.mjs';
import { createWatchToolsView } from './watch-tools.mjs';
import { createSectionNavigation } from '../../browser-extension/shared/ui/navigation.mjs';
import { createBotView, createBotSettingsView } from '../../browser-extension/shared/ui/bot-view.mjs';
import { createChannelDiscovery } from '../../browser-extension/shared/ui/channel-discovery.mjs';

const bridge = window.desk;
let bounds;
const notice = createNoticeView({ element: document.querySelector('#notice'), timers: window, onChange: () => bounds?.request() });
const controller = createDesktopController({ bridge, onNotice: notice.show, onClearNotice: notice.hide });
const players = createPlayersView({ document, run: controller.execute, notify: notice.show });
const favorites = createFavoritesView({ document, run: controller.execute, onFocusSlot: players.focusSlot, onHome: () => navigation.select('watch') });
const discovery = createChannelDiscovery({ document, root: document.querySelector('#channel-discovery'), desktop: true,
  run: (method, arg, success) => controller.execute('channel-discovery', method, arg, success) });
const clips = createClipsView({ document, run: controller.execute, queryClips: bridge ? arg => bridge.queryClips(arg) : undefined });
const toolbar = createToolbarView({ document, run: controller.execute });
const watchTools = createWatchToolsView({ document, run: controller.execute, notify: notice.show, onLayoutChange: () => bounds?.request() });
bounds = createPlayerBounds({ document, window, cards: players.cards, sendBounds: bridge ? value => bridge.setPlayerBounds(value) : null, onError: notice.show });
const navigation = createSectionNavigation({ document, onChange: section => bounds.setVisible(section === 'watch') });
const runBot = (method, arg, success) => controller.execute(method === 'stopBot' ? 'bot-stop' : 'bot-command', method, arg, success);
const bot = createBotView({ document, root: document.querySelector('#bot-workspace'), run: runBot, desktop: true, onSettings: () => navigation.select('settings') });
const botSettings = createBotSettingsView({ document, root: document.querySelector('#bot-settings'), run: runBot });
const unsubscribeNavigation = typeof bridge?.onNavigate === 'function' ? bridge.onNavigate(section => navigation.select(section)) : null;
const views = [favorites, discovery, players, clips, toolbar, watchTools, bot, botSettings];
const unsubscribe = controller.subscribe(snapshot => {
  for (const view of views) view.render(snapshot);
  bounds.update(snapshot.state.slots);
});
window.addEventListener('beforeunload', () => {
  unsubscribe();
  controller.dispose();
  for (const view of views) view.dispose();
  unsubscribeNavigation?.();
  navigation.dispose();
  bounds.dispose();
  notice.dispose();
}, { once: true });
controller.start();
