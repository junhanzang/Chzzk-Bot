'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { listenLoopback, fetchPortAllowed, MAX_LISTEN_ATTEMPTS } = require('../lib/loopback-listener.cjs');

class FakeServer extends EventEmitter {
  constructor(ports) { super(); this.ports = ports; this.calls = []; this.closes = 0; this.listening = false; this.killConnections = 0; }
  listen(options) {
    assert.equal(this.listening, false, 'Close the rejected candidate before rebinding');
    this.calls.push(options);
    queueMicrotask(() => {
      this.port = this.ports.shift();
      if (this.port instanceof Error) this.emit('error', this.port);
      else { this.listening = true; this.emit('listening'); }
    });
    return this;
  }
  address() { return this.listening ? { address: '127.0.0.1', family: 'IPv4', port: this.port } : null; }
  close(callback) { this.closes++; this.listening = false; queueMicrotask(callback); }
  closeAllConnections() { this.killConnections++; }
}

test('fetch-blocked ephemeral ports are closed and rebound before a URL is published', async () => {
  const server = new FakeServer([10080, 6667, 49152]);
  assert.equal(await listenLoopback(server), 49152);
  assert.equal(server.closes, 2); assert.equal(server.killConnections, 2);
  assert(server.calls.every(options => options.host === '127.0.0.1' && options.port === 0 && options.exclusive === true));
  assert.equal(server.listenerCount('error'), 0); assert.equal(server.listenerCount('listening'), 0);
});

test('exhausted blocked selections terminate after bounded retries and release every candidate', async () => {
  const server = new FakeServer(Array(MAX_LISTEN_ATTEMPTS).fill(10080));
  await assert.rejects(listenLoopback(server), /확보하지 못했습니다/);
  assert.equal(server.calls.length, MAX_LISTEN_ATTEMPTS); assert.equal(server.closes, MAX_LISTEN_ATTEMPTS);
  assert.equal(server.listening, false);
});

test('requested blocked ports reject before binding and safe fixed ports are preserved', async () => {
  for (const port of [0, 1, 22, 77, 554, 2049, 6000, 6667, 10080, 65536, NaN, -1, 1.5]) assert.equal(fetchPortAllowed(port), false);
  for (const port of [80, 443, 3000, 49152, 65535]) assert.equal(fetchPortAllowed(port), true);
  const server = new FakeServer([43210]);
  await assert.rejects(listenLoopback(server, { port: 10080 }), /포트/); assert.equal(server.calls.length, 0);
  assert.equal(await listenLoopback(server, { port: 43210 }), 43210); assert.equal(server.calls[0].port, 43210);
});

test('closing during a bind releases the candidate and never retries; bind errors retain no temporary listeners', async () => {
  const server = new FakeServer([49152]); let closing = false;
  const pending = listenLoopback(server, { isClosing: () => closing }); closing = true;
  await assert.rejects(pending, /종료/); assert.equal(server.closes, 1); assert.equal(server.calls.length, 1);
  const failure = new FakeServer([new Error('bind failed')]);
  await assert.rejects(listenLoopback(failure), /bind failed/); assert.equal(failure.calls.length, 1);
  assert.equal(failure.listenerCount('error'), 0); assert.equal(failure.listenerCount('listening'), 0);
  const sync = new FakeServer([]); sync.listen = () => { throw new Error('sync'); };
  await assert.rejects(listenLoopback(sync), /sync/); assert.equal(sync.listenerCount('error'), 0);
});

test('a listener reporting a non-loopback address is closed instead of being returned', async () => {
  const server = new FakeServer([49152]); server.address = () => ({ address: '0.0.0.0', port: 49152 });
  await assert.rejects(listenLoopback(server, { port: 49152 }), /확보/);
  assert.equal(server.listening, false); assert.equal(server.closes, 1);
});
