'use strict';

const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const RESOURCE_TTL_MS = 180000;
const MAX_RESOURCES = 2000;
const MAX_PLAYLIST_BYTES = 1024 * 1024;
const TRUSTED_ORIGIN = 'https://chzzk.naver.com';
const opaqueId = () => randomBytes(24).toString('hex');

function resourceExtension(url) {
  const pathname = new URL(url).pathname;
  if (/\/aes_key$/.test(pathname)) return '.key';
  return /\.(?:m3u8|ts|m4s|m4v|mp4|aac|mp3|ac3|ec3|vtt|webvtt)$/i.exec(pathname)?.[0].toLowerCase() || '.bin';
}

function validateUpstream(value, base) {
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x20\x7f]/.test(value)) {
    throw new Error('허용되지 않는 미디어 주소입니다.');
  }
  let url;
  try { url = new URL(value, base); } catch { throw new Error('허용되지 않는 미디어 주소입니다.'); }
  const mediaHost = url.hostname === 'pstatic.net' || url.hostname.endsWith('.pstatic.net');
  const keyEndpoint = url.hostname === 'api.chzzk.naver.com'
    && /^\/service\/v1\/encryption\/lives\/[0-9]+\/aes_key$/.test(url.pathname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || (!mediaHost && !keyEndpoint)) {
    throw new Error('허용되지 않는 미디어 주소입니다.');
  }
  return url.href;
}

