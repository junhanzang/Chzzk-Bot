'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const presentation = require('../shared/presentation.js');

// In-memory DOM, including focus loss on node removal. No browser is launched.
class Element {
  constructor(tag = 'div', document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.parentElement = null;
    this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.className = ''; this.id = '';
    this.value = ''; this.hidden = false; this.disabled = false; this._text = '';
    this.classList = { toggle: (name, enabled) => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      if (enabled) classes.add(name); else classes.delete(name); this.className = [...classes].join(' ');
    } };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  append(...children) {
    for (const child of children) {
      if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child);
      child.parentElement = this; this.children.push(child);
    }
  }
  replaceChildren(...children) {
    if (this.contains(this.ownerDocument?.activeElement)) this.ownerDocument.activeElement = null;
    for (const child of this.children) child.parentElement = null;
    this.children = []; this._text = ''; this.append(...children);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  async dispatch(type, extra = {}) { for (const listener of this.listeners.get(type) || []) await listener({ target: this, preventDefault() {}, ...extra }); }
  focus() { this.ownerDocument.activeElement = this; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  matches(selector) {
    return selector.split(',').some(part => {
      const attrs = [...part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)], simple = part.replace(/\[[^\]]+\]/g, '').trim();
      const tag = simple.match(/^([\w-]+)/)?.[1];
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      if (simple.includes('#') && this.id !== simple.split('#')[1]) return false;
      if (simple.includes('.') && !this.className.split(/\s+/).includes(simple.split('.')[1])) return false;
      return attrs.every(([, name, expected]) => {
        const value = name.startsWith('data-') ? this.dataset[name.slice(5)] : this.attributes[name];
        return expected === undefined ? value !== undefined : value === expected;
      });
    });
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
}
class Document extends Element {
  constructor(ids = []) {
    super('#document'); this.ownerDocument = this; this.activeElement = null;
    for (const id of ids) { const node = this.createElement('div'); node.id = id; this.append(node); }
    const brand = this.createElement('a'); brand.className = 'brand'; this.append(brand);
  }
  createElement(tag) { return new Element(tag, this); }
}

test('pinned favorites sort first stably without changing stored order or search behavior', () => {
  const channels = [{ id: 'one', name: '방송 A' }, { id: 'two', name: '방송 B', pinned: true },
    { id: 'three', name: '방송 C', pinned: true }, { id: 'four', name: '방송 D' }];
  assert.deepEqual(presentation.filterChannels(channels).map(item => item.id), ['two', 'three', 'one', 'four']);
  assert.deepEqual(channels.map(item => item.id), ['one', 'two', 'three', 'four']);
  assert.deepEqual(presentation.filterChannels(channels, '방송 b').map(item => item.id), ['two']);
});

async function editorFixture(callbacks = {}) {
  const { createChannelEditor } = await import('../shared/ui/channel-editor.mjs');
  const document = new Document(), calls = [];
  const editor = createChannelEditor({ document, onRename: callbacks.rename || (async arg => { calls.push(arg); return false; }),
    onPin: callbacks.pin || (async arg => { calls.push(arg); return false; }) });
  document.append(editor.element);
  const value = { channel: { id: 'one', name: '원래 이름', pinned: false }, available: true, pending: false };
  editor.render(value);
  const find = selector => editor.element.querySelector(selector);
  return { document, editor, value, calls, find };
}

test('inline rename preserves drafts across polling, validates 1–60 characters, and supports explicit cancel', async () => {
  const f = await editorFixture();
  await f.find('.channel-edit').dispatch('click');
  const input = f.find('input'), form = f.find('form');
  assert.equal(f.document.activeElement, input);
  input.value = '작성 중인 이름'; await input.dispatch('input');
  f.editor.render({ ...f.value, channel: { ...f.value.channel, name: '외부에서 바뀐 이름', pinned: true } });
  assert.equal(input.value, '작성 중인 이름');
  assert.equal(f.find('.channel-label').textContent, '외부에서 바뀐 이름');
  assert.equal(f.find('.channel-pin').attributes['aria-pressed'], 'true');
  for (const name of ['   ', '가'.repeat(61)]) {
    input.value = name; await input.dispatch('input'); await form.dispatch('submit');
    assert.equal(f.calls.length, 0); assert.match(f.find('.channel-edit-error').textContent, /1자에서 60자/);
  }
  input.value = '가'.repeat(60); await input.dispatch('input'); await form.dispatch('submit');
  assert.deepEqual(f.calls, [{ channelId: 'one', name: '가'.repeat(60) }]);
  assert.equal(input.value.length, 60, 'Rejected rename keeps the draft');
  assert.equal(form.hidden, false);
  await f.find('.channel-edit-cancel').dispatch('click');
  assert.equal(form.hidden, true); assert.equal(input.value, '외부에서 바뀐 이름');
  await f.find('.channel-edit').dispatch('click'); input.value = '취소할 이름'; await input.dispatch('input');
  await input.dispatch('keydown', { key: 'Escape' }); assert.equal(form.hidden, true);
  f.editor.dispose();
});

