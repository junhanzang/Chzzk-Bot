import { createDom, createEventScope } from '../shared/ui/dom.mjs';
import { createClipTools } from '../shared/ui/clip-tools.mjs';
import { connected, paired } from './state.mjs';

export function createClipsView({ document, run, queryClips, timers }) {
  const { $ } = createDom(document), events = createEventScope();
  const clips = createClipTools({ document, timers, queryClips, run, rowTag: 'li',
    list: $('#clips-list'), search: $('#clip-search'), count: $('#clip-count'), empty: $('#clips-empty'), noResults: $('#clips-no-results')
  });
  events.on($('#folder-button'), 'click', () => run('showClipsFolder'));
  return {
    render({ state, pending }) {
      $('#clips-section').hidden = !paired(state);
      $('#folder-button').disabled = pending || !connected(state);
      $('#clips-limit').hidden = true;
      clips.render({ ...state, pending, available: connected(state) });
    },
    dispose() { clips.dispose(); events.dispose(); }
  };
}
