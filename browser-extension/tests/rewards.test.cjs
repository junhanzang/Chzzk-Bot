'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rewards = require('../shared/rewards.js');
const ID = '1'.repeat(32), OTHER = '2'.repeat(32);
const url = id => `https://chzzk.naver.com/live/${id}`;
const response = (amount = 1000, claims = []) => ({ code: 200, content: { amount, claims } });
const claim = (id = 'hour-1', amount = 100) => ({ claimId: id, amount, claimType: 'WATCH_1_HOUR', state: 'COMPLIED', saveType: 'ACTIVE' });

class Element {
  constructor(tag, text = '', attrs = {}) {
    this.tagName = tag.toUpperCase(); this.localName = tag.toLowerCase(); this.textContent = text;
    this.attrs = attrs; this.classList = (attrs.class || '').split(' ').filter(Boolean);
    this.children = []; this.parentElement = null; this.isConnected = true; this.disabled = false;
    this.clicks = 0; this.rect = { width: 100, height: 30 }; this.style = {};
  }
  add(child) { child.parentElement = this; this.children.push(child); return child; }
  getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null; }
  hasAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key); }
  getBoundingClientRect() { return this.rect; }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  closest(selector) {
    for (let element = this; element; element = element.parentElement) {
      if (selector === '[role="alertdialog"]') { if (element.attrs.role === 'alertdialog') return element; }
      else if (['disabled', 'hidden', 'inert'].some(key => element.hasAttribute(key)) || ['aria-hidden', 'aria-disabled'].some(key => element.attrs[key] === 'true')) return element;
    }
    return null;
  }
  querySelectorAll() {
    return this.children.flatMap(child => [child, ...child.querySelectorAll()]).filter(child => child.tagName === 'BUTTON');
  }
  click() { this.clicks += 1; this.onClick?.(); }
}

function notice(root, amount = 100) {
  const button = root.add(new Element('button', `1시간 시청 통나무 파워 배달 완료! ${amount} 받기`, { type: 'button', class: '_button_h4sh' }));
  button.add(new Element('span', '1시간 시청 통나무 파워 배달 완료!', { class: '_text_h4sh' }));
  button.add(new Element('svg', '', { class: '_icon_power_h4sh' }));
  return button;
}

function modal(root) {
  const dialog = root.add(new Element('div', '', { role: 'alertdialog' }));
  const row = dialog.add(new Element('ul')).add(new Element('li'));
  row.add(new Element('span', '1시간 시청 보상'));
  return row.add(new Element('button', '100 파워', { type: 'button', class: '_button_x' }));
}

function fakeClock() {
  let time = 0, nextId = 0;
  const jobs = new Map();
  const api = {
    now: () => time,
    setTimeout(fn, ms) { const id = ++nextId; jobs.set(id, { fn, at: time + ms }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    async flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); },
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        await api.flush();
        const next = [...jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        time = next[1].at; jobs.delete(next[0]); next[1].fn();
      }
      time = target; await api.flush();
    },
    get size() { return jobs.size; }
  };
  return api;
}

