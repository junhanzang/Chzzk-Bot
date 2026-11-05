'use strict';

// Public, bounded bot state. Process handles, keys and arbitrary adapter data
// never cross the desktop/extension boundary.
((root, factory) => {
  const api = factory(); root.DeskBotState = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis, () => {
  const text = (value, max = 300) => typeof value === 'string' ? value.slice(0, max) : '';
  const timestamp = value => Number.isFinite(value) && value >= 0 ? value : 0;
  const oneOf = (value, options, fallback) => options.includes(value) ? value : fallback;
  function sanitizeBotState(source = {}) {
    if (!source || typeof source !== 'object') source = {};
    const config = source.config || {};
    let baseUrl = '';
    try { const url = new URL(config.baseUrl); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) baseUrl = url.href.slice(0, 2000).replace(/\/$/, ''); } catch {}
    const pending = source.pending;
    return {
      status: oneOf(source.status, ['idle', 'starting', 'running', 'stopping', 'error', 'unavailable'], 'unavailable'),
      sendMode: oneOf(source.sendMode, ['preview', 'approve', 'auto'], 'preview'),
      responseMode: oneOf(source.responseMode, ['ai', 'mimic', 'hybrid'], 'ai'),
      channelId: /^[a-f\d]{32}$/i.test(source.channelId || '') ? source.channelId.toLowerCase() : '',
      message: text(source.message),
      pending: pending && typeof pending.id === 'string' && typeof pending.response === 'string' && Number.isFinite(pending.expiresAt)
        ? { id: text(pending.id, 100), speech: text(pending.speech, 2000), response: text(pending.response, 200), expiresAt: timestamp(pending.expiresAt) } : null,
      events: (Array.isArray(source.events) ? source.events : []).slice(-50).filter(event => event && typeof event.type === 'string').map(event => ({
        id: text(event.id, 100), type: oneOf(event.type, ['heard', 'generated', 'proposed', 'skipped', 'filtered', 'error', 'sent', 'status', 'approved', 'preview', 'expired'], 'status'),
        at: timestamp(event.at), speech: text(event.speech, 2000), response: text(event.response, 200), reason: text(event.reason)
      })),
      config: { provider: oneOf(config.provider, ['ollama', 'openai_compatible'], 'ollama'), baseUrl,
        model: text(config.model, 200), apiKeySet: config.apiKeySet === true,
        keyStorage: oneOf(config.keyStorage, ['encrypted', 'session', 'none'], 'none') }
    };
  }
  function unavailableBot(message = '봇은 데스크톱 앱을 연결하면 사용할 수 있어요.') {
    return sanitizeBotState({ status: 'unavailable', message });
  }
  return { sanitizeBotState, unavailableBot };
});
