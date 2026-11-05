'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { BotService } = require('../lib/bot-service.cjs');
const { BotConfigStore, validateConfig } = require('../lib/bot-config-store.cjs');
const { sanitizeBotState } = require('../../browser-extension/shared/bot-state.js');

const state = () => ({ status: 'idle', sendMode: 'preview', responseMode: 'ai', events: [], config: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:8b', apiKeySet: false } });
function fixture({ respond = true, timeoutMs = 1000, saved = null, readAuth } = {}) {
  const calls = [], launches = [];
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', 0)); };
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const message = JSON.parse(chunk.toString()); calls.push(message); done();
    if (typeof respond === 'function' ? respond(message) : respond) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, ok: true, value: state() }) + '\n'));
  } });
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('exit', 0)));
  const store = { load: async () => saved, save: async () => 'encrypted', canEncrypt: () => true };
  const service = new BotService({ sourceRoot: path.resolve('/source'), dataDir: path.resolve('/profile'), store, timeoutMs, readAuth,
    exists: file => file.endsWith('main.py'), spawnImpl: (...args) => { launches.push(args); return child; } });
  return { service, child, calls, launches };
}

test('bot bridge is lazy and launches only fixed Python entrypoint without a shell/window', async t => {
  const { service, launches, calls } = fixture(); t.after(() => service.close());
  assert.equal(launches.length, 0); assert.equal(service.snapshot().status, 'unavailable');
  await Promise.all([service.getState(), service.getState()]);
  assert.equal(launches.length, 1);
  const [command, args, options] = launches[0];
  assert.equal(command, 'python'); assert.equal(args.at(-1), '--control');
  assert.equal(args[2], path.resolve('/source/main.py')); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert(calls.every(call => call.method === 'getState'));
});

test('saved key is passed only to configure and removed from state/unknown fields', async t => {
  const secret = 'secret-API-key';
  const saved = { provider: 'openai_compatible', baseUrl: 'https://example.test/v1', model: 'model', apiKey: secret };
  const { service, child, calls } = fixture({ saved }); t.after(() => service.close());
  await service.getState();
  assert.equal(calls.find(call => call.method === 'configure').arg.apiKey, secret);
  child.stdout.write(JSON.stringify({ event: 'state', state: { ...state(), apiKey: secret, message: secret,
    events: [{ id: '1', type: 'generated', speech: secret, response: '응답', token: secret }], config: { ...state().config, apiKey: secret } } }) + '\n');
  const output = JSON.stringify(service.snapshot());
  assert(!output.includes(secret)); assert(!output.includes('token')); assert(service.snapshot().config.apiKeySet);
});

test('malformed output and unexpected process exit fail closed without raw logs', async () => {
  const { service, child } = fixture({ respond: false });
  const request = service.getState(); await new Promise(resolve => setImmediate(resolve));
  child.stderr.write('secret log path'); child.stdout.write('secret malformed payload\n');
  await assert.rejects(request, /응답 형식/); assert(child.killed);
  assert(!JSON.stringify(service.snapshot()).includes('secret')); await service.close();
});

test('oversized output and request timeout terminate the child and reject pending calls', async () => {
  for (const oversized of [true, false]) {
    const { service, child } = fixture({ respond: false, timeoutMs: 15 });
    const request = service.getState(); await new Promise(resolve => setImmediate(resolve));
    if (oversized) child.stdout.write('x'.repeat(1048577));
    await assert.rejects(request, oversized ? /너무 커/ : /응답하지/);
    assert(child.killed); assert.equal(service.pending.size, 0); await service.close();
  }
});

test('stop reaches stdin while a previous request is pending, and close rejects late requests', async t => {
  const { service, child, calls } = fixture({ respond: message => message.method !== 'preview' }); t.after(() => service.close());
  await service.getState();
  const preview = service.command('preview', { speech: '문장' }); await new Promise(resolve => setImmediate(resolve));
  await service.command('stop');
  assert.deepEqual(calls.slice(-2).map(call => call.method), ['preview', 'stop']);
  child.stdout.write(JSON.stringify({ id: calls.find(call => call.method === 'preview').id, ok: true, value: state() }) + '\n'); await preview;
  await service.close(); await assert.rejects(service.getState(), /종료/);
  assert.equal(service.child, null); assert(child.stdin.writableEnded);
});

test('explicit send-session start refreshes app cookies privately; preview never reads login', async t => {
  let reads = 0;
  const { service, calls } = fixture({ readAuth: async () => { reads++; return { nidAut: 'SECRET_AUT', nidSes: 'SECRET_SES', nickname: 'private' }; } });
  t.after(() => service.close());
  const arg = { channelId: 'a'.repeat(32), sendMode: 'preview', responseMode: 'ai' };
  await service.command('start', arg); assert.equal(reads, 0);
  await service.command('start', { ...arg, sendMode: 'approve' });
  assert.equal(reads, 1);
  assert.deepEqual(calls.slice(-2).map(call => call.method), ['authenticate', 'start']);
  assert.deepEqual(calls.at(-2).arg, { nidAut: 'SECRET_AUT', nidSes: 'SECRET_SES' });
  assert(!JSON.stringify(service.snapshot()).includes('SECRET'));
  await assert.rejects(service.command('start', { ...arg, nidAut: 'injected' }), /확인/);
  await assert.rejects(service.command('authenticate', { nidAut: 'injected' }), /지원하지/);
});

