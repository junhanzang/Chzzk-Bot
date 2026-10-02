import { initialState } from './state.mjs';
import { errorMessage } from '../../browser-extension/shared/ui/model.mjs';

// Owns app state, command exclusion, bridge subscriptions, and their lifetime.
// Views receive snapshots and an explicit command function, never the bridge.
export function createDesktopController({ bridge, onNotice, onClearNotice }) {
  const preview = !bridge;
  let state = initialState(), initialized = false, disposed = false, started = false;
  const pending = new Set(), pendingSaves = new Set(), listeners = new Set();
  const unsubscriptions = [];
  const snapshot = () => ({ state, initialized, preview, pending: new Set(pending), pendingSaves: new Set(pendingSaves) });
  function publish() { if (!disposed) { const value = snapshot(); for (const listener of listeners) listener(value); } }
  function accept(next) {
    if (disposed || !next || !Array.isArray(next.slots)) return;
    state = { ...state, ...next, channels: next.channels || [], clips: next.clips || [], savingSlots: next.savingSlots || [] };
    initialized = true;
    publish();
  }
  async function execute(key, method, argument, successMessage) {
    if (disposed) return false;
    if (preview) { onNotice('UI 미리보기입니다. 실제 방송과 클립 기능은 데스크톱 앱에서 사용할 수 있어요.'); return false; }
    if (pending.has(key)) return false;
    pending.add(key);
    if (method === 'saveClip') pendingSaves.add(argument.slotId);
    publish();
    try {
      const result = argument === undefined ? await bridge[method]() : await bridge[method](argument);
      if (result && result.error) throw new Error(typeof result.error === 'string' ? result.error : '요청을 처리하지 못했어요.');
      if (result && Array.isArray(result.slots) && Array.isArray(result.channels)) accept(result);
      else if (!disposed) accept(await bridge.getState());
      if (!disposed) { if (successMessage) onNotice(successMessage); else onClearNotice(); }
      return !disposed;
    } catch (error) {
      if (!disposed) onNotice(errorMessage(error), true);
      return false;
    } finally {
      pending.delete(key);
      if (method === 'saveClip') pendingSaves.delete(argument.slotId);
      publish();
    }
  }
  function start() {
    if (started || disposed) return;
    started = true;
    if (preview) { onNotice('UI 미리보기입니다. 채널 연결·로그인·녹화는 데스크톱 앱에서 사용할 수 있어요.'); return; }
    unsubscriptions.push(bridge.onState(accept));
    if (typeof bridge.onNotice === 'function') unsubscriptions.push(bridge.onNotice(value => {
      if (!disposed && value && typeof value.message === 'string') onNotice(value.message, Boolean(value.error));
    }));
    bridge.getState().then(accept).catch(error => { if (!disposed) onNotice(`앱 상태를 불러오지 못했어요: ${errorMessage(error)}`, true); });
  }
  return {
    execute, start, snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    dispose() {
      disposed = true;
      for (const unsubscribe of unsubscriptions.splice(0)) if (typeof unsubscribe === 'function') unsubscribe();
      listeners.clear();
    }
  };
}
