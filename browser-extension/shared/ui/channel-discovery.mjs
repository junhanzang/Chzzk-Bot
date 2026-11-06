import { createDom, createEventScope, setText } from './dom.mjs';
import { letters, slotIds, recommendations, rankChannelList } from './model.mjs';

/** Followed channels stay in memory; only an explicit pin becomes a favorite. */
export function createChannelDiscovery({ document, root, run, desktop = false }) {
  const { element } = createDom(document), events = createEventScope();
  let snapshot, limit = 30, followingKey = '', pinsKey = '';
  const pins = element('section', 'pinned-channels');
  const pinsTitle = element('h2', '', '상단 고정');
  const pinsHelp = element('p', 'discovery-note', '즐겨찾기나 팔로잉에서 ★ 고정을 눌러 자주 보는 방송을 여기에 두세요.');
  const pinsList = element('div', 'pinned-list');
  pins.append(pinsTitle, pinsHelp, pinsList); pins.hidden = desktop;
  const following = element('details', 'following-disclosure'); following.open = true;
  const summary = element('summary', '', '내 팔로잉 방송');
  const content = element('div', 'following-content');
  const account = element('p', 'discovery-note', desktop ? '앱에서 로그인한 치지직 계정의 팔로잉이에요.' : 'Chrome에서 로그인한 치지직 계정의 팔로잉이에요.');
  const categoryStatus = element('p', 'discovery-note category-status');
  const sorting = element('label', 'following-sorting', '목록 정렬');
  const sort = element('select', 'recommendation-sort'); sort.setAttribute('aria-label', '팔로잉과 즐겨찾기 목록 정렬');
  for (const mode of recommendations.MODES) { const option = element('option', '', recommendations.MODE_LABELS[mode]); option.value = mode; sort.append(option); }
  sorting.append(sort);
  const explanation = element('details', 'recommendation-explanation');
  explanation.append(element('summary', '', '추천 기준 · 내 기록'));
  explanation.append(element('p', 'discovery-note', '고정 방송을 먼저, 그 안에서 방송 중인 채널을 우선해요. 추천순은 팔로우한 게임·카테고리와 최근 방문·재생 시간·채팅 참여를 반영해요.'));
  explanation.append(element('p', 'discovery-note', '앞으로 이 환경에서 쌓이는 기록만 내 기기에 저장해요. 앱과 Chrome 기록은 각각 관리해요. 채팅 참여는 입력 활동 기준이며 전송 횟수가 아니에요. 채팅 내용은 저장하지 않아요.'));
  const clear = element('button', 'discovery-button', '추천 기록 초기화'); clear.type = 'button'; clear.dataset.action = 'clear-history';
  const confirm = element('button', 'discovery-button', '기록 삭제 확인'); confirm.type = 'button'; confirm.dataset.action = 'confirm-clear-history'; confirm.hidden = true;
  explanation.append(clear, confirm);
  const tools = element('div', 'following-tools');
  const search = element('input', 'collection-search'); search.type = 'search'; search.placeholder = '팔로잉 검색'; search.maxLength = 100;
  search.setAttribute('aria-label', '팔로잉 방송 검색');
  const refresh = element('button', 'discovery-button', '새로고침'); refresh.type = 'button'; refresh.dataset.action = 'refresh-following';
  tools.append(search, refresh);
  const status = element('p', 'discovery-note'); status.setAttribute('role', 'status');
  const list = element('div', 'following-list');
  const more = element('button', 'discovery-button', '더 보기'); more.type = 'button'; more.hidden = true;
  content.append(account, categoryStatus, sorting, tools, status, list, more, explanation); following.append(summary, content); root.append(pins, following);

  function render(next) {
    snapshot = next;
    const { state, pending } = next;
    const busy = pending instanceof Set ? pending.has('channel-discovery') : Boolean(pending);
    const unavailable = desktop ? !next.initialized || next.preview : state.connection?.status === 'unavailable';
    const channels = state.channels || [], followed = state.following || { status: 'idle', channels: [] };
    sort.value = state.recommendations?.mode || 'recommended'; sort.disabled = busy || (desktop && (!next.initialized || next.preview));
    clear.disabled = sort.disabled; confirm.disabled = sort.disabled;
    const categories = followed.categories || [];
    setText(categoryStatus, followed.categoryStatus === 'ready' ? categories.length ? `팔로우 카테고리: ${categories.slice(0, 4).map(category => category.name).join(' · ')}${categories.length > 4 ? ` 외 ${categories.length - 4}개` : ''}` : '팔로우한 카테고리가 없어요. 이용 기록으로 추천해요.'
      : followed.categoryStatus === 'loading' ? '팔로우 카테고리 확인 중…' : followed.categoryStatus === 'error' ? '카테고리를 불러오지 못해 이용 기록으로 정렬해요.' : '로그인하면 팔로우 카테고리도 반영해요.');
    const selected = channels.filter(channel => channel.pinned === true);
    const nextPinsKey = JSON.stringify([selected, state.slots.map(slot => slot.channelId), busy, unavailable]);
    if (!desktop && nextPinsKey !== pinsKey) {
      pinsKey = nextPinsKey; pinsHelp.hidden = selected.length > 0;
      pinsList.replaceChildren(...selected.map(channel => {
        const row = element('div', 'pinned-row'), label = element('span', 'discovery-name', channel.name); label.title = channel.name;
        row.append(label);
        for (const slotId of slotIds) {
          const button = element('button', 'discovery-button', letters[slotId]); button.type = 'button';
          button.dataset.action = 'assign-pinned'; button.dataset.channel = channel.id; button.dataset.slot = String(slotId);
          button.setAttribute('aria-label', `${channel.name} 방송 ${letters[slotId]}에서 보기`);
          button.setAttribute('aria-pressed', String(state.slots.some(slot => slot.slotId === slotId && slot.channelId === channel.id)));
          button.disabled = busy || unavailable; row.append(button);
        }
        return row;
      }));
    }
    const messages = { idle: '로그인을 확인하고 팔로잉을 불러와요.', loading: '팔로잉 방송을 불러오는 중…',
      signed_out: desktop ? '상단의 네이버 로그인 후 자동으로 불러와요.' : 'Chrome에서 치지직에 로그인하면 자동으로 불러와요.',
      error: '팔로잉을 불러오지 못했어요. 새로고침해 주세요.' };
    const query = search.value.trim().toLocaleLowerCase();
    const matches = rankChannelList((followed.channels || []).filter(channel => `${channel.name} ${channel.title || ''} ${channel.category?.name || ''}`.toLocaleLowerCase().includes(query)), state);
    const ready = followed.status === 'ready';
    setText(status, ready ? (matches.length ? `${matches.length}개 방송 · ${recommendations.MODE_LABELS[sort.value] || '추천순'}` : query ? '검색에 맞는 팔로잉이 없어요.' : '아직 팔로잉한 방송이 없어요.') : messages[followed.status] || messages.error);
    if (followed.message && followed.status === 'error') setText(status, followed.message);
    refresh.disabled = busy || followed.status === 'loading' || (desktop && (!next.initialized || next.preview));
    setText(refresh, followed.status === 'loading' ? '불러오는 중' : '새로고침');
    more.hidden = !ready || matches.length <= limit;
    list.hidden = !ready;
    const visible = ready ? matches.slice(0, limit) : [];
    const nextKey = JSON.stringify([visible.map(({ id, name, live, title, category, recommendation }) => ({ id, name, live, title, category, reasons: recommendation?.reasons })), selected.map(channel => channel.id), busy, unavailable]);
    if (nextKey !== followingKey) {
      followingKey = nextKey;
      list.replaceChildren(...visible.map(channel => {
        const row = element('div', 'following-row'), info = element('div', 'following-info');
        const name = element('span', 'discovery-name', channel.name); name.title = channel.name;
        const live = element('span', channel.live ? 'following-live' : 'following-offline', channel.live ? '방송 중' : '오프라인');
        info.append(name, live); if (channel.title) { const title = element('small', 'following-title', channel.title); title.title = channel.title; info.append(title); }
        if (channel.category?.name) info.append(element('small', 'following-category', channel.category.name));
        if (channel.recommendation?.reasons.length) info.append(element('small', 'recommendation-reasons', channel.recommendation.reasons.join(' · ')));
        const pinned = selected.some(item => item.id === channel.id);
        const pin = element('button', 'discovery-button', pinned ? '★ 고정됨' : '☆ 고정'); pin.type = 'button';
        pin.dataset.action = 'pin-followed'; pin.dataset.channel = channel.id; pin.disabled = busy || unavailable || pinned;
        pin.setAttribute('aria-label', `${channel.name} 즐겨찾기 상단에 고정`); pin.setAttribute('aria-pressed', String(pinned));
        row.append(info, pin); return row;
      }));
    }
  }
  events.on(search, 'input', () => { limit = 30; if (snapshot) render(snapshot); });
  events.on(more, 'click', () => { limit += 30; if (snapshot) render(snapshot); });
  events.on(sort, 'change', () => { confirm.hidden = true; run('setRecommendationSort', sort.value); });
  events.on(root, 'click', event => {
    const button = event.target.closest('button[data-action]'); if (!button || button.disabled) return;
    if (button.dataset.action === 'refresh-following') run('refreshFollowing');
    if (button.dataset.action === 'clear-history') confirm.hidden = !confirm.hidden;
    if (button.dataset.action === 'confirm-clear-history') { confirm.hidden = true; run('clearRecommendationHistory', undefined, '추천 기록을 초기화했어요. 즐겨찾기는 유지돼요.'); }
    if (button.dataset.action === 'pin-followed') run('pinFollowedChannel', button.dataset.channel, '즐겨찾기 맨 위에 고정했어요.');
    if (button.dataset.action === 'assign-pinned') run('assignSlot', { channelId: button.dataset.channel, slotId: Number(button.dataset.slot) });
  });
  return { render, dispose() { events.dispose(); } };
}
