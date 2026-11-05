'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Element, Document } = require('./helpers/fake-dom.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function snapshot() {
  return { state: { channels: [{ id: 'one', name: '첫 방송' }, { id: 'two', name: '다른 방송' }], slots: [],
    connection: { status: 'connected' }, bot: { status: 'idle', config: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'test', apiKeySet: false }, events: [] } },
    initialized: true, preview: false, pending: new Set() };
}
function setup() {
  const document = new Document([]), root = new Element(); document.append(root);
  return { document, root };
}

test('navigation hides only panels and preserves controls without rebuilding their DOM', async () => {
  const { createSectionNavigation } = await import('../shared/ui/navigation.mjs');
  const document = new Document(['section-navigation']), navigation = document.querySelector('#section-navigation');
  const changes = [], panels = {};
  for (const section of ['watch', 'clips', 'bot']) {
    const button = new Element('button'); button.dataset.section = section; navigation.append(button);
    const panel = new Element(); panel.dataset.sectionPanel = section; document.append(panel); panels[section] = panel;
  }
  const search = new Element('input'); search.value = '유지할 검색어'; panels.clips.append(search);
  const view = createSectionNavigation({ document, onChange: section => changes.push(section) });
  assert.equal(panels.watch.hidden, false); assert.equal(panels.clips.hidden, true);
  await navigation.dispatch('click', navigation.querySelector('[data-section="clips"]'));
  assert.equal(panels.watch.hidden, true); assert.equal(panels.clips.hidden, false);
  assert.equal(search.value, '유지할 검색어'); assert.equal(panels.clips.children[0], search);
  assert.equal(view.select('not-a-section'), false);
  view.dispose(); await navigation.dispatch('click', navigation.querySelector('[data-section="bot"]'));
  assert.deepEqual(changes, ['watch', 'clips']);
});

for (const desktop of [true, false]) {
  test(`${desktop ? 'app' : 'panel'} bot view preserves drafts, defaults to preview and sends only explicit commands`, async () => {
    const { createBotView } = await import('../shared/ui/bot-view.mjs');
    const { document, root } = setup(), calls = [];
    const view = createBotView({ document, root, desktop, run: async (...args) => { calls.push(args); return true; } });
    const state = snapshot(); view.render(state);
    const channel = root.querySelector('[data-bot-role="channel"]'); channel.value = 'one';
    const speech = root.querySelector('[data-bot-role="speech"]'); speech.value = '사용자가 입력한 발화';
    view.render({ ...state, state: { ...state.state } });
    assert.equal(speech.value, '사용자가 입력한 발화'); assert.equal(channel.value, 'one'); assert.equal(calls.length, 0);
    await root.querySelector('.bot-session-form').dispatch('submit'); await tick();
    assert.deepEqual(calls[0].slice(0, 2), ['startBot', { channelId: 'one', sendMode: 'preview', responseMode: 'ai' }]);
    root.querySelector('[data-bot-role="prior"]').value = '이전 발화\n두 번째 발화';
    root.querySelector('[data-bot-role="chat"]').value = '지금 채팅';
    await root.querySelector('.bot-text-preview').dispatch('submit'); await tick();
    assert.deepEqual(calls[1].slice(0, 2), ['previewBot', { speech: '사용자가 입력한 발화', priorSpeech: ['이전 발화', '두 번째 발화'], chat: '지금 채팅' }]);
    view.dispose(); await root.querySelector('.bot-text-preview').dispatch('submit'); await tick();
    assert.equal(calls.length, 2);
  });
}

test('bot stop stays actionable during a pending request; approval uses the latest proposal ID and edited text', async () => {
  const { createBotView } = await import('../shared/ui/bot-view.mjs');
  const { document, root } = setup(), calls = []; let complete;
  const wait = new Promise(resolve => { complete = resolve; });
  const view = createBotView({ document, root, desktop: true, run: async (method, arg) => { calls.push([method, arg]); return method === 'previewBot' ? wait : true; } });
  const state = snapshot(); view.render(state);
  root.querySelector('[data-bot-role="speech"]').value = '긴 생성';
  await root.querySelector('.bot-text-preview').dispatch('submit');
  const stop = root.querySelector('[data-bot-action="stop"]'); assert.equal(stop.disabled, false);
  await root.dispatch('click', stop); await tick(); assert.equal(calls[1][0], 'stopBot');
  complete(true); await tick();
  state.state.bot = { ...state.state.bot, status: 'running', pending: { id: 'first', speech: '발화', response: '초안' } }; view.render(state);
  const draft = root.querySelector('[data-bot-role="draft"]'); draft.value = '내가 고친 문장'; view.render(state);
  assert.equal(draft.value, '내가 고친 문장');
  await root.dispatch('click', root.querySelector('[data-bot-action="approve"]')); await tick();
  assert.deepEqual(calls[2], ['approveBot', { id: 'first', action: 'send', text: '내가 고친 문장' }]);
  state.state.bot.pending = { id: 'second', speech: '다음', response: '새 초안' }; view.render(state);
  assert.equal(draft.value, '새 초안');
  await root.dispatch('click', root.querySelector('[data-bot-action="skip"]')); await tick();
  assert.deepEqual(calls[3], ['approveBot', { id: 'second', action: 'skip' }]);
  view.dispose();
});

