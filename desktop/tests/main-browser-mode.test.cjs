'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const channels = require('../lib/channels.cjs');
const { createBrowserHandlers } = require('../lib/browser-actions.cjs');
const { AuthSession, trustedRemote } = require('../lib/auth-session.cjs');
const { ProfileStore } = require('../lib/profile-store.cjs');
const { PlayerManager } = require('../lib/player-manager.cjs');
const { RecordingService } = require('../lib/recording-service.cjs');

const channelA = 'a'.repeat(32), channelB = 'b'.repeat(32);
const mainPath = path.resolve(__dirname, '..', 'main.cjs');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Execute the real main process module with every Electron, disk, media and network
// dependency replaced. This test cannot open a window or touch an actual profile.
async function boot(savedSettings, { packaged = false } = {}) {
  const profile = path.resolve(__dirname, '..', '.artifacts', 'VIRTUAL-ONLY-main-mode');
  const disk = new Map([[path.join(profile, 'settings.json'), JSON.stringify(savedSettings)],
    [path.join(profile, 'clips.json'), '[]']]);
  const windows = [], views = [], ipc = new Map(), starts = [], saves = [], errors = [], mediaLeases = [];
  let replay, browserHandlers, playbackGate, rewards;
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = { url: pathToFileURL(path.join(path.dirname(mainPath), 'ui', 'index.html')).href }; this.closed = false; this.reloads = 0; }
    setWindowOpenHandler() {}
    setAudioMuted() {}
    setZoomFactor() {}
    send() {}
    loadURL() { return Promise.resolve(); }
    reload() { this.reloads++; }
    close() { this.closed = true; }
    isDestroyed() { return this.closed; }
  }
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new Contents(); this.contentView = { addChildView() {}, removeChildView() {} }; windows.push(this); }
    removeMenu() {}
    show() {}
    isDestroyed() { return false; }
    getContentSize() { return [1500, 1000]; }
    async loadFile() { this.webContents.emit('did-finish-load'); }
  }
  class View {
    constructor() { this.webContents = new Contents(); views.push(this); }
    setBounds() {}
    setVisible() {}
  }
  class Replay extends EventEmitter {
    constructor(options) { super(); replay = this; this.ffmpegPath = options.ffmpegPath; this.states = [0, 1, 2, 3].map(() => ({ state: 'idle' })); }
    status(slotId) { return this.states[slotId]; }
    async stop(slotId) { this.states[slotId] = { state: 'idle', bufferedSeconds: 0 }; }
    async stopAll() { await Promise.all([0, 1, 2, 3].map(id => this.stop(id))); }
    async start(slotId, info) { starts.push({ slotId, info }); this.states[slotId] = { state: 'buffering', bufferedSeconds: 10 }; }
    async save(slotId, seconds) { saves.push({ slotId, seconds }); return { id: `fake-${saves.length}`, fileName: 'fake.mp4', title: 'test', duration: seconds }; }
  }
  class Gateway {
    async start() {}
    createStream() { const lease = { url: 'http://127.0.0.1:1/fake.m3u8', closed: false, close() { this.closed = true; } }; mediaLeases.push(lease); return lease; }
    async close() {}
  }
  class Bridge {
    constructor({ handlers }) { browserHandlers = handlers; this.connectionCode = '1:FAKE-ONLY'; }
    async start() { return this.connectionCode; }
    async close() { this.connectionCode = null; return { drained: true }; }
    rotateToken() { this.connectionCode = '2:FAKE-ONLY'; }
  }
  class Rewards {
    constructor() { rewards = this; this.attached = []; }
    status() { return null; }
    attach(slotId) { this.attached.push(slotId); }
    detach() {}
    setEnabled() {}
    close() {}
  }
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: packaged, setName() {}, setPath() {}, getPath: () => profile, getVersion: () => 'test',
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), quitCount: 0,
    quit() { this.quitCount++; }, exit(code) { errors.push(new Error(`Unexpected exit ${code}`)); } });
  const remoteSession = new EventEmitter();
  Object.assign(remoteSession, { setUserAgent() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    async fetch(url) {
      if (url.includes('getUserStatus')) return { ok: true, json: async () => ({ content: { loggedIn: false } }) };
      if (playbackGate) await playbackGate.promise;
      return { ok: true, json: async () => ({ content: { status: 'OPEN', liveTitle: 'test',
        livePlaybackJson: JSON.stringify({ media: [{ mediaId: 'HLS', protocol: 'HLS', path: 'https://video.pstatic.net/fake.m3u8' }] }) } }) };
    } });
  const fileApi = { mkdir: async () => {}, access: async () => {}, readdir: async () => [], rm: async () => {},
    readFile: async name => { if (!disk.has(name)) throw new Error('missing fake file'); return disk.get(name); },
    writeFile: async (name, value) => { disk.set(name, value); },
    rename: async (from, to) => { disk.set(to, disk.get(from)); disk.delete(from); } };
  const modules = {
    electron: { app, BrowserWindow: Window, WebContentsView: View, ipcMain: { handle: (name, handler) => ipc.set(name, handler) },
      session: { fromPartition: () => remoteSession }, shell: {}, clipboard: { writeText() {} } },
    'node:fs/promises': fileApi, 'node:fs': { mkdirSync() {}, realpathSync: { native: value => value } },
    'node:path': path, 'node:url': { pathToFileURL },
    './lib/channels.cjs': channels, './lib/replay-buffer.cjs': { ReplayBuffer: Replay }, './lib/media-gateway.cjs': { MediaGateway: Gateway },
    './lib/clip-storage.cjs': { validFileName: () => true, prepareClipStorage: async ({ preferredClipsDir }) => ({ clipsDir: preferredClipsDir, clips: [], warnings: [], ready: true }) },
    './lib/profile-path.cjs': { resolveProfilePath: ({ explicitPath }) => explicitPath },
    './lib/open-local-path.cjs': { openLocalPath: async () => {} }, './lib/browser-bridge.cjs': { BrowserBridge: Bridge },
    './lib/browser-actions.cjs': { createBrowserHandlers }, './lib/rewards-host.cjs': { RewardsHost: Rewards },
    './lib/auth-session.cjs': { AuthSession, trustedRemote },
    './lib/profile-store.cjs': { ProfileStore: class extends ProfileStore { constructor(directory) { super(directory, { fileSystem: fileApi }); } } },
    './lib/player-manager.cjs': { PlayerManager }, './lib/recording-service.cjs': { RecordingService },
    'ffmpeg-static': path.join(profile, 'fake-ffmpeg.exe')
  };
  const controllerModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(path.dirname(mainPath), 'lib', 'desk-controller.cjs'), 'utf8'), {
    module: controllerModule,
    require(name) { return name.startsWith('./') ? modules[`./lib/${path.basename(name)}`] : require(name); }
  });
  modules['./lib/desk-controller.cjs'] = controllerModule.exports;
  vm.runInNewContext(mainSource, { require(name) { if (!(name in modules)) throw new Error(`Unexpected dependency ${name}`); return modules[name]; },
    __dirname: path.dirname(mainPath), process: { env: { DESK_DATA_DIR: profile }, platform: process.platform, versions: { chrome: 'test' }, resourcesPath: path.join(profile, 'resources') },
    console: { error: (...args) => errors.push(new Error(args.join(' '))) }, URL, AbortSignal, setTimeout, clearTimeout }, { filename: mainPath });
  await new Promise(setImmediate);
  assert.deepEqual(errors, []);
  assert.equal(windows.length, 1);
  const event = { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame };
  async function invoke(method, arg) {
    const result = await ipc.get(`desk:${method}`)(event, arg);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
  return { app, windows, views, replay, starts, saves, mediaLeases, browserHandlers, invoke, disk, profile, rewards,
    delayPlayback() { playbackGate = deferred(); return playbackGate; } };
}

