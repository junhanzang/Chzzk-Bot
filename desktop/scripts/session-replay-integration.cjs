'use strict';
// Controlled encrypted HLS: a fake session denies keys until signed in.
// This exercises real FFmpeg, not a real Naver account.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createCipheriv } = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { MediaGateway } = require('../lib/media-gateway.cjs');
const { ReplayBuffer } = require('../lib/replay-buffer.cjs');
const ffmpeg = require('ffmpeg-static');
const root = path.resolve(__dirname, '../.artifacts/session-replay');
const fixture = path.join(root, 'fixture');
const key = randomBytes(16);
let signedIn = false, startTime, gateway, replay, stream, keyDenied = 0, keyAccepted = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Fixture FFmpeg failed (${code})`)));
  });
}

async function sessionFetch(url, options) {
  assert.equal(options.credentials, 'include');
  assert.equal(options.redirect, 'manual');
  const resource = new URL(url);
  if (resource.hostname === 'api.chzzk.naver.com') {
    if (!signedIn) { keyDenied++; return new Response('Access denied', { status: 403 }); }
    keyAccepted++;
    return new Response(key, { headers: { 'Content-Type': 'application/octet-stream' } });
  }
  if (resource.pathname === '/master.m3u8') {
    return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nlive.m3u8\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  }
  if (resource.pathname === '/live.m3u8') {
    const count = Math.min(34, 3 + Math.floor((Date.now() - startTime) / 2000));
    const first = Math.max(0, count - 6);
    let manifest = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n`;
    manifest += '#EXT-X-KEY:METHOD=AES-128,URI="https://api.chzzk.naver.com/service/v1/encryption/lives/1/aes_key?fixture=1"\n';
    for (let i = first; i < count; i++) manifest += `#EXTINF:2.000000,\npart-${String(i).padStart(3, '0')}.ts\n`;
    return new Response(manifest, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  }
  const match = resource.pathname.match(/^\/part-(\d{3})\.ts$/);
  if (!match) return new Response('Not found', { status: 404 });
  const iv = Buffer.alloc(16); iv.writeUInt32BE(Number(match[1]), 12);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const plain = await fs.readFile(path.join(fixture, `part-${match[1]}.ts`));
  return new Response(Buffer.concat([cipher.update(plain), cipher.final()]), { headers: { 'Content-Type': 'video/mp2t' } });
}

(async () => {
  await fs.mkdir(fixture, { recursive: true });
  await run(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '70', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-sc_threshold', '0', '-c:a', 'aac',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', path.join(fixture, 'part-%03d.ts'), path.join(fixture, 'all.m3u8')]);
  gateway = new MediaGateway({ fetchImpl: sessionFetch }); await gateway.start();
  replay = new ReplayBuffer({ ffmpegPath: ffmpeg, rootDir: path.join(root, 'buffer'), clipsDir: path.join(root, 'clips'), pollIntervalMs: 250 });
  startTime = Date.now();
  stream = gateway.createStream('https://fixture.pstatic.net/master.m3u8', { referer: `https://chzzk.naver.com/live/${'1'.repeat(32)}` });
  await replay.start(0, { url: stream.url, channelId: 'test', title: '세션 검증 영상' });
  let deadline = Date.now() + 12000;
  while (replay.status(0).state !== 'error' && Date.now() < deadline) await delay(100);
  assert.equal(replay.status(0).state, 'error', 'Unsigned fixture must fail when the key endpoint denies access');
  assert.ok(keyDenied > 0);
  await replay.stop(0); stream.close();

  signedIn = true; startTime = Date.now();
  stream = gateway.createStream('https://fixture.pstatic.net/master.m3u8', { referer: `https://chzzk.naver.com/live/${'1'.repeat(32)}` });
  await replay.start(0, { url: stream.url, channelId: 'test', title: '세션 검증 영상' });
  deadline = Date.now() + 45000;
  while (replay.status(0).bufferedSeconds < 32 && Date.now() < deadline) {
    assert.notEqual(replay.status(0).state, 'error', JSON.stringify(replay.status(0)));
    await delay(250);
  }
  assert.ok(keyAccepted > 0);
  assert.ok(replay.status(0).bufferedSeconds >= 30);
  const clip = await replay.save(0, 30);
  assert.ok(clip.duration >= 30 && clip.duration < 35);
  await run(['-xerror', '-i', clip.path, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  console.log(JSON.stringify({ ok: true, duration: clip.duration, verified: 'Controlled session: denied key before login, encrypted HLS to MP4 after login, video and audio decode' }));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  await replay?.stopAll(); stream?.close(); await gateway?.close(); key.fill(0);
});
