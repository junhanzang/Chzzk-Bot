'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ReplayBuffer, parseManifest, selectSegments, safeTitle, validateInput } = require('../lib/replay-buffer.cjs');
const { selectRange } = require('../lib/segment-store.cjs');

const csv = count => Array.from({ length: count }, (_, i) => `segment-${String(i).padStart(9, '0')}.ts,${i * 2},${i * 2 + 2}\n`).join('');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, spawnImpl) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-test-'));
  const engine = new ReplayBuffer({ ffmpegPath: 'ffmpeg', rootDir: path.join(root, 'buffer'), clipsDir: path.join(root, 'clips'), spawnImpl, pollIntervalMs: 60000 });
  t.after(async () => { await engine.stopAll(); await fs.rm(root, { recursive: true, force: true }); });
  return engine;
}

function fakeSpawn(calls, onExport) {
  return (binary, args, options) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = signal => { calls.push({ signal }); queueMicrotask(() => child.emit('close', 255)); return true; };
    calls.push({ binary, args, options, child });
    queueMicrotask(async () => {
      child.emit('spawn');
      if (args.includes('concat') && onExport) await onExport(child, args, options);
    });
    return child;
  };
}

async function fill(engine, slotId, count) {
  const dir = engine.slots[slotId].dir;
  for (let i = 0; i <= count; i++) await fs.writeFile(path.join(dir, `segment-${String(i).padStart(9, '0')}.ts`), 'media');
  await fs.writeFile(path.join(dir, 'manifest.csv'), csv(count));
  return dir;
}

test('manifest accepts only completed, valid, confined segments', () => {
  const parsed = parseManifest('"segment-000000000.ts",0,2\n../escape.ts,2,4\nsegment-000000001.ts,2,4\nsegment-000000002.ts,4,6');
  assert.deepEqual(parsed.map(s => s.fileName), ['segment-000000000.ts', 'segment-000000001.ts']);
  assert.equal(parseManifest('segment-000000000.ts,NaN,2\nsegment-000000001.ts,3,2\n').length, 0);
});

test('selection rounds out to full recent segments and refuses gaps or too little video', () => {
  const all = parseManifest(csv(5));
  assert.equal(selectSegments(all, 5).duration, 6);
  assert.equal(selectSegments(all, 30).duration, 10);
  assert.throws(() => selectSegments([all[0]], 30), /최소 4초/);
  assert.throws(() => selectSegments([all[0], all[4]], 4), /최소 4초/);
  for (const value of [0, -2, 91, NaN, Infinity, '30']) assert.throws(() => selectSegments(all, value), /90초/);
});

test('input rejects command-like paths and header injection; local files require opt-in', () => {
  for (const url of ['file:///tmp/test.ts', 'concat:one|two', '-version']) assert.throws(() => validateInput(url, {}, false));
  assert.throws(() => validateInput('https://example.test/live.m3u8', { Cookie: 'secret\r\nInjected: x' }, false));
  assert.throws(() => validateInput(path.resolve('test.ts'), {}, false));
  assert.equal(validateInput(path.resolve('test.ts'), {}, true).remote, false);
  assert.equal(safeTitle('../../bad:<name>?'), '.._.._bad__name__');
});

test('lifecycle is isolated per slot, emits safe status, and spawns without a shell', async t => {
  const calls = [];
  const engine = await fixture(t, fakeSpawn(calls));
  const statuses = [];
  engine.on('status', s => statuses.push(s));
  await engine.start(0, { url: 'https://example.test/live.m3u8?secret=abc', headers: { Cookie: 'secret-token' }, channelId: 'one', title: 'Test' });
  await engine.start(1, { url: 'https://example.test/second.m3u8' });
  await fill(engine, 0, 3);
  await engine._refresh(engine.slots[0]);
  assert.deepEqual(engine.status(0), { state: 'buffering', bufferedSeconds: 6 });
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.ok(!JSON.stringify(statuses).includes('secret'));
  await engine.stop(0);
  assert.deepEqual(engine.status(0), { state: 'idle', bufferedSeconds: 0 });
  assert.equal(engine.status(1).state, 'starting');
  assert.throws(() => engine.status(4), /슬롯/);
});

