export function setText(element, value) {
  const next = String(value ?? '');
  if (element.textContent !== next) element.textContent = next;
}

export function createDom(document) {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const element = (tag, className, value) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (value !== undefined) setText(result, value);
    return result;
  };
  const actionButton = (className, label, action, data = {}) => {
    const button = element('button', className, label);
    button.type = 'button';
    button.dataset.action = action;
    for (const [key, value] of Object.entries(data)) button.dataset[key] = String(value);
    return button;
  };
  return { $, $$, element, actionButton };
}

// Each view owns a scope, including teardown. Dynamic list items use delegation.
export function createEventScope() {
  const removals = [];
  return {
    on(target, type, callback, options) {
      target.addEventListener(type, callback, options);
      removals.push(() => target.removeEventListener(type, callback, options));
    },
    dispose() { for (const remove of removals.splice(0)) remove(); }
  };
}