function fixture({ enabled = true, read = async () => response(1000, [claim()]) } = {}) {
  const root = new Element('aside');
  const clock = fakeClock(), statuses = [], calls = [], observers = [];
  const location = { href: url(ID) };
  const document = { querySelector: () => root };
  class Observer {
    constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const watcher = rewards.createWatcher({ document, location, enabled, timerDeps: clock, MutationObserver: Observer,
    getComputedStyle: element => element.style,
    fetchBalance: async (id, options) => { calls.push({ id, signal: options.signal }); return read(id, options); },
    onStatus: status => statuses.push(status) });
  return { root, clock, statuses, calls, observers, location, watcher };
}

test('only official live and live chat URLs are accepted', () => {
  assert.equal(rewards.channelIdFromUrl(url(ID)), ID);
  assert.equal(rewards.channelIdFromUrl(`${url(ID)}/chat?foo=1`), ID);
  for (const value of [`https://chzzk.naver.com/${ID}`, `https://chzzk.naver.com/video/${ID}`, `${url(ID)}/other`, `http://chzzk.naver.com/live/${ID}`, `https://chzzk.naver.com.evil/live/${ID}`, `https://user@chzzk.naver.com/live/${ID}`]) assert.equal(rewards.channelIdFromUrl(value), null);
  assert.equal(rewards.balanceUrl(ID), `https://api.chzzk.naver.com/service/v1/channels/${ID}/log-power`);
  assert.throws(() => rewards.balanceUrl('../claims'));
});

test('balance parser fails closed and strips non-watch claims and account data', () => {
  assert.deepEqual(rewards.parseSnapshot({ ...response('1000', [claim(), { ...claim('follow'), claimType: 'FOLLOW' }, { ...claim('inactive'), state: 'WAITING' }]), nickname: 'private' }), { balance: 1000, watchClaims: [{ id: 'hour-1', amount: 100 }] });
  for (const raw of [null, {}, response(null), response(''), response(-1), response(Infinity), { code: 401, content: { amount: 100 } }]) assert.throws(() => rewards.parseSnapshot(raw));
  assert.deepEqual(rewards.parseSnapshot(response(0)), { balance: 0, watchClaims: [] });
});

test('native notice and modal buttons match but lookalikes, actions and invisible buttons do not', () => {
  const root = new Element('aside');
  const valid = notice(root), row = modal(root);
  assert.equal(rewards.rewardButton(valid, root).amount, 100);
  assert.equal(rewards.rewardButton(row, root).amount, 100);
  const chat = root.add(new Element('button', valid.textContent, { type: 'button', class: '_button_x' }));
  assert.equal(rewards.rewardButton(chat, root), null);
  valid.attrs['aria-label'] = '후원하기'; assert.equal(rewards.rewardButton(valid, root), null); delete valid.attrs['aria-label'];
  valid.attrs['aria-haspopup'] = 'dialog'; assert.equal(rewards.rewardButton(valid, root), null); delete valid.attrs['aria-haspopup'];
  valid.rect.width = 0; assert.equal(rewards.rewardButton(valid, root), null); valid.rect.width = 100;
  root.attrs.hidden = ''; assert.equal(rewards.rewardButton(valid, root), null); delete root.attrs.hidden;
  row.parentElement.children[0].textContent = '보유 통나무 파워'; assert.equal(rewards.rewardButton(row, root), null);
  assert.equal(rewards.rewardButton(valid, new Element('aside')), null);
});

test('OFF reads balance without observing or clicking; stop cancels every timer', async () => {
  const f = fixture({ enabled: false }); const button = notice(f.root);
  f.watcher.start(); await f.clock.advance(65000);
  assert.equal(button.clicks, 0); assert.equal(f.observers.length, 0); assert.equal(f.calls.length, 2);
  assert.equal(f.watcher.getState().status, 'disabled'); assert.equal(f.watcher.getState().balance, 1000);
  f.watcher.stop(); await f.clock.flush(); assert.equal(f.clock.size, 0);
});

test('button click alone is not a successful claim, including a rerender of the same reward', async () => {
  const f = fixture(); const button = notice(f.root);
  f.watcher.start(); await f.clock.advance(3000);
  assert.equal(button.clicks, 1); assert.equal(f.watcher.getState().status, 'claiming');
  button.isConnected = false; f.root.children = [];
  const rerender = notice(f.root);
  await f.clock.advance(65000);
  assert.equal(rerender.clicks, 0); assert.equal(f.statuses.some(status => status.status === 'claimed'), false);
  f.watcher.stop();
});

test('server balance increase, removed claim and removed native button confirm success together', async () => {
  let saved = false;
  const f = fixture({ read: async () => saved ? response(1100) : response(1000, [claim()]) });
  const button = notice(f.root); button.onClick = () => { saved = true; button.isConnected = false; f.root.children = []; };
  f.watcher.start(); await f.clock.advance(5000);
  assert.equal(button.clicks, 1); assert.equal(f.watcher.getState().status, 'claimed');
  assert.equal(f.watcher.getState().balance, 1100); assert.equal(f.watcher.getState().lastClaimAt, 4800);
  f.watcher.stop();
});

test('hiding a button without a server balance increase does not confirm a claim', async () => {
  let clicked = false;
  const f = fixture({ read: async () => clicked ? response(1000) : response(1000, [claim()]) });
  const button = notice(f.root); button.onClick = () => { clicked = true; f.root.children = []; button.isConnected = false; };
  f.watcher.start(); await f.clock.advance(10000);
  assert.equal(button.clicks, 1); assert.equal(f.statuses.some(status => status.status === 'claimed'), false);
  f.watcher.stop();
});

test('OFF immediately cancels a scheduled click and a pending read cannot reenable it', async () => {
  const f = fixture(); const button = notice(f.root);
  f.watcher.start(); await f.clock.advance(2100); f.watcher.setEnabled(false); await f.clock.advance(10000);
  assert.equal(button.clicks, 0); assert.equal(f.watcher.getState().status, 'disabled');
  assert.equal(f.observers.every(observer => !observer.connected), true);
  f.watcher.stop();
});

test('SPA navigation before click invalidates the old channel and stale read result', async () => {
  let resolve;
  const f = fixture({ read: () => new Promise(done => { resolve = done; }) }); const button = notice(f.root);
  f.watcher.start(); await f.clock.advance(2100); f.location.href = url(OTHER); resolve(response(99999, [claim()])); await f.clock.advance(1000);
  assert.equal(button.clicks, 0); assert.equal(f.watcher.getState().balance, null);
  f.watcher.stop(); await f.clock.flush();
});

test('an authentication failure clears the old balance and holds clicking until a fresh account snapshot', async () => {
  let authenticated = true;
  const f = fixture({ read: async () => authenticated ? response(1000, [claim()]) : { code: 401, content: null } });
  const button = notice(f.root); f.watcher.start(); await f.clock.advance(2100); authenticated = false;
  await f.clock.advance(40000);
  assert.equal(button.clicks, 0); assert.equal(f.watcher.getState().balance, null); assert.equal(f.calls.length, 2);
  assert.equal(f.watcher.getState().status, 'unavailable');
  f.watcher.stop();
});

test('a stalled adapter times out even if it ignores AbortSignal, and can recover next minute', async () => {
  let stall = true;
  const f = fixture({ read: () => stall ? new Promise(() => {}) : Promise.resolve(response(50)) });
  f.watcher.start(); await f.clock.advance(9000);
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.watcher.getState().status, 'unavailable');
  stall = false; await f.clock.advance(62000);
  assert.equal(f.watcher.getState().balance, 50); f.watcher.stop(); await f.clock.flush(); assert.equal(f.clock.size, 0);
});

