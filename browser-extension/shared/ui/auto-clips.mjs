import { createDom, createEventScope, setText } from './dom.mjs';

const labels = {
  disabled: '꺼짐', 'needs-buffer': '구간 보관 필요', waiting: '공식 채팅 기다리는 중',
  warming: '영상 모으는 중', watching: '감지 중', pending: '감지됨 · 뒷부분 보관 중',
  saving: '저장 중', cooldown: '다음 감지 대기 중', error: '확인 필요'
};

export function autoClipForSlot(entries, slot) {
  return Array.isArray(entries) ? entries.find(entry => Number(entry.slotId) === Number(slot.slotId) && entry.channelId === slot.channelId) : undefined;
}

export function autoClipBadge(trigger) {
  return trigger === 'keyword' ? '자동 · 키워드' : trigger === 'chat-spike' ? '자동 · 채팅 급증' : '';
}

export function describeAutoClip(settings, activity, available = true) {
  if (!available) return { summary: '앱 연결 필요', message: '데스크톱 앱과 연결하면 자동 저장을 설정할 수 있어요.', error: false };
  if (!settings?.enabled) return { summary: '꺼짐', message: '조건을 고르고 자동 저장을 켠 뒤 적용해 주세요.', error: false };
  const count = Number.isSafeInteger(activity?.savedCount) && activity.savedCount > 0 ? ` · ${activity.savedCount}개 저장` : '';
  const status = Object.hasOwn(labels, activity?.status) ? labels[activity.status] : '상태 확인 중';
  return {
    summary: `${status}${count}`,
    message: activity?.message || '구간 보관을 켜고 공식 채팅을 열어 두세요.',
    error: activity?.status === 'error'
  };
}

// Owns one slot's editable draft and listeners. Remote snapshots cannot replace
// unsaved input; a successful apply accepts the server's normalized settings.
export function createAutoClipControls({ document, label, onApply }) {
  const { element } = createDom(document);
  const events = createEventScope();
  let current, channelId, dirty = false, applying = false, disposed = false;
  const root = element('details', 'auto-clip-settings');
  const summary = element('summary', 'auto-clip-summary');
  const status = element('span', 'auto-clip-status');
  status.setAttribute('role', 'status');
  summary.append(element('span', '', '자동 저장'), status);
  summary.setAttribute('aria-label', `${label} 자동 저장 설정`);
  const form = element('form', 'auto-clip-form');
  const enabledLabel = element('label', 'auto-clip-check');
  const enabled = element('input'); enabled.type = 'checkbox'; enabled.dataset.role = 'auto-clip-enabled';
  enabledLabel.append(enabled, element('span', '', '이 방송 자동 저장'));
  const keywordLabel = element('label', 'auto-clip-keywords');
  const keywords = element('input'); keywords.type = 'text'; keywords.dataset.role = 'auto-clip-keywords';
  keywords.placeholder = '키워드를 쉼표로 구분해 주세요';
  keywords.autocomplete = 'off';
  keywordLabel.append(element('span', '', '감지할 키워드'), keywords, element('small', '', '최대 10개 · 키워드마다 40자'));
  const spikeLabel = element('label', 'auto-clip-check');
  const spike = element('input'); spike.type = 'checkbox'; spike.dataset.role = 'auto-clip-spike';
  spikeLabel.append(spike, element('span', '', '채팅이 급증하면 저장'));
  const help = element('p', 'auto-clip-help', '구간 보관을 켜고 공식 채팅을 열어 두세요. 감지 전 약 20초와 후 약 10초를 내 컴퓨터에 MP4로 저장해요. 실제 길이는 모인 영상에 따라 달라요. 치지직 클립으로 게시하지 않아요.');
  const limits = element('p', 'auto-clip-help', '저장 간격 2분 · 방송마다 시간당 최대 10회 시도');
  const message = element('p', 'auto-clip-message');
  const apply = element('button', 'button auto-clip-apply', '적용'); apply.type = 'submit';
  form.append(enabledLabel, keywordLabel, spikeLabel, help, limits, message, apply);
  root.append(summary, form);

  function render(value) {
    if (disposed) return;
    current = value;
    if (channelId !== value.channelId) {
      channelId = value.channelId;
      dirty = false;
      root.open = false;
    }
    root.hidden = !channelId;
    if (!dirty) {
      enabled.checked = value.settings?.enabled === true;
      keywords.value = (value.settings?.keywords || []).join(', ');
      spike.checked = value.settings?.chatSpike === true;
    }
    const busy = applying || value.pending;
    const blocked = !channelId || !value.available || busy;
    for (const input of [enabled, keywords, spike]) input.disabled = blocked;
    apply.disabled = blocked || !dirty;
    setText(apply, busy ? '적용 중…' : '적용');
    const description = describeAutoClip(value.settings, value.activity, value.available);
    setText(status, description.summary);
    summary.title = `${description.summary} · ${description.message}`;
    setText(message, dirty ? '변경한 설정은 적용을 누르면 저장돼요.' : description.message);
    root.classList.toggle('error', description.error);
  }
  function edit() { dirty = true; if (current) render(current); }
  events.on(enabled, 'change', edit);
  events.on(spike, 'change', edit);
  events.on(keywords, 'input', edit);
  events.on(form, 'submit', async event => {
    event.preventDefault();
    if (apply.disabled || disposed) return;
    const submittedChannel = channelId;
    const argument = { channelId, enabled: enabled.checked, keywords: keywords.value.split(',').map(value => value.trim()).filter(Boolean), chatSpike: spike.checked };
    applying = true;
    render(current);
    try {
      const accepted = await onApply(argument);
      if (!disposed && accepted && channelId === submittedChannel) dirty = false;
    } finally {
      applying = false;
      if (!disposed) render(current);
    }
  });
  return { element: root, render, dispose() { disposed = true; events.dispose(); } };
}
