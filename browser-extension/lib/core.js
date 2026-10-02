import '../shared/channels.js';
import { DesktopConnection, idleReplay, blankRemote, sanitizeClipPage } from './desktop-connection.js';
import { DeskStorage } from './desk-storage.js';
import { ManagedTabs } from './managed-tabs.js';
import { RewardService } from './reward-service.js';
import { ChatService } from './chat-service.js';
import { WindowLayout } from './window-layout.js';
import { WatchWorkspace } from './watch-workspace.js';

export { parsePairCode } from './desktop-connection.js';
export { layoutBounds } from './window-layout.js';

const CLIP_METHODS = new Set(['setBuffer', 'saveClip', 'openClip', 'showClipsFolder', 'showClipInFolder', 'updateClip']);
const ALL_METHODS = new Set(['getState', 'pair', 'disconnect', 'addChannel', 'removeChannel', 'assignSlot', 'clearSlot',
  'selectAudio', 'focusSlot', 'arrangeWindows', 'setLayout', 'setAutoRewards', 'setClipSeconds', 'setAutoClipSettings',
  'renameChannel', 'setChannelPinned', 'saveWatchPreset', 'applyWatchPreset', 'removeWatchPreset', 'setAllBuffers', 'queryClips', ...CLIP_METHODS]);

export function panelSenderAllowed(sender, chromeApi) {
  return sender?.id === chromeApi.runtime.id && sender.url === chromeApi.runtime.getURL('panel.html') && !sender.tab?.incognito;
}

/** Composes services and orders commands; each platform service owns its state and side effects. */
export class DeskController {
  constructor({ chromeApi, model = globalThis.DeskChannels, fetchImpl = globalThis.fetch, timeoutMs = 5000, actionTimeoutMs = 65000 }) {
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.storage = new DeskStorage({ chromeApi, model });
    this.desktop = new DesktopConnection({ model, storage: this.storage, timeoutMs, actionTimeoutMs,
      fetchImpl: (...args) => this.fetchImpl(...args) });
    this.tabs = new ManagedTabs({ chromeApi, model, storage: this.storage,
      onOwnershipChange: async tabId => { this.rewards.forget(tabId);
        await Promise.all([this.rewards.notifyConfig(tabId), this.chat.notifyConfig(tabId)]); } });
    this.rewards = new RewardService({ chromeApi, model, timeoutMs, fetchImpl: (...args) => this.fetchImpl(...args),
      enabled: () => this.storage.preferences.autoRewards,
      resolveTab: async tabId => {
        const context = await this.tabs.resolveContext(tabId);
        return context && (!this.desktop.paired || this.desktop.remote.slots[context.slotId].channelId === context.channelId) ? context : null;
      } });
    this.chat = new ChatService({ chromeApi, model, resolveTab: tabId => this.tabs.resolveContext(tabId),
      readRemote: () => this.desktop.paired && this.desktop.status.status === 'connected' ? this.desktop.remote : null,
      submit: batch => this.desktop.request('submitChatBatch', batch) });
    this.chatRefreshAt = 0;
    this.windows = new WindowLayout(chromeApi);
    this.watch = new WatchWorkspace({ model, storage: this.storage, desktop: this.desktop, tabs: this.tabs,
      linkedMutation: (method, arg) => this.linkedMutation(method, arg) });
    this.lastNotice = null;
    this.queue = Promise.resolve();
    this.initializing = null;
    this.stateRequest = null;
  }

