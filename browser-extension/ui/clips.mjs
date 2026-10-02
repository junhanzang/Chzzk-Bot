import { createDom, createEventScope, setText as text } from '../shared/ui/dom.mjs';
import { presentation } from '../shared/ui/model.mjs';
import { connected as isConnected, paired as isPaired } from './state.mjs';

export function createClipsView({ document, run }) {
  const { $, $$, element: node, actionButton } = createDom(document);
  const events = createEventScope();
  let snapshot, clipsKey = '';
  const connected = () => isConnected(snapshot.state);
  const paired = () => isPaired(snapshot.state);
  function render(next) {
    snapshot = next;
    const { state, pending } = snapshot;
    $('#clips-section').hidden = !paired();
    $('#folder-button').disabled = pending || !connected();
    const query = $('#clip-search').value;
    const matching = presentation.filterClips(state.clips, query, state.channels);
    const key = JSON.stringify([state.clips, state.channels, query]);
    if (key !== clipsKey) {
      clipsKey = key;
      const fragment = document.createDocumentFragment();
      const clips = matching.slice(0, 10);
      for (const clip of clips) {
        const row = node('li', 'clip-row');
        const icon = node('span', 'clip-icon', '▷');
        icon.setAttribute('aria-hidden', 'true');
        const description = node('div', 'clip-info');
        const title = node('strong', 'clip-title', clip.title || clip.fileName || '저장한 클립');
        title.title = title.textContent;
        description.append(title, node('small', 'clip-meta', presentation.formatClipMeta(clip)));
        const open = actionButton('button clip-open', '열기 ↗', 'open-clip', { clip: clip.id });
        open.setAttribute('aria-label', `${title.textContent} 클립 열기`);
        row.append(icon, description, open);
        fragment.append(row);
      }
      $('#clips-list').replaceChildren(fragment);
    }
    text($('#clip-count'), presentation.resultCount(matching.length, state.clips.length, query));
    $('#clips-empty').hidden = state.clips.length > 0;
    $('#clips-no-results').hidden = !state.clips.length || matching.length > 0;
    $('#clips-list').hidden = matching.length === 0;
    $('#clips-limit').hidden = matching.length <= 10;
    text($('#clips-limit'), query.trim() ? '검색 결과 중 최근 10개를 표시해요. 검색어를 더 구체적으로 입력해 보세요.' : '최근 10개를 표시해요. 검색으로 이전 클립을 찾아 보세요.');
    $$('[data-action="open-clip"]').forEach(button => { button.disabled = pending || !connected(); });
  }

  events.on($('#clip-search'), 'input', () => render(snapshot));
  events.on($('#folder-button'), 'click', () => run('showClipsFolder'));
  events.on($('#clips-list'), 'click', event => {
    const button = event.target.closest('button[data-action="open-clip"]');
    if (button && !button.disabled) run('openClip', button.dataset.clip);
  });
  return { render, dispose: events.dispose };
}
