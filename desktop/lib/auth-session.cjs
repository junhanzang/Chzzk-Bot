'use strict';

const { EventEmitter } = require('node:events');
const { cleanTitle } = require('./channels.cjs');
const TRUSTED_HOSTS = new Set(['chzzk.naver.com', 'nid.naver.com']);
const STATUS_URL = 'https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus';

function trustedRemote(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && TRUSTED_HOSTS.has(url.hostname) && !url.port && !url.username && !url.password;
  } catch { return false; }
}

// Session and login-window lifetime belong together. The shell decides how to
// react to 'signed-in'; it does not need to know the login navigation protocol.
class AuthSession extends EventEmitter {
  constructor({ session, BrowserWindow, partition, timeoutMs = 10000 }) {
    super();
    this.session = session;
    this.BrowserWindow = BrowserWindow;
    this.partition = partition;
    this.timeoutMs = timeoutMs;
    this.state = { status: 'checking', nickname: null };
    this.window = null;
    this.request = null;
    this.closed = false;
  }

  update(value) { this.state = value; this.emit('change', { ...value }); }

  refresh() {
    if (this.closed) return Promise.resolve({ ...this.state });
    if (this.request) return this.request.promise;
    const previous = this.state.status;
    const controller = new AbortController();
    const request = { controller, promise: null };
    this.request = request;
    this.update({ status: 'checking', nickname: null });
    let timer;
    const expiration = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Login check canceled')), { once: true });
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref?.();
    });
    request.promise = (async () => {
      try {
        const body = await Promise.race([(async () => {
          const response = await this.session.fetch(STATUS_URL, {
            credentials: 'include', cache: 'no-store', signal: controller.signal,
            headers: { Accept: 'application/json', Referer: 'https://chzzk.naver.com/', Origin: 'https://chzzk.naver.com' }
          });
          if (!response.ok) throw new Error('Login status unavailable');
          return response.json();
        })(), expiration]);
        if (this.closed || this.request !== request) return { ...this.state };
        if (typeof body.content?.loggedIn !== 'boolean') throw new Error('Login status unavailable');
        this.update(body.content.loggedIn ? { status: 'signed_in', nickname: cleanTitle(body.content.nickname, '') }
          : { status: 'signed_out', nickname: null });
        if (this.state.status === 'signed_in' && previous !== 'signed_in' && this.window && !this.window.isDestroyed()) {
          this.emit('notice', '네이버 로그인 완료. 방송과 구간 보관에 같은 로그인 세션을 사용합니다.', false);
          this.emit('signed-in');
          this.window.close();
        }
      } catch {
        if (!this.closed && this.request === request) this.update({ status: 'error', nickname: null });
      } finally {
        clearTimeout(timer);
        if (this.request === request) this.request = null;
      }
      return { ...this.state };
    })();
    return request.promise;
  }

  open() {
    if (this.closed) return;
    if (this.window && !this.window.isDestroyed()) { this.window.focus(); return; }
    const window = new this.BrowserWindow({ title: '치지직 로그인', width: 1080, height: 800, backgroundColor: '#101319',
      webPreferences: { partition: this.partition, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    this.window = window;
    const contents = window.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (!this.closed && this.window === window && trustedRemote(url)) contents.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    for (const name of ['will-navigate', 'will-redirect']) contents.on(name, (event, url) => {
      if (!trustedRemote(url)) {
        event.preventDefault();
        this.emit('notice', '이 로그인 단계는 현재 앱에서 지원되지 않습니다. 로그인 창에서 이전 단계로 돌아가 주세요.', true);
      }
    });
    const checkReturn = url => {
      if (!this.closed && this.window === window && trustedRemote(url) && new URL(url).hostname === 'chzzk.naver.com') void this.refresh();
    };
    contents.on('did-navigate', (_event, url) => checkReturn(url));
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) checkReturn(url); });
    window.on('closed', () => {
      if (this.window === window) this.window = null;
      if (!this.closed) void this.refresh();
    });
    const target = this.state.status === 'signed_in' ? 'https://chzzk.naver.com/'
      : 'https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fchzzk.naver.com%2F';
    contents.loadURL(target).catch(() => { if (!this.closed) this.emit('notice', '네이버 로그인 페이지를 열지 못했습니다. 다시 시도해 주세요.', true); });
  }

  close() {
    this.closed = true;
    this.request?.controller.abort();
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null;
  }
}

module.exports = { AuthSession, trustedRemote };