const settings = modes => ({ channels: [{ id: channelA, name: 'A' }, { id: channelB, name: 'B' }],
  slots: [channelA, channelB], playbackModes: modes });

test('packaged startup uses the external FFmpeg executable without an ASAR spawn path', async () => {
  const f = await boot(settings(['browser', 'browser']), { packaged: true });
  assert.equal(f.replay.ffmpegPath, path.join(f.profile, 'resources', 'ffmpeg', 'ffmpeg.exe'));
  assert.equal((await f.invoke('getState')).ffmpegAvailable, true);
  assert.equal(f.views.length, 0);
});

test('restored browser slots never instantiate or reload an embedded player', async () => {
  const f = await boot(settings(['browser', 'desktop']));
  assert.equal(f.views.length, 1);
  assert.equal((await f.invoke('getState')).slots[0].pageStatus, 'browser');
  await assert.rejects(f.invoke('reloadSlot', 0), /크롬/);
  await f.browserHandlers.assignSlot({ slotId: 0, channelId: channelA });
  assert.equal(f.views.length, 1);
  await f.browserHandlers.setBuffer({ slotId: 0, enabled: true, channelId: channelA });
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].info.channelId, channelA);
  assert.equal(f.views.length, 1);
  assert.equal(f.views[0].webContents.closed, false);
});

