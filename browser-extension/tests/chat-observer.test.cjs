'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatObserver } = require('../shared/chat-observer.js');

class Element {
  constructor(className = '', text = '', attrs = {}) {
    this.className = className; this.ownText = text; this.attrs = attrs;
    this.children = []; this.parentElement = null; this.isConnected = true; this.nodeType = 1;
  }
  add(child) { child.parentElement = this; this.children.push(child); return child; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set textContent(text) { this.ownText = text; this.children = []; }
  matches(selector) {
    return selector.split(',').some(part => {
      const value = part.trim();
      const classMatch = value.match(/^\[class\*="([^"]+)"\]$/);
      if (classMatch) return this.className.includes(classMatch[1]);
      const attribute = value.match(/^\[([^=\]]+)(?:="([^"]+)")?\]$/);
      return attribute && Object.hasOwn(this.attrs, attribute[1]) && (attribute[2] === undefined || this.attrs[attribute[1]] === attribute[2]);
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector === '*' || child.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function clock() {
  let now = 0, next = 0;
  const jobs = new Map();
  return {
    setTimeout(fn, delay) { const id = ++next; jobs.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const nextJob = [...jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!nextJob) break;
        now = nextJob[1].at; jobs.delete(nextJob[0]); nextJob[1].fn();
      }
      now = target;
    },
    get size() { return jobs.size; }
  };
}

function message(root, body, nickname = '이름') {
  const row = root.add(new Element('_item_hash'));
  const content = row.add(new Element('live_chatting_message_hash'));
  content.add(new Element('_nickname_hash')).add(new Element('_text_hash', nickname));
  const text = content.add(new Element('_text_hash', body));
  return { row, content, text };
}

function fixture({ missing = false } = {}) {
  const aside = new Element(), log = new Element('_container_hash', '', { role: 'log' });
  if (!missing) aside.add(log);
  const timers = clock(), observers = [], batches = [], statuses = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
    observe(root) { this.root = root; this.active = true; }
    disconnect() { this.active = false; }
  }
  const watcher = createChatObserver({ document: { querySelector: selector => selector === 'aside#aside-chatting' ? aside : null },
    MutationObserver: Observer, timerDeps: timers, onMessages: events => batches.push(events), onStatus: state => statuses.push(state) });
  const mutate = (target, addedNodes = []) => observers.filter(observer => observer.active).forEach(observer => observer.callback([{ target, addedNodes }]));
  return { aside, log, timers, observers, batches, statuses, watcher, mutate };
}

test('startup seeds old rows, then delivers only message bodies without nicknames', () => {
  const f = fixture();
  const old = message(f.log, '이미 보이던 키워드', '과거 이용자');
  f.watcher.start();
  f.mutate(old.text);
  const fresh = message(f.log, '새 채팅 본문', '제외할 이름');
  f.mutate(f.log, [fresh.row]); f.timers.advance(250);
  assert.equal(f.batches.length, 1);
  assert.equal(f.batches[0].length, 1);
  assert.equal(f.batches[0][0].text, '새 채팅 본문');
  assert.ok(f.batches[0][0].id.length <= 128);
  assert.equal(f.statuses.at(-1).status, 'watching');
  f.watcher.stop();
});

test('repeated mutation or reinsertion is deduplicated; recycled rows and separate identical messages remain distinct', () => {
  const f = fixture(); f.watcher.start();
  const first = message(f.log, '같은 본문');
  f.mutate(f.log, [first.row]); f.timers.advance(250);
  f.mutate(first.text); f.mutate(f.log, [first.row]); f.timers.advance(250);
  assert.equal(f.batches.length, 1);
  first.text.textContent = '재사용된 행의 새 본문';
  f.mutate({ nodeType: 3, parentElement: first.text }); f.timers.advance(250);
  const second = message(f.log, '같은 본문');
  f.mutate(f.log, [second.row]); f.timers.advance(250);
  const events = f.batches.flat();
  assert.deepEqual(events.map(item => item.text), ['같은 본문', '재사용된 행의 새 본문', '같은 본문']);
  assert.equal(new Set(events.map(item => item.id)).size, 3);
  f.watcher.stop();
});

test('a replaced chat container is seeded and old pending messages are discarded', () => {
  const f = fixture(); f.watcher.start();
  const queued = message(f.log, '이전 화면'); f.mutate(f.log, [queued.row]);
  const replacement = new Element('_container_new', '', { role: 'log' });
  message(replacement, '새 DOM의 과거 채팅');
  f.log.isConnected = false; f.aside.children = []; f.aside.add(replacement);
  f.timers.advance(2000);
  assert.equal(f.batches.length, 0);
  const fresh = message(replacement, '교체 후 새 채팅'); f.mutate(replacement, [fresh.row]); f.timers.advance(250);
  assert.deepEqual(f.batches.flat().map(item => item.text), ['교체 후 새 채팅']);
  f.watcher.stop();
});

test('unknown DOM waits, later recognition seeds rows, and stop cancels every pending batch/timer', () => {
  const f = fixture({ missing: true }); f.watcher.start();
  assert.equal(f.statuses.at(-1).status, 'waiting');
  message(f.log, '발견 당시 채팅'); f.aside.add(f.log); f.timers.advance(2000);
  assert.equal(f.statuses.at(-1).status, 'watching');
  assert.equal(f.batches.length, 0);
  const fresh = message(f.log, '저장되면 안 됨'); f.mutate(f.log, [fresh.row]);
  f.watcher.stop(); f.timers.advance(5000);
  assert.equal(f.batches.length, 0); assert.equal(f.timers.size, 0);
  f.watcher.start(); f.mutate(f.log, [fresh.row]); f.timers.advance(250);
  assert.equal(f.batches.length, 0, 'A generation restart seeds the full current DOM');
  f.watcher.stop();
});

test('fixed panels and dialogs are ignored; nested spans and large bursts stay bounded', () => {
  const f = fixture(); f.watcher.start();
  const fixed = f.log.add(new Element('_fixed_hash'));
  message(fixed, '고정 알림'); f.mutate(f.log, [fixed]);
  const dialog = f.log.add(new Element('', '', { role: 'dialog' }));
  message(dialog, '대화상자'); f.mutate(f.log, [dialog]);
  const nested = message(f.log, '앞'); nested.text.add(new Element('_text_nested', '뒤'));
  f.mutate(f.log, [nested.row]); f.timers.advance(250);
  assert.deepEqual(f.batches.flat().map(item => item.text), ['앞뒤']);
  const rows = Array.from({ length: 800 }, (_, index) => message(f.log, `${index}:` + '가'.repeat(600)).row);
  f.mutate(f.log, rows); f.timers.advance(250);
  assert.equal(f.batches.at(-1).length, 100);
  assert.ok(f.batches.at(-1).every(item => item.text.length <= 500));
  f.watcher.stop();
});

test('nested message wrapper/body selectors produce exactly one event', () => {
  const f = fixture(); f.watcher.start();
  const row = f.log.add(new Element('_item_hash'));
  const wrapper = row.add(new Element('live_chatting_message_wrapper_hash'));
  const body = wrapper.add(new Element('live_chatting_message_body_hash'));
  body.add(new Element('_text_hash', '한 번만'));
  f.mutate(f.log, [row]); f.mutate(body); f.timers.advance(250);
  assert.deepEqual(f.batches.flat().map(item => item.text), ['한 번만']);
  f.watcher.stop();
});

test('hidden chat or ancestor waits and reseeds accumulated messages when shown', () => {
  const f = fixture(); f.watcher.start();
  f.aside.attrs['aria-hidden'] = 'true'; f.timers.advance(2000);
  assert.equal(f.statuses.at(-1).status, 'waiting');
  const backlog = message(f.log, '접힌 동안 쌓인 채팅');
  delete f.aside.attrs['aria-hidden']; f.timers.advance(2000);
  assert.equal(f.statuses.at(-1).status, 'watching');
  f.mutate(f.log, [backlog.row]); f.timers.advance(250);
  assert.equal(f.batches.length, 0);
  f.log.style = { display: 'none' }; f.timers.advance(2000);
  assert.equal(f.statuses.at(-1).status, 'waiting');
  f.log.style = {}; f.timers.advance(2000);
  f.aside.attrs.hidden = '';
  const hidden = message(f.log, '폴링 사이에 쌓인 과거 채팅'); f.mutate(f.log, [hidden.row]);
  assert.equal(f.statuses.at(-1).status, 'waiting', 'Hidden mutations detach before the next poll');
  delete f.aside.attrs.hidden; f.timers.advance(2000); f.mutate(f.log, [hidden.row]); f.timers.advance(250);
  assert.equal(f.batches.length, 0);
  f.watcher.stop();
});
