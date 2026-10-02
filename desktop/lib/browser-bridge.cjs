'use strict';

const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const RPC_METHODS = Object.freeze(['getState', 'addChannel', 'removeChannel', 'assignSlot', 'clearSlot',
  'setBuffer', 'saveClip', 'openClip', 'showClipsFolder', 'setLayout', 'setClipSeconds']);
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_COMMANDS = 8;

class BridgeUserError extends Error {
  constructor(message) { super(message); this.name = 'BridgeUserError'; }
}

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const finish = (error, value) => {
      clearTimeout(timer);
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('aborted', onAborted);
      if (error) { request.pause(); reject(error); } else resolve(value);
    };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) finish(new RequestError(413, '요청 데이터가 너무 큽니다.'));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new RequestError(400, '올바른 JSON 요청이 아닙니다.')); }
    };
    const onError = () => finish(new RequestError(400, '요청을 읽지 못했습니다.'));
    const onAborted = () => finish(new RequestError(400, '요청이 중단되었습니다.'));
    const timer = setTimeout(() => finish(new RequestError(408, '요청 시간이 초과되었습니다.')), timeoutMs);
    timer.unref();
    request.on('data', onData).once('end', onEnd).once('error', onError).once('aborted', onAborted);
  });
}

class BrowserBridge {
  #server;
  #token;
  #port = 0;
  #handlers = new Map();
  #sockets = new Set();
  #commands = new Set();
  #startPromise;
  #closePromise;
  #closing = false;
  #requestedPort;
  #bodyTimeoutMs;
  #drainTimeoutMs;