test('mode transitions close the previous player and recreate one only for desktop mode', async () => {
  const f = await boot(settings(['desktop', 'desktop']));
  assert.equal(f.views.length, 2);
  await f.browserHandlers.assignSlot({ slotId: 0, channelId: channelA });
  assert.equal(f.views[0].webContents.closed, true);
  assert.equal(f.views[1].webContents.closed, false);
  assert.equal(f.views.length, 2);
  await f.invoke('assignSlot', { slotId: 0, channelId: channelA, playbackMode: 'desktop' });
  assert.equal(f.views.length, 3);
  assert.equal((await f.invoke('getState')).slots[0].playbackMode, 'desktop');
});

test('a live-info request finishing after shutdown cannot start a new recording', async () => {
  const f = await boot(settings(['browser', 'browser']));
  const playback = f.delayPlayback();
  const recording = f.browserHandlers.setBuffer({ slotId: 0, enabled: true, channelId: channelA });
  await new Promise(setImmediate);
  f.app.emit('before-quit', { preventDefault() {} });
  await new Promise(setImmediate);
  playback.resolve();
  await recording;
  assert.equal(f.starts.length, 0);
  assert.equal(f.mediaLeases.length, 0);
  assert.equal(f.views.length, 0);
  await assert.rejects(f.browserHandlers.getState(), /종료/);
});

test('four mixed players, shared layout and reward settings persist without restarting recording', async () => {
  const channelC = 'c'.repeat(32), channelD = 'd'.repeat(32);
  const f = await boot({ channels: [channelA, channelB, channelC, channelD].map(id => ({ id })),
    slots: [channelA, channelB, channelC, channelD], playbackModes: ['desktop', 'browser', 'desktop', 'browser'] });
  assert.equal(f.views.length, 2);
  await f.browserHandlers.setBuffer({ slotId: 3, enabled: true, channelId: channelD });
  await f.browserHandlers.setLayout({ layout: 'grid', mainSlot: 3 });
  await f.invoke('setAutoRewards', true);
  const state = await f.invoke('getState');
  assert.equal(state.slots.length, 4);
  assert.equal(state.slots[3].replay.state, 'buffering');
  assert.equal(state.mainSlot, 3);
  assert.equal(state.layout, 'grid');
  assert.equal(state.rewardSettings.enabled, true);
  assert.equal(f.starts.length, 1);
  assert.equal(f.views.length, 2);
  const persisted = JSON.parse(f.disk.get(path.join(f.profile, 'settings.json')));
  assert.equal(persisted.layout, 'grid');
  assert.equal(persisted.rewardSettings.enabled, true);
  await assert.rejects(f.invoke('setLayout', { layout: 'bad', mainSlot: 0 }), /배치/);
  await assert.rejects(f.invoke('setLayout', { layout: 'grid', mainSlot: 4 }), /슬롯/);
  await assert.rejects(f.invoke('setAutoRewards', 'true'), /설정/);
  assert.equal((await f.browserHandlers.getState()).rewardSettings, undefined, 'desktop rewards belong to the desktop session');
});

