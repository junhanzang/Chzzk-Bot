'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createActivityObserver, activityPage } = require('../shared/activity-observer.js');
const ID = 'a'.repeat(32);

function fixture({ popup = false, shadow = false, onActivity } = {}) {
  let now = 0; const listeners = new Map(), videoListeners = new Map(), timers = new Map();
  const video = { tagName: 'VIDEO', isConnected: true, paused: false, ended: false, seeking: false,
    readyState: 4, playbackRate: 1, currentTime: 100,
    addEventListener(name, fn) { videoListeners.set(name, fn); }, removeEventListener(name) { videoListeners.delete(name); } };
  const root = { isConnected: true, classList: { contains: () => false }, nodes: [video], querySelectorAll() { return this.nodes; } };
  if (shadow) root.nodes = [{ shadowRoot: { querySelectorAll: () => [video] } }];
  const aside = { isConnected: true, matches: () => false, contains: target => target === composer };
  const composer = { isConnected: true, parentElement: aside, matches: () => false,
    closest: selector => selector === 'aside#aside-chatting' ? aside : composer, contains: () => false };
  for (const name of ['textContent', 'innerHTML', 'value']) Object.defineProperty(composer, name, { get() { throw new Error('Private text must never be read'); } });
  const document = { activeElement: composer, querySelector: selector => selector === '#live_player_layout' ? root : null,
    addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
  const location = { origin: 'https://chzzk.naver.com', pathname: `/live/${ID}${popup ? '/chat' : ''}` };
  const observer = createActivityObserver({ document, location, channelId: ID, clock: () => now, onActivity,
    timerDeps: { setInterval(fn) { timers.set(1, fn); return 1; }, clearInterval(id) { timers.delete(id); } } });
  return { observer, root, video, composer, document, location, listeners, videoListeners, timers,
    advance(ms, progress = ms / 1000) { now += ms; video.currentTime += progress; observer.sample(); },
    setNow(value) { now = value; }, input(trusted = true, target = composer) { listeners.get('input')?.({ isTrusted: trusted, target }); },
    media(name) { videoListeners.get(name)?.({ target: video }); }, tick() { timers.get(1)?.(); } };
}

test('only the assigned official live page or its chat popup can produce activity', () => {
  assert.equal(activityPage(`https://chzzk.naver.com/live/${ID}`, ID), 'live');
  assert.equal(activityPage(`https://chzzk.naver.com/live/${ID}/chat?studio=true`, ID), 'chat');
  for (const value of [`http://chzzk.naver.com/live/${ID}`, `https://chzzk.naver.com.evil/live/${ID}`,
    `https://user@chzzk.naver.com/live/${ID}`, `https://chzzk.naver.com:8888/live/${ID}`,
    `https://chzzk.naver.com/video/${ID}`, `https://chzzk.naver.com/live/${'b'.repeat(32)}`]) assert.equal(activityPage(value, ID), null);
});

test('watch deltas use actual video advancement and never exceed elapsed wall time', () => {
  const f = fixture(); f.observer.start();
  f.advance(1000, 0.4); f.advance(1000, 1); f.advance(1000, 1.4);
  assert.deepEqual(f.observer.drain(), { watchSeconds: 2, chatCount: 0 });
  f.advance(1000, 0.6); assert.deepEqual(f.observer.drain(), { watchSeconds: 1, chatCount: 0 });
  f.observer.stop(); assert.equal(f.timers.size, 0); assert.equal(f.videoListeners.size, 0);
});

test('paused, ended, buffering, stalled and missing videos earn no watch time', () => {
  for (const [name, value] of [['paused', true], ['ended', true], ['seeking', true], ['readyState', 1]]) {
    const f = fixture(); f.observer.start(); f.video[name] = value; f.advance(4000, 4);
    assert.equal(f.observer.drain().watchSeconds, 0, name); f.observer.stop();
  }
  const f = fixture(); f.observer.start(); f.advance(3000, 0); assert.equal(f.observer.drain().watchSeconds, 0);
  f.root.nodes = []; f.advance(1000, 1); assert.equal(f.observer.drain().watchSeconds, 0); f.observer.stop();
});

test('seeks, interrupted playback, clock jumps and long background gaps are discarded', () => {
  const f = fixture(); f.observer.start();
  f.advance(1000, 100); f.advance(1000, -50); f.advance(60000, 60);
  f.media('seeking'); f.advance(1000, 1); f.media('waiting'); f.advance(1000, 1);
  f.setNow(-1); f.observer.sample(); assert.equal(f.observer.drain().watchSeconds, 0);
  f.observer.stop();
});

test('playback speed normalizes media time to elapsed viewing time', () => {
  const f = fixture(); f.video.playbackRate = 2; f.observer.start();
  f.advance(1000, 2); f.advance(1000, 2); assert.equal(f.observer.drain().watchSeconds, 2);
  f.video.playbackRate = 0.5; f.advance(1000, 0.5); assert.equal(f.observer.drain().watchSeconds, 0);
  f.advance(1000, 0.5); assert.equal(f.observer.drain().watchSeconds, 1); f.observer.stop();
});

test('video replacement seeds a new baseline and ambiguous players fail closed', () => {
  const f = fixture(); f.observer.start();
  const replacement = { ...f.video, currentTime: 500 };
  f.root.nodes = [replacement]; f.advance(1000, 1); assert.equal(f.observer.drain().watchSeconds, 0);
  f.root.nodes = [f.video, replacement]; f.advance(2000, 2); assert.equal(f.observer.drain().watchSeconds, 0);
  f.observer.stop();
});

test('open shadow DOM video is supported without reading player JS or closed roots', () => {
  const f = fixture({ shadow: true }); f.observer.start(); f.advance(2000, 2);
  assert.equal(f.observer.drain().watchSeconds, 2); f.observer.stop();
});

test('trusted composer editing counts one participation per 30 seconds without reading text', () => {
  const f = fixture(); f.observer.start(); f.input(); f.input(); f.advance(29000, 0); f.input();
  assert.deepEqual(f.observer.drain(), { watchSeconds: 0, chatCount: 1 });
  f.advance(1000, 0); f.input(); assert.equal(f.observer.drain().chatCount, 1);
  f.observer.stop();
});

test('synthetic input, incoming messages, unrelated controls and unfocused/hidden composers do not count', () => {
  const f = fixture(); f.observer.start(); f.input(false); f.input(true, { closest: () => null });
  f.document.activeElement = null; f.input(); f.document.activeElement = f.composer;
  f.composer.matches = () => true; f.input(); f.composer.matches = () => false;
  f.composer.isConnected = false; f.input();
  assert.equal(f.observer.drain().chatCount, 0); assert.deepEqual([...f.listeners.keys()], ['input']); f.observer.stop();
});

test('chat popup supports participation but cannot count any playing video', () => {
  const f = fixture({ popup: true }); f.observer.start(); f.input(); f.advance(4000, 4);
  assert.deepEqual(f.observer.drain(), { watchSeconds: 0, chatCount: 1 }); f.observer.stop();
});

test('SPA departure drops buffered counts and stop removes every listener', () => {
  const f = fixture(); f.observer.start(); f.input(); f.advance(2000, 2);
  f.location.pathname = '/video/123'; f.input(); f.observer.sample();
  assert.deepEqual(f.observer.drain(), { watchSeconds: 0, chatCount: 0 });
  f.observer.stop(); assert.equal(f.listeners.size, 0); assert.equal(f.videoListeners.size, 0);
});

test('automatic reports contain only bounded numbers and never replay already drained activity', () => {
  const received = [], f = fixture({ onActivity: delta => received.push(delta) }); f.observer.start(); f.input();
  for (let i = 0; i < 15; i++) { f.advance(1000, 1); f.tick(); }
  assert.deepEqual(received, [{ watchSeconds: 15, chatCount: 1 }]);
  assert.deepEqual(f.observer.drain(), { watchSeconds: 0, chatCount: 0 }); f.observer.stop();
});
