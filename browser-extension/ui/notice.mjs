import { createDom, createEventScope, setText } from '../shared/ui/dom.mjs';

export function createNoticeView({ document }) {
  const { $ } = createDom(document);
  const events = createEventScope();
  const notice = $('#notice');
  events.on($('[data-action="dismiss"]', notice), 'click', () => { notice.hidden = true; });
  return {
    show(message, error = false) {
      notice.setAttribute('role', error ? 'alert' : 'status');
      notice.classList.toggle('error', error);
      setText($('#notice-text'), message);
      notice.hidden = false;
    },
    dispose: events.dispose
  };
}
