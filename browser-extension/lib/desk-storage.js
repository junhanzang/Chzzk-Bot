const KEYS = { favorites: 'desk.favorites', pairing: 'desk.pairing', preferences: 'desk.preferences', session: 'desk.tabs' };

/** Owns local settings and serializes partial session writes under the existing storage keys. */
export class DeskStorage {
  #channels = [];
  #preferences = { layout: 'side-by-side', mainSlot: 0, clipSeconds: 30, autoRewards: false };
  #session = {};
  #sessionWrite = Promise.resolve();

  constructor({ chromeApi, model }) { this.storage = chromeApi.storage; this.model = model; }
  get channels() { return this.#channels.map(channel => ({ ...channel })); }
  get preferences() { return { ...this.#preferences }; }

  async load() {
    const [local, session] = await Promise.all([
      this.storage.local.get([KEYS.favorites, KEYS.pairing, KEYS.preferences]), this.storage.session.get(KEYS.session)
    ]);
    this.#channels = this.model.normalizeSettings({ channels: local[KEYS.favorites] }).channels;
    const raw = local[KEYS.preferences] || {};
    this.#preferences = { ...this.model.normalizeLayout(raw), clipSeconds: this.model.normalizeClipSeconds(raw.clipSeconds), autoRewards: raw.autoRewards === true };
    this.#session = session[KEYS.session] || {};
    return { pairing: local[KEYS.pairing], session: structuredClone(this.#session) };
  }

  async addChannel(channel) {
    if (this.#channels.some(item => item.id === channel.id)) throw new Error('이미 즐겨찾기에 있는 채널입니다. A–D 자리에서 열어 주세요.');
    if (this.#channels.length >= 100) throw new Error('즐겨찾기는 최대 100개까지 추가할 수 있어요.');
    await this.saveChannels([...this.#channels, channel]);
  }

  async removeChannel(id) { await this.saveChannels(this.#channels.filter(channel => channel.id !== id)); }

  async mergeChannels(channels) {
    const byId = new Map(this.#channels.map(channel => [channel.id, channel]));
    for (const channel of channels) byId.set(channel.id, channel);
    await this.saveChannels(this.model.normalizeSettings({ channels: [...byId.values()] }).channels);
  }

  async saveChannels(channels) {
    await this.storage.local.set({ [KEYS.favorites]: channels });
    this.#channels = channels.map(channel => ({ ...channel }));
  }

  async updatePreferences(patch) {
    const next = { ...this.#preferences, ...patch };
    await this.storage.local.set({ [KEYS.preferences]: next });
    this.#preferences = next;
  }

  async setPairing(pairing) {
    if (pairing) await this.storage.local.set({ [KEYS.pairing]: pairing });
    else await this.storage.local.remove(KEYS.pairing);
  }

  updateSession(patch) {
    this.#session = { ...this.#session, ...structuredClone(patch) };
    const value = structuredClone(this.#session);
    const operation = this.#sessionWrite.then(() => this.storage.session.set({ [KEYS.session]: value }));
    this.#sessionWrite = operation.catch(() => {});
    return operation;
  }
}