test('disconnected panel never offers working bot controls and timeline content remains text', async () => {
  const { createBotView } = await import('../shared/ui/bot-view.mjs');
  const { document, root } = setup(); const view = createBotView({ document, root, run: () => assert.fail('No command expected') });
  const value = snapshot(); value.state.connection.status = 'standalone'; view.render(value);
  assert.equal(root.querySelector('[data-bot-action="start"]').disabled, true);
  assert.equal(root.querySelector('[data-bot-action="preview"]').disabled, true);
  assert.match(root.querySelector('.bot-status').textContent, /앱을 연결/);
  value.state.connection.status = 'connected';
  value.state.bot.events = Array.from({ length: 70 }, (_, i) => ({ id: String(i), type: 'generated', response: '<img src=x onerror=evil()>', at: 1700000000000 + i }));
  view.render(value);
  assert.equal(root.querySelector('.bot-events').children.length, 50);
  assert.equal(root.querySelector('.bot-answer').textContent, '<img src=x onerror=evil()>');
  assert.equal(root.querySelector('img'), null); view.dispose();
});

test('app settings retain unsaved changes, never fill API keys, and clear a submitted key after success', async () => {
  const { createBotSettingsView } = await import('../shared/ui/bot-view.mjs');
  const { document, root } = setup(), calls = [];
  const view = createBotSettingsView({ document, root, run: async (...args) => { calls.push(args); return true; } });
  const state = snapshot(); state.state.bot.config.apiKeySet = true; view.render(state);
  const provider = root.querySelector('[data-config-field="provider"]'), model = root.querySelector('[data-config-field="model"]'), apiKey = root.querySelector('[data-config-field="apiKey"]');
  assert.equal(apiKey.value, ''); provider.value = 'openai_compatible'; await provider.dispatch('change');
  assert.equal(root.querySelector('[data-config-field="baseUrl"]').value, 'https://api.openai.com/v1');
  assert.equal(model.value, '', 'Do not guess a cloud model from an Ollama model tag');
  model.value = 'my-model'; await model.dispatch('input'); apiKey.value = 'private-api-key'; await apiKey.dispatch('input');
  view.render(state); assert.equal(model.value, 'my-model'); assert.equal(apiKey.value, 'private-api-key');
  await root.querySelector('form').dispatch('submit');
  assert.equal(calls[0][0], 'configureBot'); assert.equal(calls[0][1].apiKey, 'private-api-key'); assert.equal(apiKey.value, '');
  assert.equal(root.textContent.includes('private-api-key'), false); view.dispose();
});

test('approval expires in the visible UI and disposes its deadline timer', async () => {
  const { createBotView } = await import('../shared/ui/bot-view.mjs');
  const { document, root } = setup(); let now = 1000, timer, cleared = false;
  const view = createBotView({ document, root, desktop: true, clock: () => now,
    run: () => assert.fail('Expired approval must not dispatch'),
    timers: { setInterval(callback) { timer = callback; return 7; }, clearInterval(id) { assert.equal(id, 7); cleared = true; } } });
  const value = snapshot(); value.state.bot.pending = { id: 'limited', speech: '발화', response: '답변', expiresAt: 1100 };
  view.render(value); assert.equal(root.querySelector('[data-bot-action="approve"]').disabled, false);
  now = 1100; timer(); assert.equal(root.querySelector('[data-bot-action="approve"]').disabled, true);
  assert.equal(root.querySelector('[data-bot-action="skip"]').disabled, false);
  assert.match(root.querySelector('.bot-proposal').textContent, /유효시간/);
  view.dispose(); assert.equal(cleared, true);
});

test('an externally started bot shows its actual target and send mode without changing the session', async () => {
  const { createBotView } = await import('../shared/ui/bot-view.mjs');
  const { document, root } = setup(); const view = createBotView({ document, root, desktop: true, run: () => assert.fail('Rendering must not start a session') });
  const value = snapshot(); view.render(value);
  root.querySelector('[data-bot-role="channel"]').value = 'one';
  value.state.bot = { ...value.state.bot, status: 'running', channelId: 'two', sendMode: 'auto', responseMode: 'mimic' };
  view.render(value);
  assert.equal(root.querySelector('[data-bot-role="channel"]').value, 'two');
  assert.equal(root.querySelector('[data-bot-role="send-mode"]').value, 'auto');
  assert.equal(root.querySelector('[data-bot-role="response-mode"]').value, 'mimic');
  assert.equal(root.querySelector('[data-bot-action="start"]').disabled, true);
  assert.equal(root.querySelector('[data-bot-action="stop"]').disabled, false);
  view.dispose();
});

test('panel library readiness and favorites disclosure survive polling without misleading actions', async () => {
  const { createPanelNavigationView } = await import('../ui/navigation.mjs');
  const document = new Document(['clips-connection-help', 'open-desk-clips']);
  const favorites = new Element('details'); favorites.className = 'favorites-drawer'; document.append(favorites);
  const calls = [], view = createPanelNavigationView({ document, run: (...args) => calls.push(args) });
  const value = { state: { channels: [], connection: { status: 'standalone' } }, pending: false, initialized: false };
  view.render(value); assert.equal(document.querySelector('#open-desk-clips').disabled, true);
  value.initialized = true; view.render(value); assert.equal(favorites.open, true);
  favorites.open = false; view.render(value); assert.equal(favorites.open, false, 'Polling must preserve a user-closed drawer');
  value.state.connection.status = 'connected'; view.render(value);
  assert.equal(document.querySelector('#clips-connection-help').hidden, true);
  assert.equal(document.querySelector('#open-desk-clips').disabled, false);
  await document.querySelector('#open-desk-clips').dispatch('click');
  assert.deepEqual(calls, [['openDeskSection', 'clips']]); view.dispose();
});
