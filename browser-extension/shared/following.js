'use strict';

// Fixed read-only CHZZK following endpoint; no cookies, platform APIs or storage.
// Sources and observed response fields: shared/FOLLOWING-SOURCES.md.
((root, factory) => {
  const model = factory();
  root.DeskFollowing = model;
  if (typeof module === 'object' && module.exports) module.exports = model;
})(globalThis, () => {
  const ENDPOINT = 'https://api.chzzk.naver.com/service/v1/channels/followings';
  const PAGE_SIZE = 100, MAX_PAGES = 20, MAX_CHANNELS = PAGE_SIZE * MAX_PAGES;
  const MAX_BODY_BYTES = 1024 * 1024;
  const CHANNEL_ID = /^[a-f\d]{32}$/i;
  const MESSAGES = Object.freeze({
    idle: '로그인하면 팔로우한 채널을 불러와요.',
    loading: '팔로우한 채널을 불러오는 중이에요.',
    signed_out: '치지직에 로그인한 뒤 팔로우 목록을 새로고침해 주세요.',
    error: '팔로우 목록을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.',
    timeout: '팔로우 목록 조회 시간이 초과됐어요. 다시 시도해 주세요.',
    invalid: '팔로우 목록 응답을 확인하지 못했어요. 다시 시도하거나 앱 업데이트를 확인해 주세요.',
    limit: '팔로우 목록이 조회 한도를 넘었어요. 일부 목록을 전체 목록으로 표시하지 않았어요.',
    rate_limit: '팔로우 목록 요청이 많아요. 잠시 뒤 다시 시도해 주세요.'
  });

  class FollowingError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  const failure = code => { throw new FollowingError(code); };
  const text = (value, limit) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, limit) : '';

  function parseChannel(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return failure('invalid');
    const channel = row.channel;
    const id = channel?.channelId || row.channelId;
    if (typeof id !== 'string' || !CHANNEL_ID.test(id)) return failure('invalid');
    if (row.channelId && channel?.channelId && row.channelId.toLowerCase?.() !== channel.channelId.toLowerCase()) return failure('invalid');
    const name = text(channel?.channelName, 100);
    if (!name) return failure('invalid');
    // Following rows expose streamer.openLive; newer channel models can carry
    // openLive themselves. Missing status is not silently called "offline".
    const live = typeof row.streamer?.openLive === 'boolean' ? row.streamer.openLive : channel?.openLive;
    if (typeof live !== 'boolean') return failure('invalid');
    const title = text(row.liveInfo?.liveTitle, 200);
    return { id: id.toLowerCase(), name, live, ...(title && live ? { title } : {}) };
  }

  function parseFollowingPage(payload, requestedPage) {
    if (payload?.code === 401 || payload?.code === 403) return failure('signed_out');
    if (payload?.code === 429) return failure('rate_limit');
    if (payload?.code !== 200 || !payload.content || typeof payload.content !== 'object') return failure('invalid');
    const { followingList, totalPage } = payload.content;
    if (!Array.isArray(followingList) || followingList.length > PAGE_SIZE || !Number.isInteger(totalPage) || totalPage < 0) return failure('invalid');
    if (totalPage > MAX_PAGES) return failure('limit');
    if ((totalPage === 0 && followingList.length) || requestedPage >= Math.max(1, totalPage)
        || (!followingList.length && requestedPage + 1 < totalPage)) return failure('invalid');
    return { totalPages: Math.max(1, totalPage), channels: followingList.map(parseChannel) };
  }

  async function readBody(response) {
    const declared = response.headers?.get?.('content-length');
    if (declared && Number(declared) > MAX_BODY_BYTES) return failure('limit');
    if (response.body?.getReader) {
      const reader = response.body.getReader(), chunks = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_BODY_BYTES) { void reader.cancel().catch(() => {}); return failure('limit'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    // Fallback supports fetch-compatible injected transports without a stream.
    const body = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return failure('limit');
    return JSON.parse(body);
  }

  class FollowingService {
    constructor({ fetchImpl, onChange = () => {}, timeoutMs = 10000, clock = Date.now } = {}) {
      if (typeof fetchImpl !== 'function' || typeof onChange !== 'function' || typeof clock !== 'function') throw new TypeError('팔로우 조회 연결을 확인하세요.');
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) throw new RangeError('조회 제한시간을 확인하세요.');
      this.fetchImpl = fetchImpl; this.onChange = onChange; this.timeoutMs = timeoutMs; this.clock = clock;
      this.generation = 0; this.request = null; this.closed = false;
      this.state = { status: 'idle', channels: [], message: MESSAGES.idle, updatedAt: null };
    }

    snapshot() { return { ...this.state, channels: this.state.channels.map(channel => ({ ...channel })) }; }
    publish() { if (!this.closed) { try { this.onChange(this.snapshot()); } catch { /* Observers never own request lifecycle. */ } } }

    clear(status = 'idle') {
      if (!['idle', 'signed_out', 'error'].includes(status)) throw new TypeError('팔로우 상태를 확인하세요.');
      this.generation++;
      const previous = this.request; this.request = null;
      previous?.controller.abort();
      this.state = { status, channels: [], message: MESSAGES[status], updatedAt: null };
      this.publish();
      return this.snapshot();
    }

    refresh() {
      if (this.closed) return Promise.resolve(this.snapshot());
      if (this.request) return this.request.promise;
      const controller = new AbortController(), generation = ++this.generation;
      const request = { controller, promise: null };
      this.request = request;
      this.state = { status: 'loading', channels: [], message: MESSAGES.loading, updatedAt: null };
      let timer, timedOut = false;
      const expiration = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new FollowingError(timedOut ? 'timeout' : 'cancelled')), { once: true });
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
        timer.unref?.();
      });
      const load = async () => {
        const channels = new Map(); let pages = 1;
        for (let page = 0; page < pages; page++) {
          if (controller.signal.aborted) return failure('cancelled');
          const response = await this.fetchImpl(`${ENDPOINT}?page=${page}&size=${PAGE_SIZE}&sortType=FOLLOW`, {
            method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
            headers: { Accept: 'application/json' }, signal: controller.signal
          });
          if (response.status === 401 || response.status === 403) return failure('signed_out');
          if (response.status === 429) return failure('rate_limit');
          if (!response.ok || response.status !== 200) return failure('error');
          const parsed = parseFollowingPage(await readBody(response), page);
          if (controller.signal.aborted) return failure('cancelled');
          if (page && parsed.totalPages !== pages) return failure('invalid');
          pages = parsed.totalPages;
          const before = channels.size;
          for (const channel of parsed.channels) channels.set(channel.id, channel);
          if (channels.size > MAX_CHANNELS) return failure('limit');
          if (page && parsed.channels.length && before === channels.size) return failure('invalid');
        }
        return [...channels.values()];
      };
      request.promise = Promise.race([Promise.resolve().then(load), expiration]).then(channels => {
        if (this.closed || this.request !== request || this.generation !== generation) return this.snapshot();
        this.state = { status: 'ready', channels, message: channels.length ? '' : '팔로우한 채널이 아직 없어요.', updatedAt: this.clock() };
        this.publish(); return this.snapshot();
      }).catch(error => {
        if (this.closed || this.request !== request || this.generation !== generation) return this.snapshot();
        const code = error instanceof FollowingError ? error.code : 'error';
        this.state = { status: code === 'signed_out' ? 'signed_out' : 'error', channels: [],
          message: MESSAGES[code] || MESSAGES.error, updatedAt: null };
        this.publish(); return this.snapshot();
      }).finally(() => {
        clearTimeout(timer);
        if (this.request === request) this.request = null;
      });
      this.publish();
      return request.promise;
    }

    close() { this.closed = true; this.clear(); }
  }

  return Object.freeze({ FollowingService, parseFollowingPage, ENDPOINT, PAGE_SIZE, MAX_PAGES, MAX_CHANNELS });
});
