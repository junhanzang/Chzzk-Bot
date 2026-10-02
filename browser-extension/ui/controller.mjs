import { createEventScope } from '../shared/ui/dom.mjs';
import { slotIds } from '../shared/ui/model.mjs';
import { initialState } from './state.mjs';

// Owns remote snapshots, serialized commands, visibility polling, and revision
// guards. Views have no Chrome runtime access and no refresh timers.
export function createPanelController({ sendMessage, document, onNotice, timers = globalThis }) {
  let state = initialState(), pending = false, revision = 0, refreshPromise = null;
  let timer = null, seenNoticeAt = null, disposed = false, started = false;
  const listeners = new Set(), events = createEventScope();
  const snapshot = () => ({ state, pending });
  function publish() { if (!disposed) { const value = snapshot(); for (const listener of listeners) listener(value); } }
  async function send(method, arg) {
    const response = await sendMessage({ target: 'desk', method, arg });
    if (!response?.ok) throw new Error(typeof response?.error === 'string' ? response.error : '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.');
    return response.value;
  }
  function accept(next) {
    if (disposed) return;
    if (!next || !Array.isArray(next.channels) || !Array.isArray(next.slots)) throw new Error('확장 프로그램 상태를 읽지 못했어요.');
    state = { ...state, ...next,
      channels: next.channels.filter(item => item && typeof item.id === 'string'),
      slots: next.slots.filter(item => item && slotIds.includes(Number(item.slotId))),
      clips: Array.isArray(next.clips) ? next.clips.filter(item => item && typeof item.id === 'string') : [],
      savingSlots: Array.isArray(next.savingSlots) ? next.savingSlots : [],
      connection: next.connection || { status: 'standalone' }, auth: next.auth || { status: 'unknown' }
    };
    publish();
    if (typeof next.notice?.message === 'string' && Number.isFinite(next.notice.at) && next.notice.at !== seenNoticeAt) {
      seenNoticeAt = next.notice.at;
      onNotice(next.notice.message, next.notice.error === true);
    }
  }
  async function refresh(force = false) {
    if (disposed || (!force && (document.hidden || pending))) return;
    if (refreshPromise) { await refreshPromise; if (!force || disposed) return; }
    const current = revision;
    const request = (async () => {
      try { const next = await send('getState'); if (!disposed && current === revision) accept(next); }
      catch (error) { if (!disposed && current === revision) onNotice(error.message || '확장 프로그램과 연결하지 못했어요.', true); }
    })();
    refreshPromise = request;
    await request;
    if (refreshPromise === request) refreshPromise = null;
  }
  async function execute(method, arg, success) {
    if (pending || disposed) return false;
    pending = true;
    revision++;
    publish();
    let succeeded = false;
    try {
      await send(method, arg);
      succeeded = true;
      if (success && !disposed) onNotice(success);
    } catch (error) { if (!disposed) onNotice(error.message || '요청을 처리하지 못했어요.', true); }
    finally { await refresh(true); pending = false; publish(); }
    return !disposed && succeeded;
  }
  function schedule() {
    timers.clearInterval(timer);
    timer = null;
    if (!document.hidden && !disposed) { void refresh(); timer = timers.setInterval(() => refresh(), 2000); }
  }
  return {
    execute, refresh, snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    start() { if (!started && !disposed) { started = true; events.on(document, 'visibilitychange', schedule); schedule(); } },
    dispose() { disposed = true; revision++; timers.clearInterval(timer); timer = null; events.dispose(); listeners.clear(); }
  };
}
