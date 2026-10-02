import { createDom, createEventScope } from '../../browser-extension/shared/ui/dom.mjs';
import { presentation } from '../../browser-extension/shared/ui/model.mjs';
import { autoClipBadge } from '../../browser-extension/shared/ui/auto-clips.mjs';

export function createClipsView({ document, run }) {
  const { $, element } = createDom(document);
  const events = createEventScope();
  let snapshot, lastClips = '';
  function render(next) {
    snapshot = next;
    const { state, pending } = snapshot;
    $('#clips-folder').disabled = pending.has('folder');
    const query = $('#clip-search').value;
    const key = JSON.stringify([state.clips, state.channels, [...pending], query]);
    if (key === lastClips) return;
    lastClips = key;
    const list = $('#clips-list');
    list.replaceChildren();
    const clips = presentation.filterClips(state.clips, query, state.channels);
    $('#clip-count').textContent = presentation.resultCount(clips.length, state.clips.length, query);
    $('#clips-empty').hidden = state.clips.length > 0;
    $('#clips-no-results').hidden = !state.clips.length || clips.length > 0;
    list.hidden = clips.length === 0;
    clips.forEach(clip => {
      const row = element('div', 'clip-row');
      row.append(element('span', 'clip-badge', '▷'));
      const description = element('div', 'clip-description');
      const title = element('strong', '', clip.title || clip.fileName || '저장한 클립');
      title.title = clip.fileName || clip.title || '';
      description.append(title);
      const meta = element('small', '', presentation.formatClipMeta(clip));
      const badge = autoClipBadge(clip.trigger);
      if (badge) meta.append(element('span', 'auto-clip-badge', badge));
      description.append(meta);
      row.append(description);
      const open = element('button', 'clip-open', '열기 ↗');
      open.type = 'button';
      open.setAttribute('aria-label', `${clip.title || clip.fileName || '클립'} 열기`);
      open.disabled = pending.has(`clip-${clip.id}`);
      open.dataset.clip = clip.id;
      row.append(open);
      list.append(row);
    });
  }

  events.on($('#clip-search'), 'input', () => render(snapshot));
  events.on($('#clips-folder'), 'click', () => run('folder', 'showClipsFolder'));
  events.on($('#clips-list'), 'click', event => {
    const button = event.target.closest('button[data-clip]');
    if (button && !button.disabled) run(`clip-${button.dataset.clip}`, 'openClip', button.dataset.clip);
  });
  return { render, dispose: events.dispose };
}
