import '../shared/channels.js';

const { SLOT_IDS, LAYOUTS, CLIP_DURATIONS } = globalThis.DeskChannels;
const AUTH_STATES = new Set(['checking', 'signed_in', 'signed_out', 'error']);

export function parsePairCode(code) {
  if (typeof code !== 'string') throw new Error('앱에서 복사한 연결 코드를 입력해 주세요.');
  const match = /^(\d{1,5}):([a-f\d]{48})$/i.exec(code.trim());
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error('연결 코드 형식이 올바르지 않습니다. 앱에서 다시 복사해 주세요.');
  return { port: Number(match[1]), token: match[2].toLowerCase() };
}

export function idleReplay() { return { state: 'idle', bufferedSeconds: 0 }; }

export function blankRemote() {
  return { channels: [], slots: SLOT_IDS.map(slotId => ({ slotId, channelId: null, replay: idleReplay() })),
    layout: 'side-by-side', mainSlot: 0, clipSeconds: 30,
    clips: [], savingSlots: [], ffmpegAvailable: false, auth: { status: 'signed_out' } };
}

/** Pick only the fields the extension needs; desktop auth details and secrets stay private. */
export function sanitizeRemote(value, model) {
  if (!value || !Array.isArray(value.channels) || !Array.isArray(value.slots)) throw new Error('앱 응답 형식이 올바르지 않습니다.');
  const channels = model.normalizeSettings({ channels: value.channels }).channels;
  return {
    channels,
    slots: SLOT_IDS.map(slotId => {
      const source = value.slots.find(slot => slot?.slotId === slotId) || {};
      const channelId = channels.some(channel => channel.id === source.channelId) ? source.channelId : null;
      const replay = source.replay || {};
      return { slotId, channelId, title: model.cleanTitle(source.title), playbackMode: source.playbackMode,
        replay: { state: typeof replay.state === 'string' ? replay.state.slice(0, 30) : 'idle',
          bufferedSeconds: Math.max(0, Number(replay.bufferedSeconds) || 0),
          ...(typeof replay.error === 'string' ? { error: replay.error.slice(0, 500) } : {}) } };
    }),
    clips: (Array.isArray(value.clips) ? value.clips : []).filter(item => item && typeof item.id === 'string').slice(0, 1000).map(item => ({
      id: item.id, fileName: typeof item.fileName === 'string' ? item.fileName : '', title: model.cleanTitle(item.title),
      channelId: typeof item.channelId === 'string' ? item.channelId : '', createdAt: item.createdAt,
      duration: Number(item.duration) || 0
    })),
    savingSlots: (Array.isArray(value.savingSlots) ? value.savingSlots : []).filter(id => SLOT_IDS.includes(id)),
    layout: LAYOUTS.includes(value.layout) ? value.layout : 'side-by-side',
    mainSlot: SLOT_IDS.includes(value.mainSlot) ? value.mainSlot : 0,
    clipSeconds: CLIP_DURATIONS.includes(value.clipSeconds) ? value.clipSeconds : 30,
    ffmpegAvailable: value.ffmpegAvailable === true,
    auth: { status: AUTH_STATES.has(value.auth?.status) ? value.auth.status : 'signed_out' }
  };
}

/** Loopback RPC is separate from Chrome-session reward GETs. It never forwards browser credentials. */
export async function requestDesktop({ pairing, fetchImpl, timeoutMs, actionTimeoutMs }, method, arg) {
  if (!pairing) throw new Error('최근 구간 보관과 클립은 데스크톱 앱을 연결하면 사용할 수 있어요.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), method === 'getState' ? timeoutMs : actionTimeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${pairing.port}/rpc`, {
      method: 'POST', headers: { Authorization: `Bearer ${pairing.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, arg }), signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error'
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? '연결 코드가 만료되었어요. 앱에서 새 코드를 복사해 주세요.'
      : typeof result?.error === 'string' ? result.error.slice(0, 500) : '데스크톱 앱이 요청을 처리하지 못했어요.');
    if (!result || result.ok !== true) throw new Error(typeof result?.error === 'string' ? result.error.slice(0, 500) : '앱 요청에 실패했어요.');
    return result.value;
  } catch (error) {
    if (error?.name === 'AbortError' || error instanceof TypeError) throw new Error('데스크톱 앱에 연결하지 못했어요. 앱 실행 상태와 연결 코드를 확인해 주세요.');
    throw error;
  } finally { clearTimeout(timer); }
}

/** Owns pairing and the last desktop snapshot; it never opens or modifies a Chrome tab. */
export class DesktopConnection {
  #pairing = null;
  #remote = blankRemote();
  #status = { status: 'standalone' };

  constructor({ model, storage, fetchImpl, timeoutMs, actionTimeoutMs }) {
    this.model = model;
    this.storage = storage;
    this.transport = { fetchImpl, timeoutMs, actionTimeoutMs };
  }

  get paired() { return Boolean(this.#pairing); }
  get remote() { return structuredClone(this.#remote); }
  get status() { return { ...this.#status }; }

  async restore({ pairing, session }) {
    if (pairing) {
      try { this.#pairing = parsePairCode(`${pairing.port}:${pairing.token}`); }
      catch { await this.storage.setPairing(null); }
    }
    if (session?.remote) this.#remote = sanitizeRemote(session.remote, this.model);
    this.#status = this.paired ? { status: 'unavailable', message: '데스크톱 앱 연결을 확인하고 있어요.' } : { status: 'standalone' };
  }

  request(method, arg, pairing = this.#pairing) { return requestDesktop({ ...this.transport, pairing }, method, arg); }

  async pair(code) {
    const pairing = parsePairCode(code);
    const remote = sanitizeRemote(await this.request('getState', undefined, pairing), this.model);
    await this.storage.setPairing(pairing);
    this.#pairing = pairing;
    this.#remote = remote;
    this.#status = { status: 'connected' };
    await this.storage.updateSession({ remote });
  }

  async disconnect() {
    await this.storage.setPairing(null);
    this.#pairing = null;
    this.#remote = blankRemote();
    this.#status = { status: 'standalone' };
    await this.storage.updateSession({ remote: this.#remote });
  }

  async refresh() {
    try {
      this.#remote = sanitizeRemote(await this.request('getState'), this.model);
      this.#status = { status: 'connected' };
      await this.storage.updateSession({ remote: this.#remote });
      return this.remote;
    } catch (error) {
      this.#status = { status: 'unavailable', message: error.message };
      throw error;
    }
  }

  async mutate(method, arg) {
    try {
      const result = await this.request(method, arg);
      await this.refresh();
      return result;
    } catch (error) {
      this.#status = { status: 'unavailable', message: error.message };
      throw error;
    }
  }
}