test('C and D record independently and shutdown cancels all four slots', async t => {
  const calls = [];
  const engine = await fixture(t, fakeSpawn(calls));
  await Promise.all([0, 1, 2, 3].map(slotId => engine.start(slotId, { url: `https://example.test/${slotId}.m3u8` })));
  await fill(engine, 3, 3);
  await engine._refresh(engine.slots[3]);
  assert.equal(engine.status(3).bufferedSeconds, 6);
  await engine.stop(2);
  assert.equal(engine.status(2).state, 'idle');
  assert.equal(engine.status(3).bufferedSeconds, 6);
  await engine.stopAll();
  assert.ok([0, 1, 2, 3].every(slotId => engine.status(slotId).state === 'idle'));
  assert.equal(calls.filter(call => call.signal).length, 4);
});

test('pruning bounds completed history while preserving the partial active segment', async t => {
  const engine = await fixture(t, fakeSpawn([]));
  await engine.start(0, { url: 'https://example.test/live.m3u8' });
  const dir = await fill(engine, 0, 60);
  await engine._refresh(engine.slots[0]);
  const files = await fs.readdir(dir);
  assert.equal(engine.status(0).bufferedSeconds, 90);
  assert.ok(!files.includes('segment-000000000.ts'));
  assert.ok(files.includes('segment-000000060.ts'));
  assert.equal(files.filter(f => f.endsWith('.ts')).length, 46);
});

test('save exports only snapshot copies of completed segments and returns actual duration', async t => {
  const calls = [];
  const engine = await fixture(t, fakeSpawn(calls, async (child, args, options) => {
    const parts = await fs.readdir(options.cwd);
    assert.equal(parts.filter(p => p.endsWith('.ts')).length, 3);
    assert.equal(await fs.readFile(path.join(options.cwd, 'concat.txt'), 'utf8'), "file 'part-0.ts'\nfile 'part-1.ts'\nfile 'part-2.ts'\n");
    await fs.writeFile(args.at(-1), 'mp4-data');
    child.emit('close', 0);
  }));
  await engine.start(0, { url: 'https://example.test/live.m3u8', title: 'bad/title', channelId: 'channel' });
  await fill(engine, 0, 5);
  const clip = await engine.save(0, 5);
  assert.equal(clip.duration, 6);
  assert.equal(clip.channelId, 'channel');
  assert.equal(await fs.readFile(clip.path, 'utf8'), 'mp4-data');
  assert.ok(!clip.fileName.includes('/'));
  await engine.stop(0);
  assert.equal(await fs.readFile(clip.path, 'utf8'), 'mp4-data');
});

test('stop cancels an in-flight export and removes unfinished output', async t => {
  const calls = [];
  let exporting;
  const started = new Promise(resolve => { exporting = resolve; });
  const engine = await fixture(t, fakeSpawn(calls, async (child, args) => {
    await fs.writeFile(args.at(-1), 'incomplete');
    exporting();
  }));
  await engine.start(0, { url: 'https://example.test/live.m3u8' });
  await fill(engine, 0, 3);
  const saving = engine.save(0);
  const rejection = assert.rejects(saving, /취소/);
  await started;
  await assert.rejects(engine.save(0), /이미 저장/);
  await engine.stop(0);
  await rejection;
  assert.deepEqual(await fs.readdir(engine.clipsDir), []);
});

test('spawn errors are generic and do not leak signed URLs or credentials', async t => {
  const engine = await fixture(t, () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('secret=https://private.test/?token=abc')));
    return child;
  });
  await assert.rejects(engine.start(0, { url: 'https://example.test/live.m3u8' }), /녹화를 시작하지/);
  assert.equal(engine.status(0).state, 'error');
  assert.ok(!JSON.stringify(engine.status(0)).includes('secret'));
});

