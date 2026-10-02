/** Owns managed-tab records, adoption, audio selection and the tab portion of the browser session. */
export class ManagedTabs {
  #slots;
  #audioSlot = null;

  constructor({ chromeApi, model, storage, onOwnershipChange = async () => {} }) {
    this.chrome = chromeApi;
    this.model = model;
    this.storage = storage;
    this.onOwnershipChange = onOwnershipChange;
    this.#slots = model.SLOT_IDS.map(() => null);
  }

  restore(saved = {}) {
    this.#slots = this.model.SLOT_IDS.map(slotId => {
      const value = saved.slots?.[slotId];
      if (!value) return null;
      try {
        return { channelId: this.model.parseChannel(value.channelId), title: this.model.cleanTitle(value.title),
          tabId: Number.isInteger(value.tabId) ? value.tabId : null, pageStatus: 'detached',
          createdByDesk: value.createdByDesk !== false, previousMuted: value.previousMuted === true };
      } catch { return null; }
    });
    this.#audioSlot = this.model.SLOT_IDS.includes(saved.audioSlot) ? saved.audioSlot : null;
  }

  records() { return this.#slots.map(slot => slot ? { ...slot } : null); }
  slot(slotId) { const slot = this.#slots[slotId]; return slot ? { ...slot } : null; }
  channelId(slotId) { return this.#slots[slotId]?.channelId; }
  assignments() { return this.#slots.map(slot => slot?.channelId || null); }
  tabIds() { return this.#slots.filter(slot => Number.isInteger(slot?.tabId)).map(slot => slot.tabId); }
  contains(tabId) { return this.#slots.some(slot => slot?.tabId === tabId); }
  slotsForChannel(id) { return this.model.SLOT_IDS.filter(slotId => this.#slots[slotId]?.channelId === id); }
  firstEmpty() { return this.#slots.findIndex(slot => !slot?.channelId); }
  persist() { return this.storage.updateSession({ slots: this.records(), audioSlot: this.#audioSlot }); }

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
      if (this.#audioSlot === slotId) this.#audioSlot = null;
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
      if (tab) this.#slots[slotId].pageStatus = tab.status === 'loading' ? 'loading' : 'ready';
    }
    await this.persist();
  }

  async open(slotId, channel) {
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
      if (old) await this.release(slotId);
      const window = await this.chrome.windows.getLastFocused();
      if (window.incognito) throw new Error('일반 Chrome 창에서 방송을 열어 주세요.');
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
    if (this.#audioSlot === slotId) this.#audioSlot = null;
    await this.persist();
    await this.chrome.windows.update(tab.windowId, { focused: true });
    await this.onOwnershipChange(tab.id);
  }

  async release(slotId, { closeOwned = true } = {}) {
    const tab = await this.getTab(slotId), record = this.#slots[slotId];
    if (tab) {
      if (record.createdByDesk !== false && closeOwned) await this.chrome.tabs.remove(tab.id);
      else await this.chrome.tabs.update(tab.id, { muted: record.createdByDesk !== false ? true : record.previousMuted === true });
    }
    this.#slots[slotId] = null;
    if (this.#audioSlot === slotId) this.#audioSlot = null;
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

  async selectAudio(slotId) {
    const selected = slotId === null ? null : await this.getTab(slotId);
    if (slotId !== null && !selected) throw new Error('방송 탭을 먼저 열어 주세요.');
    const tabs = await this.targets();
    for (const { tab } of tabs) await this.chrome.tabs.update(tab.id, { muted: true });
    if (selected) await this.chrome.tabs.update(selected.id, { muted: false });
    this.#audioSlot = slotId;
    await this.persist();
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
      audioSlot: this.#audioSlot !== null && this.channelId(this.#audioSlot) === assignments[this.#audioSlot] ? this.#audioSlot : null
    };
  }
}
