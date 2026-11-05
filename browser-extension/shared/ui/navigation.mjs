import { createEventScope } from './dom.mjs';

// Changes only visibility. Views and their playback/recording resources stay alive.
export function createSectionNavigation({ document, initial = 'watch', onChange = () => {} }) {
  const navigation = document.querySelector('#section-navigation');
  const buttons = [...navigation.querySelectorAll('[data-section]')];
  const panels = [...document.querySelectorAll('[data-section-panel]')];
  const events = createEventScope();
  const sections = new Set(buttons.map(button => button.dataset.section));
  let current = null, disposed = false;
  function select(section) {
    if (disposed || !sections.has(section)) return false;
    current = section;
    navigation.dataset.current = section;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.section === section));
    for (const panel of panels) panel.hidden = !panel.dataset.sectionPanel.split(' ').includes(section);
    onChange(section);
    return true;
  }
  events.on(navigation, 'click', event => {
    const button = event.target.closest('button[data-section]');
    if (button && !button.disabled) select(button.dataset.section);
  });
  select(initial);
  return { select, current: () => current, dispose() { disposed = true; events.dispose(); } };
}