test('stalled recording enters an error state and terminates its recorder', async t => {
  const calls = [];
  const engine = await fixture(t, fakeSpawn(calls));
  await engine.start(0, { url: 'https://example.test/live.m3u8' });
  const session = engine.slots[0];
  if (session.poll) await session.poll;
  session.store.lastProgressAt = Date.now() - 60000;
  engine._poll(session);
  await session.poll;
  assert.equal(engine.status(0).state, 'error');
  assert.match(engine.status(0).error, /더 이상 들어오지/);
  assert.ok(calls.some(call => call.signal === 'SIGTERM'));
});

test('stopping while start prepares storage never leaves a running recorder', async t => {
  const calls = [];
  const engine = await fixture(t, fakeSpawn(calls));
  const start = engine.start(0, { url: 'https://example.test/live.m3u8' });
  await engine.stop(0);
  await start;
  assert.equal(engine.status(0).state, 'idle');
  assert.ok(calls.filter(call => call.child).every(call => calls.some(k => k.signal === 'SIGTERM')));
});

test('completed final moments remain saveable after recording ends without clearing its error', async t => {
  const calls = [];
  const engine = await fixture(t, fakeSpawn(calls, async (child, args) => {
    await fs.writeFile(args.at(-1), 'final-moment-mp4');
    child.emit('close', 0);
  }));
  await engine.start(0, { url: 'https://example.test/live.m3u8', channelId: 'ended-channel', title: 'Ended broadcast' });
  await fill(engine, 0, 3);
  const session = engine.slots[0];
  await engine._refresh(session);
  calls[0].child.emit('close', 1);
  await session.recorder.done;
  const errorStatus = engine.status(0);
  assert.equal(errorStatus.state, 'error');
  assert.equal(errorStatus.bufferedSeconds, 6);

  const clip = await engine.save(0, 30);
  assert.equal(clip.duration, 6);
  assert.equal(clip.channelId, 'ended-channel');
  assert.equal(await fs.readFile(clip.path, 'utf8'), 'final-moment-mp4');
  assert.deepEqual(engine.status(0), errorStatus);

  await engine.stop(0);
  assert.deepEqual(engine.status(0), { state: 'idle', bufferedSeconds: 0 });
  assert.equal(await fs.readFile(clip.path, 'utf8'), 'final-moment-mp4');
  await assert.rejects(engine.save(0), /먼저 시작/);
});

test('an error state with insufficient completed video still cannot be exported', async t => {
  const calls = [];
  const engine = await fixture(t, fakeSpawn(calls));
  await engine.start(0, { url: 'https://example.test/live.m3u8' });
  await fill(engine, 0, 1);
  const session = engine.slots[0];
  await engine._refresh(session);
  calls[0].child.emit('close', 1);
  await session.recorder.done;
  await assert.rejects(engine.save(0, 30), /최소 4초/);
  assert.equal(engine.status(0).state, 'error');
  assert.equal(calls.filter(call => call.child).length, 1);
  assert.deepEqual(await fs.readdir(engine.clipsDir), []);
});

