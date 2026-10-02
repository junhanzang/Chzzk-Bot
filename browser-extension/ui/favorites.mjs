import { createDom, createEventScope, setText as text } from '../shared/ui/dom.mjs';
import { createChannelEditor } from '../shared/ui/channel-editor.mjs';
import { presentation, slotIds, letters, getSlot as findSlot } from '../shared/ui/model.mjs';
import { unavailable as isUnavailable } from './state.mjs';

export function createFavoritesView({ document, run }) {
  const { $, $$, element: node, actionButton } = createDom(document);
  const events = createEventScope();
  let snapshot, lastOrder = '';
  const rows = new Map();
  const slot = slotId => findSlot(snapshot.state, slotId);
  const unavailable = () => isUnavailable(snapshot.state);
  function createRow(channel) {
    const row = node('li', 'channel-row'); row.dataset.channel = channel.id;
    const avatar = node('span', 'channel-avatar'); avatar.setAttribute('aria-hidden', 'true');
    const editor = createChannelEditor({ document,
      onRename: arg => run('renameChannel', arg, '채널 이름을 바꿨어요.'),
      onPin: arg => run('setChannelPinned', arg) });
    row.append(avatar, editor.element);
    const assignments = slotIds.map(slotId => {
      const button = actionButton('button channel-assign', letters[slotId], 'assign', { slot: slotId, channel: channel.id });
      row.append(button); return button;
    });
    const remove = actionButton('icon-button channel-remove', '×', 'remove', { channel: channel.id }); row.append(remove);
    return { row, avatar, editor, assignments, remove };
  }
  function render(next) {
    snapshot = next;
    const { state, pending } = snapshot;
    const query = $('#channel-search').value;
    const channels = presentation.filterChannels(state.channels, query);
    const known = new Set(state.channels.map(channel => channel.id));
    for (const [id, value] of rows) if (!known.has(id)) { value.editor.dispose(); rows.delete(id); }
    for (const channel of state.channels) {
      if (!rows.has(channel.id)) rows.set(channel.id, createRow(channel));
      const value = rows.get(channel.id), name = channel.name || `채널 ${channel.id.slice(0, 6)}`;
      value.row.classList.toggle('assigned', state.slots.some(item => item.channelId === channel.id));
      value.row.classList.toggle('pinned', channel.pinned === true);
      text(value.avatar, Array.from(name)[0] || '◇');
      value.editor.render({ channel, pending, available: !unavailable() });
      value.assignments.forEach((button, slotId) => {
        button.setAttribute('aria-label', `${name} · ${letters[slotId]}에 열기`);
        button.setAttribute('aria-pressed', String(slot(slotId).channelId === channel.id));
      });
      value.remove.setAttribute('aria-label', `${name} 즐겨찾기 삭제`);
    }
    const order = JSON.stringify(channels.map(channel => channel.id));
    if (order !== lastOrder) {
      lastOrder = order;
      const list = $('#channels-list'), active = document.activeElement, start = active?.selectionStart, end = active?.selectionEnd;
      const restoreFocus = active && list.contains?.(active);
      list.replaceChildren(...channels.map(channel => rows.get(channel.id).row));
      if (restoreFocus && list.contains(active)) {
        active.focus({ preventScroll: true });
        if (Number.isInteger(start) && Number.isInteger(end)) active.setSelectionRange?.(start, end);
      }
    }
    text($('#channel-count'), presentation.resultCount(channels.length, state.channels.length, query));
    $('#channels-empty').hidden = state.channels.length > 0;
    $('#channels-no-results').hidden = !state.channels.length || channels.length > 0;
    $('#channels-list').hidden = channels.length === 0;
    $('#add-button').disabled = pending || unavailable();
    text($('#add-button'), pending ? '처리 중' : '추가');
    $$('[data-action="assign"], [data-action="remove"]').forEach(button => { button.disabled = pending || unavailable(); });
  }

  events.on($('#channel-form'), 'submit', async event => {
    event.preventDefault();
    const input = $('#channel-input').value;
    const name = $('#channel-name').value;
    if (await run('addChannel', { input: input.trim(), name: name.trim() }, '즐겨찾기에 추가했어요.')) {
      if ($('#channel-input').value === input) $('#channel-input').value = '';
      if ($('#channel-name').value === name) $('#channel-name').value = '';
      $('#channel-input').focus();
    }
  });
  events.on($('#channel-search'), 'input', () => render(snapshot));
  events.on($('#channels-list'), 'click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    if (button.dataset.action === 'assign') run('assignSlot', { slotId: Number(button.dataset.slot), channelId: button.dataset.channel });
    if (button.dataset.action === 'remove') run('removeChannel', button.dataset.channel, '즐겨찾기에서 삭제했어요.');
  });
  return { render, dispose() { events.dispose(); for (const value of rows.values()) value.editor.dispose(); rows.clear(); } };
}