test('stop cancels a start waiting for login and never revives it after cookie lookup', async t => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const { service, calls } = fixture({ readAuth: () => gate }); t.after(() => service.close());
  await service.getState();
  const start = service.command('start', { channelId: 'a'.repeat(32), sendMode: 'auto', responseMode: 'ai' });
  await new Promise(resolve => setImmediate(resolve)); await service.command('stop');
  finish({ nidAut: 'SECRET_AUT', nidSes: 'SECRET_SES' });
  await assert.rejects(start, /중지된/); assert(!calls.some(call => call.method === 'start' || call.method === 'authenticate'));
});

test('configuration validates transport and keeps an existing key when UI leaves it blank', () => {
  const old = { provider: 'openai_compatible', baseUrl: 'https://example.test/v1', model: 'chat', apiKey: 'old' };
  assert.equal(validateConfig({ apiKey: '' }, old).apiKey, 'old');
  assert.equal(validateConfig({ clearApiKey: true }, old).apiKey, '');
  assert.equal(validateConfig({ baseUrl: 'https://other.example/v1', apiKey: '' }, old).apiKey, '');
  assert.equal(validateConfig({ provider: 'ollama', baseUrl: 'http://localhost:11434' }, old).apiKey, '');
  assert.equal(validateConfig({ baseUrl: 'https://other.example/v1', apiKey: 'new-key' }, old).apiKey, 'new-key');
  assert.equal(validateConfig({ apiKey: '' }, { ...old, apiKey: undefined, apiKeySet: true }).apiKey, undefined);
  for (const baseUrl of ['http://external.test/v1', 'https://user:pass@example.test', 'https://example.test?key=abc', 'file:///private']) {
    assert.throws(() => validateConfig({ baseUrl }, old));
  }
  assert.equal(validateConfig({ baseUrl: 'http://localhost:1234/v1' }, old).baseUrl, 'http://localhost:1234/v1');
  assert.throws(() => validateConfig({ apiKey: 'abc\nHeader: bad' }, old));
  assert.throws(() => validateConfig({ apiKey: 'abc def' }, old));
  assert.throws(() => validateConfig({ baseUrl: 'https://example.test/v1/chat/completions' }, old));
  assert.throws(() => validateConfig({ executable: 'anything' }, old));
});

test('stop retains one reserved request slot when normal requests reach the cap', async () => {
  let ready = false;
  const { service, calls } = fixture({ respond: message => !ready || message.method === 'stop' });
  await service.getState(); ready = true;
  const waiting = Array.from({ length: 8 }, () => service.request('getState').catch(() => null));
  await assert.rejects(service.request('getState'), /진행 중/);
  await service.command('stop'); assert.equal(calls.at(-1).method, 'stop');
  await service.close(); await Promise.all(waiting);
});

test('a delayed command snapshot cannot overwrite a newer asynchronous worker state', async t => {
  const { service, child, calls } = fixture({ respond: message => message.method !== 'preview' });
  t.after(() => service.close()); await service.getState();
  const preview = service.command('preview', { speech: '오늘 방송' });
  await new Promise(resolve => setImmediate(resolve));
  const pending = calls.at(-1);
  child.stdout.write(JSON.stringify({ event: 'state', state: { ...state(), status: 'starting' } }) + '\n');
  child.stdout.write(JSON.stringify({ event: 'state', state: { ...state(), status: 'idle', message: '완료한 최신 결과',
    events: [{ id: 'result', type: 'generated', at: 1, response: '수고했네' }] } }) + '\n');
  child.stdout.write(JSON.stringify({ id: pending.id, ok: true, value: { ...state(), status: 'starting', message: '준비 중' } }) + '\n');
  const returned = await preview;
  assert.equal(returned.status, 'idle'); assert.equal(returned.message, '완료한 최신 결과');
  assert.equal(service.snapshot().events[0].id, 'result');
  assert.equal(service.snapshot().status, 'idle');
});

test('configuration storage never writes plaintext keys and degrades to session-only without encryption', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-bot-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = { provider: 'openai_compatible', baseUrl: 'https://example.test/v1', model: 'chat', apiKey: 'secret-only-memory' };
  const storage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from([...text].reverse().join('')), decryptString: data => [...data.toString()].reverse().join('') };
  const store = new BotConfigStore({ directory, safeStorage: storage });
  assert.equal(await store.save(config), 'encrypted');
  assert(!String(await fs.readFile(store.file)).includes(config.apiKey)); assert.deepEqual(await store.load(), config);
  storage.isEncryptionAvailable = () => false;
  assert.equal(await store.save(config), 'session');
  const disk = JSON.parse(await fs.readFile(store.file, 'utf8')); assert.equal(disk.encryptedKey, undefined); assert.equal(disk.apiKey, undefined);
  assert.equal((await store.load()).apiKey, '');
});

test('public bot schema bounds content and does not forward arbitrary fields or URL credentials', () => {
  const result = sanitizeBotState({ status: 'anything', token: 'secret', config: { baseUrl: 'https://user:secret@host/', apiKey: 'secret' },
    pending: { id: '1', response: 'x', expiresAt: NaN }, events: Array.from({ length: 100 }, (_, id) => ({ id: String(id), type: 'generated', speech: 'x'.repeat(10000), token: 'secret' })) });
  assert.equal(result.status, 'unavailable'); assert.equal(result.config.baseUrl, ''); assert.equal(result.pending, null);
  assert.equal(result.events.length, 50); assert.equal(result.events[0].speech.length, 2000); assert(!JSON.stringify(result).includes('secret'));
});
