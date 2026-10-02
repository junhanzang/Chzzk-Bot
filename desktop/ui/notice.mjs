export function createNoticeView({ element, timers = globalThis, onChange = () => {} }) {
  let timer = null;
  function hide() {
    timers.clearTimeout(timer);
    timer = null;
    element.hidden = true;
    onChange();
  }
  return {
    show(message, error = false) {
      element.textContent = message;
      element.classList.toggle('error', error);
      element.hidden = false;
      timers.clearTimeout(timer);
      timer = timers.setTimeout(hide, error ? 12000 : 6000);
      onChange();
    },
    hide,
    dispose() { timers.clearTimeout(timer); timer = null; }
  };
}
