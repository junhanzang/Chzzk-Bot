import { normalWindow } from './normal-window.js';

/** Owns managed-tab records, adoption, audio selection and the tab portion of the browser session. */
export class ManagedTabs {
  #slots;
  #audioSlot = null;
  #audioSlots = new Set();
  #audioEpochs;
  #soloEpoch = 0;
  #audioWrites = new Map();

  constructor({ chromeApi, model, storage, onOwnershipChange = async () => {} }) {
    this.chrome = chromeApi;
    this.model = model;
    this.storage = storage;
    this.onOwnershipChange = onOwnershipChange;
    this.#slots = model.SLOT_IDS.map(() => null);
    this.#audioEpochs = model.SLOT_IDS.map(() => 0);
  }

  restore(saved = {}) {
    this.#soloEpoch++;
    this.#slots = this.model.SLOT_IDS.map(slotId => {
      const value = saved.slots?.[slotId];
      if (!value) return null;
      try {
        return { channelId: this.model.parseChannel(value.channelId), title: this.model.cleanTitle(value.title),
          tabId: Number.isInteger(value.tabId) ? value.tabId : null, pageStatus: 'detached',
          createdByDesk: value.createdByDesk !== false, previousMuted: value.previousMuted === true };
      } catch { return null; }
    });
    const selected = Array.isArray(saved.audioSlots) ? saved.audioSlots : [saved.audioSlot];
    this.#audioSlots = new Set(selected.filter(slotId => this.model.SLOT_IDS.includes(slotId) && Number.isInteger(this.#slots[slotId]?.tabId)));
    this.#audioSlot = this.#audioSlots.has(saved.audioSlot) ? saved.audioSlot : [...this.#audioSlots].at(-1) ?? null;
  }

  get audioSlots() { return this.model.SLOT_IDS.filter(slotId => this.#audioSlots.has(slotId)); }
  get audioSlot() { return this.#audioSlot; }

  commitAudio(slotId, enabled) {
    if (enabled) {
      this.#audioSlots.delete(slotId); this.#audioSlots.add(slotId); this.#audioSlot = slotId;
    } else {
      this.#audioSlots.delete(slotId);
      if (this.#audioSlot === slotId) this.#audioSlot = [...this.#audioSlots].at(-1) ?? null;
    }
  }

  removeAudio(slotId) { this.#audioEpochs[slotId]++; this.commitAudio(slotId, false); }

  records() { return this.#slots.map(slot => slot ? { ...slot } : null); }
  slot(slotId) { const slot = this.#slots[slotId]; return slot ? { ...slot } : null; }
  channelId(slotId) { return this.#slots[slotId]?.channelId; }
  assignments() { return this.#slots.map(slot => slot?.channelId || null); }
  tabIds() { return this.#slots.filter(slot => Number.isInteger(slot?.tabId)).map(slot => slot.tabId); }
  contains(tabId) { return this.#slots.some(slot => slot?.tabId === tabId); }
  slotsForChannel(id) { return this.model.SLOT_IDS.filter(slotId => this.#slots[slotId]?.channelId === id); }
  firstEmpty() { return this.#slots.findIndex(slot => !slot?.channelId); }
  persist() { return this.storage.updateSession({ slots: this.records(), audioSlot: this.#audioSlot, audioSlots: [...this.#audioSlots] }); }

  matches(tab, channelId) {
    if (!tab || tab.incognito) return false;
    try {
      const url = new URL(tab.pendingUrl || tab.url || '');
      return url.origin === 'https://chzzk.naver.com' && !url.username && !url.password && this.model.parseChannel(url.href) === channelId;
    } catch { return false; }
  }

  async getTab(slotId) {
    const record = this.#slots[slotId];
    if (!Number.isInteger(record?.tabId)) return null;
    const tabId = record.tabId;
    try {
      const tab = await this.chrome.tabs.get(tabId);
      // An in-flight reward check may finish after a queued clear or replacement.
      if (this.#slots[slotId] !== record || record.tabId !== tabId) return null;
      if (this.matches(tab, record.channelId)) return tab;
    } catch { /* Closed or no longer accessible. */ }
    if (this.#slots[slotId] === record && record.tabId === tabId) {
      record.tabId = null;
      record.pageStatus = 'detached';
      this.removeAudio(slotId);
    }
    return null;
  }

  async resolveContext(tabId) {
    const slotId = this.#slots.findIndex(slot => slot?.tabId === tabId);
    if (slotId === -1) return null;
    const record = this.#slots[slotId];
    if (!await this.getTab(slotId) || this.#slots[slotId] !== record || record.tabId !== tabId) return null;
    return { slotId, tabId, channelId: record.channelId };
  }

  async inspect() {
    for (const slotId of this.model.SLOT_IDS) {
      const tab = await this.getTab(slotId);
      if (tab) {
        this.#slots[slotId].pageStatus = tab.status === 'loading' ? 'loading' : 'ready';
        // Service-worker restoration observes existing tab state; it must never
        // unmute a tab just because an old session said it was selected.
        if (tab.mutedInfo?.muted === true && this.#audioSlots.has(slotId)) this.removeAudio(slotId);
      }
    }
    await this.persist();
  }

  async prepareAssignments(assignments) {
    // Keep ownership attached to the actual tab when channels swap or move.
    // Every old record remains in a slot until replacements have been opened;
    // unused records are released by the caller only after a target tab exists.
    for (const slotId of this.model.SLOT_IDS) await this.getTab(slotId);
    const previous = this.#slots, remaining = previous.filter(Boolean);
    const next = this.model.SLOT_IDS.map(() => null);
    const take = (slotId, record) => {
      if (!record) return;
      next[slotId] = record;
      remaining.splice(remaining.indexOf(record), 1);
    };
    for (const slotId of this.model.SLOT_IDS) {
      if (assignments[slotId]) take(slotId, remaining.find(record => record.channelId === assignments[slotId]));
    }
    for (const slotId of this.model.SLOT_IDS) {
      if (!assignments[slotId] || next[slotId]) continue;
      const reusable = record => Number.isInteger(record.tabId) && record.createdByDesk !== false;
      take(slotId, remaining.find(record => record === previous[slotId] && reusable(record)) || remaining.find(reusable) ||
        remaining.find(record => record === previous[slotId]) || remaining[0]);
    }
    for (const slotId of this.model.SLOT_IDS) {
      if (!next[slotId]) take(slotId, remaining.find(record => record === previous[slotId]) || remaining[0]);
    }
    for (const slotId of this.model.SLOT_IDS) if (next[slotId] !== previous[slotId]) this.removeAudio(slotId);
    this.#slots = next;
    await this.persist();
    for (const slotId of this.model.SLOT_IDS) {
      if (!next[slotId] || next[slotId] === previous[slotId]) continue;
      const tab = await this.getTab(slotId);
      if (tab) {
        await this.chrome.tabs.update(tab.id, { muted: true });
        await this.onOwnershipChange(tab.id);
      }
    }
    await this.persist();
  }

  async open(slotId, channel) {
    this.model.validSlot(slotId);
    // Invalidate older requests, but retain the audible state if opening fails
    // before Chrome has actually muted/replaced the previous managed tab.
    this.#audioEpochs[slotId]++;
    const channelId = channel.id;
    const old = await this.getTab(slotId), oldSlot = this.#slots[slotId];
    let tab, createdByDesk = oldSlot?.createdByDesk !== false, previousMuted = oldSlot?.previousMuted === true;
    const candidates = old && oldSlot.channelId === channelId ? [] : await this.chrome.tabs.query({ url: 'https://chzzk.naver.com/live/*' });
    const existing = candidates.find(candidate => this.matches(candidate, channelId) &&
      !this.#slots.some((slot, index) => index !== slotId && slot?.tabId === candidate.id));
    if (existing) {
      if (old) await this.release(slotId);
      previousMuted = existing.mutedInfo?.muted === true;
      createdByDesk = false;
      tab = await this.chrome.tabs.update(existing.id, { muted: true, active: true });
    } else if (old && (oldSlot.channelId === channelId || oldSlot.createdByDesk !== false)) {
      tab = await this.chrome.tabs.update(old.id, { muted: true, active: true,
        ...(oldSlot.channelId === channelId ? {} : { url: `https://chzzk.naver.com/live/${channelId}` }) });
    } else {
      const window = await normalWindow(this.chrome);
      if (!window) throw new Error('일반 Chrome 창에서 방송을 열어 주세요.');
      if (old) await this.release(slotId);
      tab = await this.chrome.tabs.create({ url: 'about:blank', active: false, windowId: window.id });
      try { tab = await this.chrome.tabs.update(tab.id, { muted: true, url: `https://chzzk.naver.com/live/${channelId}`, active: true }); }
      catch (error) {
        try { const created = await this.chrome.tabs.get(tab.id); if (created.url === 'about:blank') await this.chrome.tabs.remove(tab.id); } catch {}
        throw error;
      }
      createdByDesk = true;
      previousMuted = false;
    }
    this.#slots[slotId] = { channelId, tabId: tab.id, title: channel.name, createdByDesk, previousMuted,
      pageStatus: tab.status === 'complete' ? 'ready' : 'loading' };
    this.removeAudio(slotId);
    await this.persist();
    await this.chrome.windows.update(tab.windowId, { focused: true });
    await this.onOwnershipChange(tab.id);
  }

  async release(slotId, { closeOwned = true } = {}) {
    this.model.validSlot(slotId);
    const record = this.#slots[slotId], tab = await this.getTab(slotId);
    if (this.#slots[slotId] !== record) return;
    this.#audioEpochs[slotId]++;
    if (tab) {
      if (record.createdByDesk !== false && closeOwned) await this.chrome.tabs.remove(tab.id);
      else await this.chrome.tabs.update(tab.id, { muted: record.createdByDesk !== false ? true : record.previousMuted === true });
    }
    if (this.#slots[slotId] === record) { this.#slots[slotId] = null; this.removeAudio(slotId); }
    await this.persist();
    if (tab) await this.onOwnershipChange(tab.id);
  }

  async reconcile(assignments) {
    for (const slotId of this.model.SLOT_IDS) {
      if (this.#slots[slotId] && this.channelId(slotId) !== assignments[slotId]) await this.release(slotId, { closeOwned: false });
    }
    await this.persist();
  }

  async focus(slotId) {
    const tab = await this.getTab(slotId);
    if (!tab) return false;
    await this.chrome.tabs.update(tab.id, { active: true });
    await this.chrome.windows.update(tab.windowId, { focused: true });
    return true;
  }

  async repairAudio(tabId) {
    const slotId = this.#slots.findIndex(record => record?.tabId === tabId);
    if (slotId === -1) return;
    const record = this.#slots[slotId], tab = await this.getTab(slotId);
    if (!tab || this.#slots[slotId] !== record || tab.id !== tabId) return;
    await this.chrome.tabs.update(tab.id, { muted: !this.#audioSlots.has(slotId) });
  }

  async audioWrite(tabId, action) {
    // Per-tab ordering keeps late Chrome update acknowledgements from reversing
    // a newer toggle. Different broadcasts still change independently.
    const previous = this.#audioWrites.get(tabId) || Promise.resolve();
    const operation = previous.catch(() => {}).then(action);
    this.#audioWrites.set(tabId, operation);
    try { return await operation; }
    finally { if (this.#audioWrites.get(tabId) === operation) this.#audioWrites.delete(tabId); }
  }

  async setAudioEnabled({ slotId, enabled } = {}) {
    this.model.validSlot(slotId);
    if (typeof enabled !== 'boolean') throw new Error('소리 설정이 올바르지 않습니다.');
    const epoch = ++this.#audioEpochs[slotId], solo = this.#soloEpoch, record = this.#slots[slotId];
    const current = () => this.#audioEpochs[slotId] === epoch && this.#soloEpoch === solo && this.#slots[slotId] === record;
    const tab = await this.getTab(slotId);
    if (!current()) return false;
    if (!tab) {
      if (enabled) throw new Error('방송 탭을 먼저 열어 주세요.');
      this.commitAudio(slotId, false); await this.persist(); return true;
    }
    try {
      return await this.audioWrite(tab.id, async () => {
        if (!current()) return false;
        await this.chrome.tabs.update(tab.id, { muted: !enabled });
        if (!current()) { await this.repairAudio(tab.id); return false; }
        this.commitAudio(slotId, enabled); return true;
      });
    } finally { await this.persist(); }
  }

  async selectAudio(slotId) {
    if (slotId !== null) this.model.validSlot(slotId);
    const solo = ++this.#soloEpoch;
    const epochs = this.#audioEpochs.map(epoch => epoch + 1); this.#audioEpochs = [...epochs];
    const records = [...this.#slots];
    const current = id => this.#soloEpoch === solo && this.#audioEpochs[id] === epochs[id] && this.#slots[id] === records[id];
    const selected = slotId === null ? null : await this.getTab(slotId);
    if (this.#soloEpoch !== solo || (slotId !== null && !current(slotId))) return false;
    if (slotId !== null && !selected) throw new Error('방송 탭을 먼저 열어 주세요.');
    try {
      // Mute first so a solo shortcut never temporarily adds another source.
      const order = this.model.SLOT_IDS.filter(id => id !== slotId);
      if (slotId !== null) order.push(slotId);
      for (const id of order) {
        if (!current(id)) continue;
        const tab = id === slotId ? selected : await this.getTab(id);
        if (!current(id)) continue;
        if (!tab) { this.commitAudio(id, false); continue; }
        await this.audioWrite(tab.id, async () => {
          if (!current(id)) return;
          await this.chrome.tabs.update(tab.id, { muted: id !== slotId });
          if (!current(id)) { await this.repairAudio(tab.id); return; }
          this.commitAudio(id, id === slotId);
        });
      }
      return true;
    } finally { await this.persist(); }
  }

  async targets() {
    return (await Promise.all(this.model.SLOT_IDS.map(async slotId => ({ slotId, tab: await this.getTab(slotId) })))).filter(item => item.tab);
  }

  snapshot(channels, assignments = this.assignments()) {
    return {
      slots: this.model.SLOT_IDS.map(slotId => {
        const channelId = assignments[slotId] || null, local = this.#slots[slotId];
        const ownsTab = local?.channelId === channelId && Number.isInteger(local?.tabId);
        return { slotId, channelId, title: channels.find(item => item.id === channelId)?.name || local?.title || '',
          ...(ownsTab ? { tabId: local.tabId } : {}), pageStatus: !channelId ? 'empty' : ownsTab ? local.pageStatus : 'detached' };
      }),
      audioSlots: this.audioSlots.filter(slotId => this.channelId(slotId) === assignments[slotId] && Number.isInteger(this.#slots[slotId]?.tabId)),
      audioSlot: this.#audioSlot !== null && this.channelId(this.#audioSlot) === assignments[this.#audioSlot] && Number.isInteger(this.#slots[this.#audioSlot]?.tabId) ? this.#audioSlot : null
    };
  }
}
