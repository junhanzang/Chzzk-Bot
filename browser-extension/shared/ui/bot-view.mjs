import { createDom, createEventScope, setText } from './dom.mjs';

const STATUS = { idle: '준비', starting: '시작하는 중', running: '실행 중', stopping: '중지하는 중', error: '확인 필요', unavailable: '준비 필요' };
const TYPES = { heard: '들린 말', observed: '들린 말', generated: '응답 제안', proposed: '응답 제안', skipped: '생략', filtered: '필터 차단', error: '오류', sent: '전송 완료', preview: '미리보기', status: '상태' };
const REASONS = { model_skip: '모델이 이번 발화에는 반응하지 않기로 했어요.', invalid_format: '응답 형식이 맞지 않아 보내지 않았어요.', response_guard: '반복 또는 금칙어 검사에서 차단했어요.', token_limit: '답변이 중간에 잘려 보내지 않았어요.', timeout: '제한시간 안에 답변을 받지 못했어요.', connection: 'AI 서버에 연결하지 못했어요.', invalid_payload: 'AI 응답 형식을 확인해 주세요.', empty_response: 'AI가 빈 응답을 반환했어요.', reply: '형식 검사를 통과한 응답이에요.', expired: '발화 유효시간이 지나 보내지 않았어요.' };
const active = status => ['starting', 'running', 'stopping'].includes(status);
Object.assign(REASONS, {
  provider_filter: 'AI 서비스가 이 응답을 차단했어요.', dependencies_missing: '봇 실행에 필요한 Python 패키지가 없어요. 설치 안내를 확인해 주세요.',
  model_unavailable: '설정한 AI 서버 또는 모델을 사용할 수 없어요.', session_setup_failed: '방송·로그인·오디오 준비 상태를 확인해 주세요.',
  session_failed: '방송 봇을 시작하지 못했어요. 연결과 실행 환경을 확인해 주세요.', operation_failed: '작업을 완료하지 못했어요. 연결과 실행 환경을 확인해 주세요.',
  running: '선택한 방송을 처리하고 있어요.', expired_or_stopped: '유효시간이 지났거나 중지되어 보내지 않았어요.',
  warmup: '방송 분위기를 먼저 관찰하고 있어요.', cooldown: '다음 응답까지 잠시 기다리고 있어요.',
  response_chance: '설정한 참여 빈도에 따라 이번 반응은 쉬어요.', approval_skipped: '승인하지 않았거나 승인 시간이 지나 보내지 않았어요.',
  send_failed: '전송을 확인하지 못했어요. 중복 방지를 위해 자동 재전송하지 않아요.',
  http_401: 'API 키가 유효한지 확인해 주세요.', http_403: '이 API 또는 모델을 사용할 권한이 없어요.',
  http_429: 'API 요청 한도나 사용 가능 잔액을 확인해 주세요.', generation_failed: 'AI 응답을 만들지 못했어요.',
});

