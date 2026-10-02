import { createDom, createEventScope, setText as text } from '../shared/ui/dom.mjs';
import { presentation, slotIds, letters, getSlot as findSlot } from '../shared/ui/model.mjs';
import { unavailable as isUnavailable } from './state.mjs';

export function createFavoritesView({ document, run }) {
  const { $, $$, element: node, actionButton } = createDom(document);
  const events = createEventScope();
  let snapshot, channelsKey = '';
  const slot = slotId => findSlot(snapshot.state, slotId);
  const unavailable = () => isUnavailable(snapshot.state);
  function render(next) {
    snapshot = next;
    const { state, pending } = snapshot;
    const query = $('#channel-search').value;
    const channels = presentation.filterChannels(state.channels, query);
    const key = JSON.stringify([state.channels, state.slots.map(item => [item.slotId, item.channelId]), query]);
    if (key !== channelsKey) {
      channelsKey = key;
      const fragment = document.createDocumentFragment();
      for (const channel of channels) {
        const name = channel.name || `채널 ${channel.id.slice(0, 6)}`;
        const row = node('li', 'channel-row');
        row.classList.toggle('assigned', state.slots.some(item => item.channelId === channel.id));
        const avatar = node('span', 'channel-avatar', Array.from(name)[0] || '◇');
        avatar.setAttribute('aria-hidden', 'true');
        const label = node('span', 'channel-label', name);
        label.title = name;
        row.append(avatar, label);
        for (const slotId of slotIds) {
          const letter = letters[slotId];
          const button = actionButton('button channel-assign', letter, 'assign', { slot: slotId, channel: channel.id });
          button.setAttribute('aria-label', `${name} · ${letter}에 열기`);
          button.setAttribute('aria-pressed', String(slot(slotId).channelId === channel.id));
          row.append(button);
        }
        const remove = actionButton('icon-button channel-remove', '×', 'remove', { channel: channel.id });
        remove.setAttribute('aria-label', `${name} 즐겨찾기 삭제`);
        row.append(remove);
        fragment.append(row);
      }
      $('#channels-list').replaceChildren(fragment);
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
  return { render, dispose: events.dispose };
}