test('recorder access denial immediately fails safely; export stderr does not change recording status', async t => {
  for (const diagnostic of ['HTTP error 401 Unauthorized', 'HTTP error 403 Forbidden', 'Unable to open key file']) {
    const calls = [];
    const engine = await fixture(t, fakeSpawn(calls, async (child, args) => {
      child.stderr.emit('data', Buffer.from('HTTP error 403 Forbidden https://private.test/?token=export-secret'));
      await fs.writeFile(args.at(-1), 'exported-mp4');
      child.emit('close', 0);
    }));
    const events = [];
    engine.on('status', event => events.push(event));
    await engine.start(0, { url: 'https://example.test/live.m3u8' });
    await fill(engine, 0, 3);
    const clip = await engine.save(0, 4);
    assert.equal(await fs.readFile(clip.path, 'utf8'), 'exported-mp4');
    assert.equal(engine.status(0).state, 'buffering');

    const session = engine.slots[0];
    calls[0].child.stderr.emit('data', Buffer.from(`${diagnostic}: https://private.test/?token=record-secret Cookie: private-cookie`));
    assert.deepEqual(engine.status(0), {
      state: 'error', bufferedSeconds: 6,
      error: '방송 서버가 영상 접근을 거부했습니다. 이 방송의 로그인·재생 권한 또는 앱 호환성을 확인해 주세요.',
    });
    assert.ok(calls.some(call => call.signal === 'SIGTERM'));
    await session.recorder.done;
    assert.match(engine.status(0).error, /영상 접근을 거부/);
    assert.ok(!JSON.stringify(events).includes('secret'));
    assert.ok(!JSON.stringify(events).includes('private-cookie'));
    await engine.stop(0);
  }
});

test('anchored selection requires the entire range and never bridges a discontinuity', () => {
  const segments = parseManifest(csv(10));
  assert.deepEqual(selectRange(segments, { start: 3, end: 9 }).segments.map(item => item.start), [2, 4, 6, 8]);
  assert.equal(selectRange(segments, { start: 3, end: 9 }).duration, 8);
  assert.throws(() => selectRange(segments, { start: 18, end: 24 }), /완전히 보관/);
  assert.throws(() => selectRange(segments.slice(2), { start: 0, end: 6 }), /완전히 보관/);
  assert.throws(() => selectRange(segments.filter(item => item.start !== 6), { start: 3, end: 9 }), /완전히 보관/);
  const tinyGap = segments.map(item => item.start === 6 ? { ...item, start: 6.05 } : item);
  assert.throws(() => selectRange(tinyGap, { start: 3, end: 9 }), /완전히 보관/);
  for (const range of [{ start: -1, end: 5 }, { start: 0, end: 91 }, { start: 3, end: 5 }, { start: NaN, end: 9 }]) {
    assert.throws(() => selectRange(segments, range));
  }
});

test('marks expose only the active contiguous tail and each restart gets a fresh generation', async t => {
  const calls = [], engine = await fixture(t, fakeSpawn(calls));
  assert.equal(engine.mark(0), null);
  await engine.start(0, { url: 'https://example.test/live.m3u8', channelId: 'same-channel' });
  assert.equal(engine.mark(0), null);
  const dir = await fill(engine, 0, 6);
  await engine._refresh(engine.slots[0]);
  const first = engine.mark(0);
  assert.deepEqual(first, { generation: engine.slots[0].generation, channelId: 'same-channel', start: 0, end: 12 });
  first.start = 999;
  assert.equal(engine.mark(0).start, 0, 'marks cannot mutate the stored interval');
  await fs.rm(path.join(dir, 'segment-000000002.ts'));
  await engine._refresh(engine.slots[0]);
  assert.equal(engine.mark(0).start, 6);
  await assert.rejects(engine.saveRange(0, { ...first, start: 0, end: 8 }), /완전히 보관/);
  await engine.start(0, { url: 'https://example.test/live.m3u8', channelId: 'same-channel' });
  await fill(engine, 0, 6); await engine._refresh(engine.slots[0]);
  assert.notEqual(engine.mark(0).generation, first.generation);
  await assert.rejects(engine.saveRange(0, { ...first, start: 0, end: 8 }), /변경/);
  await assert.rejects(engine.saveRange(0, { start: 0, end: 8 }), /변경/);
  await engine.stop(0);
  assert.equal(engine.mark(0), null);
  await assert.rejects(engine.saveRange(0, { ...first, start: 0, end: 8 }), /진행 중/);
  assert.equal(calls.filter(call => call.args?.includes('concat')).length, 0);
});

