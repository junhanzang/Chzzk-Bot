import { createEventScope } from '../shared/ui/dom.mjs';

export function createPanelNavigationView({ document, run }) {
  const events = createEventScope();
  const help = document.querySelector('#clips-connection-help');
  const open = document.querySelector('#open-desk-clips');
  const favorites = document.querySelector('.favorites-drawer');
  let initialized = false;
  events.on(open, 'click', () => run('openDeskSection', 'clips'));
  return {
    render({ state, pending, initialized: loaded }) {
      const connected = state.connection?.status === 'connected';
      help.hidden = connected;
      help.textContent = state.connection?.status === 'unavailable'
        ? '앱에 응답이 없어요. 앱을 다시 실행하고 위의 연결 상태를 확인해 주세요.'
        : '앱을 연결하면 로컬 클립을 확인할 수 있어요. 위의 데스크톱 앱 연결을 펼쳐 주세요.';
      open.disabled = !connected || pending;
      // Preserve the user's disclosure choice after the first loaded snapshot.
      if (!initialized && loaded) { initialized = true; favorites.open = state.channels.length === 0; }
    },
    dispose() { events.dispose(); }
  };
}
