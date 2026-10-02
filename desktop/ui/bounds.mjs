import { createEventScope } from '../../browser-extension/shared/ui/dom.mjs';
import { errorMessage } from '../../browser-extension/shared/ui/model.mjs';

export function clippedSurfaceBounds(rect, workspace, viewport, slotId, hidden = false) {
  const x = Math.max(rect.left + 1, workspace.left, 0);
  const y = Math.max(rect.top + 1, workspace.top, 0);
  const right = Math.min(rect.right - 1, workspace.right, viewport.width);
  const bottom = Math.min(rect.bottom - 1, workspace.bottom, viewport.height);
  return { slotId, x: Math.round(x), y: Math.round(y), width: hidden ? 0 : Math.max(0, Math.round(right - x)), height: hidden ? 0 : Math.max(0, Math.round(bottom - y)) };
}

// The bounds reporter owns observation, RAF coalescing, and IPC deduplication.
export function createPlayerBounds({ document, window, cards, sendBounds, onError }) {
  const workspaceNode = document.querySelector('.workspace');
  const grid = document.querySelector('.players-grid');
  const surfaces = cards.map(card => ({ card, surface: card.querySelector('[data-role="surface"]') }));
  const events = createEventScope();
  let frame = null, lastBounds = '', slots = [], disposed = false;
  function request() {
    if (disposed || frame !== null) return;
    frame = window.requestAnimationFrame(async () => {
      frame = null;
      if (disposed) return;
      const workspace = workspaceNode.getBoundingClientRect();
      // Scrolling the shelf must not alter the stage's unscrolled height.
      const gridTop = grid.getBoundingClientRect().top + workspaceNode.scrollTop;
      const padding = Number.parseFloat(window.getComputedStyle(workspaceNode).paddingBottom) || 0;
      const height = `${Math.max(0, Math.floor(workspace.bottom - gridTop - padding))}px`;
      if (grid.style.getPropertyValue('--stage-height') !== height) grid.style.setProperty('--stage-height', height);
      if (!sendBounds) return;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const bounds = surfaces.map(({ card, surface }, slotId) => clippedSurfaceBounds(surface.getBoundingClientRect(), workspace, viewport, slotId, card.hidden));
      const key = JSON.stringify({ bounds, slots });
      if (key === lastBounds) return;
      lastBounds = key;
      try { await sendBounds(bounds); }
      catch (error) { if (!disposed) onError(`플레이어 위치를 맞추지 못했어요: ${errorMessage(error)}`, true); }
    });
  }
  const observer = new window.ResizeObserver(request);
  for (const { surface } of surfaces) observer.observe(surface);
  events.on(window, 'resize', request);
  events.on(document, 'scroll', request, true);
  return {
    request,
    update(nextSlots) { slots = nextSlots.map(slot => [slot.slotId, slot.channelId, slot.pageStatus]); request(); },
    dispose() {
      disposed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      observer.disconnect();
      events.dispose();
    }
  };
}