test('range export pins its older interval while live pruning advances and rejects overlapping saves', async t => {
  const started = deferred(), finish = deferred(), calls = [];
  const engine = await fixture(t, fakeSpawn(calls, async (child, args, options) => {
    started.resolve(options.cwd); await finish.promise;
    await fs.writeFile(args.at(-1), 'anchored-mp4'); child.emit('close', 0);
  }));
  await engine.start(0, { url: 'https://example.test/live.m3u8', channelId: 'channel', title: 'Anchor' });
  const dir = await fill(engine, 0, 10);
  for (let i = 0; i < 10; i++) await fs.writeFile(path.join(dir, `segment-${String(i).padStart(9, '0')}.ts`), `segment ${i}`);
  await engine._refresh(engine.slots[0]);
  const range = { generation: engine.mark(0).generation, start: 3, end: 9 };
  const saving = engine.saveRange(0, range);
  const snapshotDir = await started.promise;
  await assert.rejects(engine.save(0, 4), /이미 저장/);
  await assert.rejects(engine.saveRange(0, range), /이미 저장/);
  await fill(engine, 0, 70); await engine._refresh(engine.slots[0]);
  assert.equal(engine.mark(0).start, 50);
  await assert.rejects(fs.access(path.join(dir, 'segment-000000001.ts')));
  assert.equal(await fs.readFile(path.join(snapshotDir, 'part-0.ts'), 'utf8'), 'segment 1');
  assert.equal(await fs.readFile(path.join(snapshotDir, 'part-3.ts'), 'utf8'), 'segment 4');
  finish.resolve();
  const clip = await saving;
  assert.equal(clip.duration, 8); assert.equal(clip.channelId, 'channel');
  assert.equal(await fs.readFile(clip.path, 'utf8'), 'anchored-mp4');
  await assert.rejects(fs.access(snapshotDir));
  await assert.rejects(engine.saveRange(0, range), /완전히 보관/);
  await assert.rejects(engine.saveRange(0, { ...range, start: 136, end: 142 }), /완전히 보관/);
  assert.equal(calls.filter(call => call.args?.includes('concat')).length, 1, 'missing ranges never start an exporter');
});

test('stop cancels a range waiting for the segment queue before any export process starts', async t => {
  const calls = [], engine = await fixture(t, fakeSpawn(calls));
  await engine.start(0, { url: 'https://example.test/live.m3u8' });
  await fill(engine, 0, 5); await engine._refresh(engine.slots[0]);
  const range = { ...engine.mark(0), start: 0, end: 6 }, gate = deferred();
  engine.slots[0].store.queue = gate.promise;
  const saving = engine.saveRange(0, range);
  const rejection = assert.rejects(saving, /취소/);
  const stopping = engine.stop(0);
  assert.equal(engine.mark(0), null);
  gate.resolve(); await stopping; await rejection;
  assert.equal(calls.filter(call => call.args?.includes('concat')).length, 0);
  assert.deepEqual(await fs.readdir(engine.clipsDir), []);
});

test('recording failure cancels an active anchored export and refuses new range saves', async t => {
  const started = deferred(), calls = [];
  const engine = await fixture(t, fakeSpawn(calls, async (_child, args) => {
    await fs.writeFile(args.at(-1), 'partial'); started.resolve();
  }));
  await engine.start(0, { url: 'https://example.test/live.m3u8' });
  await fill(engine, 0, 5); await engine._refresh(engine.slots[0]);
  const range = { ...engine.mark(0), start: 0, end: 6 };
  const saving = engine.saveRange(0, range), rejection = assert.rejects(saving, /취소/);
  await started.promise;
  calls[0].child.emit('close', 1);
  await rejection;
  assert.equal(engine.mark(0), null);
  await assert.rejects(engine.saveRange(0, range), /진행 중/);
  assert.deepEqual(await fs.readdir(engine.clipsDir), []);
  assert.equal((await fs.readdir(engine.slots[0].dir)).some(name => name.startsWith('export-')), false);
});
