'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseChannel, normalizeSettings, selectPlayback } = require('../lib/channels.cjs');
const id = '0123456789abcdef0123456789abcdef';

test('only actual CHZZK live/channel links are accepted', () => {
  assert.equal(parseChannel(`https://chzzk.naver.com/live/${id}?from=share`), id);
  assert.equal(parseChannel(id.toUpperCase()), id);
  for (const input of [`https://evil.com/live/${id}`, `https://chzzk.naver.com.evil.com/live/${id}`,
    `https://user@chzzk.naver.com/live/${id}`, `https://chzzk.naver.com:123/live/${id}`,
    'file:///etc/passwd', 'javascript:alert(1)', 'https://chzzk.naver.com/video/123', 'not a channel']) {
    assert.throws(() => parseChannel(input));
  }
});

test('corrupt saved state cannot restore unknown slots, duplicate channels or audio/recording', () => {
  const state = normalizeSettings({ channels: [null, { id, name: '\nhello' }, { id, name: 'duplicate' }, { id: 'bad' }],
    slots: [id, 'unknown'], audioSlot: 0, recording: true });
  const defaults = { layout: 'side-by-side', mainSlot: 0, clipSeconds: 30, rewardSettings: { enabled: false }, autoClipSettings: {}, watchPresets: [] };
  assert.deepEqual(state, { channels: [{ id, name: 'hello' }], slots: [id, null, null, null], ...defaults });
  assert.deepEqual(normalizeSettings(null), { channels: [], slots: [null, null, null, null], ...defaults });
  assert.deepEqual(normalizeSettings({ channels: [{ id: [id] }] }), { channels: [], slots: [null, null, null, null], ...defaults });
});

test('four slots, layout and explicit reward preference survive normalization', () => {
  const other = 'b'.repeat(32);
  const result = normalizeSettings({ channels: [{ id }, { id: other }], slots: [id, null, null, other],
    playbackModes: ['desktop', 'browser', 'invalid', 'browser'], layout: 'focus', mainSlot: 3,
    rewardSettings: { enabled: true, secret: 'discard' } });
  assert.deepEqual(result.slots, [id, null, null, other]);
  assert.deepEqual(result.playbackModes, ['desktop', 'desktop', 'desktop', 'browser']);
  assert.equal(result.layout, 'focus');
  assert.equal(result.mainSlot, 3);
  assert.deepEqual(result.rewardSettings, { enabled: true });
  const corrupt = normalizeSettings({ layout: 'invalid', mainSlot: 4, rewardSettings: { enabled: 'true' } });
  assert.equal(corrupt.layout, 'side-by-side');
  assert.equal(corrupt.mainSlot, 0);
  assert.equal(corrupt.rewardSettings.enabled, false);
});

test('replay resolves regular HLS first and rejects offline/private/local payloads', () => {
  const content = { status: 'OPEN', liveTitle: '방송', livePlaybackJson: JSON.stringify({ media: [
    { mediaId: 'LLHLS', protocol: 'HLS', path: 'https://cdn.example.com/low.m3u8' },
    { mediaId: 'HLS', protocol: 'HLS', path: 'https://cdn.example.com/normal.m3u8' }
  ] }) };
  assert.equal(selectPlayback(content).url, 'https://cdn.example.com/normal.m3u8');
  assert.throws(() => selectPlayback({ status: 'CLOSE' }));
  assert.throws(() => selectPlayback({ status: 'OPEN', livePlaybackJson: null }));
  for (const path of ['file:///tmp/test', 'https://127.0.0.1/a.m3u8', 'https://localhost/a.m3u8', 'http://cdn.example.com/a.m3u8']) {
    assert.throws(() => selectPlayback({ ...content, livePlaybackJson: JSON.stringify({ media: [{ protocol: 'HLS', path }] }) }));
  }
});
