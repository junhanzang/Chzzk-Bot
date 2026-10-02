import { createDom, createEventScope, setText as text } from '../shared/ui/dom.mjs';
import { connected as isConnected, paired as isPaired, unavailable as isUnavailable } from './state.mjs';

export function createConnectionView({ document, run, notify }) {
  const { $ } = createDom(document);
  const events = createEventScope();
  let snapshot;
  const connected = () => isConnected(snapshot.state);
  const paired = () => isPaired(snapshot.state);
  const unavailable = () => isUnavailable(snapshot.state);
  function render(next) {
    snapshot = next;
    const { state, pending } = snapshot;
    const status = state.connection.status;
    const badge = $('#connection-badge');
    text(badge, connected() ? '앱 연결됨' : unavailable() ? '앱 응답 없음' : '독립 모드');
    badge.classList.toggle('connected', connected());
    badge.classList.toggle('unavailable', unavailable());
    const description = state.connection.message || (connected()
      ? 'Chrome에서 보고, 앱으로 지나간 장면을 보관해요.'
      : unavailable() ? '앱을 실행해 주세요. 연결을 해제하면 독립 모드를 쓸 수 있어요.'
        : '앱 없이도 Chrome 탭 시청과 소리 전환을 사용할 수 있어요.');
    text($('#connection-description'), description);
    $('#disconnect-button').hidden = status === 'standalone';
    $('#disconnect-button').disabled = pending;
    $('#pair-button').disabled = pending;
    text($('#pair-button'), pending ? '처리 중…' : '앱 연결');
    const auth = $('#auth-label');
    auth.hidden = !paired();
    auth.classList.toggle('signed-in', connected() && state.auth.status === 'signed_in');
    text(auth, unavailable() ? '앱과 다시 연결되면 보관 상태를 확인할 수 있어요.'
      : state.auth.status === 'signed_in' ? '앱 네이버 로그인됨 · Chrome 로그인은 별도'
        : state.auth.status === 'checking' ? '앱 네이버 로그인 상태를 확인하고 있어요.'
          : '저장이 제한되면 앱에서 네이버 로그인해 주세요. Chrome 로그인과는 별개예요.');
  }

  events.on($('#pairing-form'), 'submit', async event => {
    event.preventDefault();
    const input = $('#pairing-code');
    const code = input.value.trim();
    if (!/^[0-9]{1,5}:[a-fA-F0-9]{48}$/.test(code)) {
      notify('앱에서 복사한 연결 코드를 그대로 붙여 넣어 주세요.', true);
      input.focus();
      return;
    }
    if (await run('pair', code, '앱을 연결했어요.')) {
      if (input.value.trim() === code) input.value = '';
      $('#pairing-details').open = false;
    }
  });
  events.on($('#disconnect-button'), 'click', () => run('disconnect', undefined, '앱 연결을 해제했어요. 독립 모드로 사용할 수 있어요.'));
  return { render, dispose: events.dispose };
}
