'use strict';

// Real FFmpeg, generated media, fake chat and loopback HTTP only. No Electron,
// browser, account, credentials, or live CHZZK requests are used by this check.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { ReplayBuffer } = require('../lib/replay-buffer.cjs');
const { RecordingService } = require('../lib/recording-service.cjs');
const { AutoClipService, PRE_SECONDS, POST_SECONDS } = require('../lib/auto-clip-service.cjs');
const ffmpeg = require('ffmpeg-static');
const channelId = '0123456789abcdef0123456789abcdef';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args],
      { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostics = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60000);
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (!timedOut && code === 0) resolve();
      else reject(new Error(`Synthetic FFmpeg check failed (${code}): ${diagnostics}`));
    });
  });
}

async function waitFor(replay, condition, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.notEqual(replay.status(0).state, 'error', JSON.stringify(replay.status(0)));
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(100);
  }
}

(async () => {
  const artifacts = path.resolve(__dirname, '..', '.artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const root = await fs.mkdtemp(path.join(artifacts, 'auto-clip-integration-'));
  const fixture = path.join(root, 'fixture');
  await fs.mkdir(fixture);
  await run(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '52', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-sc_threshold', '0', '-c:a', 'aac',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', path.join(fixture, 'part-%03d.ts'), path.join(fixture, 'all.m3u8')]);
  let streamStartedAt = Date.now();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/live.m3u8') {
        const count = Math.min(25, 3 + Math.floor((Date.now() - streamStartedAt) / 2000));
        const first = Math.max(0, count - 6);
        let manifest = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n`;
        for (let i = first; i < count; i++) manifest += `#EXTINF:2.000000,\npart-${String(i).padStart(3, '0')}.ts\n`;
        response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
        response.end(manifest);
      } else if (/^\/part-\d{3}\.ts$/.test(url.pathname)) {
        const contents = await fs.readFile(path.join(fixture, url.pathname.slice(1)));
        response.writeHead(200, { 'Content-Type': 'video/mp2t' }); response.end(contents);
      } else { response.writeHead(404); response.end(); }
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const replay = new ReplayBuffer({ ffmpegPath: ffmpeg, rootDir: path.join(root, 'buffer'), clipsDir: path.join(root, 'clips'), pollIntervalMs: 100 });
  const leases = [];
  // RecordingService still performs its real live-info selection and lease flow;
  // these two adapters can return only our generated local source.
  const recordings = new RecordingService({ replay, ffmpegAvailable: true, storageReady: true,
    session: { async fetch(url) {
      assert.equal(url, `https://api.chzzk.naver.com/service/v3/channels/${channelId}/live-detail`);
      return { ok: true, json: async () => ({ content: { status: 'OPEN', liveTitle: '자동 클립 검증', livePlaybackJson: JSON.stringify({
        media: [{ mediaId: 'HLS', protocol: 'HLS', path: 'https://synthetic.example.test/live.m3u8' }]
      }) } }) };
    } },
    gateway: { createStream(url) {
      assert.equal(url, 'https://synthetic.example.test/live.m3u8');
      const lease = { url: `http://127.0.0.1:${server.address().port}/live.m3u8`, closed: false, close() { this.closed = true; } };
      leases.push(lease); return lease;
    }, async close() { for (const lease of leases) lease.close(); } }
  });
  const records = [], attempts = [], config = { enabled: true, chatSpike: false, keywords: ['합성하이라이트'] };
  let detectorNow = 1000;
  const auto = new AutoClipService({ recordings, now: () => detectorNow, intervalMs: 100,
    assignment: slotId => ({ channelId: slotId === 0 ? channelId : null }),
    config: id => id === channelId ? config : { enabled: false },
    isBusy: slotId => recordings.savingSlots.includes(slotId),
    save: async (slotId, range, trigger) => {
      const atSave = replay.mark(slotId);
      assert.equal(atSave.generation, range.generation);
      assert(atSave.end >= range.end, 'Export must wait for ten seconds of completed media after the anchor');
      attempts.push({ start: range.start, end: range.end, observedEnd: atSave.end });
      return recordings.saveRange(slotId, range, trigger, async record => { records.push(record); });
    }
  });
  try {
    await recordings.setBuffer(0, true, channelId);
    await waitFor(replay, () => {
      const mark = replay.mark(0); return mark && mark.end - mark.start >= PRE_SECONDS;
    }, '20 seconds of completed preroll');
    const context = auto.context(0);
    const batch = events => ({ ...context, events, sourceStatus: 'watching' });
    assert.equal(auto.submit(batch([{ id: 'warmup', text: '합성 채팅 준비' }])).accepted, true);
    detectorNow += 5000;
    const anchor = replay.mark(0);
    auto.submit(batch([{ id: 'highlight', text: '합성하이라이트 감지' }]));
    assert.equal(auto.state(0).status, 'pending');
    assert.equal(attempts.length, 0); assert.equal(records.length, 0);
    await waitFor(replay, () => {
      const mark = replay.mark(0);
      if (mark.end < anchor.end + POST_SECONDS) assert.equal(attempts.length, 0, 'Wall-clock delay alone must not export');
      assert.notEqual(auto.state(0).status, 'error', auto.state(0).message);
      return records.length > 0;
    }, 'automatic postroll export', 30000);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].start, anchor.end - PRE_SECONDS);
    assert.equal(attempts[0].end, anchor.end + POST_SECONDS);
    const clip = records[0], clipPath = path.join(root, 'clips', clip.fileName);
    assert.equal(clip.trigger, 'keyword'); assert.equal(clip.channelId, channelId);
    assert(!JSON.stringify(clip).includes('합성하이라이트'), 'Chat text is never persisted in clip metadata');
    assert(clip.duration >= PRE_SECONDS + POST_SECONDS && clip.duration < PRE_SECONDS + POST_SECONDS + 5);
    assert((await fs.stat(clipPath)).size > 10000);
    await run(['-xerror', '-i', clipPath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
    auto.submit(batch([{ id: 'highlight', text: '합성하이라이트 감지' }]));
    assert.equal(attempts.length, 1, 'Repeated chat must not create a duplicate clip');
    config.enabled = false; auto.tick();
    await recordings.stop(0);
    assert.equal(leases[0].closed, true);
    streamStartedAt = Date.now();
    await recordings.setBuffer(0, true, channelId);
    await waitFor(replay, () => replay.mark(0)?.end >= 4, 'new recording generation', 15000);
    assert.notEqual(replay.mark(0).generation, anchor.generation);
    await assert.rejects(replay.saveRange(0, { generation: anchor.generation, start: 0, end: 4 }), /변경/);
    console.log(JSON.stringify({ ok: true, clip: clipPath, trigger: clip.trigger, duration: clip.duration,
      range: attempts[0], staleGenerationRejected: true, verified: 'MP4 video and audio decode', actualBrowserUsed: false }));
  } finally {
    auto.close();
    await recordings.shutdown();
    assert.equal(replay.status(0).state, 'idle');
    assert.equal((await fs.readdir(path.join(root, 'buffer'))).length, 0);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
