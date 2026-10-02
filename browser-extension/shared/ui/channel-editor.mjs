import { createDom, createEventScope, setText } from './dom.mjs';

let nextEditorId = 0;

/** Owns one channel's inline draft. Server refreshes update labels/pins, never an
 * unfinished name. Callbacks return true only after the command was accepted. */
export function createChannelEditor({ document, onRename, onPin, labelClass = 'channel-label' }) {
  const { element } = createDom(document), events = createEventScope();
  let current, channelId, editing = false, applying = false, pinning = false, disposed = false, revision = 0, errorText = '';
  const root = element('div', 'channel-editor');
  const identity = element('div', 'channel-identity');
  const label = element('span', labelClass);
  identity.append(label);
  const tools = element('div', 'channel-tools');
  const pin = element('button', 'channel-pin'); pin.type = 'button';
  const edit = element('button', 'channel-edit', '이름'); edit.type = 'button';
  tools.append(pin, edit);
  const form = element('form', 'channel-edit-form'); form.hidden = true;
  const input = element('input', 'channel-edit-input'); input.type = 'text'; input.maxLength = 60; input.autocomplete = 'off';
  const actions = element('div', 'channel-edit-actions');
  const apply = element('button', 'channel-edit-apply', '적용'); apply.type = 'submit';
  const cancel = element('button', 'channel-edit-cancel', '취소'); cancel.type = 'button';
  actions.append(apply, cancel); form.append(input, actions);
  const error = element('p', 'channel-edit-error'); error.id = `channel-edit-error-${++nextEditorId}`;
  error.setAttribute('role', 'alert'); error.hidden = true;
  input.setAttribute('aria-describedby', error.id);
  root.append(identity, tools, form, error);

  function render(value) {
    if (disposed) return;
    current = value;
    if (channelId !== value.channel.id) {
      channelId = value.channel.id; revision++; editing = false; applying = false; pinning = false; errorText = '';
    }
    const name = value.channel.name || '이름 없는 채널';
    setText(label, name); label.title = name;
    if (!editing) input.value = value.channel.name || '';
    const blocked = value.available === false || value.pending || applying || pinning;
    pin.disabled = Boolean(blocked); edit.disabled = Boolean(blocked || editing);
    setText(pin, value.channel.pinned === true ? '★ 고정' : '☆ 고정');
    pin.setAttribute('aria-pressed', String(value.channel.pinned === true));
    pin.setAttribute('aria-label', `${name} ${value.channel.pinned === true ? '고정 해제' : '상단 고정'}`);
    pin.title = value.channel.pinned === true ? '상단 고정 해제' : '즐겨찾기 맨 위에 고정';
    edit.setAttribute('aria-label', `${name} 이름 수정`); edit.title = '이름 수정';
    edit.setAttribute('aria-expanded', String(editing));
    form.hidden = !editing;
    input.setAttribute('aria-label', `${name} 새 이름 · 1자에서 60자`);
    input.disabled = Boolean(blocked); apply.disabled = Boolean(blocked || input.value.trim() === (value.channel.name || '').trim());
    cancel.disabled = applying;
    setText(apply, applying ? '적용 중…' : '적용');
    error.hidden = !errorText; setText(error, errorText);
    input.setAttribute('aria-invalid', String(Boolean(errorText && editing)));
  }
  function closeEditor() {
    if (applying || disposed) return;
    editing = false; errorText = ''; render(current); edit.focus({ preventScroll: true });
  }
  events.on(edit, 'click', () => {
    if (edit.disabled || disposed || !current) return;
    editing = true; errorText = ''; input.value = current.channel.name || '';
    render(current); input.focus({ preventScroll: true }); input.select?.();
  });
  events.on(input, 'input', () => { if (!disposed) { errorText = ''; render(current); } });
  events.on(input, 'keydown', event => {
    if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); closeEditor(); }
  });
  events.on(cancel, 'click', closeEditor);
  events.on(form, 'submit', async event => {
    event.preventDefault();
    if (disposed || !editing || applying || apply.disabled) return;
    const name = input.value.trim();
    if (!name || name.length > 60) {
      errorText = '이름은 1자에서 60자까지 입력해 주세요.'; render(current); input.focus(); return;
    }
    const operation = revision, argument = { channelId, name };
    applying = true; errorText = ''; render(current);
    let accepted = false;
    try { accepted = await onRename(argument); }
    catch { /* The command adapter reports the detailed failure. Keep the draft. */ }
    if (disposed || operation !== revision) return;
    applying = false;
    if (accepted) { editing = false; errorText = ''; }
    else errorText = '이름을 저장하지 못했어요. 입력한 내용은 유지했어요.';
    render(current);
    if (accepted) edit.focus({ preventScroll: true });
  });
  events.on(pin, 'click', async () => {
    if (pin.disabled || disposed || !current) return;
    const operation = revision, argument = { channelId, pinned: current.channel.pinned !== true };
    pinning = true; errorText = ''; render(current);
    let accepted = false;
    try { accepted = await onPin(argument); }
    catch { /* Preserve the last confirmed pin state. */ }
    if (disposed || operation !== revision) return;
    pinning = false;
    if (!accepted) errorText = '고정 상태를 바꾸지 못했어요. 다시 시도해 주세요.';
    render(current);
  });
  return { element: root, render, dispose() { disposed = true; revision++; events.dispose(); } };
}
