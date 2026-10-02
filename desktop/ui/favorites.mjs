import { createDom, createEventScope } from '../../browser-extension/shared/ui/dom.mjs';
import { presentation, slotIds, letters, slotKey, getSlot as findSlot } from '../../browser-extension/shared/ui/model.mjs';

export function createFavoritesView({ document, run, onFocusSlot }) {
  const { $, element } = createDom(document);
  const events = createEventScope();
  let snapshot, lastChannels = '';
  const getSlot = slotId => findSlot(snapshot.state, slotId);
  function render(next) {
    snapshot = next;
    const { state, pending, initialized, preview } = snapshot;
    $('#add-channel').disabled = pending.has('add') || (!initialized && !preview);
    $('#add-channel').textContent = pending.has('add') ? '추가 중…' : '채널 추가';
    const query = $('#channel-search').value;
    const key = JSON.stringify([state.channels, state.slots.map(slot => [slot.slotId, slot.channelId, slot.playbackMode]), [...pending], query]);
    if (key === lastChannels) return;
    lastChannels = key;
    const list = $('#channels-list');
    list.replaceChildren();
    const channels = presentation.filterChannels(state.channels, query);
    $('#channel-count').textContent = presentation.resultCount(channels.length, state.channels.length, query);
    $('#channels-empty').hidden = state.channels.length > 0;
    $('#channels-no-results').hidden = !state.channels.length || channels.length > 0;
    list.hidden = !channels.length;
    channels.forEach(channel => {
      const assigned = state.slots.some(slot => slot.channelId === channel.id);
      const row = element('div', `channel-item${assigned ? ' active' : ''}`);
      const info = element('div', 'channel-info');
      const name = channel.name || '이름 없는 채널';
      info.append(element('span', 'channel-avatar', [...name][0] || 'C'));
      const label = element('span', 'channel-name', name);
      label.title = name;
      info.append(label);
      const remove = element('button', 'channel-remove', '×');
      remove.type = 'button';
      remove.title = '즐겨찾기에서 삭제';
      remove.setAttribute('aria-label', `${name} 즐겨찾기에서 삭제`);
      remove.disabled = pending.has(`remove-${channel.id}`);
      remove.dataset.action = 'remove';
      remove.dataset.channel = channel.id;
      info.append(remove);
      row.append(info);
      const buttons = element('div', 'channel-slots');
      slotIds.forEach(slotId => {
        const current = getSlot(slotId).channelId === channel.id && getSlot(slotId).playbackMode !== 'browser';
        const button = element('button', `channel-slot-button${current ? ' assigned' : ''}`, `${letters[slotId]}${current ? ' ✓' : ''}`);
        button.type = 'button';
        button.setAttribute('aria-label', `${name} 방송 ${letters[slotId]}에서 보기`);
        button.title = `${letters[slotId]}에서 보기`;
        button.disabled = current || pending.has(slotKey(slotId));
        button.dataset.action = 'assign';
        button.dataset.channel = channel.id;
        button.dataset.slot = String(slotId);
        buttons.append(button);
      });
      row.append(buttons);
      list.append(row);
    });
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
  return { render, dispose: events.dispose };
}
