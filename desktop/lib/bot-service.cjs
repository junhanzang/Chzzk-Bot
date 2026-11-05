'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { BotConfigStore, validateConfig } = require('./bot-config-store.cjs');
const { sanitizeBotState, unavailableBot } = require('../../browser-extension/shared/bot-state.js');

const METHODS = new Set(['getState', 'configure', 'authenticate', 'preview', 'start', 'stop', 'approve']);
class BotService extends EventEmitter {
  constructor({ sourceRoot, dataDir, safeStorage, readAuth, spawnImpl = spawn, exists = fs.existsSync, timeoutMs = 12000, store }) {
    super(); this.sourceRoot = sourceRoot; this.dataDir = dataDir; this.spawn = spawnImpl; this.exists = exists; this.timeoutMs = timeoutMs;
    this.store = store || new BotConfigStore({ directory: dataDir, safeStorage });
    this.child = null; this.starting = null; this.pending = new Map(); this.nextId = 0; this.eventRevision = 0; this.closed = false;
    this.config = null; this.keyStorage = 'none'; this.redactions = new Set(); this.state = unavailableBot('봇 연결 확인을 누르면 설치 상태를 확인해요.');
    this.readAuth = readAuth; this.commandGeneration = 0;
    this.loaded = this.store.load().then(config => { this.config = config; if (config) { this.keyStorage = config.apiKey ? this.store.canEncrypt() ? 'encrypted' : 'session' : 'none'; this.state.config = this.publicConfig(); this.emit('change'); } });
  }
  publicConfig() { const config = this.config || {}; return { provider: config.provider || 'ollama', baseUrl: config.baseUrl || '', model: config.model || '', apiKeySet: config.apiKey === undefined ? this.state.config.apiKeySet : Boolean(config.apiKey), keyStorage: this.keyStorage }; }
  snapshot() { const value = sanitizeBotState(this.state); if (this.config) value.config = this.publicConfig(); else value.config.keyStorage = this.keyStorage; return value; }
  publish(value) {
    const keys = [...new Set([...this.redactions, this.config?.apiKey].filter(Boolean))];
    const redact = item => {
      if (typeof item === 'string') return keys.reduce((result, key) => result.split(key).join('[비공개]'), item);
      if (Array.isArray(item)) return item.map(redact);
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, redact(entry)]));
      return item;
    };
    this.state = redact(sanitizeBotState(value)); this.emit('change');
  }
  failure(message, child = this.child) {
    if (child && child !== this.child) return;
    if (child) { this.child = null; try { child.kill(); } catch {} }
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    this.pending.clear(); this.publish({ ...this.state, status: 'unavailable', message, pending: null });
  }
  async ensure() {
    if (this.closed) throw new Error('봇 연결을 종료하고 있습니다.');
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = (async () => {
      await this.loaded;
      if (this.closed) throw new Error('봇 연결을 종료하고 있습니다.');
      const script = path.join(this.sourceRoot, 'main.py');
      if (!this.exists(script)) { this.failure('봇 소스가 없습니다. 앱을 다시 설치하거나 소스 폴더에서 실행해 주세요.'); throw new Error(this.state.message); }
      const venv = [path.join(this.sourceRoot, '.venv', 'Scripts', 'python.exe'), path.join(this.sourceRoot, 'venv', 'Scripts', 'python.exe'), path.join(this.sourceRoot, '.venv', 'bin', 'python')].find(file => this.exists(file));
      let child;
      try {
        child = this.spawn(venv || 'python', ['-B', '-u', script, '--control'], {
          cwd: this.dataDir, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', CHZZK_BOT_DATA_DIR: this.dataDir }
        });
      } catch { this.failure('Python을 실행하지 못했어요. Python 3.11 이상과 봇 의존성을 준비해 주세요.'); throw new Error(this.state.message); }
      this.child = child;
      const decoder = new StringDecoder('utf8'); let buffer = '';
      child.stdout.on('data', chunk => {
        if (child !== this.child) return;
        buffer += decoder.write(chunk);
        if (buffer.length > 1048576) { this.failure('봇 응답이 너무 커 연결을 종료했어요.', child); return; }
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          let value; try { value = JSON.parse(line); } catch { this.failure('봇 응답 형식이 올바르지 않습니다.', child); return; }
          if (!value || typeof value !== 'object' || Array.isArray(value)) { this.failure('봇 응답 형식이 올바르지 않습니다.', child); return; }
          if (value.event === 'state' && value.state) { this.eventRevision++; this.publish(value.state); }
          else if (typeof value.id === 'string' && this.pending.has(value.id)) {
            const entry = this.pending.get(value.id); this.pending.delete(value.id); clearTimeout(entry.timer);
            if (value.ok === true) {
              // A worker may publish a newer state after the command took its
              // snapshot but before stdout writes the command response.
              if (value.value?.status && entry.eventRevision === this.eventRevision) this.publish(value.value);
              entry.resolve(this.snapshot());
            }
            else entry.reject(new Error('봇 요청을 처리하지 못했어요. 연결 설정과 실행 상태를 확인해 주세요.'));
          }
        }
      });
      // Dependency exceptions can contain paths or credentials. Never relay logs.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => this.failure('봇 프로세스 연결이 끊겼어요.', child));
      child.on('error', () => this.failure('Python을 실행하지 못했어요. Python 3.11 이상과 봇 의존성을 준비해 주세요.', child));
      child.on('exit', () => this.failure('봇 프로세스가 종료됐어요. 실행 환경을 확인한 뒤 다시 연결해 주세요.', child));
      await this.request('getState');
      if (this.config) await this.request('configure', this.config);
    })();
    try { return await this.starting; }
    catch (error) { if (this.child || this.state.status !== 'unavailable') this.failure('봇 연결을 준비하지 못했어요. Python 설치와 AI 설정을 확인해 주세요.'); throw new Error(this.state.message || '봇 연결을 준비하지 못했어요.'); }
    finally { this.starting = null; }
  }
  request(method, arg) {
    if (!METHODS.has(method) || !this.child || this.closed) return Promise.reject(new Error('봇이 연결되지 않았어요.'));
    if (this.pending.size >= 8 && (method !== 'stop' || [...this.pending.values()].some(entry => entry.method === 'stop'))) return Promise.reject(new Error('봇 요청이 진행 중입니다. 잠시 후 다시 시도해 주세요.'));
    const id = String(++this.nextId), line = JSON.stringify({ id, method, arg }) + '\n';
    if (line.length > 32768) return Promise.reject(new Error('봇 입력이 너무 깁니다.'));
    const child = this.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failure('봇이 응답하지 않아 연결을 종료했어요. 다시 연결해 주세요.', child), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, eventRevision: this.eventRevision });
      try { child.stdin.write(line); } catch { this.failure('봇 요청을 전달하지 못했어요.', child); }
    });
  }
  async getState() { await this.ensure(); return this.request('getState'); }
  async configure(arg) {
    await this.ensure();
    if (['starting', 'running', 'stopping'].includes(this.state.status)) throw new Error('봇을 중지한 뒤 AI 연결 설정을 바꿔 주세요.');
    const next = validateConfig(arg, this.config || this.state.config);
    if (next.apiKey) this.redactions.add(next.apiKey);
    await this.request('configure', next);
    this.config = next;
    try { this.keyStorage = await this.store.save(next); }
    catch { this.keyStorage = next.apiKey ? 'session' : 'none'; this.state.message = '이번 실행에 적용했지만 설정을 저장하지 못했어요.'; }
    this.emit('change'); return this.snapshot();
  }
  async command(method, arg) {
    if (!['preview', 'start', 'stop', 'approve'].includes(method)) throw new Error('지원하지 않는 봇 명령입니다.');
    if (method === 'stop') this.commandGeneration++;
    const generation = this.commandGeneration;
    const current = () => { if (generation !== this.commandGeneration || this.closed) throw new Error('중지된 봇 요청입니다. 다시 시작해 주세요.'); };
    if (method === 'start' && (!arg || typeof arg !== 'object' || Object.keys(arg).some(key => !['channelId', 'sendMode', 'responseMode'].includes(key)) ||
      !['preview', 'approve', 'auto'].includes(arg.sendMode) || !['ai', 'mimic', 'hybrid'].includes(arg.responseMode) || typeof arg.channelId !== 'string')) throw new Error('방송과 봇 실행 방식을 확인해 주세요.');
    await this.ensure(); current();
    if (method === 'start' && arg.sendMode !== 'preview') {
      if (!this.readAuth) throw new Error('봇 전송 전에 앱에서 네이버 로그인해 주세요.');
      const auth = await this.readAuth(); current();
      if (![auth?.nidAut, auth?.nidSes].every(value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[^\x21-\x7e]|;/.test(value))) throw new Error('앱의 네이버 로그인 상태를 확인해 주세요.');
      this.redactions.add(auth.nidAut); this.redactions.add(auth.nidSes);
      await this.request('authenticate', { nidAut: auth.nidAut, nidSes: auth.nidSes }); current();
    }
    return this.request(method, arg);
  }
  async close() {
    if (this.closed) return;
    const child = this.child;
    if (child) {
      try { child.stdin.write(JSON.stringify({ id: 'shutdown', method: 'stop' }) + '\n'); } catch {}
      child.stdin.end();
    }
    this.closed = true;
    this.commandGeneration++;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('봇 연결을 종료했습니다.')); }
    this.pending.clear(); this.child = null;
    if (child) await new Promise(resolve => { const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 1500); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
}
module.exports = { BotService };