test('late document loading during slot shutdown cannot reenable rewards', async () => {
  const f = await boot(settings(['desktop', 'browser']));
  const gate = deferred();
  f.replay.stop = () => gate.promise;
  const closing = f.invoke('clearSlot', 0);
  await new Promise(setImmediate);
  f.views[0].webContents.emit('did-finish-load');
  assert.equal(f.rewards.attached.length, 0);
  gate.resolve();
  await closing;
  assert.equal(f.views[0].webContents.closed, true);
});

for (const transition of ['clearSlot', 'assignSlot', 'removeChannel']) {
  test(`${transition} cannot reopen the previous player through reload or shell restoration while recording stops`, async () => {
    const f = await boot(settings(['desktop', 'browser']));
    assert.equal(f.views.length, 1, 'startup restores the desktop player');
    const gate = deferred();
    f.replay.stop = () => gate.promise;
    const arg = transition === 'assignSlot' ? { slotId: 0, channelId: channelB, playbackMode: 'desktop' }
      : transition === 'removeChannel' ? channelA : 0;
    const changing = f.invoke(transition, arg);
    await new Promise(setImmediate);
    assert.equal(f.views[0].webContents.closed, false, 'old player is still waiting for recording to stop');
    await assert.rejects(f.invoke('reloadSlot', 0), /작업이 진행 중/);
    f.windows[0].webContents.emit('did-finish-load');
    assert.equal(f.views.length, 1, 'shell restoration must not recreate a busy slot');
    gate.resolve();
    await changing;
    assert.equal(f.views[0].webContents.closed, true);
    const state = await f.invoke('getState');
    assert.equal(state.slots[0].channelId, transition === 'assignSlot' ? channelB : null);
    f.windows[0].webContents.emit('did-finish-load');
    await f.invoke('reloadSlot', 0);
    assert.equal(f.views.length, transition === 'assignSlot' ? 2 : 1);
    assert.equal(f.views.filter(view => !view.webContents.closed).length, transition === 'assignSlot' ? 1 : 0,
      'the completed slot action leaves no orphan player');
    if (transition === 'assignSlot') assert.equal(f.views[1].webContents.reloads, 1, 'normal reload resumes after the slot is unlocked');
  });
}

test('clip length persists, accepts only offered durations and reaches browser and keyboard saves', async () => {
  const f = await boot(settings(['desktop', 'browser']));
  assert.equal((await f.invoke('getState')).clipSeconds, 30);
  await f.browserHandlers.setClipSeconds(60);
  assert.equal((await f.browserHandlers.getState()).clipSeconds, 60);
  assert.equal(JSON.parse(f.disk.get(path.join(f.profile, 'settings.json'))).clipSeconds, 60);
  await f.browserHandlers.saveClip({ slotId: 1, channelId: channelB });
  assert.equal(f.saves[0].seconds, 60);
  await f.invoke('setClipSeconds', 15);
  let prevented = false;
  f.views[0].webContents.emit('before-input-event', { preventDefault() { prevented = true; } },
    { type: 'keyDown', control: true, shift: true, code: 'KeyS' });
  await new Promise(setImmediate);
  assert.equal(prevented, true);
  assert.deepEqual(f.saves[1], { slotId: 0, seconds: 15 });
  for (const seconds of [0, 14, 90, '30', NaN]) {
    await assert.rejects(f.invoke('setClipSeconds', seconds), /저장 길이/);
    await assert.rejects(f.invoke('saveClip', { slotId: 0, seconds }), /저장 길이/);
  }
  assert.equal(f.saves.length, 2);
});