test('pending apply excludes duplicates and accepts only the confirmed server name', async () => {
  let resolve, sent;
  const f = await editorFixture({ rename: arg => { sent = arg; return new Promise(done => { resolve = done; }); } });
  await f.find('.channel-edit').dispatch('click');
  f.find('input').value = ' 새 이름 '; await f.find('input').dispatch('input');
  const pending = f.find('form').dispatch('submit');
  assert.deepEqual(sent, { channelId: 'one', name: '새 이름' });
  assert.equal(f.find('input').disabled, true); assert.equal(f.find('.channel-edit-cancel').disabled, true);
  await f.find('form').dispatch('submit');
  f.editor.render({ ...f.value, channel: { ...f.value.channel, name: '새 이름' } });
  assert.equal(f.find('input').value, ' 새 이름 ', 'A state update cannot replace an in-flight draft');
  resolve(true); await pending;
  assert.equal(f.find('form').hidden, true); assert.equal(f.find('.channel-label').textContent, '새 이름');
  f.editor.dispose();
});

test('pin toggles never update optimistically and unavailable/disposed editors cannot issue changes', async () => {
  let finish;
  const f = await editorFixture({ pin: arg => { f.calls.push(arg); return new Promise(resolve => { finish = resolve; }); } });
  const pending = f.find('.channel-pin').dispatch('click');
  assert.deepEqual(f.calls, [{ channelId: 'one', pinned: true }]);
  assert.equal(f.find('.channel-pin').attributes['aria-pressed'], 'false');
  await f.find('.channel-pin').dispatch('click'); assert.equal(f.calls.length, 1);
  f.editor.render({ ...f.value, channel: { ...f.value.channel, pinned: true } }); finish(true); await pending;
  assert.equal(f.find('.channel-pin').attributes['aria-pressed'], 'true');
  f.editor.render({ ...f.value, available: false });
  await f.find('.channel-pin').dispatch('click'); await f.find('.channel-edit').dispatch('click'); assert.equal(f.calls.length, 1);
  f.editor.render(f.value); await f.find('.channel-edit').dispatch('click');
  f.editor.dispose();
  await f.find('.channel-pin').dispatch('click'); assert.equal(f.calls.length, 1);
});

test('failed pin retains confirmed state and disposing a pending rename ignores its late completion', async () => {
  let finish;
  const f = await editorFixture({ rename: () => new Promise(resolve => { finish = resolve; }) });
  await f.find('.channel-pin').dispatch('click');
  assert.equal(f.find('.channel-pin').attributes['aria-pressed'], 'false');
  assert.match(f.find('.channel-edit-error').textContent, /고정 상태/);
  await f.find('.channel-edit').dispatch('click'); f.find('input').value = '늦은 응답'; await f.find('input').dispatch('input');
  const pending = f.find('form').dispatch('submit');
  f.editor.dispose();
  const before = f.editor.element.textContent;
  finish(true); await pending;
  assert.equal(f.editor.element.textContent, before);
  assert.equal(f.find('form').hidden, false);
  assert.equal(f.find('input').listeners.get('input').size, 0);
});

const ids = ['channel-search', 'channel-count', 'channels-empty', 'channels-no-results', 'channels-list', 'channel-form', 'channel-input', 'channel-name', 'add-channel', 'add-button'];
for (const platform of ['desktop', 'extension']) {
  test(`${platform} favorite rows retain draft/focus through polling and pin sorting, with platform command wiring`, async () => {
    const { createFavoritesView } = await import(platform === 'desktop' ? '../../desktop/ui/favorites.mjs' : '../ui/favorites.mjs');
    const document = new Document(ids), calls = [];
    const view = createFavoritesView({ document, run: async (...args) => { calls.push(args); return false; }, onFocusSlot() {} });
    let state = { channels: [{ id: 'one', name: '첫 방송', pinned: false }, { id: 'two', name: '둘 방송', pinned: false }],
      slots: [0, 1, 2, 3].map(slotId => ({ slotId })), connection: { status: 'standalone' } };
    const render = () => view.render({ state, pending: platform === 'desktop' ? new Set() : false, initialized: true, preview: false });
    render();
    const list = document.querySelector('#channels-list'), first = list.children[0];
    await first.querySelector('.channel-edit').dispatch('click');
    const input = first.querySelector('input'); input.value = '편집 중'; input.setSelectionRange(1, 2); await input.dispatch('input');
    render(); assert.equal(first.querySelector('input'), input); assert.equal(document.activeElement, input);
    state = { ...state, channels: [state.channels[0], { ...state.channels[1], pinned: true }] }; render();
    assert.deepEqual(list.children.map(row => row.dataset.channel), ['two', 'one']);
    assert.equal(document.activeElement, input); assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 2]);
    assert.equal(input.value, '편집 중');
    await first.querySelector('form').dispatch('submit');
    assert.deepEqual(calls[0].slice(0, platform === 'desktop' ? 3 : 2), platform === 'desktop'
      ? ['rename-one', 'renameChannel', { channelId: 'one', name: '편집 중' }]
      : ['renameChannel', { channelId: 'one', name: '편집 중' }]);
    const search = document.querySelector('#channel-search'); search.focus(); search.value = '둘'; await search.dispatch('input');
    search.value = ''; await search.dispatch('input');
    assert.equal(first.querySelector('input').value, '편집 중');
    await first.querySelector('.channel-pin').dispatch('click');
    assert.deepEqual(calls.at(-1), platform === 'desktop'
      ? ['pin-one', 'setChannelPinned', { channelId: 'one', pinned: true }]
      : ['setChannelPinned', { channelId: 'one', pinned: true }]);
    state = { ...state, channels: [state.channels[1]] }; render();
    const before = calls.length; await first.querySelector('.channel-pin').dispatch('click'); assert.equal(calls.length, before);
    view.dispose();
  });
}
