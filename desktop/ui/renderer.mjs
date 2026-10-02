import { createDesktopController } from './controller.mjs';
import { createNoticeView } from './notice.mjs';
import { createFavoritesView } from './favorites.mjs';
import { createClipsView } from './clips.mjs';
import { createPlayersView } from './players.mjs';
import { createToolbarView } from './toolbar.mjs';
import { createPlayerBounds } from './bounds.mjs';

const bridge = window.desk;
let bounds;
const notice = createNoticeView({ element: document.querySelector('#notice'), timers: window, onChange: () => bounds?.request() });
const controller = createDesktopController({ bridge, onNotice: notice.show, onClearNotice: notice.hide });
const players = createPlayersView({ document, run: controller.execute, notify: notice.show });
const favorites = createFavoritesView({ document, run: controller.execute, onFocusSlot: players.focusSlot });
const clips = createClipsView({ document, run: controller.execute });
const toolbar = createToolbarView({ document, run: controller.execute });
bounds = createPlayerBounds({ document, window, cards: players.cards, sendBounds: bridge ? value => bridge.setPlayerBounds(value) : null, onError: notice.show });
const views = [favorites, players, clips, toolbar];
const unsubscribe = controller.subscribe(snapshot => {
  for (const view of views) view.render(snapshot);
  bounds.update(snapshot.state.slots);
});
window.addEventListener('beforeunload', () => {
  unsubscribe();
  controller.dispose();
  for (const view of views) view.dispose();
  bounds.dispose();
  notice.dispose();
}, { once: true });
controller.start();
