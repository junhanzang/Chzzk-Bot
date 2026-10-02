import { createDom, createEventScope, setText } from './dom.mjs';
import { letters, slotIds, getSlot, presentation } from './model.mjs';

const layoutNames = { 'side-by-side': '나란히', stacked: '세로', grid: '4분할', focus: '메인 크게' };
const hasBuffer = slot => presentation.bufferEnabled(slot.replay) || Number(slot.replay?.bufferedSeconds) > 0;

export function presetChanges(state, preset, playbackMode) {
  return slotIds.filter(slotId => {
    const slot = getSlot(state, slotId), target = preset.slots[slotId] || null;
    return (slot.channelId || null) !== target || Boolean(target && slot.playbackMode && slot.playbackMode !== playbackMode);
  });
}

export function bulkBufferMessage(summary, enabled) {
  const action = enabled ? '보관 켜기' : '보관 끄기';
  if (!summary || !Number.isSafeInteger(summary.succeeded) || summary.succeeded < 0 || !Array.isArray(summary.failures)) {
    return { message: `전체 ${action} 요청을 처리했어요.`, error: false };
  }
  const failures = summary.failures.map(item => `${letters[item.slotId] || '방송'}: ${item.message || '처리하지 못했어요.'}`);
  return { message: [`전체 ${action} · ${summary.succeeded}개 완료`, ...failures].join(' / '), error: failures.length > 0 };
}