export function createBotView({ document, root, run, desktop = false, onSettings = () => {}, clock = Date.now, timers = globalThis }) {
  const { element } = createDom(document), events = createEventScope();
  let snapshot = null, disposed = false, channelKey = '', eventKey = '', pendingId = null;
  let localBusy = 0, expiryTimer = null;
  const node = (tag, className, text) => element(tag, className, text);
  const button = (text, action, primary = false) => {
    const value = node('button', `bot-button${primary ? ' bot-primary' : ''}`, text);
    value.type = 'button'; value.dataset.botAction = action; return value;
  };
  const field = (form, label, tag, role, options = []) => {
    const wrapper = node('label', 'bot-field'), caption = node('span', '', label), control = node(tag);
    control.dataset.botRole = role;
    for (const [value, text] of options) { const option = node('option', '', text); option.value = value; control.append(option); }
    wrapper.append(caption, control); form.append(wrapper); return control;
  };
  const heading = node('div', 'bot-heading'), title = node('div'), badge = node('span', 'bot-badge', '준비 필요');
  title.append(node('h2', '', '방송에 맞춰, 짧게'), node('p', 'bot-muted', '들린 말과 반응을 확인하고 직접 제어하세요.'));
  const stop = button('봇 중지', 'stop'); heading.append(title, badge, stop);
  const notice = node('p', 'bot-status'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const connection = node('div', 'bot-connection'), setup = button(desktop ? 'AI 설정 열기' : '앱에서 AI 설정', 'settings'), refresh = button('상태 확인', 'refresh');
  const connectionText = node('p', 'bot-muted'); connection.append(connectionText, setup, refresh);
  const form = node('form', 'bot-session-form'); form.setAttribute('aria-label', '방송 봇 실행 설정');
  const channel = field(form, '대상 방송', 'select', 'channel', [['', '방송을 선택하세요']]);
  const sendMode = field(form, '전송 방식', 'select', 'send-mode', [['preview', '보내지 않고 미리보기'], ['approve', '확인 후 전송'], ['auto', '자동 전송']]);
  const responseMode = field(form, '반응 방식', 'select', 'response-mode', [['ai', '방송 음성에 반응'], ['hybrid', '음성 + 채팅 분위기'], ['mimic', '채팅 분위기 따라하기']]);
  sendMode.value = 'preview'; responseMode.value = 'ai';
  const modeHelp = node('p', 'bot-muted', '미리보기에서도 방송 오디오와 음성 인식 환경이 필요해요.');
  const start = button('미리보기 시작', 'start', true); start.type = 'submit'; form.append(modeHelp, start);
  const pending = node('section', 'bot-proposal'); pending.hidden = true; pending.setAttribute('aria-label', '전송 승인 대기');
  const heard = node('p', 'bot-heard'), draftLabel = node('label', 'bot-field'), draft = node('input');
  draft.type = 'text'; draft.maxLength = 50; draft.dataset.botRole = 'draft'; draftLabel.append(node('span', '', '보낼 답변 · 수정 가능'), draft);
  const pendingHelp = node('p', 'bot-muted'), pendingButtons = node('div', 'bot-actions');
  pendingButtons.append(button('넘기기', 'skip'), button('확인 후 전송', 'approve', true)); pending.append(node('h3', '', '이 답변을 보낼까요?'), heard, draftLabel, pendingHelp, pendingButtons);
  const previewForm = node('form', 'bot-text-preview'); previewForm.setAttribute('aria-label', '문장으로 AI 미리보기');
  previewForm.append(node('h3', '', '문장으로 먼저 확인하기'), node('p', 'bot-muted', '오디오·로그인·채팅 전송 없이 AI 응답만 확인해요.'));
  const speech = field(previewForm, '방송에서 들은 말', 'textarea', 'speech'); speech.rows = 3; speech.maxLength = 2000; speech.required = true;
  speech.placeholder = '예: 오늘 드디어 목표 기록을 넘겼어';
  const contextDetails = node('details', 'bot-details'); contextDetails.append(node('summary', '', '앞뒤 맥락 추가'));
  const prior = field(contextDetails, '이전 발화 · 한 줄에 하나, 최대 5개', 'textarea', 'prior'); prior.rows = 2; prior.maxLength = 1500;
  const chat = field(contextDetails, '최근 채팅', 'textarea', 'chat'); chat.rows = 2; chat.maxLength = 2000;
  const previewButton = button('AI 반응 확인', 'preview', true); previewButton.type = 'submit';
  const privacy = node('p', 'bot-muted'); previewForm.append(contextDetails, privacy, previewButton);
  const timeline = node('section', 'bot-history'); timeline.setAttribute('aria-label', '봇 활동');
  const historyList = node('ol', 'bot-events'), empty = node('p', 'bot-muted', '문장을 확인하거나 봇을 시작하면 활동이 여기에 나타나요.');
  timeline.append(node('h3', '', '최근 반응'), empty, historyList);
  root.append(heading, notice, connection, form, pending, previewForm, timeline);
  function available() { return !!snapshot && (desktop ? snapshot.initialized && !snapshot.preview : snapshot.state.connection?.status === 'connected'); }
  async function invoke(method, arg, success) {
    if (disposed) return false;
    localBusy++; render(snapshot);
    try { return await run(method, arg, success); }
    finally { localBusy--; if (!disposed) render(snapshot); }
  }
  events.on(form, 'submit', event => {
    event.preventDefault();
    if (start.disabled || !channel.value) return;
    void invoke('startBot', { channelId: channel.value, sendMode: sendMode.value, responseMode: responseMode.value });
  });
  events.on(sendMode, 'change', () => render(snapshot));
  events.on(responseMode, 'change', () => render(snapshot));
  events.on(previewForm, 'submit', event => {
    event.preventDefault();
    if (previewButton.disabled || !speech.value.trim()) return;
    void invoke('previewBot', { speech: speech.value.trim(), priorSpeech: prior.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean).slice(-5), chat: chat.value.trim() });
  });
  events.on(root, 'click', event => {
    const target = event.target.closest('button[data-bot-action]'); if (!target || target.disabled || disposed) return;
    if (target.dataset.botAction === 'stop') void invoke('stopBot');
    if (target.dataset.botAction === 'refresh') void invoke('getBotState');
    if (target.dataset.botAction === 'settings') { if (desktop) onSettings(); else void invoke('openDeskSection', 'settings'); }
    if (['approve', 'skip'].includes(target.dataset.botAction) && pendingId) {
      const expiresAt = snapshot?.state.bot?.pending?.expiresAt;
      if (target.dataset.botAction === 'approve' && Number.isFinite(expiresAt) && clock() >= expiresAt) { render(snapshot); return; }
      void invoke('approveBot', { id: pendingId, action: target.dataset.botAction === 'skip' ? 'skip' : 'send', ...(target.dataset.botAction === 'approve' ? { text: draft.value.trim() } : {}) });
    }
  });
  function render(next) {
    if (!next || disposed) return; snapshot = next;
    const bot = next.state.bot || { status: 'unavailable', message: '봇 상태 확인을 눌러 준비 상태를 확인하세요.' };
    const canUse = available(), running = active(bot.status), busy = localBusy > 0;
    setText(badge, canUse ? STATUS[bot.status] || '확인 필요' : desktop ? '앱 실행 필요' : '앱 연결 필요');
    setText(notice, !canUse ? desktop ? '데스크톱 앱에서 봇을 사용할 수 있어요.' : '앱을 연결하면 봇 상태·문장 미리보기·중지를 사용할 수 있어요. 시청 기능은 계속 사용할 수 있어요.' : bot.message || (running ? '봇이 선택한 방송을 처리하고 있어요.' : '먼저 문장으로 반응을 확인해 보세요.'));
    const config = bot.config || {};
    setText(connectionText, config.model ? `${config.provider === 'openai_compatible' ? '외부 AI' : 'Ollama'} · ${config.model}` : 'AI 연결 설정이 필요해요. 채팅 따라하기는 AI 없이 사용할 수 있어요.');
    setup.disabled = !desktop && !canUse; refresh.disabled = !canUse || busy;
    stop.disabled = !canUse || (!running && !busy && !bot.pending);
    const channels = [...(next.state.channels || [])];
    if (running && bot.channelId && !channels.some(item => item.id === bot.channelId)) channels.push({ id: bot.channelId, name: '실행 중인 방송' });
    const nextChannelKey = JSON.stringify(channels.map(item => [item.id, item.name]));
    if (channelKey !== nextChannelKey) {
      channelKey = nextChannelKey; const selected = channel.value || bot.channelId || '';
      const options = [node('option', '', '방송을 선택하세요')]; options[0].value = '';
      for (const item of channels) { const option = node('option', '', item.name || item.id); option.value = item.id; options.push(option); }
      channel.replaceChildren(...options); channel.value = channels.some(item => item.id === selected) ? selected : '';
    }
    if (running) {
      if (bot.channelId) channel.value = bot.channelId;
      if (['preview', 'approve', 'auto'].includes(bot.sendMode)) sendMode.value = bot.sendMode;
      if (['ai', 'hybrid', 'mimic'].includes(bot.responseMode)) responseMode.value = bot.responseMode;
    }
    channel.disabled = running || busy || !canUse; sendMode.disabled = responseMode.disabled = running || busy || !canUse;
    start.disabled = !canUse || running || busy || !channels.length || bot.status === 'unavailable';
    setText(start, sendMode.value === 'preview' ? '미리보기 시작' : sendMode.value === 'approve' ? '승인 모드로 시작' : '자동 전송 시작');
    setText(modeHelp, sendMode.value === 'auto' ? '시작하면 앱의 네이버 로그인 계정으로 선택한 방송에 자동 전송해요. 언제든 봇 중지로 끝낼 수 있어요.' : sendMode.value === 'approve' ? '앱의 네이버 로그인 계정으로 승인한 문장만 전송해요. Chrome 로그인과는 별개예요.' : responseMode.value === 'mimic' ? '채팅 분위기만 따라해요. 음성 인식·AI 모델은 사용하지 않아요.' : '방송 오디오와 음성 인식 환경이 필요해요. 시스템 소리가 입력되므로 듣는 방송을 확인하세요.');
    const proposal = canUse ? bot.pending : null;
    pending.hidden = !proposal;
    if (proposal) {
      setText(heard, `들린 말: ${proposal.speech || ''}`);
      if (pendingId !== proposal.id) draft.value = proposal.response || '';
      const expired = Number.isFinite(proposal.expiresAt) && clock() >= proposal.expiresAt;
      setText(pendingHelp, expired ? '이 제안은 유효시간이 지나 전송할 수 없어요. 넘기기로 닫아 주세요.' : '오래된 제안은 보내지 않아요. 수정한 최종 문장만 전송해요.');
      pending.querySelectorAll('button').forEach(item => { item.disabled = busy || (expired && item.dataset.botAction === 'approve'); });
      if (expiryTimer === null) expiryTimer = timers.setInterval(() => render(snapshot), 1000);
    } else if (expiryTimer !== null) {
      timers.clearInterval(expiryTimer); expiryTimer = null;
    }
    pendingId = proposal?.id || null;
    previewButton.disabled = !canUse || running || busy || bot.status === 'unavailable';
    setText(privacy, config.provider === 'openai_compatible' ? '입력한 발화·이전 발화·채팅을 설정한 외부 AI로 전송하며 사용량에 따른 비용이 발생할 수 있어요.' : '입력 문장을 설정한 모델 서버로 전달해요. 실제 채팅은 보내지 않아요.');
    const entries = canUse && Array.isArray(bot.events) ? bot.events.slice(-50).reverse() : [];
    const nextKey = JSON.stringify(entries);
    if (nextKey !== eventKey) {
      eventKey = nextKey; historyList.replaceChildren();
      for (const entry of entries) {
        const item = node('li', `bot-event bot-event-${TYPES[entry.type] ? entry.type : 'status'}`);
        const header = node('div', 'bot-event-heading'); header.append(node('strong', '', TYPES[entry.type] || '상태'));
        const time = new Date(entry.at); if (Number.isFinite(time.getTime())) header.append(node('time', 'bot-muted', time.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
        item.append(header);
        if (entry.speech) item.append(node('p', 'bot-heard', entry.speech));
        if (entry.response) item.append(node('p', 'bot-answer', entry.response));
        if (entry.reason) item.append(node('p', 'bot-muted', REASONS[entry.reason] || entry.reason));
        historyList.append(item);
      }
    }
    empty.hidden = entries.length > 0;
  }
  return { render, dispose() { disposed = true; if (expiryTimer !== null) timers.clearInterval(expiryTimer); events.dispose(); } };
}

export function createBotSettingsView({ document, root, run }) {
  const { element } = createDom(document), events = createEventScope();
  let loaded = false, dirty = false, disposed = false, busy = false, snapshot;
  const form = element('form', 'bot-config-form'); form.setAttribute('aria-label', 'AI 연결 설정');
  form.append(element('h2', '', 'AI 연결'), element('p', 'bot-muted', '외부 AI를 사용하면 Ollama 설치 없이 답변을 만들 수 있어요. 방송 음성 인식 환경은 별도로 필요해요.'));
  const controls = {};
  for (const [name, label, type] of [['provider', 'AI 실행 방식', 'select'], ['baseUrl', '서버 주소', 'url'], ['model', '모델 이름', 'text'], ['apiKey', 'API 키', 'password']]) {
    const wrapper = element('label', 'bot-field'), input = element(type === 'select' ? 'select' : 'input');
    input.dataset.configField = name;
    if (type === 'select') for (const [value, text] of [['ollama', '내 PC / Ollama'], ['openai_compatible', '외부 AI / 호환 API']]) { const option = element('option', '', text); option.value = value; input.append(option); }
    else { input.type = type; input.maxLength = name === 'apiKey' ? 4096 : name === 'model' ? 200 : 2048; input.autocomplete = 'off'; input.spellcheck = false; input.required = name !== 'apiKey'; }
    if (name === 'apiKey') input.placeholder = '같은 서버에서 빈칸이면 기존 키 유지';
    wrapper.append(element('span', '', label), input); form.append(wrapper); controls[name] = input;
  }
  const help = element('p', 'bot-muted'), storage = element('p', 'bot-muted'), save = element('button', 'bot-button bot-primary', 'AI 연결 저장'); save.type = 'submit';
  form.append(help, storage, save); root.append(form);
  function describe() {
    controls.apiKey.disabled = controls.provider.value !== 'openai_compatible' || busy;
    setText(help, controls.provider.value === 'openai_compatible' ? '발화·채팅·기억 문맥을 이 서버로 전송해요. API 사용료는 서비스별로 별도예요. 모델 식별자를 직접 입력하고, 서버나 실행 방식을 바꿀 때는 API 키도 다시 입력하세요.' : 'Ollama 서버 주소와 설치된 모델 태그를 입력하세요. 자동 설치나 다운로드는 하지 않아요.');
  }
  for (const input of Object.values(controls)) {
    events.on(input, 'input', () => { dirty = true; });
    events.on(input, 'change', () => {
      dirty = true;
      if (input === controls.provider) {
        controls.baseUrl.value = input.value === 'openai_compatible' ? 'https://api.openai.com/v1' : 'http://localhost:11434';
        controls.model.value = ''; controls.apiKey.value = '';
      }
      if (input === controls.baseUrl) controls.apiKey.value = '';
      describe();
    });
  }
  events.on(form, 'submit', async event => {
    event.preventDefault(); if (save.disabled || disposed) return;
    const values = Object.fromEntries(Object.entries(controls).map(([name, input]) => [name, input.value.trim()]));
    busy = true; render(snapshot);
    try {
      const succeeded = await run('configureBot', values, 'AI 연결 설정을 저장했어요. 문장 미리보기로 응답을 확인해 보세요.');
      if (succeeded && !disposed) {
        if (controls.apiKey.value.trim() === values.apiKey) controls.apiKey.value = '';
        dirty = Object.entries(controls).some(([name, input]) => name !== 'apiKey' && input.value.trim() !== values[name]);
      }
    } finally { busy = false; if (!disposed) render(snapshot); }
  });
  function render(next) {
    if (!next || disposed) return; snapshot = next;
    const bot = next.state.bot, config = bot?.config;
    if (config && !dirty) {
      controls.provider.value = config.provider === 'openai_compatible' ? config.provider : 'ollama';
      controls.baseUrl.value = config.baseUrl || ''; controls.model.value = config.model || ''; loaded = true;
    }
    const disabled = busy || !next.initialized || next.preview || active(bot?.status);
    for (const input of Object.values(controls)) input.disabled = disabled;
    save.disabled = disabled;
    setText(storage, config?.apiKeySet ? config.keyStorage === 'encrypted' ? 'API 키가 운영체제의 암호화 저장소에 저장돼 있어요.' : 'API 키가 현재 세션에 설정돼 있어요. 암호화 저장이 안 되는 환경에서는 재실행 후 다시 입력하세요.' : '저장된 API 키가 없어요. 키는 확장 프로그램이나 화면 상태에 전달하지 않아요.');
    if (!loaded && !dirty) controls.provider.value = 'ollama';
    describe();
    if (disabled) controls.apiKey.disabled = true;
  }
  return { render, dispose() { disposed = true; controls.apiKey.value = ''; events.dispose(); } };
}