  async initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const saved = await this.storage.load();
      await this.desktop.restore(saved);
      this.tabs.restore(saved.session);
      this.windows.restore(saved.session);
      await this.storage.updateSession({ remote: this.desktop.remote, ...this.windows.serialize() });
      await this.tabs.inspect();
    })();
    return this.initializing;
  }

  enqueue(operation) {
    const promise = this.queue.then(async () => { await this.initialize(); return operation(); });
    this.queue = promise.catch(() => {});
    return promise;
  }

  handle(method, arg) {
    if (!ALL_METHODS.has(method)) return Promise.reject(new Error('지원하지 않는 요청입니다.'));
    if (method === 'getState' && this.stateRequest) return this.stateRequest;
    const promise = this.enqueue(() => this.perform(method, arg));
    if (method === 'getState') {
      this.stateRequest = promise;
      promise.finally(() => { if (this.stateRequest === promise) this.stateRequest = null; }).catch(() => {});
    }
    return promise;
  }

  // Public transport contract is also used by headless desktop/FFmpeg integration checks.
  rpc(method, arg, pairing) { return this.desktop.request(method, arg, pairing); }

  channels() { return this.desktop.paired ? this.desktop.remote.channels : this.storage.channels; }
  assignments() { return this.desktop.paired ? this.desktop.remote.slots.map(slot => slot.channelId) : this.tabs.assignments(); }

  ensureUniqueSlot(slotId, channelId) {
    if (this.assignments().some((id, index) => index !== slotId && id === channelId)) {
      throw new Error('이미 다른 자리에 열린 방송입니다. 같은 방송을 두 번 열면 고화질 시청이 제한될 수 있어요.');
    }
  }

  async openAssignedChannel(slotId, channelId) {
    const channel = this.channels().find(item => item.id === channelId);
    if (!channel) throw new Error('즐겨찾기에 없는 채널입니다.');
    this.ensureUniqueSlot(slotId, channelId);
    await this.tabs.open(slotId, channel);
  }

  async notifyChangedAssignments(previous) {
    const remote = this.desktop.remote;
    await Promise.all(this.tabs.records().filter((slot, index) => Number.isInteger(slot?.tabId) && previous[index] !== remote.slots[index].channelId)
      .map(slot => this.rewards.notifyConfig(slot.tabId)));
  }

  async refreshRemote({ reconcile = true } = {}) {
    const previous = this.desktop.remote.slots.map(slot => slot.channelId);
    await this.desktop.refresh();
    if (reconcile) await this.tabs.reconcile(this.assignments());
    await this.notifyChangedAssignments(previous);
    await this.chat.notifyAll(this.tabs.tabIds());
  }

  async linkedMutation(method, arg) {
    const previous = this.desktop.remote.slots.map(slot => slot.channelId);
    const result = await this.desktop.mutate(method, arg);
    // Controlled commands retain old tab ownership until the command releases or reassigns it.
    await this.notifyChangedAssignments(previous);
    await this.chat.notifyAll(this.tabs.tabIds());
    return result;
  }

  async handleRewardMessage(message, sender) {
    await this.initialize();
    return this.rewards.handleMessage(message, sender);
  }

  async handleChatMessage(message, sender) {
    await this.initialize();
    if (message?.method === 'getContext') {
      if (!await this.chat.managedSender(sender)) return null;
      // The panel can be closed. Coalesce context refreshes across all four tabs;
      // chat batches themselves never fetch or persist another remote snapshot.
      return this.enqueue(async () => {
        if (this.desktop.paired && Date.now() - this.chatRefreshAt >= 5000) {
          this.chatRefreshAt = Date.now();
          await this.desktop.refresh().catch(() => {});
        }
        return this.chat.handleMessage(message, sender);
      });
    }
    return this.chat.handleMessage(message, sender);
  }

  snapshot() {
    const linked = this.desktop.paired, base = linked ? this.desktop.remote : blankRemote();
    const preferences = this.storage.preferences, channels = linked ? base.channels : this.storage.channels;
    const view = this.tabs.snapshot(channels, linked ? base.slots.map(slot => slot.channelId) : this.tabs.assignments());
    return {
      channels, slots: view.slots.map(slot => ({ ...slot,
        playbackMode: linked ? base.slots[slot.slotId].playbackMode : 'browser',
        replay: linked ? base.slots[slot.slotId].replay : idleReplay() })),
      audioSlot: view.audioSlot, clips: base.clips, savingSlots: base.savingSlots,
      watchPresets: this.watch.presets, clipRevision: base.clipRevision, clipTotal: base.clipTotal, actionSummary: null,
      ffmpegAvailable: linked && this.desktop.status.status === 'connected' && base.ffmpegAvailable,
      layout: linked ? base.layout : preferences.layout, mainSlot: linked ? base.mainSlot : preferences.mainSlot,
      clipSeconds: linked ? base.clipSeconds : preferences.clipSeconds,
      autoClipSettings: base.autoClipSettings, autoClips: base.autoClips,
      rewardSettings: { enabled: preferences.autoRewards },
      rewards: view.slots.map(slot => this.rewards.stateFor(slot.slotId, slot.channelId, slot.tabId)),
      connection: this.desktop.status, auth: base.auth, ...(this.lastNotice ? { notice: this.lastNotice } : {})
    };
  }

  async perform(method, arg) {
    if (method === 'queryClips') {
      if (!this.desktop.paired) throw new Error('클립 보관함은 데스크톱 앱을 연결하면 사용할 수 있어요.');
      return sanitizeClipPage(await this.desktop.request(method, arg), this.model);
    }
    if (method === 'setAllBuffers') return this.setAllBuffers(arg);
    if (method === 'getState') {
      if (this.desktop.paired) await this.refreshRemote().catch(() => {});
      await this.tabs.inspect();
      return this.snapshot();
    }
    if (method === 'pair') {
      await this.desktop.pair(arg);
      // Pairing does not open Chrome tabs, replace desktop players or start recording.
      await this.tabs.inspect();
      await this.rewards.notifyAll(this.tabs.tabIds());
      await this.chat.notifyAll(this.tabs.tabIds());
      return this.snapshot();
    }
    if (method === 'disconnect') {
      if (this.desktop.paired) {
        const { layout, mainSlot, clipSeconds, channels } = this.desktop.remote;
        await this.storage.updatePreferences({ layout, mainSlot, clipSeconds });
        await this.storage.mergeChannels(channels);
      }
      await this.desktop.disconnect();
      await this.chat.notifyAll(this.tabs.tabIds());
      await this.tabs.persist();
      return this.snapshot();
    }
    if (method === 'addChannel') {
      const channelId = this.model.parseChannel(arg?.input), name = this.model.cleanTitle(arg?.name, `채널 ${channelId.slice(0, 6)}`);
      if (this.desktop.paired) {
        await this.linkedMutation('addChannel', { input: channelId, name });
        const target = this.desktop.remote.slots.find(slot => slot.channelId === channelId && !this.tabs.slot(slot.slotId)?.tabId);
        if (target) await this.openAssignedChannel(target.slotId, channelId);
      } else {
        await this.storage.addChannel({ id: channelId, name });
        const slotId = this.tabs.firstEmpty();
        if (slotId !== -1) await this.openAssignedChannel(slotId, channelId);
      }
    } else if (method === 'renameChannel' || method === 'setChannelPinned') {
      // Shared validation is also used by the desktop command.
      this.model.updateChannel(this.channels(), method, arg);
      if (this.desktop.paired) await this.linkedMutation(method, arg);
      else await this.storage.changeChannel(method, arg);
    } else if (method === 'saveWatchPreset') {
      await this.watch.save(arg);
    } else if (method === 'removeWatchPreset') {
      await this.watch.remove(arg);
    } else if (method === 'applyWatchPreset') {
      await this.watch.apply(arg);
      const preferences = this.desktop.paired ? this.desktop.remote : this.storage.preferences;
      await this.windows.arrange(await this.tabs.targets(), preferences, () => this.storage.updateSession(this.windows.serialize()));
    } else if (method === 'removeChannel') {
      const id = this.model.parseChannel(arg), affected = this.tabs.slotsForChannel(id);
      if (this.desktop.paired) await this.linkedMutation('removeChannel', id);
      else await this.storage.removeChannel(id);
      for (const slotId of affected) await this.tabs.release(slotId);
    } else if (method === 'assignSlot') {
      const slotId = this.model.validSlot(arg?.slotId), channelId = this.model.parseChannel(arg?.channelId);
      if (this.desktop.paired) await this.refreshRemote();
      this.ensureUniqueSlot(slotId, channelId);
      if (this.desktop.paired) await this.linkedMutation('assignSlot', { slotId, channelId, playbackMode: 'browser' });
      await this.openAssignedChannel(slotId, channelId);
    } else if (method === 'clearSlot') {
      const slotId = this.model.validSlot(arg);
      if (this.desktop.paired) await this.linkedMutation('clearSlot', slotId);
      await this.tabs.release(slotId);
    } else if (method === 'focusSlot') {
      const slotId = this.model.validSlot(arg);
      if (this.desktop.paired) await this.refreshRemote();
      const channelId = this.assignments()[slotId];
      if (!channelId) throw new Error('먼저 이 자리에 방송을 지정해 주세요.');
      this.ensureUniqueSlot(slotId, channelId);
      if (this.desktop.paired && this.desktop.remote.slots[slotId].playbackMode !== 'browser') {
        await this.linkedMutation('assignSlot', { slotId, channelId, playbackMode: 'browser' });
      }
      if (!await this.tabs.focus(slotId)) await this.openAssignedChannel(slotId, channelId);
    } else if (method === 'selectAudio') {
      if (arg !== null) this.model.validSlot(arg);
      if (arg !== null && this.desktop.paired && this.tabs.channelId(arg) !== this.desktop.remote.slots[arg].channelId) {
        throw new Error('방송 배치가 달라졌어요. 들을 방송을 A–D 자리에 다시 지정해 주세요.');
      }
      await this.tabs.selectAudio(arg);
    } else if (method === 'setAutoRewards') {
      if (typeof arg !== 'boolean') throw new Error('잘못된 자동 수령 설정입니다.');
      await this.storage.updatePreferences({ autoRewards: arg });
      await this.rewards.notifyAll(this.tabs.tabIds());
    } else if (method === 'setClipSeconds') {
      const seconds = this.model.validClipSeconds(arg);
      if (this.desktop.paired) await this.linkedMutation('setClipSeconds', seconds);
      else await this.storage.updatePreferences({ clipSeconds: seconds });
    } else if (method === 'setAutoClipSettings') {
      if (!this.desktop.paired) throw new Error('자동 클립은 데스크톱 앱을 연결하면 사용할 수 있어요.');
      const channelId = this.model.parseChannel(arg?.channelId);
      if (!this.channels().some(channel => channel.id === channelId)) throw new Error('즐겨찾기에 없는 채널입니다.');
      // Keep user input intact for the desktop command's strict validation.
      // The shared normalizer is for restored state, not silently shortening commands.
      await this.linkedMutation('setAutoClipSettings', { channelId, enabled: arg.enabled,
        keywords: arg.keywords, chatSpike: arg.chatSpike });
    } else if (method === 'setLayout') {
      if (!this.model.LAYOUTS.includes(arg?.layout)) throw new Error('지원하지 않는 화면 배치입니다.');
      const preferences = { layout: arg.layout, mainSlot: this.model.validSlot(arg?.mainSlot) };
      if (this.desktop.paired) await this.linkedMutation('setLayout', preferences);
      else await this.storage.updatePreferences(preferences);
    } else if (method === 'arrangeWindows') {
      const { layout, mainSlot } = this.desktop.paired ? this.desktop.remote : this.storage.preferences;
      await this.windows.arrange(await this.tabs.targets(), { layout, mainSlot }, () => this.storage.updateSession(this.windows.serialize()));
    } else if (CLIP_METHODS.has(method)) {
      return this.performClip(method, arg);
    }
    await this.tabs.inspect();
    return this.snapshot();
  }

  async performClip(method, arg) {
    if (!this.desktop.paired) throw new Error('최근 구간 보관과 클립은 데스크톱 앱을 연결하면 사용할 수 있어요.');
    if (method === 'setBuffer' || method === 'saveClip') {
      const slotId = this.model.validSlot(arg?.slotId);
      if (method === 'setBuffer' && typeof arg?.enabled !== 'boolean') throw new Error('잘못된 보관 설정입니다.');
      if (method === 'saveClip' && arg?.seconds !== undefined) this.model.validClipSeconds(arg.seconds);
      await this.refreshRemote({ reconcile: false });
      const state = this.desktop.remote;
      if (method === 'saveClip') arg = { ...arg, seconds: arg.seconds ?? state.clipSeconds };
      const managed = this.tabs.slot(slotId), remote = state.slots[slotId];
      const requiresLiveTab = method === 'setBuffer' && arg.enabled === true;
      if ((requiresLiveTab && !await this.tabs.getTab(slotId)) || !managed || managed.channelId !== remote.channelId || remote.playbackMode !== 'browser') {
        throw new Error('앱과 Chrome의 방송 배치가 달라졌어요. 즐겨찾기에서 A–D 자리에 방송을 다시 지정해 주세요.');
      }
      if (method === 'saveClip' && remote.replay.bufferedSeconds < 4) throw new Error('완료된 영상 구간이 4초 이상 모인 뒤 저장해 주세요.');
      arg = { ...arg, channelId: managed.channelId };
    }
    const result = await this.linkedMutation(method, arg);
    return method === 'updateClip' ? this.snapshot() : result;
  }

  async setAllBuffers(arg) {
    if (!this.desktop.paired) throw new Error('구간 보관은 데스크톱 앱을 연결하면 사용할 수 있어요.');
    if (typeof arg?.enabled !== 'boolean') throw new Error('보관 설정이 올바르지 않습니다.');
    await this.refreshRemote({ reconcile: false });
    const targets = this.desktop.remote.slots.filter(slot => slot.channelId && slot.playbackMode === 'browser');
    if (!targets.length) throw new Error('Chrome에서 보관할 방송을 먼저 열어 주세요.');
    const slots = [], failures = [];
    for (const { slotId, channelId } of targets) {
      if (arg.enabled && (!await this.tabs.getTab(slotId) || this.tabs.channelId(slotId) !== channelId)) {
        failures.push({ slotId, message: 'Chrome 방송 탭을 먼저 열어 주세요.' });
      } else slots.push({ slotId, channelId });
    }
    let summary = { succeeded: 0, failures: [] };
    if (slots.length) {
      const response = await this.linkedMutation('setAllBuffers', { enabled: arg.enabled, slots });
      if (response?.actionSummary) summary = response.actionSummary;
    }
    return { ...this.snapshot(), actionSummary: { succeeded: summary.succeeded,
      failures: [...failures, ...summary.failures].sort((a, b) => a.slotId - b.slotId) } };
  }

  onTabChanged(tabId) { return this.enqueue(async () => { if (this.tabs.contains(tabId)) await this.tabs.inspect(); }); }
  recordNotice(error) {
    return this.enqueue(async () => { this.lastNotice = { message: error?.message || '요청을 처리하지 못했어요.', error: true, at: Date.now() }; });
  }
}
