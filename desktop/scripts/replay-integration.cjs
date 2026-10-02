'use strict';
// Real FFmpeg test using generated video/audio and a local, advancing HLS fixture.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { ReplayBuffer } = require('../lib/replay-buffer.cjs');
const { BrowserBridge } = require('../lib/browser-bridge.cjs');
const { createBrowserHandlers } = require('../lib/browser-actions.cjs');
const { validClipSeconds } = require('../lib/channels.cjs');
const ffmpeg = require('ffmpeg-static');
const throughBridge = process.argv.includes('--browser-bridge');
const durations = process.argv.includes('--all-durations') ? [15, 30, 60] : [30];
const longest = Math.max(...durations);
const root = path.resolve(__dirname, throughBridge ? '../.artifacts/browser-replay-integration' : '../.artifacts/replay-integration');

async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg ${code}: ${error.slice(-2000)}`)));
  });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const fixture = path.join(root, 'fixture');
  await fs.mkdir(fixture, { recursive: true });
  await run(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '70', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-sc_threshold', '0', '-c:a', 'aac',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', path.join(fixture, 'part-%03d.ts'), path.join(fixture, 'all.m3u8')]);
  const startTime = Date.now();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/live.m3u8') {
        const count = Math.min(34, 3 + Math.floor((Date.now() - startTime) / 2000));
        const first = Math.max(0, count - 6);
        let manifest = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n`;
        for (let i = first; i < count; i++) manifest += `#EXTINF:2.000000,\npart-${String(i).padStart(3, '0')}.ts\n`;
        response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
        response.end(manifest);
      } else if (/^\/part-\d{3}\.ts$/.test(url.pathname)) {
        response.writeHead(200, { 'Content-Type': 'video/mp2t' }); response.end(await fs.readFile(path.join(fixture, url.pathname.slice(1))));
      } else { response.writeHead(404); response.end(); }
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const replay = new ReplayBuffer({ ffmpegPath: ffmpeg, rootDir: path.join(root, 'buffer'), clipsDir: path.join(root, 'clips'), pollIntervalMs: 250 });
  let bridge, rpc;
  try {
    const channelId = '0123456789abcdef0123456789abcdef';
    const input = { url: `http://127.0.0.1:${server.address().port}/live.m3u8`, channelId, title: '검증용 영상' };
    if (throughBridge) {
      let assigned = false;
      let clipSeconds = 30;
      const saved = [];
      const actions = {
        getState: () => ({ channels: [{ id: channelId, name: input.title }], clips: saved, clipSeconds,
          slots: [{ slotId: 0, channelId: assigned ? channelId : null, playbackMode: 'browser', replay: replay.status(0) }],
          savingSlots: [], ffmpegAvailable: true, auth: { status: 'signed_in', nickname: 'not shared' } }),
        assignSlot: async arg => { assert.equal(arg.playbackMode, 'browser'); assigned = true; return actions.getState(); },
        setClipSeconds: async seconds => { clipSeconds = validClipSeconds(seconds); return actions.getState(); },
        setBuffer: async arg => { if (arg.enabled) await replay.start(arg.slotId, input); else await replay.stop(arg.slotId); return actions.getState(); },
        saveClip: async arg => {
          const result = await replay.save(arg.slotId, validClipSeconds(arg.seconds ?? clipSeconds));
          const { path: ignored, ...metadata } = result;
          saved.push(metadata); return metadata;
        }
      };
      bridge = new BrowserBridge({ handlers: createBrowserHandlers({ actions }) });
      const [port, token] = (await bridge.start()).split(':');
      // No Chrome/Electron window: a simulated extension origin exercises the real HTTP bridge.
      const { DeskController } = await import('../../browser-extension/lib/core.js');
      const extension = new DeskController({ chromeApi: {}, fetchImpl: (url, options) => fetch(url, {
        ...options, headers: { ...options.headers, Origin: `chrome-extension://${'a'.repeat(32)}` }
      }) });
      rpc = (method, arg) => extension.rpc(method, arg, { port: Number(port), token });
      await rpc('assignSlot', { slotId: 0, channelId });
      await rpc('setBuffer', { slotId: 0, channelId, enabled: true });
    } else await replay.start(0, input);
    const deadline = Date.now() + longest * 1000 + 20000;
    while (replay.status(0).bufferedSeconds < longest + 2 && Date.now() < deadline) {
      assert.notEqual(replay.status(0).state, 'error', JSON.stringify(replay.status(0)));
      await delay(250);
    }
    assert.ok(replay.status(0).bufferedSeconds >= longest, `Generated stream must accumulate at least ${longest} seconds`);
    const results = [];
    for (const seconds of durations) {
      if (throughBridge) assert.equal((await rpc('setClipSeconds', seconds)).clipSeconds, seconds);
      // Omitting seconds also exercises the persisted preference's default on the bridge.
      const clip = throughBridge ? await rpc('saveClip', { slotId: 0, channelId }) : await replay.save(0, seconds);
      const clipPath = throughBridge ? path.join(root, 'clips', clip.fileName) : clip.path;
      assert.ok(clip.duration >= seconds && clip.duration < seconds + 5, `Unexpected duration ${clip.duration} for ${seconds}`);
      assert.ok((await fs.stat(clipPath)).size > 10000);
      await run(['-xerror', '-i', clipPath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
      results.push({ requestedSeconds: seconds, duration: clip.duration, clip: clip.fileName, id: clip.id });
    }
    if (throughBridge) {
      const state = await rpc('getState');
      assert.deepEqual(state.clips.map(clip => clip.id), results.map(clip => clip.id));
      assert.equal(state.auth.nickname, undefined);
      await rpc('setBuffer', { slotId: 0, channelId, enabled: false });
    }
    console.log(JSON.stringify({ ok: true, clips: results.map(({ id: ignored, ...clip }) => clip),
      throughBridge, verified: 'MP4 video and audio decode', actualBrowserUsed: false }));
  } finally {
    await bridge?.close();
    await replay.stopAll();
    assert.equal(replay.status(0).state, 'idle');
    assert.equal((await fs.readdir(path.join(root, 'buffer'))).length, 0, 'Stop must remove session media');
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
