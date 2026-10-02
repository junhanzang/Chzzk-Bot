'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Lightweight event/DOM contracts; no browser, app, profile, or network access.
class Element {
  constructor(tag = 'div', document) {
    Object.assign(this, { tagName: tag.toUpperCase(), document, children: [], parentElement: null, dataset: {}, attributes: {},
      listeners: new Map(), hidden: false, disabled: false, value: '', className: '', text: '' });
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.text = ''; this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  async dispatch(type, target = this) { for (const listener of this.listeners.get(type) || []) await listener({ target, preventDefault() {} }); }
  matches(selector) {
    const attrs = [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)], simple = selector.replace(/\[[^\]]+\]/g, '').trim();
    const tag = simple.match(/^([\w-]+)/)?.[1];
    if (tag && tag.toUpperCase() !== this.tagName) return false;
    if (simple.includes('.') && !this.className.split(/\s+/).includes(simple.split('.')[1])) return false;
    return attrs.every(([, name, expected]) => {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const value = name.startsWith('data-') ? this.dataset[key] : this.attributes[name];
      return expected === undefined ? value !== undefined : value === expected;
    });
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  focus() { this.document.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
}
class Document extends Element {
  constructor() { super('#document'); this.document = this; }
  createElement(tag) { return new Element(tag, this); }
}
function timers() {
  let id = 0; const pending = new Map();
  return { pending, setTimeout(callback) { pending.set(++id, callback); return id; }, clearTimeout(key) { pending.delete(key); },
    fire() { const callbacks = [...pending.values()]; pending.clear(); for (const callback of callbacks) callback(); } };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const flush = () => new Promise(resolve => setImmediate(resolve));
const clip = (id, extra = {}) => ({ id: String(id), title: `장면 ${id}`, fileName: `${id}.mp4`, createdAt: '2026-01-01', ...extra });
const response = (items, offset = 0, total = items.length, revision = 'run:1') => ({ items, offset, total, revision });
async function fixture(extra = {}) {
  const { createClipTools } = await import('../shared/ui/clip-tools.mjs');
  const document = new Document(), nodes = Object.fromEntries(['list', 'search', 'count', 'empty', 'noResults'].map(key => [key, document.createElement('div')]));
  document.append(...Object.values(nodes));
  const clock = timers(), calls = [];
  const view = createClipTools({ document, ...nodes, timers: clock, run: async (...args) => { calls.push(args); return true; }, ...extra });
  const state = { clips: [clip('one')], channels: [], clipTotal: 1, clipRevision: 'run:1', available: true, pending: false };
  return { document, ...nodes, clock, calls, view, state, more: document.querySelector('.clip-load-more'), status: document.querySelector('.clip-results-status') };
}

test('remote library loads bounded pages and refreshes only when the revision or query changes', async () => {
  const all = Array.from({ length: 235 }, (_, id) => clip(id)), requests = [];
  const f = await fixture({ queryClips: async args => {
    requests.push(args); const matches = args.query ? all.filter(item => item.id === args.query) : all;
    return response(matches.slice(args.offset, args.offset + args.limit), args.offset, matches.length);
  } });
  f.state.clips = all.slice(0, 100); f.state.clipTotal = all.length;
  f.view.render(f.state); await flush(); assert.equal(f.list.children.length, 50);
  f.view.render({ ...f.state, unrelated: true }); await flush(); assert.equal(requests.length, 1);
  await f.more.dispatch('click'); assert.equal(f.list.children.length, 100);
  await f.more.dispatch('click'); assert.equal(f.list.children.length, 150);
  assert.deepEqual(requests.map(({ offset, limit }) => [offset, limit]), [[0, 50], [0, 100], [0, 100], [100, 50]]);
  assert.equal(requests.every(request => request.limit <= 100), true);
  f.search.value = '220'; await f.search.dispatch('input'); f.clock.fire(); await flush();
  assert.equal(f.list.children.length, 1); assert.equal(f.list.querySelector('button').dataset.clip, '220');
  assert.equal(f.count.textContent, '1 / 235'); assert.equal(f.more.hidden, true);
  f.view.dispose();
});

test('search debounce invalidates older responses immediately and is preserved through state polling', async () => {
  const pending = [], f = await fixture({ queryClips: args => { const request = deferred(); pending.push({ ...request, args }); return request.promise; } });
  f.view.render(f.state); assert.equal(pending.length, 1);
  f.search.value = 'first'; await f.search.dispatch('input');
  f.search.value = 'new'; await f.search.dispatch('input');
  f.view.render({ ...f.state }); assert.equal(pending.length, 1); assert.equal(f.clock.pending.size, 1);
  pending[0].resolve(response([clip('stale')])); await flush(); assert.equal(f.list.children.length, 0);
  f.clock.fire(); assert.equal(pending.length, 2); assert.equal(pending[1].args.query, 'new');
  pending[1].resolve(response([clip('new')])); await flush(); assert.equal(f.list.querySelector('button').dataset.clip, 'new');
  f.view.render({ ...f.state, clipRevision: 'new-run:1' }); assert.equal(pending.length, 3, 'New app sessions invalidate identical counters');
  pending[2].resolve(response([clip('restarted')], 0, 1, 'new-run:1')); await flush();
  assert.equal(f.list.querySelector('button').dataset.clip, 'restarted'); f.view.dispose();
});

test('filter/sort reset pagination and keep response revisions from being combined', async () => {
  let revision = 'run:1', sequence = 0; const requests = [];
  const f = await fixture({ queryClips: async args => {
    requests.push(args); const rows = Array.from({ length: Math.min(args.limit, 220 - args.offset) }, (_, index) => clip(args.offset + index));
    return response(rows, args.offset, 220, sequence++ >= 3 ? 'run:2' : revision);
  } });
  f.state.clipTotal = 220; f.view.render(f.state); await flush();
  await f.more.dispatch('click'); assert.equal(f.list.children.length, 100);
  await f.more.dispatch('click'); assert.equal(f.list.children.length, 100, 'Different revision page must not partially replace the last complete result');
  assert.match(f.status.textContent, /변경되었습니다/);
  const filter = f.document.querySelector('.clip-filter'); filter.value = 'starred'; await filter.dispatch('change'); await flush();
  assert.equal(requests.at(-1).filter, 'starred'); assert.equal(requests.at(-1).limit, 50);
  const sort = f.document.querySelector('.clip-sort'); sort.value = 'oldest'; await sort.dispatch('change'); await flush();
  assert.equal(requests.at(-1).sort, 'oldest'); f.view.dispose();
});

test('metadata controls keep title drafts and focus through refresh, reject duplicates and expose only IDs', async () => {
  const saving = deferred(), calls = [];
  const f = await fixture({ run: (...args) => { calls.push(args); return args[0] === 'updateClip' && args[1].title ? saving.promise : Promise.resolve(true); } });
  f.view.render(f.state);
  await f.list.dispatch('click', f.list.querySelector('[data-action="star"]'));
  assert.deepEqual(calls[0], ['updateClip', { id: 'one', favorite: true }]);
  await f.list.dispatch('click', f.list.querySelector('[data-action="reveal"]'));
  assert.deepEqual(calls[1], ['showClipInFolder', 'one']);
  await f.list.dispatch('click', f.list.querySelector('[data-action="rename"]'));
  let input = f.list.querySelector('[data-clip-title]'); input.value = '아직 쓰는 제목'; input.setSelectionRange(3, 4); await f.list.dispatch('input', input);
  f.view.render({ ...f.state, clips: [clip('one', { favorite: true })], clipRevision: 'run:2' });
  input = f.list.querySelector('[data-clip-title]'); assert.equal(input.value, '아직 쓰는 제목'); assert.equal(f.document.activeElement, input);
  assert.equal(input.selectionStart, 3);
  const form = f.list.querySelector('form'); const applying = f.list.dispatch('submit', form);
  await f.list.dispatch('submit', form); assert.equal(calls.length, 3, 'Repeated submit while saving sends one command');
  assert.deepEqual(calls[2], ['updateClip', { id: 'one', title: '아직 쓰는 제목' }]);
  assert.equal(f.list.querySelector('[data-clip-title]').disabled, true);
  saving.resolve(false); await applying; assert.equal(f.list.querySelector('[data-clip-title]').value, '아직 쓰는 제목', 'Rejected draft remains editable');
  f.view.dispose();
});

test('disconnect and disposal invalidate late requests, clear debounce and remove command listeners', async () => {
  const pending = [], f = await fixture({ queryClips: () => { const item = deferred(); pending.push(item); return item.promise; } });
  f.view.render(f.state); f.view.render({ ...f.state, available: false });
  pending[0].resolve(response([clip('stale')])); await flush();
  assert.equal(f.list.querySelector('button').dataset.clip, 'one'); assert.equal(f.list.querySelector('button').disabled, true);
  f.view.render(f.state); assert.equal(pending.length, 2);
  f.search.value = 'pending search'; await f.search.dispatch('input'); assert.equal(f.clock.pending.size, 1);
  f.view.dispose(); assert.equal(f.clock.pending.size, 0);
  pending[1].resolve(response([clip('too late')])); await flush();
  assert.equal(f.list.querySelector('button').dataset.clip, 'one');
  await f.list.dispatch('click', f.list.querySelector('button')); assert.equal(f.calls.length, 0);
  assert.equal(f.list.listeners.get('click').size, 0);
});

test('failed reads can be retried without repeated network calls on unrelated state updates', async () => {
  let requests = 0;
  const f = await fixture({ queryClips: async () => { if (++requests === 1) throw new Error('연결이 끊겼습니다.'); return response([clip('recovered')]); } });
  f.view.render(f.state); await flush(); assert.match(f.status.textContent, /연결이 끊겼습니다/); assert.equal(f.more.hidden, false);
  f.view.render({ ...f.state }); await flush(); assert.equal(requests, 1);
  await f.more.dispatch('click'); assert.equal(requests, 2); assert.equal(f.list.querySelector('button').dataset.clip, 'recovered');
  f.view.dispose();
});
