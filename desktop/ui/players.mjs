import { createDom, createEventScope } from '../../browser-extension/shared/ui/dom.mjs';
import { presentation, slotIds, letters, ordinals, layouts, slotKey, getSlot as findSlot } from '../../browser-extension/shared/ui/model.mjs';
import { canSave as canSaveClip, isSaving as isSavingClip } from './state.mjs';
import { autoClipForSlot, createAutoClipControls } from '../../browser-extension/shared/ui/auto-clips.mjs';

export function createPlayersView({ document, run, notify }) {
  const { $, element } = createDom(document);
  const events = createEventScope();
  const { bufferEnabled } = presentation;
  let snapshot, focusedSlot = 0;
  const getSlot = slotId => findSlot(snapshot.state, slotId);
  const canSave = slotId => canSaveClip(snapshot, slotId);
  const isSaving = slotId => isSavingClip(snapshot, slotId);
  const selectedSeconds = () => presentation.clipSeconds(snapshot.state.clipSeconds);
  for (const slotId of [2, 3]) {
    const card = $('.player-card[data-slot="1"]').cloneNode(true);
    card.dataset.slot = String(slotId);
    card.setAttribute('aria-label', `방송 ${letters[slotId]}`);
    $('.slot-letter', card).textContent = letters[slotId];
    $('kbd', card).textContent = String(slotId + 1);
    $('[data-role="empty"] h3', card).textContent = '더 보고 싶은 방송을 여기에';
    $('[data-role="empty"] p', card).textContent = `즐겨찾기의 ${letters[slotId]} 버튼으로 방송을 열어 주세요.`;
    card.querySelectorAll('[aria-label]').forEach(node => node.setAttribute('aria-label', node.getAttribute('aria-label').replace('방송 B', `방송 ${letters[slotId]}`)));
    $('.players-grid').append(card);
  }
  const cards = [...document.querySelectorAll('.player-card')];
  const autoClips = [];
  cards.forEach((card, slotId) => {
    const main = element('button', 'main-button', '메인');
    main.type = 'button';
    main.dataset.action = 'main';
    main.setAttribute('aria-label', `${letters[slotId]} 방송 메인으로`);
    $('.player-menu', card).prepend(main);
    const reward = element('div', 'reward-status');
    reward.dataset.role = 'reward-status';
    reward.setAttribute('role', 'status');
    reward.setAttribute('aria-live', 'polite');
    $('.player-footer', card).append(reward);
    const autoClip = createAutoClipControls({ document, label: `방송 ${letters[slotId]}`,
      onApply: argument => run(`auto-clip-${argument.channelId}`, 'setAutoClipSettings', argument, '자동 저장 설정을 적용했어요.') });
    autoClips.push(autoClip);
    $('.player-footer', card).append(autoClip.element);
  });
  function render(next) {
    snapshot = next;
    const { state, pending } = snapshot;
    const layout = layouts.includes(state.layout) ? state.layout : 'side-by-side';
    const mainSlot = slotIds.includes(state.mainSlot) ? state.mainSlot : 0;
    const visibleIds = slotIds.filter(slotId => slotId < 2 || getSlot(slotId).channelId || layout === 'grid' || mainSlot === slotId);
    const grid = $('.players-grid');
    grid.dataset.layout = layout;
    grid.dataset.count = String(visibleIds.length);
    $('.workspace').classList.toggle('many-players', visibleIds.length > 2 || layout === 'stacked');
    cards.forEach((card, slotId) => {
      const slot = getSlot(slotId);
      const channel = state.channels.find(item => item.id === slot.channelId);
      const assigned = Boolean(slot.channelId);
      const external = assigned && slot.playbackMode === 'browser';
      const replay = slot.replay || {};
      const seconds = Math.max(0, Math.floor(Number(replay.bufferedSeconds) || 0));
      const enabled = bufferEnabled(replay);
      const working = pending.has(slotKey(slotId));
      const audible = assigned && Number(state.audioSlot) === slotId && state.audioSlot !== null;
      card.hidden = !visibleIds.includes(slotId);
      card.classList.toggle('main-player', mainSlot === slotId);
      const mainButton = $('[data-action="main"]', card);
      mainButton.setAttribute('aria-pressed', String(mainSlot === slotId));
      mainButton.disabled = !assigned || pending.has('layout');
      mainButton.title = mainSlot === slotId ? '메인 방송' : '메인 방송으로 선택 · 소리는 유지해요';
      card.classList.toggle('listening', audible);
      $('[data-role="title"]', card).textContent = assigned ? slot.title || channel?.name || '치지직 방송' : '방송을 추가해 주세요';
      const pageStatus = $('[data-role="page-status"]', card);
      const statuses = { browser: '크롬 시청 모드 · 앱에서 클립 보관', loading: '공식 방송 페이지 여는 중', ready: '공식 치지직 페이지 · 일반 화질', loaded: '공식 치지직 페이지', error: '페이지를 열지 못했어요', idle: '방송 페이지 준비 중' };
      pageStatus.textContent = !assigned ? `${ordinals[slotId]} 번째 시청 자리` : slot.pageError || statuses[slot.pageStatus] || '방송 페이지 상태 확인 중';
      pageStatus.title = slot.pageError || '';
      pageStatus.classList.toggle('error', Boolean(slot.pageError) || slot.pageStatus === 'error');
      $('[data-role="title"]', card).title = `${$('[data-role="title"]', card).textContent} · ${pageStatus.textContent}`;
      $('[data-role="empty"]', card).hidden = assigned;
      let browserNote = $('[data-role="browser-note"]', card);
      if (!browserNote) {
        browserNote = element('div', 'player-empty browser-player-note');
        browserNote.dataset.role = 'browser-note';
        browserNote.append(element('h3', '', '크롬에서 시청하는 자리'));
        browserNote.append(element('p', '', '크롬 확장에서 이 방송을 열어 주세요. 구간 보관과 저장은 여기서도 사용할 수 있어요.'));
        const back = element('button', 'button button-quiet', '앱에서 보기');
        back.type = 'button';
        events.on(back, 'click', () => run(slotKey(slotId), 'assignSlot', { slotId, channelId: getSlot(slotId).channelId, playbackMode: 'desktop' }));
        browserNote.append(back);
        $('[data-role="surface"]', card).append(browserNote);
      }
      browserNote.hidden = !external;
      $('button', browserNote).disabled = working;
      $('[data-role="audio-label"]', card).textContent = audible ? '지금 듣는 방송' : '이 방송 듣기';
      $('[data-action="audio"]', card).setAttribute('aria-pressed', String(audible));
      ['audio', 'reload', 'external', 'clear'].forEach(name => { $(`[data-action="${name}"]`, card).disabled = !assigned || working || pending.has('audio') || (external && name !== 'clear'); });
      if (external) $('[data-role="audio-label"]', card).textContent = '소리는 크롬에서 전환';
      const toggle = $('[data-role="buffer-toggle"]', card);
      toggle.checked = enabled;
      toggle.disabled = !assigned || !state.ffmpegAvailable || working;
      toggle.setAttribute('aria-label', `방송 ${letters[slotId]} 최근 구간 보관`);
      let status = '보관 꺼짐';
      if (replay.state === 'starting') status = '최근 구간 보관 준비 중';
      else if (replay.state === 'stopping') status = '구간 보관 종료 중';
      else if (replay.error || replay.state === 'error') status = seconds >= 4 ? `연결 중단 · 마지막 ${seconds}초 저장 가능` : '구간 보관 오류';
      else if (enabled) status = seconds > 0 ? `최근 ${seconds}초 보관 중` : '첫 영상 구간 기다리는 중';
      $('[data-role="buffer-status"]', card).textContent = status;
      $('[data-role="buffer-dot"]', card).classList.toggle('active', enabled && seconds > 0);
      $('[data-role="buffer-dot"]', card).classList.toggle('error', Boolean(replay.error) || replay.state === 'error');
      $('[data-action="save"]', card).disabled = !canSave(slotId);
      $('[data-action="save"]', card).title = presentation.saveHint(selectedSeconds(), seconds);
      $('[data-role="save-label"]', card).textContent = presentation.saveLabel(selectedSeconds(), { saving: isSaving(slotId) });
      const note = $('[data-role="note"]', card);
      note.textContent = replay.error || (assigned && !state.ffmpegAvailable ? 'FFmpeg를 준비하면 최근 구간 보관과 클립 저장을 사용할 수 있어요.' : enabled ? presentation.saveNote(selectedSeconds(), seconds) : '구간 보관은 실험 기능이에요. 방송의 재생 권한에 따라 제한될 수 있어요.');
      note.title = note.textContent;
      note.classList.toggle('error', Boolean(replay.error));
      const reward = presentation.formatReward(presentation.rewardForSlot(state.rewards, slot), { enabled: state.rewardSettings?.enabled, external });
      const rewardStatus = $('[data-role="reward-status"]', card);
      rewardStatus.hidden = !assigned;
      if (rewardStatus.textContent !== reward.summary) rewardStatus.textContent = reward.summary;
      rewardStatus.title = reward.title;
      rewardStatus.classList.toggle('claimed', reward.claimed);
      autoClips[slotId].render({ channelId: slot.channelId, settings: state.autoClipSettings?.[slot.channelId], activity: autoClipForSlot(state.autoClips, slot),
        available: !snapshot.preview && snapshot.initialized, pending: working || pending.has(`auto-clip-${slot.channelId}`) });
    });
  }

  cards.forEach((card, slotId) => {
    events.on(card, 'pointerdown', () => { focusedSlot = slotId; });
    events.on(card, 'focusin', () => { focusedSlot = slotId; });
    events.on($('[data-action="main"]', card), 'click', () => run('layout', 'setLayout', { layout: snapshot.state.layout || 'side-by-side', mainSlot: slotId }));
    events.on($('[data-action="audio"]', card), 'click', () => run('audio', 'selectAudio', slotId));
    events.on($('[data-action="reload"]', card), 'click', () => run(slotKey(slotId), 'reloadSlot', slotId));
    events.on($('[data-action="external"]', card), 'click', () => run(slotKey(slotId), 'openExternal', slotId));
    events.on($('[data-action="clear"]', card), 'click', () => run(slotKey(slotId), 'clearSlot', slotId));
    events.on($('[data-action="save"]', card), 'click', () => run(slotKey(slotId), 'saveClip', { slotId, seconds: selectedSeconds() }, '클립을 내 컴퓨터에 저장했어요.'));
    events.on($('[data-role="buffer-toggle"]', card), 'change', event => {
      const enabled = event.target.checked;
      event.target.checked = bufferEnabled(getSlot(slotId).replay);
      run(slotKey(slotId), 'setBuffer', { slotId, enabled });
    });
  });
  events.on(document, 'keydown', event => {
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.repeat) return;
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyS') {
      event.preventDefault();
      const slotId = snapshot.state.audioSlot !== null ? Number(snapshot.state.audioSlot) : focusedSlot;
      if (canSave(slotId)) run(slotKey(slotId), 'saveClip', { slotId, seconds: selectedSeconds() }, '클립을 내 컴퓨터에 저장했어요.');
      else notify('최근 구간 보관을 켜고 영상이 4초 이상 모인 뒤 저장해 주세요.');
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (/^Digit[1-4]$/.test(event.code)) {
      const slotId = Number(event.code.slice(-1)) - 1;
      if (getSlot(slotId).channelId) { event.preventDefault(); focusedSlot = slotId; run('audio', 'selectAudio', slotId); }
    } else if (event.code === 'KeyM') { event.preventDefault(); run('audio', 'selectAudio', null); }
  });
  return { render, cards, focusSlot(slotId) { focusedSlot = slotId; }, dispose() { events.dispose(); for (const control of autoClips) control.dispose(); } };
}
