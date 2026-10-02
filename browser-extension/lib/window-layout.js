import '../shared/channels.js';

const { SLOT_IDS, LAYOUTS } = globalThis.DeskChannels;

/** Integer partitions avoid gaps and keep empty slots out of the arrangement. */
export function layoutBounds(layout, slotIds, mainSlot, area) {
  if (!LAYOUTS.includes(layout) || !Array.isArray(slotIds) || slotIds.some(id => !SLOT_IDS.includes(id)) || new Set(slotIds).size !== slotIds.length) {
    throw new Error('지원하지 않는 화면 배치입니다.');
  }
  const count = slotIds.length;
  if (!count) return [];
  const left = Math.round(area.left), top = Math.round(area.top), width = Math.round(area.width), height = Math.round(area.height);
  const rect = (slotId, x1, y1, x2, y2) => ({ slotId, left: left + Math.round(x1), top: top + Math.round(y1),
    width: Math.round(x2) - Math.round(x1), height: Math.round(y2) - Math.round(y1) });
  if (count === 1) return [rect(slotIds[0], 0, 0, width, height)];
  if (layout === 'focus') {
    const lead = slotIds.includes(mainSlot) ? mainSlot : slotIds[0];
    const rest = slotIds.filter(id => id !== lead), split = Math.round(width * 2 / 3);
    return [rect(lead, 0, 0, split, height), ...rest.map((id, index) => rect(id, split, height * index / rest.length, width, height * (index + 1) / rest.length))];
  }
  if (layout === 'grid') {
    const columns = Math.min(2, count), rows = Math.ceil(count / columns);
    return slotIds.map((id, index) => rect(id, width * (index % columns) / columns, height * Math.floor(index / columns) / rows,
      width * ((index % columns) + 1) / columns, height * (Math.floor(index / columns) + 1) / rows));
  }
  return slotIds.map((id, index) => layout === 'stacked'
    ? rect(id, 0, height * index / count, width, height * (index + 1) / count)
    : rect(id, width * index / count, 0, width * (index + 1) / count, height));
}

/** Owns only the windows it creates, with session metadata compatible with earlier releases. */
export class WindowLayout {
  constructor(chromeApi) {
    this.chrome = chromeApi;
    this.managedWindows = new Set();
    this.arrangementBounds = null;
  }

  restore(saved = {}) {
    this.managedWindows = new Set(Array.isArray(saved.managedWindows) ? saved.managedWindows.filter(Number.isInteger) : []);
    const bounds = saved.arrangementBounds;
    this.arrangementBounds = bounds && ['left', 'top', 'width', 'height'].every(key => Number.isFinite(bounds[key])) && bounds.width > 0 && bounds.height > 0
      ? { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height } : null;
  }

  serialize() { return { managedWindows: [...this.managedWindows], arrangementBounds: this.arrangementBounds }; }

  async arrange(tabs, { layout, mainSlot }, persist) {
    if (!tabs.length) throw new Error('방송 탭을 먼저 열어 주세요.');
    const current = await this.chrome.windows.getLastFocused();
    if (current.incognito || !Number.isFinite(current.width) || !Number.isFinite(current.height)) {
      throw new Error('일반 Chrome 창에서 다시 시도해 주세요.');
    }
    // Reuse the full pre-split rectangle; repeating an arrangement must not shrink it.
    if (!this.arrangementBounds || !this.managedWindows.has(current.id)) {
      this.arrangementBounds = { left: current.left || 0, top: current.top || 0, width: current.width, height: current.height };
    }
    const rectangles = layoutBounds(layout, tabs.map(item => item.slotId), mainSlot, this.arrangementBounds);
    const ordered = rectangles.map(rectangle => ({ rectangle, ...tabs.find(item => item.slotId === rectangle.slotId) }));
    let focusWindow = null;
    const focusSlot = tabs.some(item => item.slotId === mainSlot) ? mainSlot : tabs[0].slotId;
    for (const { slotId, tab, rectangle } of ordered) {
      const { slotId: ignored, ...bounds } = rectangle;
      // Another tab joining a Desk-created window makes whole-window resizing off-limits.
      const occupants = await this.chrome.tabs.query({ windowId: tab.windowId });
      let windowId;
      if (this.managedWindows.has(tab.windowId) && occupants.length === 1 && occupants[0].id === tab.id) {
        await this.chrome.windows.update(tab.windowId, { state: 'normal', ...bounds, focused: false });
        windowId = tab.windowId;
      } else {
        const created = await this.chrome.windows.create({ tabId: tab.id, type: 'normal', ...bounds, focused: false });
        windowId = created.id;
        this.managedWindows.add(windowId);
      }
      if (slotId === focusSlot) focusWindow = windowId;
      // Persist after every successful move, so a later failed move does not lose ownership.
      await persist();
    }
    if (focusWindow !== null) await this.chrome.windows.update(focusWindow, { focused: true });
  }
}
