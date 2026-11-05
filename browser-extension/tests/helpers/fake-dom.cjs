'use strict';
// In-memory DOM contracts only: no browser, layout engine, app, or user profile.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
    this.dataset = {}; this.attributes = {}; this.listeners = new Map();
    this.hidden = false; this.disabled = false; this.value = ''; this.className = ''; this.id = ''; this._text = '';
    this.classList = { toggle: (name, enabled) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      if (enabled) names.add(name); else names.delete(name);
      this.className = [...names].join(' ');
    } };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) {
    for (const child of children) {
      if (child.tagName === '#FRAGMENT') { this.append(...child.children); continue; }
      child.parentElement = this; this.children.push(child);
    }
  }
  replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  async dispatch(type, target = this) { for (const listener of this.listeners.get(type) || []) await listener({ target, preventDefault() {} }); }
  matches(selector) {
    return selector.split(',').some(part => {
      const attrs = [...part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
      const simple = part.replace(/\[[^\]]+\]/g, '').trim();
      const tag = simple.match(/^([\w-]+)/)?.[1];
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      if (simple.includes('#') && this.id !== simple.split('#')[1]) return false;
      if (simple.includes('.') && !this.className.split(/\s+/).includes(simple.split('.')[1])) return false;
      return attrs.every(([, name, expected]) => {
        const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        const value = name.startsWith('data-') ? this.dataset[key] : this.attributes[name];
        return expected === undefined ? value !== undefined : value === expected;
      });
    });
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  focus() {}
}
class Document extends Element {
  constructor(ids) {
    super('#document');
    for (const id of ids) { const element = new Element(); element.id = id; this.append(element); }
    const brand = new Element('a'); brand.className = 'brand'; this.append(brand);
  }
  createElement(tag) { return new Element(tag); }
  createDocumentFragment() { return new Element('#fragment'); }
}

module.exports = { Element, Document };