// Owns the preset-name draft, an explicit apply confirmation, pending commands,
// and the bulk response captured before a subsequent state poll removes it.
export function createWatchTools({ document, send, notify, capabilities, playbackMode, onLayoutChange = () => {} }) {
  const { $, $$, element, actionButton } = createDom(document);
  const events = createEventScope(), host = $('#watch-tools');
  let snapshot, expanded = false, confirming = null, localBusy = false, disposed = false, listKey = '';
  let bulkRequest = null;
  const heading = element('div', 'watch-tools-heading');
  const toggle = actionButton('button watch-presets-toggle', '시청 모음', 'toggle-presets');
  toggle.setAttribute('aria-controls', 'watch-presets-panel');
  const bulk = element('div', 'watch-buffer-actions');
  const start = actionButton('button watch-buffer-start', '전체 보관 켜기', 'buffers-on');
  const stop = actionButton('button watch-buffer-stop', '전체 보관 끄기', 'buffers-off');
  bulk.append(start, stop); heading.append(toggle, bulk);
  const panel = element('div', 'watch-presets-panel'); panel.id = 'watch-presets-panel'; panel.hidden = true;
  const form = element('form', 'watch-preset-form');
  const label = element('label', 'watch-preset-name-label', '현재 시청 조합 저장');
  const name = element('input', 'watch-preset-name');
  name.type = 'text'; name.maxLength = 40; name.required = true; name.autocomplete = 'off'; name.placeholder = '모음 이름 (최대 40자)';
  label.append(name);
  const save = element('button', 'button watch-preset-save', '저장'); save.type = 'submit';
  form.append(label, save);
  const hint = element('p', 'watch-preset-hint', '방송 A–D와 화면 배치를 최대 10개 저장해요. 소리·보관·자동 저장 설정은 모음에 저장하지 않아요.');
  const list = element('ul', 'watch-presets-list'); list.setAttribute('aria-label', '저장한 시청 모음');
  const empty = element('p', 'watch-presets-empty', '저장한 시청 모음이 없어요.');
  const confirmation = element('div', 'watch-preset-confirmation'); confirmation.hidden = true; confirmation.setAttribute('role', 'group');
  confirmation.setAttribute('aria-label', '시청 모음 불러오기 확인');
  const confirmTitle = element('strong'), confirmMessage = element('p'), confirmChanges = element('p');
  const confirmActions = element('div', 'watch-preset-confirm-actions');
  const apply = actionButton('button watch-preset-confirm', '확인 후 불러오기', 'confirm-preset');
  const cancel = actionButton('button watch-preset-cancel', '취소', 'cancel-preset');
  confirmActions.append(apply, cancel);
  confirmation.append(confirmTitle, confirmMessage, confirmChanges, confirmActions);
  panel.append(form, hint, list, empty, confirmation);
  const recordingHint = element('p', 'watch-buffer-hint');
  host.append(heading, recordingHint, panel);

  const presets = () => snapshot?.state.watchPresets || [];
  const controls = () => capabilities(snapshot);
  const busy = () => localBusy || controls().busy;
  function render(next) {
    if (disposed) return;
    snapshot = next;
    const { state } = snapshot, capability = controls(), items = presets();
    if (bulkRequest && state.actionSummary && state.actionSummary !== bulkRequest.previous) bulkRequest.summary = state.actionSummary;
    if (confirming && !items.some(item => item.id === confirming)) confirming = null;
    panel.hidden = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    setText(toggle, `시청 모음 ${items.length}/10 ${expanded ? '▴' : '▾'}`);
    const locked = busy() || !capability.available;
    name.disabled = locked;
    save.disabled = locked || items.length >= 10;
    save.title = items.length >= 10 ? '사용하지 않는 모음을 삭제한 뒤 저장해 주세요.' : '현재 방송과 배치를 새 이름으로 저장';
    const assigned = state.slots.filter(slot => slot.channelId);
    start.disabled = locked || !capability.recordingAvailable || !state.ffmpegAvailable || !assigned.length;
    stop.disabled = locked || !capability.recordingAvailable || !assigned.some(hasBuffer);
    const recordingMessage = !capability.recordingAvailable ? '전체 구간 보관은 데스크톱 앱과 연결한 뒤 사용할 수 있어요.'
      : !state.ffmpegAvailable ? '영상 저장 도구를 준비하면 전체 구간 보관을 사용할 수 있어요.' : '';
    recordingHint.hidden = !recordingMessage;
    setText(recordingHint, recordingMessage);
    const nextKey = JSON.stringify([items, state.channels]);
    if (nextKey !== listKey) {
      listKey = nextKey;
      list.replaceChildren();
      for (const preset of items) {
        const row = element('li', 'watch-preset-row'), description = element('div', 'watch-preset-description');
        const title = element('strong', '', preset.name);
        const channels = preset.slots.map((channelId, slotId) => `${letters[slotId]} ${channelId ? state.channels.find(channel => channel.id === channelId)?.name || '방송' : '빈 자리'}`);
        const summary = element('small', '', `${channels.join(' · ')} / ${layoutNames[preset.layout] || '기본 배치'} · 메인 ${letters[preset.mainSlot] || 'A'}`);
        title.title = preset.name; summary.title = summary.textContent;
        description.append(title, summary);
        const load = actionButton('button watch-preset-load', '불러오기', 'load-preset', { preset: preset.id });
        const remove = actionButton('button watch-preset-remove', '삭제', 'remove-preset', { preset: preset.id });
        load.setAttribute('aria-label', `${preset.name} 시청 모음 불러오기`);
        remove.setAttribute('aria-label', `${preset.name} 시청 모음 삭제`);
        row.append(description, load, remove); list.append(row);
      }
    }
    empty.hidden = items.length > 0;
    $$('button', list).forEach(button => { button.disabled = locked; });
    confirmation.hidden = !confirming;
    if (confirming) {
      const preset = items.find(item => item.id === confirming);
      const changed = presetChanges(state, preset, playbackMode), recording = changed.filter(slotId => hasBuffer(getSlot(state, slotId)));
      setText(confirmTitle, `‘${preset.name}’ 모음을 불러올까요?`);
      setText(confirmMessage, '조합을 불러오면 바뀌는 자리의 구간 보관이 종료돼요. 소리·녹화는 자동으로 켜지지 않아요.');
      setText(confirmChanges, `${changed.length ? `바뀌는 자리: ${changed.map(slotId => letters[slotId]).join(', ')}` : '방송은 같고 저장한 화면 배치를 적용해요.'}${recording.length ? ` · 구간 보관 종료: ${recording.map(slotId => letters[slotId]).join(', ')}` : ''}`);
    }
    apply.disabled = locked || !confirming;
    cancel.disabled = busy();
    onLayoutChange();
  }
  async function command(method, argument, success) {
    if (disposed || busy() || !controls().available) return false;
    localBusy = true; render(snapshot);
    try { return await send(method, argument, success); }
    finally { localBusy = false; if (!disposed) render(snapshot); }
  }
  events.on(toggle, 'click', () => { expanded = !expanded; render(snapshot); });
  events.on(form, 'submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    const value = name.value.trim();
    if (!value) { notify('시청 모음 이름을 입력해 주세요.', true); return; }
    if (await command('saveWatchPreset', { name: value }, '현재 시청 조합을 저장했어요.') && !disposed) name.value = '';
  });
  events.on(list, 'click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    if (button.dataset.action === 'load-preset') { confirming = button.dataset.preset; render(snapshot); apply.focus(); }
    else if (button.dataset.action === 'remove-preset') await command('removeWatchPreset', button.dataset.preset, '시청 모음을 삭제했어요.');
  });
  events.on(cancel, 'click', () => { if (!cancel.disabled) { confirming = null; render(snapshot); } });
  events.on(apply, 'click', async () => {
    if (apply.disabled) return;
    if (await command('applyWatchPreset', confirming, '시청 모음을 불러왔어요.') && !disposed) { confirming = null; render(snapshot); }
  });
  async function setBuffers(enabled) {
    if ((enabled ? start : stop).disabled) return;
    bulkRequest = { previous: snapshot.state.actionSummary, summary: null };
    try {
      const accepted = await command('setAllBuffers', { enabled });
      if (!disposed && accepted) {
        const result = bulkBufferMessage(bulkRequest.summary, enabled);
        notify(result.message, result.error);
      }
    } finally { bulkRequest = null; }
  }
  events.on(start, 'click', () => setBuffers(true));
  events.on(stop, 'click', () => setBuffers(false));
  return { render, dispose() { disposed = true; events.dispose(); } };
}
