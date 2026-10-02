'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Only the DOM operations used by this view; no app or browser is started.
class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.value = ''; this._text = ''; this.disabled = false; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return (this.className || '').split(' ').includes(selector.slice(1));
    const [, tag, attribute] = selector.match(/^([\w-]+)(?:\[([\w-]+)\])?$/) || [];
    return this.tagName === tag && (!attribute || (attribute === 'data-action' && this.dataset.action !== undefined));
  }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  async fire(type, target = this) { for (const listener of this.listeners.get(type) || []) await listener({ target, preventDefault() {} }); }
  focus() { this.focused = true; }
}
function documentFixture() {
  const document = new Node('document'), host = new Node(); host.id = 'watch-tools'; document.append(host);
  document.createElement = tag => new Node(tag);
  return document;
}
function fixture(platform) {
  return { initialized: true, preview: false, pending: platform === 'desktop' ? new Set() : false,
    state: { channels: [{ id: 'one', name: '첫 방송' }, { id: 'two', name: '둘째 방송' }, { id: 'new', name: '새 방송' }],
      slots: [{ slotId: 0, channelId: 'one', playbackMode: platform === 'desktop' ? 'desktop' : 'browser', replay: { enabled: true, state: 'buffering', bufferedSeconds: 20 } }, { slotId: 1, channelId: 'two' }, { slotId: 2 }, { slotId: 3 }],
      connection: { status: 'connected' }, ffmpegAvailable: true,
      watchPresets: [{ id: 'preset', name: '같이 보기', slots: ['new', 'two', null, null], layout: 'grid', mainSlot: 0 }] } };
}
const importView = platform => import(platform === 'desktop' ? '../../desktop/ui/watch-tools.mjs' : '../ui/watch-tools.mjs');
const pending = platform => platform === 'desktop' ? new Set(['watch-tools']) : true;
const call = (platform, method, ...args) => platform === 'desktop' ? ['watch-tools', method, ...args] : [method, ...args];

test('preset change summary includes playback-mode replacements and empty target slots', async () => {
  const { presetChanges } = await import('../shared/ui/watch-tools.mjs');
  const state = fixture('extension').state;
  const preset = { slots: ['one', null, null, null] };
  assert.deepEqual(presetChanges(state, preset, 'desktop'), [0, 1]);
  assert.deepEqual(presetChanges(state, preset, 'browser'), [1]);
});

for (const platform of ['desktop', 'extension']) {
  test(`${platform} presets preserve the name draft and require inline confirmation before applying`, async () => {
    const { createWatchToolsView } = await importView(platform);
    const document = documentFixture(), value = fixture(platform), calls = [];
    let resized = 0;
    const view = createWatchToolsView({ document, run: async (...args) => { calls.push(args); return true; }, notify() {}, onLayoutChange() { resized++; } });
    view.render(value);
    const name = document.querySelector('.watch-preset-name'), list = document.querySelector('.watch-presets-list');
    name.value = ' 내 조합 '; view.render({ ...value, state: { ...value.state } });
    assert.equal(name.value, ' 내 조합 ');
    assert.equal(name.maxLength, 40);
    await document.querySelector('.watch-presets-toggle').fire('click');
    assert.equal(document.querySelector('#watch-presets-panel').hidden, false);
    await list.fire('click', list.querySelector('.watch-preset-load'));
    const confirmation = document.querySelector('.watch-preset-confirmation');
    assert.equal(calls.length, 0);
    assert.equal(confirmation.hidden, false);
    assert.match(confirmation.textContent, /바뀌는 자리: A/);
    assert.match(confirmation.textContent, /구간 보관 종료: A/);
    await document.querySelector('.watch-preset-cancel').fire('click');
    assert.equal(calls.length, 0);
    await list.fire('click', list.querySelector('.watch-preset-load'));
    await document.querySelector('.watch-preset-confirm').fire('click');
    assert.deepEqual(calls[0], call(platform, 'applyWatchPreset', 'preset', '시청 모음을 불러왔어요.'));
    assert.equal(confirmation.hidden, true);
    await document.querySelector('.watch-preset-form').fire('submit');
    assert.deepEqual(calls[1], call(platform, 'saveWatchPreset', { name: '내 조합' }, '현재 시청 조합을 저장했어요.'));
    assert.equal(name.value, '');
    await list.fire('click', list.querySelector('.watch-preset-remove'));
    assert.deepEqual(calls[2], call(platform, 'removeWatchPreset', 'preset', '시청 모음을 삭제했어요.'));
    assert(resized > 0);
    view.dispose();
  });

  test(`${platform} bulk buffers report partial results once even after the response summary disappears`, async () => {
    const { createWatchToolsView } = await importView(platform);
    const document = documentFixture(), value = fixture(platform), notices = [], calls = [];
    value.state.actionSummary = { succeeded: 4, failures: [] };
    let view, attempts = 0;
    view = createWatchToolsView({ document, notify: (...args) => notices.push(args), run: async (...args) => {
      calls.push(args); attempts++;
      view.render({ ...value, pending: pending(platform) });
      if (attempts === 1) {
        view.render({ ...value, pending: pending(platform), state: { ...value.state, actionSummary: { succeeded: 1, failures: [{ slotId: 1, message: '방송 연결 실패' }] } } });
      }
      const refreshed = { ...value.state }; delete refreshed.actionSummary;
      view.render({ ...value, state: refreshed });
      return true;
    } });
    view.render(value);
    await document.querySelector('.watch-buffer-start').fire('click');
    assert.deepEqual(calls[0], call(platform, 'setAllBuffers', { enabled: true }, undefined));
    assert.deepEqual(notices[0], ['전체 보관 켜기 · 1개 완료 / B: 방송 연결 실패', true]);
    assert.equal(notices.length, 1);
    view.render(value);
    await document.querySelector('.watch-buffer-start').fire('click');
    assert.deepEqual(notices[1], ['전체 보관 켜기 요청을 처리했어요.', false], 'The old summary must not be reused');
    view.dispose();
  });
}

