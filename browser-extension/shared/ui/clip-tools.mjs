import { createDom, createEventScope, setText } from './dom.mjs';
import { presentation } from './model.mjs';
import { autoClipBadge } from './auto-clips.mjs';

const FILTERS = [['all', '전체'], ['starred', '즐겨찾기'], ['manual', '직접 저장'], ['auto', '자동 저장'], ['keyword', '키워드 감지'], ['chat-spike', '채팅 급증']];
export function localClipQuery(clips, options, channels = []) {
  const { query = '', filter = 'all', sort = 'newest', offset = 0, limit = 50 } = options;
  const items = presentation.filterClips(clips, query, channels).filter(clip => {
    const automatic = ['keyword', 'chat-spike'].includes(clip.trigger);
    return filter === 'all' || (filter === 'starred' && clip.favorite) || (filter === 'manual' && !automatic) ||
      (filter === 'auto' && automatic) || clip.trigger === filter;
  });
  if (sort === 'oldest') items.sort((a, b) => {
    const left = Date.parse(a.createdAt), right = Date.parse(b.createdAt);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.isFinite(left) ? -1 : Number.isFinite(right) ? 1 : 0;
    return left - right;
  });
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
}

// Both shells provide only commands and a read-only query. This component owns
// request lifetimes, drafts and pagination, including cancellation on disconnect.
export function createClipTools({ document, list, search, count, empty, noResults, queryClips, run, timers = globalThis, rowTag = 'div' }) {
  const { element, actionButton } = createDom(document), events = createEventScope();
  const tools = element('div', 'clip-tools');
  function select(className, label, values) {
    const result = element('select', className); result.setAttribute('aria-label', label);
    for (const [value, text] of values) { const option = element('option', '', text); option.value = value; result.append(option); }
    result.value = values[0][0]; tools.append(result); return result;
  }
  const filter = select('clip-filter', '클립 종류', FILTERS);
  const sort = select('clip-sort', '클립 정렬', [['newest', '최신순'], ['oldest', '오래된순']]);
  const status = element('p', 'clip-results-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const more = actionButton('clip-load-more', '더 보기', 'more');
  function insertAfter(anchor, node) { if (anchor.insertAdjacentElement) anchor.insertAdjacentElement('afterend', node); else anchor.parentElement?.append(node); }
  insertAfter(search, tools); insertAfter(list, status); insertAfter(status, more);
  let state = { clips: [], channels: [], available: false, pending: false }, page = { items: [], total: 0 };
  let wanted = 50, epoch = 0, debounce, disposed = false, loading = false, error = '', lastRequest = '', lastRows = '', draft;
  const working = new Set();
  const options = () => ({ query: search.value.slice(0, 200), filter: filter.value, sort: sort.value });
  const identity = () => JSON.stringify([state.clipRevision ?? state.clips, state.channels, options(), wanted]);
  const busy = id => working.has(id) || state.pending === true || (state.pending instanceof Set && state.pending.has(id));

  function draw() {
    if (disposed) return;
    const total = Number.isSafeInteger(state.clipTotal) ? state.clipTotal : Math.max(state.clips.length, page.total);
    const filtered = search.value.trim() || filter.value !== 'all';
    setText(count, filtered ? `${page.total} / ${total}` : total);
    empty.hidden = total > 0 || loading || !!error;
    noResults.hidden = total === 0 || page.total > 0 || loading || !!error;
    list.hidden = page.items.length === 0;
    setText(status, error || (loading ? '클립을 불러오는 중…' : `${page.items.length} / ${page.total}개 표시`));
    more.hidden = !error && page.items.length >= page.total;
    more.disabled = loading || !state.available;
    setText(more, error ? '다시 불러오기' : '더 보기');
    const rowKey = JSON.stringify([page.items, state.available, page.items.map(clip => busy(clip.id)), draft?.id]);
    if (rowKey === lastRows) return;
    lastRows = rowKey;
    const focused = document.activeElement;
    const selection = focused?.dataset?.clipTitle && draft ? [focused.selectionStart, focused.selectionEnd] : null;
    list.replaceChildren();
    for (const clip of page.items) {
      const row = element(rowTag, 'clip-row'), description = element('div', 'clip-description clip-info');
      const title = element('strong', 'clip-title', clip.title || clip.fileName || '저장한 클립'); title.title = clip.fileName || '';
      const meta = element('small', 'clip-meta', presentation.formatClipMeta(clip));
      const badge = autoClipBadge(clip.trigger); if (badge) meta.append(element('span', 'auto-clip-badge', badge));
      description.append(title, meta); row.append(element('span', 'clip-badge clip-icon', '▷'), description);
      const actions = element('div', 'clip-actions');
      for (const [action, className, label, accessible] of [
        ['open', 'clip-open', '열기 ↗', `${title.textContent} 열기`],
        ['star', 'clip-star', clip.favorite ? '★' : '☆', `${title.textContent} 즐겨찾기`],
        ['rename', 'clip-rename', '제목 수정', `${title.textContent} 제목 수정`],
        ['reveal', 'clip-reveal', '폴더', `${title.textContent} 폴더에서 보기`]
      ]) {
        const button = actionButton(className, label, action, { clip: clip.id });
        button.disabled = !state.available || busy(clip.id); button.setAttribute('aria-label', accessible);
        if (action === 'star') button.setAttribute('aria-pressed', String(clip.favorite === true));
        actions.append(button);
      }
      row.append(actions);
      if (draft?.id === clip.id) {
        const form = element('form', 'clip-title-editor'); form.dataset.clip = clip.id;
        const input = element('input', 'clip-title-input'); input.type = 'text'; input.maxLength = 100; input.required = true;
        input.value = draft.title; input.dataset.clipTitle = clip.id; input.setAttribute('aria-label', '새 클립 제목');
        const save = element('button', '', '저장'); save.type = 'submit';
        const cancel = actionButton('', '취소', 'cancel', { clip: clip.id });
        input.disabled = save.disabled = cancel.disabled = !state.available || busy(clip.id);
        form.append(input, save, cancel); row.append(form);
      }
      list.append(row);
    }
    if (selection) { const input = list.querySelector('[data-clip-title]'); input?.focus(); input?.setSelectionRange?.(...selection); }
  }

  async function refresh() {
    if (disposed) return;
    const request = ++epoch, args = options();
    lastRequest = identity(); error = '';
    if (!queryClips || !state.available) {
      loading = false; page = localClipQuery(state.clips, { ...args, limit: wanted }, state.channels); draw(); return;
    }
    loading = true; draw();
    try {
      const items = []; let total = 0, revision;
      // Refetch loaded pages on a revision change so edits never leave stale rows.
      // Every request is bounded to 100; pages from different revisions cannot mix.
      do {
        const offset = items.length, limit = Math.min(100, wanted - offset);
        const result = await queryClips({ ...args, offset, limit });
        if (disposed || request !== epoch) return;
        if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.offset !== offset ||
            result.items.length > limit || result.items.some(clip => !clip || typeof clip.id !== 'string')) throw new Error('클립 목록을 읽지 못했습니다.');
        if (offset && result.revision !== revision) throw new Error('보관함이 변경되었습니다. 다시 불러와 주세요.');
        revision = result.revision; total = result.total; items.push(...result.items);
        if (!result.items.length) break;
      } while (items.length < wanted && items.length < total);
      page = { items, total };
    } catch (failure) { if (!disposed && request === epoch) error = failure?.message || '클립 목록을 불러오지 못했습니다.'; }
    finally { if (!disposed && request === epoch) { loading = false; draw(); } }
  }

  function changed(delay = false) {
    ++epoch; timers.clearTimeout(debounce); debounce = undefined; wanted = 50; draft = undefined;
    if (delay && queryClips) {
      loading = true; error = ''; draw();
      debounce = timers.setTimeout(() => { debounce = undefined; void refresh(); }, 180);
    } else void refresh();
  }
  async function mutate(id, method, arg) {
    if (disposed || !state.available || busy(id)) return false;
    working.add(id); error = ''; draw();
    try { return await run(method, arg); }
    catch (failure) { error = failure?.message || '클립 작업을 완료하지 못했습니다.'; return false; }
    finally { working.delete(id); draw(); }
  }
  events.on(search, 'input', () => changed(true));
  events.on(filter, 'change', () => changed()); events.on(sort, 'change', () => changed());
  events.on(more, 'click', () => { if (more.disabled) return; if (!error) wanted += 50; return refresh(); });
  events.on(list, 'input', event => { if (draft && event.target.dataset.clipTitle === draft.id) draft.title = event.target.value; });
  events.on(list, 'submit', async event => {
    const form = event.target.closest('form[data-clip]'); if (!form || draft?.id !== form.dataset.clip) return;
    event.preventDefault(); const id = draft.id, title = draft.title.trim();
    if (!title || title.length > 100) { error = '클립 제목은 1자 이상 100자 이하로 입력해 주세요.'; draw(); return; }
    if (await mutate(id, 'updateClip', { id, title })) { if (draft?.id === id) draft = undefined; draw(); }
  });
  events.on(list, 'click', async event => {
    const button = event.target.closest('button[data-clip]'); if (!button || button.disabled) return;
    const id = button.dataset.clip, clip = page.items.find(item => item.id === id); if (!clip) return;
    if (button.dataset.action === 'open') return mutate(id, 'openClip', id);
    if (button.dataset.action === 'reveal') return mutate(id, 'showClipInFolder', id);
    if (button.dataset.action === 'star') return mutate(id, 'updateClip', { id, favorite: clip.favorite !== true });
    if (button.dataset.action === 'rename') { draft = { id, title: clip.title || '' }; draw(); list.querySelector('[data-clip-title]')?.focus(); }
    if (button.dataset.action === 'cancel') { draft = undefined; draw(); }
  });
  return {
    render(next) {
      const wasAvailable = state.available; state = { ...state, ...next };
      if (!state.available && wasAvailable) { ++epoch; timers.clearTimeout(debounce); debounce = undefined; lastRequest = ''; void refresh(); }
      else if (!debounce && (!queryClips || identity() !== lastRequest || state.available !== wasAvailable)) void refresh();
      else draw();
    },
    dispose() { disposed = true; ++epoch; timers.clearTimeout(debounce); events.dispose(); }
  };
}
