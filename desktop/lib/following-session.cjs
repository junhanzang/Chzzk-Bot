'use strict';

const { FollowingService } = require('../../browser-extension/shared/following.js');

// App login lifetime controls the private account list. No nickname or cookie
// needs to enter this adapter; its injected fetch uses the existing app session.
class FollowingSession {
  constructor({ auth, fetchImpl, onChange = () => {}, timeoutMs, clock } = {}) {
    if (!auth || typeof auth.on !== 'function' || typeof auth.refresh !== 'function') throw new TypeError('앱 로그인 연결을 확인하세요.');
    if (typeof fetchImpl !== 'function') throw new TypeError('팔로우 조회 연결을 확인하세요.');
    this.auth = auth; this.closed = false; this.request = null;
    this.service = new FollowingService({ fetchImpl: (url, options) => fetchImpl(url, { ...options,
      headers: { ...options.headers, Referer: 'https://chzzk.naver.com/', Origin: 'https://chzzk.naver.com' }
    }), onChange, timeoutMs, clock });
    this.onAuthChange = () => {
      if (this.closed) return;
      const status = this.auth.state.status;
      if (status === 'signed_in') {
        if (!this.request) void this.service.refresh();
      } else this.service.clear(status === 'signed_out' ? 'signed_out' : status === 'error' ? 'error' : 'idle');
    };
    this.auth.on('change', this.onAuthChange);
    this.onAuthChange();
  }

  snapshot() { return this.service.snapshot(); }

  refresh() {
    if (this.closed) return Promise.resolve(this.snapshot());
    if (this.request) return this.request.promise;
    const request = { promise: null };
    this.request = request;
    request.promise = (async () => {
      try {
        await this.auth.refresh();
        if (this.closed || this.request !== request) return this.snapshot();
        if (this.auth.state.status === 'signed_in') return await this.service.refresh();
        return this.service.clear(this.auth.state.status === 'signed_out' ? 'signed_out' : 'error');
      } catch {
        if (!this.closed && this.request === request) return this.service.clear('error');
        return this.snapshot();
      } finally { if (this.request === request) this.request = null; }
    })();
    return request.promise;
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.request = null;
    this.auth.removeListener('change', this.onAuthChange);
    this.service.close();
  }
}

module.exports = { FollowingSession };
