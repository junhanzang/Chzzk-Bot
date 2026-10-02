'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

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
const favoritesIds = ['channel-search', 'channel-count', 'channels-empty', 'channels-no-results', 'channels-list', 'channel-form', 'channel-input', 'channel-name', 'add-channel', 'add-button'];
const clipsIds = ['clip-search', 'clip-count', 'clips-empty', 'clips-no-results', 'clips-list', 'clips-folder', 'clips-section', 'folder-button', 'clips-limit'];
function snapshot() {
  return { state: { channels: [{ id: 'one', name: '버스 방송' }, { id: 'two', name: '다른 방송' }],
    slots: [0, 1, 2, 3].map(slotId => ({ slotId })), clips: [], savingSlots: [], connection: { status: 'connected' } },
    pending: new Set(), pendingSaves: new Set(), initialized: true, preview: false };
}

for (const platform of ['desktop', 'extension']) {
  const base = platform === 'desktop' ? '../../desktop/ui/' : '../ui/';
  test(`${platform} favorites view keeps its search through state updates and owns command listeners`, async () => {
    const { createFavoritesView } = await import(base + 'favorites.mjs');
    const document = new Document(favoritesIds), calls = [], focused = [];
    const view = createFavoritesView({ document, run: (...args) => calls.push(args), onFocusSlot: id => focused.push(id) });
    const value = snapshot(); if (platform === 'extension') value.pending = false;
    const search = document.querySelector('#channel-search'), list = document.querySelector('#channels-list');
    search.value = '버스';
    view.render(value);
    assert.equal(list.children.length, 1);
    view.render({ ...value, state: { ...value.state, channels: [...value.state.channels, { id: 'three', name: '버스 합방' }] } });
    assert.equal(search.value, '버스');
    assert.equal(list.children.length, 2);
    const assign = list.querySelector('button[data-slot="3"]');
    await list.dispatch('click', assign);
    assert.deepEqual(calls[0], platform === 'desktop' ? ['slot-3', 'assignSlot', { slotId: 3, channelId: 'one' }] : ['assignSlot', { slotId: 3, channelId: 'one' }]);
    if (platform === 'desktop') assert.deepEqual(focused, [3]);
    search.value = '일치하지 않음'; await search.dispatch('input');
    assert.equal(document.querySelector('#channels-empty').hidden, true);
    assert.equal(document.querySelector('#channels-no-results').hidden, false);
    view.dispose();
    await list.dispatch('click', assign);
    assert.equal(calls.length, 1, 'Disposed view must not send commands');
  });

  test(`${platform} clips view filters before display limits and keeps text during refresh`, async () => {
    const { createClipsView } = await import(base + 'clips.mjs');
    const document = new Document(clipsIds), calls = [];
    const view = createClipsView({ document, run: (...args) => calls.push(args) });
    const value = snapshot(); if (platform === 'extension') value.pending = false;
    value.state.clips = Array.from({ length: 14 }, (_, index) => ({ id: String(index), title: index === 1 ? '오래전 장면' : '다른 장면', fileName: `${index}.mp4`, createdAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z` }));
    const search = document.querySelector('#clip-search'), list = document.querySelector('#clips-list');
    search.value = '오래전';
    view.render(value); view.render({ ...value, state: { ...value.state } });
    assert.equal(search.value, '오래전');
    assert.equal(list.children.length, 1);
    await list.dispatch('click', list.querySelector('button'));
    assert.deepEqual(calls[0], platform === 'desktop' ? ['clip-1', 'openClip', '1'] : ['openClip', '1']);
    search.value = '없는 클립'; await search.dispatch('input');
    assert.equal(document.querySelector('#clips-no-results').hidden, false);
    assert.equal(document.querySelector('#clips-empty').hidden, true);
    view.render({ ...value, state: { ...value.state, clips: [] } });
    assert.equal(document.querySelector('#clips-no-results').hidden, true);
    assert.equal(document.querySelector('#clips-empty').hidden, false);
    view.dispose();
  });
}

test('bounds reporter resends unchanged geometry when a player becomes ready and releases observers', async () => {
  const { createPlayerBounds } = await import('../../desktop/ui/bounds.mjs');
  const document = new Document([]), workspace = new Element(), grid = new Element(), card = new Element(), surface = new Element();
  workspace.className = 'workspace'; workspace.scrollTop = 0;
  workspace.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600 });
  grid.className = 'players-grid'; grid.getBoundingClientRect = () => ({ top: 100 - workspace.scrollTop });
  const style = new Map(); grid.style = { getPropertyValue: name => style.get(name), setProperty: (name, value) => style.set(name, value) };
  surface.setAttribute('data-role', 'surface'); surface.dataset.role = 'surface';
  surface.getBoundingClientRect = () => ({ left: 20, top: 100, right: 400, bottom: 400 });
  card.append(surface); document.append(workspace, grid);
  const frames = new Map(), sent = [], observed = []; let frameId = 0, disconnected = false;
  const window = new Element();
  Object.assign(window, { innerWidth: 800, innerHeight: 600,
    getComputedStyle: () => ({ paddingBottom: '10px' }), requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { observe(node) { observed.push(node); } disconnect() { disconnected = true; } }
  });
  const flushFrame = async () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) await callback(); };
  const reporter = createPlayerBounds({ document, window, cards: [card], sendBounds: async bounds => sent.push(bounds), onError: error => assert.fail(error) });
  assert.deepEqual(observed, [card, surface], 'Footer expansion can move other videos without resizing their surfaces');
  reporter.update([{ slotId: 0, channelId: 'one', pageStatus: 'loading' }]); await flushFrame();
  reporter.request(); await flushFrame(); assert.equal(sent.length, 1);
  reporter.update([{ slotId: 0, channelId: 'one', pageStatus: 'ready' }]); await flushFrame(); assert.equal(sent.length, 2);
  workspace.scrollTop = 30; reporter.request(); await flushFrame(); assert.equal(style.get('--stage-height'), '490px');
  reporter.request(); reporter.dispose(); await flushFrame();
  assert.equal(disconnected, true);
  assert.equal(frames.size, 0);
  assert.equal(document.listeners.get('scroll').size, 0);
  assert.equal(window.listeners.get('resize').size, 0);
});

test('auto clip status uses the current channel and does not confuse observation and recorder generations', async () => {
  const { autoClipForSlot, describeAutoClip, autoClipBadge } = await import('../shared/ui/auto-clips.mjs');
  const current = { slotId: 0, channelId: 'current', generation: 'observation', status: 'needs-buffer', message: '구간 보관을 켜 주세요.' };
  const entries = [{ ...current, channelId: 'previous', status: 'saving' }, current];
  assert.equal(autoClipForSlot(entries, { slotId: 0, channelId: 'current', generation: 7 }), current);
  assert.equal(autoClipForSlot(entries, { slotId: 1, channelId: 'current' }), undefined);
  assert.equal(describeAutoClip({ enabled: true }, current).summary, '구간 보관 필요');
  assert.equal(describeAutoClip({ enabled: true }, { ...current, status: 'pending', savedCount: 2 }).summary, '감지됨 · 뒷부분 보관 중 · 2개 저장');
  assert.equal(describeAutoClip({ enabled: true }, { ...current, status: 'error' }).error, true);
  assert.equal(describeAutoClip({ enabled: false }, { ...current, status: 'saving' }).summary, '꺼짐');
  assert.equal(describeAutoClip({ enabled: true }, current, false).summary, '앱 연결 필요');
  assert.equal(autoClipBadge('keyword'), '자동 · 키워드');
  assert.equal(autoClipBadge('chat-spike'), '자동 · 채팅 급증');
  assert.equal(autoClipBadge(undefined), '');
});

test('auto clip form keeps edits through refresh, applies explicitly, and retains rejected drafts', async () => {
  const { createAutoClipControls } = await import('../shared/ui/auto-clips.mjs');
  const document = new Document([]), calls = [];
  let finish, result = new Promise(resolve => { finish = resolve; });
  const view = createAutoClipControls({ document, label: '방송 A', onApply: argument => { calls.push(argument); return result; } });
  const state = { channelId: 'one', settings: { enabled: false, keywords: [], chatSpike: false }, available: true, pending: false };
  view.render(state);
  const form = view.element.querySelector('form'), apply = view.element.querySelector('button');
  const enabled = view.element.querySelector('[data-role="auto-clip-enabled"]');
  const keywords = view.element.querySelector('[data-role="auto-clip-keywords"]');
  const spike = view.element.querySelector('[data-role="auto-clip-spike"]');
  assert.equal(enabled.checked, false);
  enabled.checked = true; await enabled.dispatch('change');
  keywords.value = ' 우승, 레전드 '; await keywords.dispatch('input');
  spike.checked = true; await spike.dispatch('change');
  view.render({ ...state, activity: { status: 'disabled' } });
  assert.equal(keywords.value, ' 우승, 레전드 ');
  assert.equal(enabled.checked, true);
  assert.equal(calls.length, 0, 'Editing must not enable automatic saving');
  const applying = form.dispatch('submit');
  assert.deepEqual(calls, [{ channelId: 'one', enabled: true, keywords: ['우승', '레전드'], chatSpike: true }]);
  assert.equal(apply.disabled, true);
  assert.equal(keywords.disabled, true);
  await form.dispatch('submit');
  assert.equal(calls.length, 1, 'Pending applies must be excluded');
  const accepted = { ...state, settings: calls[0] };
  view.render(accepted);
  finish(true); await applying;
  assert.equal(keywords.value, '우승, 레전드', 'Successful applies show server settings');
  assert.equal(apply.disabled, true);
  keywords.value = '실패해도 남을 입력'; await keywords.dispatch('input');
  result = Promise.resolve(false);
  await form.dispatch('submit');
  view.render(accepted);
  assert.equal(keywords.value, '실패해도 남을 입력');
  assert.equal(apply.disabled, false);
  view.dispose();
});

test('auto clip controls require app connection, reset on channel change, and drop late completions after disposal', async () => {
  const { createAutoClipControls } = await import('../shared/ui/auto-clips.mjs');
  const document = new Document([]), calls = [];
  let finish;
  const view = createAutoClipControls({ document, label: '방송 B', onApply: argument => { calls.push(argument); return new Promise(resolve => { finish = resolve; }); } });
  const state = { channelId: 'one', settings: { enabled: true, keywords: ['첫 방송'], chatSpike: false }, available: false, pending: false };
  const form = view.element.querySelector('form'), keywords = view.element.querySelector('[data-role="auto-clip-keywords"]');
  view.render(state);
  assert.equal(keywords.disabled, true);
  assert.equal(view.element.querySelector('.auto-clip-status').textContent, '앱 연결 필요');
  await form.dispatch('submit'); assert.equal(calls.length, 0);
  view.render({ ...state, available: true });
  keywords.value = '이전 방송 수정'; await keywords.dispatch('input');
  view.element.open = true;
  view.render({ ...state, channelId: 'two', settings: { enabled: false, keywords: ['다른 방송'], chatSpike: true }, available: true });
  assert.equal(keywords.value, '다른 방송');
  assert.equal(view.element.open, false);
  keywords.value = '새 조건'; await keywords.dispatch('input');
  const applying = form.dispatch('submit');
  assert.equal(calls[0].channelId, 'two');
  view.dispose();
  const before = view.element.textContent;
  finish(true); await applying;
  assert.equal(view.element.textContent, before);
  await form.dispatch('submit'); assert.equal(calls.length, 1);
  assert.equal(keywords.listeners.get('input').size, 0);
});

for (const platform of ['desktop', 'extension']) {
  test(`${platform} library marks automatic clips without marking manual saves`, async () => {
    const { createClipsView } = await import(platform === 'desktop' ? '../../desktop/ui/clips.mjs' : '../ui/clips.mjs');
    const document = new Document(clipsIds), value = snapshot();
    if (platform === 'extension') value.pending = false;
    const view = createClipsView({ document, run() {} });
    value.state.clips = [{ id: 'manual', fileName: 'manual.mp4' }, { id: 'auto', fileName: 'auto.mp4', trigger: 'keyword' }];
    view.render(value);
    const list = document.querySelector('#clips-list');
    assert.equal(list.querySelectorAll('.auto-clip-badge').length, 1);
    assert.equal(list.querySelector('.auto-clip-badge').textContent, '자동 · 키워드');
    value.state.clips[1].trigger = 'chat-spike'; view.render(value);
    assert.equal(list.querySelector('.auto-clip-badge').textContent, '자동 · 채팅 급증');
    view.dispose();
  });
}
