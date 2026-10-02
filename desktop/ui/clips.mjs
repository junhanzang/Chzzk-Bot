import { createDom, createEventScope } from '../../browser-extension/shared/ui/dom.mjs';
import { createClipTools } from '../../browser-extension/shared/ui/clip-tools.mjs';

export function createClipsView({ document, run, queryClips, timers }) {
  const { $ } = createDom(document), events = createEventScope();
  const clips = createClipTools({ document, timers, queryClips,
    list: $('#clips-list'), search: $('#clip-search'), count: $('#clip-count'), empty: $('#clips-empty'), noResults: $('#clips-no-results'),
    run: (method, arg) => run(method === 'openClip' ? `clip-${arg}` : method === 'showClipInFolder' ? `clip-reveal-${arg}` : `clip-update-${arg.id}`, method, arg)
  });
  events.on($('#clips-folder'), 'click', () => run('folder', 'showClipsFolder'));
  return {
    render({ state, pending = new Set(), initialized = true, preview = false }) {
      $('#clips-folder').disabled = pending.has('folder') || preview;
      const busy = new Set([...pending].flatMap(key => key.startsWith('clip-update-') || key.startsWith('clip-reveal-') ? [key.slice(12)] : key.startsWith('clip-') ? [key.slice(5)] : []));
      clips.render({ ...state, pending: busy, available: initialized && !preview });
    },
    dispose() { clips.dispose(); events.dispose(); }
  };
}
