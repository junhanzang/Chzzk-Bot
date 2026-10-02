import { createDom, createEventScope } from '../../browser-extension/shared/ui/dom.mjs';
import { presentation, layouts, slotIds } from '../../browser-extension/shared/ui/model.mjs';

export function createToolbarView({ document, run }) {
  const { $ } = createDom(document);
  const events = createEventScope();
  let snapshot;
  const selectedSeconds = () => presentation.clipSeconds(snapshot.state.clipSeconds);
  function render(next) {
    snapshot = next;
    const { state, pending, pendingSaves, initialized, preview } = snapshot;
    $('#layout-select').value = layouts.includes(state.layout) ? state.layout : 'side-by-side';
    $('#main-slot-select').value = String(slotIds.includes(state.mainSlot) ? state.mainSlot : 0);
    $('#layout-select').disabled = pending.has('layout');
    $('#main-slot-select').disabled = pending.has('layout');
    $('#auto-rewards').checked = state.rewardSettings?.enabled === true;
    $('#auto-rewards').disabled = pending.has('rewards') || (!initialized && !preview);
    $('#clip-seconds').value = String(selectedSeconds());
    $('#clip-seconds').disabled = pending.has('clip-seconds') || pendingSaves.size > 0 || state.savingSlots.length > 0 || (!initialized && !preview);
    const loginButton = $('#login-button');
    const auth = state.auth || { status: preview ? 'signed_out' : 'checking', nickname: null };
    const loginLabels = { checking: '로그인 확인 중', signed_in: '로그인됨', signed_out: '네이버 로그인', error: '로그인 상태 확인' };
    $('#login-label').textContent = loginLabels[auth.status] || '네이버 로그인';
    loginButton.title = auth.status === 'signed_in'
      ? `${typeof auth.nickname === 'string' && auth.nickname ? auth.nickname : '네이버 계정'} · 로그인 창 열기`
      : auth.status === 'checking' ? '치지직 로그인 상태를 확인하고 있어요.'
      : auth.status === 'error' ? '네이버 로그인 창에서 계정을 확인하세요.' : '네이버 로그인 창 열기';
    loginButton.classList.toggle('signed-in', auth.status === 'signed_in');
    loginButton.disabled = pending.has('login');
    const browserReady = Boolean(state.browserConnection?.available);
    $('#browser-connect').disabled = !browserReady || pending.has('browser-connection');
    $('#browser-reset').disabled = !browserReady || pending.has('browser-connection');
    $('#browser-connection-status').textContent = browserReady ? '확장 프로그램과 연결할 수 있어요.' : preview ? '앱 실행 후 크롬과 연결할 수 있어요.' : '크롬 연결을 준비하지 못했어요.';
    $('#mute-button').disabled = pending.has('audio');
    $('#mute-button').setAttribute('aria-pressed', String(state.audioSlot === null));
    $('#version-label').textContent = state.version ? `DESK / ${state.version}` : 'DESK / 로컬 보관';
    const recorder = $('#recorder-status');
    recorder.textContent = preview ? '미리보기 · 방송 연결 없음' : !initialized ? '녹화 도구 확인 중' : state.ffmpegAvailable ? '녹화 도구 준비됨' : '녹화 도구 준비 필요';
    recorder.classList.toggle('warning', initialized && !state.ffmpegAvailable && !preview);
    $('#preview-badge').hidden = !preview;
  }
  events.on($('#login-button'), 'click', () => run('login', 'login'));
  events.on($('#mute-button'), 'click', () => run('audio', 'selectAudio', null));
  events.on($('#clip-seconds'), 'change', event => run('clip-seconds', 'setClipSeconds', Number(event.target.value)));
  events.on($('#layout-select'), 'change', event => run('layout', 'setLayout', { layout: event.target.value, mainSlot: snapshot.state.mainSlot ?? 0 }));
  events.on($('#main-slot-select'), 'change', event => run('layout', 'setLayout', { layout: snapshot.state.layout || 'side-by-side', mainSlot: Number(event.target.value) }));
  events.on($('#auto-rewards'), 'change', event => {
    const enabled = event.target.checked;
    event.target.checked = snapshot.state.rewardSettings?.enabled === true;
    run('rewards', 'setAutoRewards', enabled);
  });
  events.on($('#browser-connect'), 'click', () => run('browser-connection', 'copyBrowserConnectionCode', undefined, '연결 코드를 복사했어요. 크롬 확장의 앱 연결에 붙여 넣어 주세요.'));
  events.on($('#browser-reset'), 'click', () => run('browser-connection', 'resetBrowserConnection', undefined, '기존 연결 코드를 해제했어요. 새 코드를 복사해서 다시 연결해 주세요.'));
  return { render, dispose: events.dispose };
}