function validateReferer(value) {
  if (typeof value !== 'string' || !/^https:\/\/chzzk\.naver\.com\/live\/[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('방송 페이지 주소가 올바르지 않습니다.');
  }
  return value;
}

function abortError() { return new Error('미디어 요청이 중단되었습니다.'); }

function abortable(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function discardBody(response) {
  try { await response?.body?.cancel(); } catch { /* Already consumed or cancelled. */ }
}

async function readPlaylist(response, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_PLAYLIST_BYTES) { await discardBody(response); throw new Error('재생 목록이 너무 큽니다.'); }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) { complete = true; break; }
      length += value.byteLength;
      if (length > MAX_PLAYLIST_BYTES) throw new Error('재생 목록이 너무 큽니다.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

class MediaGateway {
  constructor({ fetchImpl, requestTimeoutMs = 20000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('로그인 세션의 미디어 요청 함수가 필요합니다.');
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error('요청 제한 시간이 올바르지 않습니다.');
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this._leases = new Map();
    this._server = null;
    this._starting = null;
    this._closing = false;
    this._closePromise = null;
    this._baseUrl = null;
  }

  start() {
    if (this._closing) return Promise.reject(new Error('미디어 연결이 종료되었습니다.'));
    if (this._starting) return this._starting;
    this._starting = new Promise((resolve, reject) => {
      this._server = http.createServer((request, response) => {
        this._handle(request, response).catch(() => this._error(response, 502));
      });
      this._server.requestTimeout = this.requestTimeoutMs + 1000;
      this._server.headersTimeout = Math.min(this.requestTimeoutMs, 10000);
      this._server.on('error', () => reject(new Error('로컬 미디어 연결을 시작하지 못했습니다.')));
      this._server.listen(0, '127.0.0.1', () => {
        this._baseUrl = `http://127.0.0.1:${this._server.address().port}`;
        resolve(this._baseUrl);
      });
    });
    return this._starting;
  }

  createStream(upstreamUrl, { referer } = {}) {
    if (this._closing || !this._server?.listening) throw new Error('로컬 미디어 연결을 먼저 시작해 주세요.');
    const url = validateUpstream(upstreamUrl);
    const lease = { token: opaqueId(), referer: validateReferer(referer), resources: new Map(), byUrl: new Map(), controllers: new Set(), closed: false };
    this._leases.set(lease.token, lease);
    const rootUrl = this._mapResource(lease, url, true);
    return { url: rootUrl, close: () => this._closeLease(lease) };
  }

  _prune(lease) {
    const cutoff = Date.now() - RESOURCE_TTL_MS;
    for (const [id, resource] of lease.resources) {
      if (!resource.pinned && !resource.active && resource.touchedAt < cutoff) {
        lease.resources.delete(id);
        lease.byUrl.delete(resource.url);
      }
    }
  }

  _mapResource(lease, upstreamUrl, pinned = false) {
    const url = validateUpstream(upstreamUrl);
    const existing = lease.byUrl.get(url);
    if (existing) {
      const resource = lease.resources.get(existing);
      resource.touchedAt = Date.now();
      return `${this._baseUrl}/${lease.token}/${existing}${resource.extension}`;
    }
    this._prune(lease);
    if (lease.resources.size >= MAX_RESOURCES) throw new Error('재생 목록의 항목 제한에 도달했습니다.');
    const id = opaqueId();
    const extension = resourceExtension(url);
    lease.resources.set(id, { url, extension, pinned, active: 0, touchedAt: Date.now() });
    lease.byUrl.set(url, id);
    return `${this._baseUrl}/${lease.token}/${id}${extension}`;
  }

  _rewrite(lease, text, playlistUrl) {
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('재생 목록 형식이 올바르지 않습니다.');
    const map = uri => this._mapResource(lease, validateUpstream(uri, playlistUrl));
    return text.split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (!trimmed.startsWith('#')) return map(trimmed);
      return line.replace(/(\bURI\s*=\s*")([^"]*)(")/g, (_match, start, uri, end) => `${start}${map(uri)}${end}`);
    }).join('\n');
  }

  _headers(response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
  }

  _error(response, status) {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) { response.destroy(); return; }
    this._headers(response);
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('미디어 요청을 처리하지 못했습니다.');
  }

  async _fetch(lease, url, method, range, signal) {
    for (let redirects = 0; ; redirects++) {
      url = validateUpstream(url);
      // Cross-origin requests use an origin-only Referer, matching Chromium's
      // default strict-origin-when-cross-origin policy used by session.fetch.
      // This is a main-process network request. Injecting an Origin would turn
      // it into a CORS request; credentialed requests to the public CDN fail.
      const headers = { Referer: `${TRUSTED_ORIGIN}/` };
      if (range) headers.Range = range;
      const pending = Promise.resolve().then(() => this.fetchImpl(url, {
        method, credentials: 'include', redirect: 'manual', cache: 'no-store', headers, signal,
      }));
      // A fetch implementation that resolves late after cancellation must not leave a body open.
      pending.then(response => { if (signal.aborted) discardBody(response); }, () => {});
      const response = await abortable(pending, signal);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await discardBody(response);
        if (!location || redirects >= 3) throw new Error('미디어 이동 요청을 처리하지 못했습니다.');
        url = validateUpstream(location, url);
        continue;
      }
      return { response, url };
    }
  }

  async _handle(request, response) {
    this._headers(response);
    if (this._closing) return this._error(response, 503);
    if (!['GET', 'HEAD'].includes(request.method)) return this._error(response, 405);
    if (request.headers.host !== this._baseUrl.slice('http://'.length)) return this._error(response, 403);
    if (request.headers.origin && request.headers.origin !== this._baseUrl) return this._error(response, 403);
    const match = /^\/([a-f0-9]{48})\/([a-f0-9]{48})(\.[a-z0-9]+)$/.exec(request.url);
    if (!match) return this._error(response, 404);
    const lease = this._leases.get(match[1]);
    if (!lease || lease.closed) return this._error(response, 404);
    this._prune(lease);
    const resource = lease.resources.get(match[2]);
    if (!resource || resource.extension !== match[3]) return this._error(response, 404);
    const range = request.headers.range;
    if (range && (typeof range !== 'string' || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) return this._error(response, 400);
    resource.active++;
    resource.touchedAt = Date.now();
    const controller = new AbortController();
    lease.controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.requestTimeoutMs);
    timer.unref?.();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    request.once('aborted', cancel);
    response.once('close', cancel);
    try {
      // FFmpeg can ask for bytes=0- even on a playlist. Rewriting requires the
      // complete document, so only binary resources forward Range upstream.
      const upstreamRange = resource.extension === '.m3u8' ? undefined : range;
      const { response: upstream, url } = await this._fetch(lease, resource.url, request.method, upstreamRange, controller.signal);
      if (upstream.status < 200 || upstream.status >= 300) {
        await discardBody(upstream);
        return this._error(response, upstream.status);
      }
      if (request.method === 'HEAD') {
        this._copyBinaryHeaders(upstream, response);
        response.writeHead(upstream.status);
        response.end();
        await discardBody(upstream);
        return;
      }
      const type = upstream.headers.get('content-type') || '';
      const playlist = /(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(type) || /\.m3u8$/i.test(new URL(url).pathname);
      if (playlist) {
        if (upstream.status === 206) { await discardBody(upstream); throw new Error('부분 재생 목록은 지원하지 않습니다.'); }
        const text = await readPlaylist(upstream, controller.signal);
        if (lease.closed || controller.signal.aborted) throw abortError();
        const rewritten = Buffer.from(this._rewrite(lease, text, url));
        response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8', 'Content-Length': rewritten.length });
        response.end(rewritten);
      } else {
        this._copyBinaryHeaders(upstream, response);
        response.writeHead(upstream.status);
        if (!upstream.body) response.end();
        else await pipeline(Readable.fromWeb(upstream.body), response, { signal: controller.signal });
      }
    } catch {
      this._error(response, timedOut ? 504 : lease.closed ? 503 : 502);
    } finally {
      clearTimeout(timer);
      request.removeListener('aborted', cancel);
      response.removeListener('close', cancel);
      resource.active--;
      lease.controllers.delete(controller);
    }
  }

  _copyBinaryHeaders(upstream, response) {
    for (const name of ['content-type', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(name);
      if (value) response.setHeader(name, value);
    }
    // Fetch may decompress the body; a compressed Content-Length would be incorrect.
    const length = upstream.headers.get('content-length');
    if (length && !upstream.headers.get('content-encoding')) response.setHeader('content-length', length);
  }

  _closeLease(lease) {
    if (lease.closed) return;
    lease.closed = true;
    this._leases.delete(lease.token);
    for (const controller of lease.controllers) controller.abort();
    lease.resources.clear();
    lease.byUrl.clear();
  }

  close() {
    if (this._closePromise) return this._closePromise;
    this._closing = true;
    for (const lease of this._leases.values()) this._closeLease(lease);
    this._closePromise = (async () => {
      if (!this._server) return;
      await this._starting.catch(() => {});
      if (!this._server.listening) return;
      await new Promise(resolve => {
        this._server.close(resolve);
        this._server.closeAllConnections();
      });
      this._baseUrl = null;
    })();
    return this._closePromise;
  }
}

module.exports = { MediaGateway, validateUpstream, validateReferer };
