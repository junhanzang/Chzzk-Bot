'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const presentation = require('../shared/presentation.js');
const model = require('../shared/channels.js');

test('favorites search normalizes Korean Unicode and case, and matches name plus channel ID', () => {
  const channels = [{ id: 'aBcD1234', name: '한글 방송' }, { id: 'ffff5555', name: '다른 채널' }];
  assert.deepEqual(presentation.filterChannels(channels, `${'한글'.normalize('NFD')} ＡＢＣＤ`), [channels[0]]);
  assert.deepEqual(presentation.filterChannels(channels, '   '), channels);
  assert.deepEqual(presentation.filterChannels(channels, '없는 방송'), []);
  assert.equal(presentation.resultCount(0, 2, '없는 방송'), '0 / 2');
  assert.equal(presentation.resultCount(2, 2, ''), '2');
  assert.equal(channels.length, 2);
});

test('clips search covers the entire collection before a client display limit and retains source order', () => {
  const clips = Array.from({ length: 14 }, (_, index) => ({ id: String(index), channelId: index === 1 ? 'ch' : 'other',
    title: `게임 방송 ${index}`, fileName: index === 1 ? '오늘_명장면.MP4' : `${index}.mp4`, createdAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z` }));
  assert.equal(presentation.filterClips(clips).slice(0, 10).some(clip => clip.id === '1'), false);
  assert.deepEqual(presentation.filterClips(clips, '명장면.mp4').slice(0, 10).map(clip => clip.id), ['1']);
  assert.deepEqual(presentation.filterClips(clips, '스트리머 게임', [{ id: 'ch', name: '스트리머 이름' }]).map(clip => clip.id), ['1']);
  assert.equal(clips[0].id, '0');
});

test('invalid dates and lengths are not shown as fabricated clip metadata', () => {
  assert.equal(presentation.formatClipMeta({ createdAt: 'invalid', duration: Infinity }), '');
  assert.equal(presentation.formatClipMeta({ duration: 14.8 }), '약 15초');
  const clips = [{ id: 'invalid', createdAt: 'invalid' }, { id: 'new', createdAt: '2026-10-02T00:00:00Z' }, { id: 'missing' }];
  assert.equal(presentation.filterClips(clips)[0].id, 'new');
});

test('save labels and partial buffer explanation follow every supported duration', () => {
  for (const seconds of model.CLIP_DURATIONS) {
    assert.equal(presentation.saveLabel(seconds), `최근 약 ${seconds}초 저장`);
    assert.equal(presentation.saveLabel(seconds, { compact: true }), `약 ${seconds}초 저장`);
    assert.match(presentation.saveHint(seconds, 12.9), /모인 약 12초만/);
    assert.match(presentation.saveHint(seconds, 12.9), /구간 경계/);
  }
  assert.doesNotMatch(presentation.saveNote(15, 40), /만 저장/);
  assert.doesNotMatch(presentation.saveNote(60, NaN), /NaN|모인 약/);
  assert.equal(presentation.saveLabel(60, { saving: true }), '클립 저장 중…');
  assert.equal(presentation.saveLabel(undefined), '최근 약 30초 저장');
});

test('reward presentation distinguishes zero from unknown and rejects another slot channel', () => {
  const reward = { slotId: 3, channelId: 'channel', balance: 0, status: 'claimed', lastClaimAt: 1790899200000, message: '갱신 확인' };
  assert.equal(presentation.rewardForSlot([reward], { slotId: 3, channelId: 'changed' }), undefined);
  assert.equal(presentation.rewardForSlot([reward], { slotId: 3, channelId: 'channel' }), reward);
  const display = presentation.formatReward(reward, { enabled: true });
  assert.match(display.summary, /통나무 0개/);
  assert.match(display.summary, /최근 수령/);
  assert.match(display.title, /갱신 확인/);
  assert.equal(display.claimed, true);
  assert.match(presentation.formatReward({ balance: null }).summary, /확인 안 됨/);
  assert.doesNotMatch(presentation.formatReward({ balance: null, lastClaimAt: 'invalid' }).summary, /0개|Invalid|최근 수령/);
  const browserSlot = presentation.formatReward(reward, { external: true });
  assert.match(browserSlot.summary, /크롬/);
  assert.equal(browserSlot.claimed, false);
});

test('shared presentation runs as packaged external scripts without DOM, Node APIs, or CSP changes', () => {
  const context = vm.createContext({});
  for (const file of ['channels.js', 'presentation.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared', file), 'utf8'), context);
  assert.equal(context.DeskPresentation.saveLabel(60), '최근 약 60초 저장');
  for (const [htmlFile, base] of [
    [path.join(__dirname, '../panel.html'), path.join(__dirname, '..')],
    [path.join(__dirname, '../../desktop/ui/index.html'), path.join(__dirname, '../../desktop/ui')]
  ]) {
    const html = fs.readFileSync(htmlFile, 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)];
    assert.equal(scripts.length, 1, 'Each document loads a single module bootstrap');
    assert.match(scripts[0][0], /type="module"/);
    const visited = new Set();
    function walk(file) {
      if (visited.has(file)) return;
      visited.add(file);
      assert.ok(fs.statSync(file).isFile(), file);
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\bimport\s+(?:[^;\n]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
        assert.ok(match[1].startsWith('.'), 'UI imports stay in packaged local modules');
        walk(path.resolve(path.dirname(file), match[1]));
      }
    }
    walk(path.resolve(base, scripts[0][1]));
    assert.ok(visited.has(path.resolve(__dirname, '../shared/channels.js')));
    assert.ok(visited.has(path.resolve(__dirname, '../shared/presentation.js')));
    assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/i);
  }
});