test('standalone Chrome supports presets while bulk recording requires an available desktop connection', async () => {
  const { createWatchToolsView } = await importView('extension');
  const document = documentFixture(), value = fixture('extension'), calls = [];
  const view = createWatchToolsView({ document, run: async (...args) => { calls.push(args); return true; }, notify() {} });
  value.state.connection.status = 'standalone'; view.render(value);
  assert.equal(document.querySelector('.watch-preset-save').disabled, false);
  assert.equal(document.querySelector('.watch-buffer-start').disabled, true);
  assert.equal(document.querySelector('.watch-buffer-stop').disabled, true);
  await document.querySelector('.watch-buffer-start').fire('click'); assert.equal(calls.length, 0);
  value.state.connection.status = 'unavailable'; view.render(value);
  assert.equal(document.querySelector('.watch-preset-load').disabled, true);
  assert.equal(document.querySelector('.watch-preset-save').disabled, true);
  value.state.connection.status = 'connected'; value.state.ffmpegAvailable = false; view.render(value);
  assert.equal(document.querySelector('.watch-buffer-start').disabled, true);
  assert.equal(document.querySelector('.watch-buffer-stop').disabled, false, 'Stopping existing buffers must remain available');
  value.state.watchPresets = Array.from({ length: 10 }, (_, index) => ({ ...value.state.watchPresets[0], id: String(index) }));
  view.render(value); assert.equal(document.querySelector('.watch-preset-save').disabled, true);
  view.dispose();
});

test('watch tools exclude duplicate commands and ignore late work after disposal', async () => {
  const { createWatchToolsView } = await importView('desktop');
  const document = documentFixture(), value = fixture('desktop'), calls = [], notices = [];
  let finish;
  const view = createWatchToolsView({ document, run: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); }, notify: (...args) => notices.push(args) });
  view.render(value);
  const start = document.querySelector('.watch-buffer-start');
  const applying = start.fire('click');
  await start.fire('click'); assert.equal(calls.length, 1);
  view.dispose();
  const before = document.textContent;
  finish(true); await applying;
  assert.equal(document.textContent, before);
  assert.deepEqual(notices, []);
  await start.fire('click'); assert.equal(calls.length, 1);
});

test('rejected saves preserve the name and a removed preset cancels an obsolete confirmation', async () => {
  const { createWatchToolsView } = await importView('extension');
  const document = documentFixture(), value = fixture('extension'), calls = [];
  const view = createWatchToolsView({ document, run: async (...args) => { calls.push(args); return false; }, notify() {} });
  view.render(value);
  const name = document.querySelector('.watch-preset-name'); name.value = '중복 이름';
  await document.querySelector('.watch-preset-form').fire('submit');
  assert.equal(name.value, '중복 이름');
  assert.equal(document.querySelector('.watch-preset-save').disabled, false);
  const list = document.querySelector('.watch-presets-list');
  await list.fire('click', list.querySelector('.watch-preset-load'));
  view.render({ ...value, state: { ...value.state, watchPresets: [] } });
  assert.equal(document.querySelector('.watch-preset-confirmation').hidden, true);
  await document.querySelector('.watch-preset-confirm').fire('click');
  assert.equal(calls.length, 1);
  view.dispose();
});
