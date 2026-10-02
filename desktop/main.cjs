'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, clipboard } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ReplayBuffer } = require('./lib/replay-buffer.cjs');
const { MediaGateway } = require('./lib/media-gateway.cjs');
const { resolveProfilePath } = require('./lib/profile-path.cjs');
const { BrowserBridge } = require('./lib/browser-bridge.cjs');
const { createBrowserHandlers } = require('./lib/browser-actions.cjs');
const { RewardsHost } = require('./lib/rewards-host.cjs');
const { ChatHost } = require('./lib/chat-host.cjs');
const { ProfileStore } = require('./lib/profile-store.cjs');
const { AuthSession } = require('./lib/auth-session.cjs');
const { PlayerManager } = require('./lib/player-manager.cjs');
const { RecordingService } = require('./lib/recording-service.cjs');
const { DeskController, loadDeskProfile } = require('./lib/desk-controller.cjs');

app.setName('Chzzk Desk');
const profileDir = resolveProfilePath({
  defaultPath: app.getPath('userData'), explicitPath: process.env.DESK_DATA_DIR,
  platform: process.platform, localAppData: process.env.LOCALAPPDATA
});
fsSync.mkdirSync(profileDir, { recursive: true });
const physicalProfileDir = fsSync.realpathSync.native(profileDir);
app.setPath('userData', physicalProfileDir);
app.setPath('sessionData', physicalProfileDir);
if (!app.requestSingleInstanceLock()) app.exit(0);
const uiPath = path.join(__dirname, 'ui', 'index.html');
const uiUrl = pathToFileURL(uiPath).href;
const remotePartition = 'persist:chzzk-viewer';
let win, controller, authSession, browserBridge;
let quitReady = false, quitting = false;

function publish() {
  if (controller && win && !win.isDestroyed()) win.webContents.send('desk:state', controller.getState());
}
function notify(message, error = false) {
  if (win && !win.isDestroyed()) win.webContents.send('desk:notice', { message, error });
}
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  const store = new ProfileStore(dataDir);
  // Custom/test profiles remain self-contained; normal exports belong in Videos.
  const preferredClipsDir = process.env.DESK_DATA_DIR ? path.join(dataDir, 'clips') : path.join(app.getPath('videos'), 'Chzzk Desk');
  const profile = await loadDeskProfile({ store, dataDir, preferredClipsDir });
  let storageNotice = profile.notice;
  let ffmpegPath, ffmpegAvailable;
  try {
    ffmpegPath = app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe') : require('ffmpeg-static');
    await fs.access(ffmpegPath); ffmpegAvailable = true;
  }
  catch { ffmpegAvailable = false; }
  const bufferDir = path.join(dataDir, 'replay-buffer');
  await fs.mkdir(bufferDir, { recursive: true });
  // Only our own UUID session directories are disposable, including after a crash.
  for (const entry of await fs.readdir(bufferDir, { withFileTypes: true })) {
    if (entry.isDirectory() && /^replay-[0-3]-[a-f\d-]{36}$/.test(entry.name)) {
      const target = path.resolve(bufferDir, entry.name);
      if (path.dirname(target) === path.resolve(bufferDir)) await fs.rm(target, { recursive: true, force: true });
    }
  }
  const remoteSession = session.fromPartition(remotePartition);
  // CHZZK's standard-quality player rejects Electron's app token in the UA.
  remoteSession.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`);
  remoteSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'fullscreen'));
  remoteSession.setPermissionCheckHandler((_contents, permission) => permission === 'fullscreen');
  remoteSession.on('will-download', event => event.preventDefault());
  authSession = new AuthSession({ session: remoteSession, BrowserWindow, partition: remotePartition });
  const rewards = new RewardsHost({ enabled: profile.settings.rewardSettings.enabled, onChange: publish,
    fetchImpl: (url, options) => remoteSession.fetch(url, options) });
  const gateway = new MediaGateway({ fetchImpl: (url, options) => remoteSession.fetch(url, options) });
  await gateway.start();
  const replay = new ReplayBuffer({ ffmpegPath: ffmpegPath || 'ffmpeg', rootDir: bufferDir, clipsDir: profile.clipsDir });
  const recordings = new RecordingService({ replay, gateway, session: remoteSession, ffmpegAvailable, storageReady: profile.storageReady });
  win = new BrowserWindow({
    title: '치지직 데스크', width: 1500, height: 1000, minWidth: 1100, minHeight: 760,
    backgroundColor: '#101319', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const chat = new ChatHost({ context: slotId => controller?.autoClips.context(slotId),
    onBatch: batch => controller?.autoClips.submit(batch), onDetach: slotId => controller?.autoClips.reset(slotId) });
  const players = new PlayerManager({ window: win, WebContentsView, partition: remotePartition, rewards, chat });
  players.on('login-requested', () => authSession.open());
  players.on('external-requested', url => { shell.openExternal(url).catch(() => {}); });
  authSession.on('signed-in', () => players.reloadAll());
  controller = new DeskController({ profile, store, players, recordings, auth: authSession, version: app.getVersion(),
    browserAvailable: () => Boolean(browserBridge?.connectionCode),
    openExternal: url => shell.openExternal(url), openPath: target => shell.openPath(target), revealPath: target => shell.showItemInFolder(target) });
  controller.on('change', publish);
  controller.on('notice', notify);
  const actions = {
    ...controller.commands(),
    copyBrowserConnectionCode() {
      if (!browserBridge?.connectionCode) throw new Error('크롬 연결을 준비하지 못했습니다. 앱을 다시 열어 주세요.');
      clipboard.writeText(browserBridge.connectionCode);
    },
    resetBrowserConnection() {
      if (!browserBridge) throw new Error('크롬 연결이 준비되지 않았습니다.');
      browserBridge.rotateToken(); publish();
    }
  };
  if (!process.env.DESK_DISABLE_BROWSER_BRIDGE) {
    browserBridge = new BrowserBridge({ handlers: createBrowserHandlers({ actions, isQuitting: () => quitting }) });
    try { await browserBridge.start(); }
    catch {
      await browserBridge.close().catch(() => {}); browserBridge = null;
      storageNotice = [storageNotice, '크롬 연결을 준비하지 못했습니다. 앱을 다시 열어 주세요.'].filter(Boolean).join(' ');
    }
  }
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  for (const [method, handler] of Object.entries(actions)) ipcMain.handle(`desk:${method}`, async (event, arg) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== uiUrl) {
      return { ok: false, error: '허용되지 않은 요청입니다.' };
    }
    if (quitting) return { ok: false, error: '앱을 종료하고 있습니다.' };
    try { return { ok: true, value: await handler(arg) }; }
    catch (error) { return { ok: false, error: error.message || '요청을 처리하지 못했습니다.' }; }
  });
  win.webContents.on('did-finish-load', () => {
    controller.restorePlayers(); publish();
    if (storageNotice) { notify(storageNotice, true); storageNotice = null; }
  });
  win.once('ready-to-show', () => win.show());
  await win.loadFile(uiPath);
  void authSession.refresh();
  win.on('close', event => { if (!quitReady) { event.preventDefault(); app.quit(); } });
}).catch(error => { console.error('Desktop startup failed:', error.message); app.exit(1); });

app.on('before-quit', event => {
  if (quitReady) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  controller?.beginShutdown(); authSession?.close();
  (async () => {
    await browserBridge?.close();
    await controller?.shutdown();
  })().finally(() => { quitReady = true; app.quit(); });
});
app.on('window-all-closed', () => app.quit());