test('rapid chat mutations coalesce, and a button changed into a donation before click is rejected', async () => {
  const f = fixture(); const button = notice(f.root); f.watcher.start(); await f.clock.advance(2100);
  button.textContent = '후원하기';
  for (let i = 0; i < 10000; i++) f.observers[0].fn();
  assert.ok(f.clock.size <= 4);
  await f.clock.advance(5000); assert.equal(button.clicks, 0); f.watcher.stop();
});

test('disabling while a claim preflight read is pending aborts it and ignores its late balance', async () => {
  let count = 0, resolve;
  const f = fixture({ read: () => ++count === 2 ? new Promise(done => { resolve = done; }) : Promise.resolve(response(1000, [claim()])) });
  const button = notice(f.root); f.watcher.start(); await f.clock.advance(3000);
  assert.equal(f.calls.length, 2); f.watcher.setEnabled(false);
  assert.equal(f.calls[1].signal.aborted, true);
  resolve(response(99999, [claim()])); await f.clock.advance(3000);
  assert.equal(button.clicks, 0); assert.equal(f.watcher.getState().status, 'disabled'); assert.equal(f.watcher.getState().balance, 1000);
  f.watcher.stop();
});

test('switching channel immediately before OFF cannot retain the previous channel balance', async () => {
  const f = fixture({ read: async id => response(id === ID ? 1000 : 20) });
  f.watcher.start(); await f.clock.flush(); assert.equal(f.watcher.getState().balance, 1000);
  f.location.href = url(OTHER); f.watcher.setEnabled(false);
  assert.equal(f.watcher.getState().balance, null); await f.clock.flush();
  assert.equal(f.watcher.getState().channelId, OTHER); assert.equal(f.watcher.getState().balance, 20);
  f.watcher.stop();
});

test('a later eligible claim can be collected without hardcoding a 100 point reward', async () => {
  let available = 'first', balance = 1000;
  const f = fixture({ read: async () => response(balance, available ? [claim(available, 200)] : []) });
  let button = notice(f.root, 200);
  const save = () => { available = ''; balance += 200; f.root.children = []; button.isConnected = false; };
  button.onClick = save; f.watcher.start(); await f.clock.advance(9000);
  assert.equal(f.watcher.getState().status, 'claimed'); assert.equal(balance, 1200);
  available = 'second'; button = notice(f.root, 200); button.onClick = save;
  await f.clock.advance(70000);
  assert.equal(button.clicks, 1); assert.equal(balance, 1400); assert.equal(f.watcher.getState().status, 'claimed');
  f.watcher.stop();
});

test('repeated OFF/ON switches keep one heartbeat and stop leaves no delayed work', async () => {
  const f = fixture({ enabled: false }); f.watcher.start(); await f.clock.flush();
  for (let i = 0; i < 30; i++) {
    f.watcher.setEnabled(true); await f.clock.flush(); f.watcher.setEnabled(false); await f.clock.flush();
  }
  assert.equal(f.clock.size, 1);
  const reads = f.calls.length; await f.clock.advance(65000);
  assert.equal(f.calls.length, reads + 1);
  f.watcher.stop(); await f.clock.flush(); assert.equal(f.clock.size, 0);
});