  constructor({ handlers = {}, port = 0, token, bodyTimeoutMs = 5000, drainTimeoutMs = 5000 } = {}) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('올바른 포트가 필요합니다.');
    if (token !== undefined && !/^[a-f\d]{48}$/.test(token)) throw new TypeError('연결 토큰 형식이 올바르지 않습니다.');
    if (![bodyTimeoutMs, drainTimeoutMs].every(value => Number.isInteger(value) && value > 0 && value <= 60000)) {
      throw new TypeError('올바른 제한 시간이 필요합니다.');
    }
    for (const method of RPC_METHODS) {
      if (Object.hasOwn(handlers, method) && typeof handlers[method] === 'function') this.#handlers.set(method, handlers[method]);
    }
    this.#requestedPort = port;
    this.#token = token || randomBytes(24).toString('hex');
    this.#bodyTimeoutMs = bodyTimeoutMs;
    this.#drainTimeoutMs = drainTimeoutMs;
  }

  get connectionCode() { return this.#port && !this.#closing ? `${this.#port}:${this.#token}` : null; }

  rotateToken() {
    if (this.#closing) throw new Error('브라우저 연결이 종료되었습니다.');
    this.#token = randomBytes(24).toString('hex');
    return this.connectionCode;
  }

  async start() {
    if (this.#closing) throw new Error('브라우저 연결이 종료되었습니다.');
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = (async () => {
      const server = this.#server = http.createServer({ maxHeaderSize: 8192 }, (request, response) => {
        this.#handle(request, response).catch(() => this.#send(response, 500, { ok: false, error: '요청을 처리하지 못했습니다.' }));
      });
      server.maxConnections = 16;
      server.maxRequestsPerSocket = 16;
      server.headersTimeout = 5000;
      server.requestTimeout = Math.max(5000, this.#bodyTimeoutMs);
      server.keepAliveTimeout = 1000;
      server.on('connection', socket => {
        this.#sockets.add(socket);
        socket.once('close', () => this.#sockets.delete(socket));
      });
      server.on('clientError', (_error, socket) => socket.destroy());
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: this.#requestedPort, exclusive: true }, () => {
          server.removeListener('error', reject);
          this.#port = server.address().port;
          resolve();
        });
      });
      return `${this.#port}:${this.#token}`;
    })();
    return this.#startPromise;
  }

  #authorized(request) {
    const match = /^Bearer ([a-f\d]{48})$/.exec(request.headers.authorization || '');
    return !!match && timingSafeEqual(Buffer.from(match[1]), Buffer.from(this.#token));
  }

  #send(response, status, value) {
    if (response.destroyed || response.writableEnded) return;
    const body = JSON.stringify(value);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
    response.end(body);
  }

  async #handle(request, response) {
    // Connection: close ends rejected uploads without resetting a just-written error
    // response. Resume discarded bytes so a paused body cannot retain the socket.
    response.once('finish', () => { if (!request.complete) request.resume(); });
    if (request.headers.host !== `127.0.0.1:${this.#port}`) {
      return this.#send(response, 403, { ok: false, error: '허용되지 않는 요청입니다.' });
    }
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !EXTENSION_ORIGIN.test(origin)) {
      return this.#send(response, 403, { ok: false, error: '허용되지 않는 요청입니다.' });
    }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    if (this.#closing) return this.#send(response, 503, { ok: false, error: '앱이 종료 중입니다.' });
    if (request.url === '/health' && request.method === 'GET') return this.#send(response, 200, { ok: true });
    if (request.url !== '/rpc') return this.#send(response, 404, { ok: false, error: '지원하지 않는 요청입니다.' });
    if (request.method === 'OPTIONS') {
      const headers = String(request.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(v => v.trim()).filter(Boolean);
      if (request.headers['access-control-request-method'] !== 'POST'
        || headers.some(name => !['authorization', 'content-type'].includes(name))) {
        return this.#send(response, 403, { ok: false, error: '허용되지 않는 요청입니다.' });
      }
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'authorization, content-type', 'Cache-Control': 'no-store', Connection: 'close' });
      response.end();
      return;
    }
    if (request.method !== 'POST') return this.#send(response, 405, { ok: false, error: 'POST 요청만 지원합니다.' });
    if (!this.#authorized(request)) return this.#send(response, 401, { ok: false, error: '연결 코드를 다시 확인해 주세요.' });
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')
      || (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) {
      return this.#send(response, 415, { ok: false, error: 'JSON 요청이 필요합니다.' });
    }
    if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
      return this.#send(response, 413, { ok: false, error: '요청 데이터가 너무 큽니다.' });
    }
    let body;
    try { body = await readBody(request, this.#bodyTimeoutMs); }
    catch (error) { return this.#send(response, error.status || 400, { ok: false, error: error.message }); }
    if (request.aborted || response.destroyed) return;
    if (this.#closing) return this.#send(response, 503, { ok: false, error: '앱이 종료 중입니다.' });
    // A token revoked while a slow request was uploading cannot start a command.
    if (!this.#authorized(request)) return this.#send(response, 401, { ok: false, error: '연결 코드를 다시 확인해 주세요.' });
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.method !== 'string' || !this.#handlers.has(body.method)) {
      return this.#send(response, 400, { ok: false, error: '지원하지 않는 명령입니다.' });
    }
    if (this.#commands.size >= MAX_COMMANDS) return this.#send(response, 429, { ok: false, error: '진행 중인 작업이 많습니다. 잠시 후 다시 시도해 주세요.' });
    const command = (async () => {
      try {
        const value = await this.#handlers.get(body.method)(body.arg);
        this.#send(response, 200, { ok: true, value: value ?? null });
      } catch (error) {
        const exposed = error instanceof BridgeUserError || error?.expose === true;
        const message = exposed && typeof error.message === 'string'
          ? error.message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240) : '요청을 처리하지 못했습니다.';
        this.#send(response, 500, { ok: false, error: message });
      }
    })();
    this.#commands.add(command);
    try { await command; } finally { this.#commands.delete(command); }
  }

  /** Stop accepting commands, allow active commands up to drainTimeoutMs, then close sockets.
   * A false drained result means a handler still runs; closing HTTP cannot cancel its work.
   */
  async close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      if (this.#startPromise) await this.#startPromise.catch(() => {});
      const server = this.#server;
      if (!server?.listening) return { drained: true };
      const closed = new Promise(resolve => server.close(resolve));
      let timer;
      const drained = await Promise.race([
        Promise.allSettled([...this.#commands]).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), this.#drainTimeoutMs); timer.unref(); })
      ]);
      clearTimeout(timer);
      // Closing also clears incomplete bodies and idle connections.
      for (const socket of this.#sockets) socket.destroy();
      await closed;
      return { drained };
    })();
    return this.#closePromise;
  }
}

module.exports = { BrowserBridge, BridgeUserError, RPC_METHODS };
