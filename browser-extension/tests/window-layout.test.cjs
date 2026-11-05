'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture(current, windows = []) {
  const { WindowLayout } = await import('../lib/window-layout.js');
  const created = [], queries = [], tabs = [{ slotId: 0, tab: { id: 1, windowId: 10 } }, { slotId: 1, tab: { id: 2, windowId: 10 } }];
  const chromeApi = {
    tabs: { async query() { return tabs.map(item => item.tab); } },
    windows: {
      async getLastFocused(options) { queries.push(options); return current; },
      async getAll(options) { queries.push(options); return windows; },
      async create(options) { created.push(options); return { id: 100 + created.length }; },
      async update() {}
    }
  };
  return { layout: new WindowLayout(chromeApi), created, queries, tabs };
}
const area = { left: 20, top: 30, width: 1400, height: 900 };
const popup = { id: 44, type: 'popup', focused: true, left: 0, top: 0, width: 440, height: 800 };
const arrange = f => f.layout.arrange(f.tabs, { layout: 'side-by-side', mainSlot: 0 }, async () => {});

test('arrangement uses normal-window bounds even when chat has focus', async () => {
  const f = await fixture(popup, [popup, { id: 10, type: 'normal', ...area }]);
  await arrange(f);
  assert.deepEqual(f.queries, [{ windowTypes: ['normal'] }, { windowTypes: ['normal'] }]);
  assert.deepEqual(f.layout.arrangementBounds, area);
  assert.deepEqual(f.created.map(window => window.width), [700, 700]);
});

test('arrangement keeps its full saved bounds when no normal window is available', async () => {
  const f = await fixture(popup, [popup]);
  f.layout.restore({ arrangementBounds: area, managedWindows: [] });
  await arrange(f);
  assert.deepEqual(f.layout.arrangementBounds, area);
  assert.deepEqual(f.created.map(window => window.width), [700, 700]);
});

test('arrangement with no usable normal window or saved area leaves windows unchanged', async () => {
  const f = await fixture(popup, [popup, { id: 45, type: 'normal', incognito: true, ...area }, { id: 46, type: 'normal', width: 0, height: 900 }]);
  await assert.rejects(arrange(f), /일반 Chrome 창/);
  assert.deepEqual(f.created, []); assert.equal(f.layout.arrangementBounds, null);
});
