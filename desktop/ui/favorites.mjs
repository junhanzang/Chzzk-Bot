import { createDom, createEventScope, setText } from '../../browser-extension/shared/ui/dom.mjs';
import { createChannelEditor } from '../../browser-extension/shared/ui/channel-editor.mjs';
import { presentation, slotIds, letters, slotKey, getSlot as findSlot } from '../../browser-extension/shared/ui/model.mjs';

export function createFavoritesView({ document, run, onFocusSlot }) {
  const { $, element } = createDom(document);
  const events = createEventScope();
  let snapshot, lastOrder = '';
  const rows = new Map();
  const getSlot = slotId => findSlot(snapshot.state, slotId);
  function createRow(channel) {
    const row = element('div', 'channel-item'); row.dataset.channel = channel.id;
    const info = element('div', 'channel-info');
    const avatar = element('span', 'channel-avatar'); avatar.setAttribute('aria-hidden', 'true');
    const editor = createChannelEditor({ document, labelClass: 'channel-name',
      onRename: arg => run(`rename-${arg.channelId}`, 'renameChannel', arg, '채널 이름을 바꿨어요.'),
      onPin: arg => run(`pin-${arg.channelId}`, 'setChannelPinned', arg) });
    const remove = element('button', 'channel-remove', '×'); remove.type = 'button';
    remove.title = '즐겨찾기에서 삭제'; remove.dataset.action = 'remove'; remove.dataset.channel = channel.id;
    info.append(avatar, editor.element, remove);
    const buttons = element('div', 'channel-slots');
    const assignments = slotIds.map(slotId => {
      const button = element('button', 'channel-slot-button'); button.type = 'button';
      button.title = `${letters[slotId]}에서 보기`; button.dataset.action = 'assign';
      button.dataset.channel = channel.id; button.dataset.slot = String(slotId); buttons.append(button);
      return button;
    });
    row.append(info, buttons);
    return { row, avatar, editor, remove, assignments };
  }
  function render(next) {
    snapshot = next;
    const { state, pending, initialized, preview } = snapshot;
    $('#add-channel').disabled = pending.has('add') || (!initialized && !preview);
    $('#add-channel').textContent = pending.has('add') ? '추가 중…' : '채널 추가';
    const query = $('#channel-search').value;
    const list = $('#channels-list');
    const known = new Set(state.channels.map(channel => channel.id));
    for (const [id, value] of rows) if (!known.has(id)) { value.editor.dispose(); rows.delete(id); }
    for (const channel of state.channels) {
      if (!rows.has(channel.id)) rows.set(channel.id, createRow(channel));
      const value = rows.get(channel.id), name = channel.name || '이름 없는 채널';
      const busy = ['remove', 'rename', 'pin'].some(action => pending.has(`${action}-${channel.id}`));
      value.row.classList.toggle('active', state.slots.some(slot => slot.channelId === channel.id));
      value.row.classList.toggle('pinned', channel.pinned === true);
      setText(value.avatar, [...name][0] || 'C');
      value.editor.render({ channel, pending: busy, available: initialized || preview });
      value.remove.setAttribute('aria-label', `${name} 즐겨찾기에서 삭제`); value.remove.disabled = busy;
      value.assignments.forEach((button, slotId) => {
        const current = getSlot(slotId).channelId === channel.id && getSlot(slotId).playbackMode !== 'browser';
        button.classList.toggle('assigned', current); setText(button, `${letters[slotId]}${current ? ' ✓' : ''}`);
        button.setAttribute('aria-label', `${name} 방송 ${letters[slotId]}에서 보기`);
        button.disabled = current || pending.has(slotKey(slotId)) || busy;
      });
    }
    const channels = presentation.filterChannels(state.channels, query);
    $('#channel-count').textContent = presentation.resultCount(channels.length, state.channels.length, query);
    $('#channels-empty').hidden = state.channels.length > 0;
    $('#channels-no-results').hidden = !state.channels.length || channels.length > 0;
    list.hidden = !channels.length;
    const order = JSON.stringify(channels.map(channel => channel.id));
    if (order !== lastOrder) {
      lastOrder = order;
      const active = document.activeElement, start = active?.selectionStart, end = active?.selectionEnd;
      const restoreFocus = active && list.contains?.(active);
      list.replaceChildren(...channels.map(channel => rows.get(channel.id).row));
      if (restoreFocus && list.contains(active)) {
        active.focus({ preventScroll: true });
        if (Number.isInteger(start) && Number.isInteger(end)) active.setSelectionRange?.(start, end);
      }
    }
  }

  events.on($('#channel-search'), 'input', () => render(snapshot));
  events.on($('#channels-list'), 'click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const channelId = button.dataset.channel;
    if (button.dataset.action === 'remove') run(`remove-${channelId}`, 'removeChannel', channelId);
    if (button.dataset.action === 'assign') {
      const slotId = Number(button.dataset.slot);
      onFocusSlot(slotId);
      run(slotKey(slotId), 'assignSlot', { slotId, channelId });
    }
  });
  events.on($('#channel-form'), 'submit', async event => {
    event.preventDefault();
    const input = $('#channel-input').value.trim();
    if (!input) return;
    const ok = await run('add', 'addChannel', { input, name: $('#channel-name').value.trim() });
    if (ok) { $('#channel-input').value = ''; $('#channel-name').value = ''; }
  });
  events.on($('.brand'), 'click', event => { event.preventDefault(); $('#channel-input').focus(); });
  return { render, dispose() { events.dispose(); for (const value of rows.values()) value.editor.dispose(); rows.clear(); } };
}
