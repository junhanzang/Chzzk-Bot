'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSettings, validClipSeconds, CLIP_DURATIONS } = require('../shared/channels.js');

test('existing settings migrate to 30 seconds without enabling sound, recording, or rewards', () => {
  const id = 'a'.repeat(32);
  const old = { channels: [{ id, name: '기존 방송' }], slots: [id, null], layout: 'focus', mainSlot: 0 };
  const result = normalizeSettings(old);
  assert.equal(result.clipSeconds, 30);
  assert.deepEqual(result.channels, old.channels);
  assert.deepEqual(result.slots, [id, null, null, null]);
  assert.equal(result.layout, 'focus');
  assert.equal(result.rewardSettings.enabled, false);
  assert.equal(Object.hasOwn(result, 'audioSlot'), false);
  assert.equal(Object.hasOwn(result, 'recording'), false);
  assert.equal(Object.hasOwn(old, 'clipSeconds'), false);
});

test('saved durations recover safely while user commands reject unsupported lengths', () => {
  for (const seconds of CLIP_DURATIONS) {
    assert.equal(normalizeSettings({ clipSeconds: seconds }).clipSeconds, seconds);
    assert.equal(validClipSeconds(seconds), seconds);
  }
  for (const seconds of [null, undefined, '60', -1, 0, 14, 30.5, 61, Infinity, {}, []]) {
    assert.equal(normalizeSettings({ clipSeconds: seconds }).clipSeconds, 30);
    assert.throws(() => validClipSeconds(seconds));
  }
  assert.equal(Object.isFrozen(CLIP_DURATIONS), true);
});
