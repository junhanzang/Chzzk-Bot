import { createDom, createEventScope, setText as text } from '../shared/ui/dom.mjs';
import { presentation, slotIds, letters, ordinals, layouts, getSlot as findSlot } from '../shared/ui/model.mjs';
import { connected as isConnected, paired as isPaired, unavailable as isUnavailable, saving as isSaving, canSave as canSaveClip } from './state.mjs';
import { autoClipForSlot, createAutoClipControls } from '../shared/ui/auto-clips.mjs';

export function createSlotsView({ document, run }) {
  const { $, $$, element: node, actionButton } = createDom(document);
  const events = createEventScope();
  const { bufferEnabled } = presentation;
  let snapshot;
  const slot = slotId => findSlot(snapshot.state, slotId);
  const connected = () => isConnected(snapshot.state);
  const paired = () => isPaired(snapshot.state);
  const unavailable = () => isUnavailable(snapshot.state);
  const saving = slotId => isSaving(snapshot.state, slotId);
  const canSave = slotId => canSaveClip(snapshot, slotId);
  const selectedSeconds = () => presentation.clipSeconds(snapshot.state.clipSeconds);
  const autoClips = [];
  for (const slotId of [2, 3]) {
    const card = $('#slot-1').cloneNode(true);
    card.id = `slot-${slotId}`;
    card.dataset.slot = String(slotId);
    card.setAttribute('aria-labelledby', `slot-${slotId}-title`);
    $('[id]', card).id = `slot-${slotId}-title`;
    $$('[data-slot]', card).forEach(element => { element.dataset.slot = String(slotId); });
    $$('[aria-label]', card).forEach(element => element.setAttribute('aria-label', element.getAttribute('aria-label').replace(/^B /, `${letters[slotId]} `)));
    $('.slot-letter', card).textContent = letters[slotId];
    $('[data-action="open-slot"]', card).textContent = `${letters[slotId]} 방송 열기 ↗`;
    $('.slots').append(card);
  }
  for (const slotId of slotIds) {
    const card = $(`#slot-${slotId}`);
    const main = actionButton('button main-button', '메인', 'main-slot', { slot: slotId });
    main.setAttribute('aria-label', `${letters[slotId]} 방송 메인으로`);
    $('.slot-heading', card).insertBefore(main, $('[data-action="clear-slot"]', card));
    const reward = node('p', 'reward-status');
    reward.dataset.role = 'reward-status';
    reward.setAttribute('role', 'status');
    reward.setAttribute('aria-live', 'polite');
    card.append(reward);
    const autoClip = createAutoClipControls({ document, label: `방송 ${letters[slotId]}`,
      onApply: argument => run('setAutoClipSettings', argument, '자동 저장 설정을 적용했어요.') });
    autoClips.push(autoClip);
    card.append(autoClip.element);
  }
  function render(next) {
    snapshot = next;
    const { state, pending } = snapshot;
    const statuses = { loading: 'Chrome에서 방송을 여는 중', ready: '공식 치지직 탭에서 시청', detached: '방송 열기로 탭을 다시 열 수 있어요.', empty: '방송을 골라 주세요.', error: '방송 탭 상태를 확인해 주세요.' };
    for (const slotId of slotIds) {
      const item = slot(slotId);
      const card = $(`#slot-${slotId}`);
      const letter = letters[slotId];
      const assigned = Boolean(item.channelId);
      const hasTab = Number.isInteger(item.tabId);
      const replay = item.replay || {};
      const seconds = Math.max(0, Math.floor(Number(replay.bufferedSeconds) || 0));
      const enabled = bufferEnabled(replay);
      const listening = assigned && Number.isInteger(state.audioSlot) && state.audioSlot === slotId;
      const channel = state.channels.find(entry => entry.id === item.channelId);
      const name = item.title || channel?.name || `채널 ${String(item.channelId).slice(0, 6)}`;
      const title = $(`#slot-${slotId}-title`);
      text(title, assigned ? `${letter} · ${name}` : `${letter} · 방송을 골라 주세요`);
      title.title = assigned ? name : '';
      card.classList.toggle('listening', listening);
      card.classList.toggle('main-slot', state.mainSlot === slotId);
      const main = $('[data-action="main-slot"]', card);
      main.disabled = pending || unavailable() || !assigned;
      main.setAttribute('aria-pressed', String(state.mainSlot === slotId));
      main.title = state.mainSlot === slotId ? '메인 방송' : '메인 방송으로 선택 · 소리는 유지해요';
      const pageStatus = $('[data-role="page-status"]', card);
      text(pageStatus, !assigned ? `${ordinals[slotId]} 번째 시청 자리` : item.pageError || statuses[item.pageStatus] || '공식 방송 탭 열기');
      pageStatus.classList.toggle('error', Boolean(item.pageError) || item.pageStatus === 'error');
      $$('[data-action="open-slot"], [data-action="clear-slot"]', card).forEach(button => {
        button.disabled = !assigned || pending || unavailable();
      });
      const audio = $('[data-action="listen-slot"]', card);
      audio.disabled = pending || !hasTab;
      audio.title = `${letter} 방송 듣기${slotId < 2 ? ` · Alt+Shift+${slotId + 1}` : ''}`;
      audio.setAttribute('aria-pressed', String(listening));
      text(audio, listening ? `${letter} 듣는 중` : `${letter} 듣기`);
      $('[data-role="recording"]', card).hidden = !paired();
      const toggle = $('[data-action="buffer"]', card);
      toggle.checked = enabled;
      toggle.disabled = !connected() || pending || saving(slotId) || (!enabled && (!assigned || !hasTab || !state.ffmpegAvailable));
      const save = $('[data-action="save-slot"]', card);
      save.disabled = !canSave(slotId);
      save.title = presentation.saveHint(selectedSeconds(), seconds);
      text(save, presentation.saveLabel(selectedSeconds(), { compact: true, saving: saving(slotId) }));
      let bufferStatus = '보관을 켠 뒤 지나간 장면을 저장해요.';
      if (!connected()) bufferStatus = '앱 연결을 기다리고 있어요.';
      else if (!state.ffmpegAvailable) bufferStatus = '앱의 영상 저장 도구를 준비해 주세요.';
      else if (replay.state === 'starting') bufferStatus = '구간 보관 준비 중…';
      else if (replay.state === 'stopping') bufferStatus = '구간 보관 종료 중…';
      else if (replay.state === 'error') bufferStatus = seconds >= 4 ? `연결 중단 · 마지막 ${seconds}초 저장 가능` : '구간 보관에 문제가 있어요.';
      else if (enabled) bufferStatus = seconds >= 4 ? `최근 약 ${seconds}초 보관 중` : '영상이 4초 이상 쌓이면 저장할 수 있어요.';
      const status = $('[data-role="buffer-status"]', card);
      text(status, bufferStatus);
      status.classList.toggle('error', replay.state === 'error');
      text($('[data-role="recording-note"]', card), replay.error || (enabled ? `${presentation.saveNote(selectedSeconds(), seconds)} 보관을 끄면 임시 영상이 지워져요.` : '선택한 방송만 앱에서 임시 보관해요.'));
      const reward = presentation.formatReward(presentation.rewardForSlot(state.rewards, item), { enabled: state.rewardSettings?.enabled });
      const rewardStatus = $('[data-role="reward-status"]', card);
      rewardStatus.hidden = !assigned;
      text(rewardStatus, reward.summary);
      rewardStatus.title = reward.title;
      rewardStatus.classList.toggle('claimed', reward.claimed);
      autoClips[slotId].render({ channelId: item.channelId, settings: state.autoClipSettings?.[item.channelId], activity: autoClipForSlot(state.autoClips, item),
        available: connected(), pending });
    }
    const mute = $('#mute-button');
    const allMuted = state.audioSlot === null || state.audioSlot === undefined;
    mute.setAttribute('aria-pressed', String(allMuted));
    mute.disabled = pending || !state.slots.some(item => Number.isInteger(item.tabId));
    text(mute, allMuted ? '전체 음소거 중' : '전체 음소거');
    $('#arrange-button').disabled = pending || !state.slots.some(item => Number.isInteger(item.tabId));
    $('#layout-select').value = layouts.includes(state.layout) ? state.layout : 'side-by-side';
    $('#main-slot-select').value = String(slotIds.includes(state.mainSlot) ? state.mainSlot : 0);
    $('#layout-select').disabled = pending || unavailable();
    $('#main-slot-select').disabled = pending || unavailable();
    $('#auto-rewards').checked = state.rewardSettings?.enabled === true;
    $('#auto-rewards').disabled = pending;
    $('#clip-seconds').value = String(selectedSeconds());
    $('#clip-seconds').disabled = pending || unavailable() || state.savingSlots.length > 0;
  }

  events.on($('.slots'), 'click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const slotId = Number(button.dataset.slot);
    switch (button.dataset.action) {
      case 'open-slot': run('focusSlot', slotId); break;
      case 'clear-slot': run('clearSlot', slotId); break;
      case 'listen-slot': run('selectAudio', slotId); break;
      case 'main-slot': run('setLayout', { layout: snapshot.state.layout || 'side-by-side', mainSlot: slotId }); break;
      case 'save-slot': if (canSave(slotId)) run('saveClip', { slotId, seconds: selectedSeconds() }, '클립을 앱 보관함에 저장했어요.'); break;
    }
  });
  $$('[data-action="buffer"]').forEach(input => events.on(input, 'change', () => {
    run('setBuffer', { slotId: Number(input.dataset.slot), enabled: input.checked });
  }));
  events.on($('#mute-button'), 'click', () => run('selectAudio', null));
  events.on($('#arrange-button'), 'click', () => run('arrangeWindows'));
  events.on($('#layout-select'), 'change', event => run('setLayout', { layout: event.target.value, mainSlot: snapshot.state.mainSlot ?? 0 }));
  events.on($('#clip-seconds'), 'change', event => run('setClipSeconds', Number(event.target.value)));
  events.on($('#main-slot-select'), 'change', event => run('setLayout', { layout: snapshot.state.layout || 'side-by-side', mainSlot: Number(event.target.value) }));
  events.on($('#auto-rewards'), 'change', event => {
    const enabled = event.target.checked;
    event.target.checked = snapshot.state.rewardSettings?.enabled === true;
    run('setAutoRewards', enabled);
  });
  return { render, dispose() { events.dispose(); for (const control of autoClips) control.dispose(); } };
}
