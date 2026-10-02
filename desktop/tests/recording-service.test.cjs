'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { RecordingService } = require('../lib/recording-service.cjs');
const channel = 'a'.repeat(32);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const leases = [], starts = [];
  const replay = new EventEmitter();
  Object.assign(replay, { status: () => ({ state: 'idle' }), async stop() {}, async stopAll() {},
    async start(slotId, info) { starts.push({ slotId, info }); },
    async save() { return { id: 'clip', fileName: 'clip.mp4', title: 'view', channelId: channel, duration: 30 }; } });
  const gateway = { closed: false,
    createStream() { const lease = { url: 'http://127.0.0.1:1/opaque', closed: false, close() { this.closed = true; } }; leases.push(lease); return lease; },
    async close() { this.closed = true; } };
  const service = new RecordingService({ replay, gateway, session: {}, ffmpegAvailable: true, storageReady: true });
  service.playbackInfo = async () => ({ url: 'https://video.pstatic.net/test.m3u8', title: 'view' });
  return { service, replay, gateway, leases, starts };
}

test('shutdown during the previous recorder stop cannot create a new media lease', async () => {
  const f = fixture(), gate = deferred(); f.replay.stop = () => gate.promise;
  const starting = f.service.setBuffer(0, true, channel);
  await new Promise(setImmediate); assert.equal(f.service.status(0).state, 'starting');
  f.service.beginShutdown(); gate.resolve(); await starting;
  assert.equal(f.leases.length, 0); assert.equal(f.starts.length, 0); assert.equal(f.service.status(0).state, 'idle');
});

test('recording failure disposes only that slot lease and shutdown disposes the rest', async () => {
  const f = fixture(); await f.service.setBuffer(0, true, channel); await f.service.setBuffer(1, true, channel);
  f.replay.emit('status', { slotId: 0, status: { state: 'error' } });
  assert.equal(f.leases[0].closed, true); assert.equal(f.leases[1].closed, false);
  await f.service.shutdown(); assert.equal(f.leases[1].closed, true); assert.equal(f.gateway.closed, true);
});

test('save remains busy until index commit completes and clears progress on commit failure', async () => {
  const f = fixture(), gate = deferred();
  const saving = f.service.save(0, 30, () => gate.promise);
  await new Promise(setImmediate); assert.deepEqual(f.service.savingSlots, [0]);
  gate.resolve(); assert.equal((await saving).id, 'clip'); assert.deepEqual(f.service.savingSlots, []);
  await assert.rejects(f.service.save(0, 30, async () => { throw new Error('index error'); }), /index error/);
  assert.deepEqual(f.service.savingSlots, []);
});
