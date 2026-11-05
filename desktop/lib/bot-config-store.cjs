'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function validateConfig(input, current = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['provider', 'baseUrl', 'model', 'apiKey', 'clearApiKey'].includes(key))) throw new Error('AI 설정 형식이 올바르지 않습니다.');
  const provider = input.provider ?? current.provider ?? 'ollama';
  if (!['ollama', 'openai_compatible'].includes(provider)) throw new Error('지원하지 않는 AI 연결 방식입니다.');
  const baseUrl = String(input.baseUrl ?? current.baseUrl ?? (provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1')).trim().replace(/\/$/, '');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('올바른 AI 서버 주소를 입력해 주세요.'); }
  if (baseUrl.length > 2000 || /\s/.test(baseUrl) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      (provider === 'openai_compatible' && url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('외부 AI는 인증정보 없는 HTTPS 주소가 필요합니다.');
  if (provider === 'openai_compatible' && /\/chat\/completions\/?$/i.test(url.pathname)) throw new Error('/chat/completions를 제외한 기본 주소를 입력해 주세요. 예: https://api.openai.com/v1');
  const model = String(input.model ?? current.model ?? '').trim();
  if (!model || model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) throw new Error('사용할 모델 이름을 입력해 주세요.');
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[^\x21-\x7e]/.test(input.apiKey))) throw new Error('API 키에는 공백·제어문자·한글을 사용할 수 없습니다.');
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') throw new Error('API 키 설정이 올바르지 않습니다.');
  const changedDestination = (current.provider && current.provider !== provider) || (current.baseUrl && current.baseUrl.replace(/\/$/, '') !== baseUrl);
  const apiKey = input.clearApiKey ? '' : input.apiKey || (changedDestination ? '' : current.apiKey ?? (current.apiKeySet ? undefined : ''));
  return { provider, baseUrl, model, ...(apiKey === undefined ? {} : { apiKey }) };
}

class BotConfigStore {
  constructor({ directory, safeStorage, fsImpl = fs }) { this.file = path.join(directory, 'bot-connection.json'); this.safeStorage = safeStorage; this.fs = fsImpl; }
  canEncrypt() { try { return Boolean(this.safeStorage?.isEncryptionAvailable()) && this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; } catch { return false; } }
  async load() {
    try {
      const stat = await this.fs.stat(this.file); if (stat.size > 32768) return null;
      const stored = JSON.parse(await this.fs.readFile(this.file, 'utf8'));
      let apiKey = '';
      if (typeof stored.encryptedKey === 'string' && stored.encryptedKey.length < 22000 && this.canEncrypt()) {
        try { apiKey = this.safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64')); } catch {}
      }
      return validateConfig({ provider: stored.provider, baseUrl: stored.baseUrl, model: stored.model, apiKey });
    } catch { return null; }
  }
  async save(config) {
    const stored = { version: 1, provider: config.provider, baseUrl: config.baseUrl, model: config.model };
    let keyStorage = config.apiKey ? 'session' : 'none';
    if (config.apiKey && this.canEncrypt()) { stored.encryptedKey = this.safeStorage.encryptString(config.apiKey).toString('base64'); keyStorage = 'encrypted'; }
    await this.fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try { await this.fs.writeFile(temporary, JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 }); await this.fs.rename(temporary, this.file); }
    finally { await this.fs.unlink(temporary).catch(() => {}); }
    return keyStorage;
  }
}

module.exports = { BotConfigStore, validateConfig };
