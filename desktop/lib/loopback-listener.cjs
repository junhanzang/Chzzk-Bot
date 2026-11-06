'use strict';

// WHATWG Fetch §2.9, checked 2026-11-06:
// https://fetch.spec.whatwg.org/#port-blocking
// An OS-assigned free port can still be unusable by fetch/Chromium.
const BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080
]);
const MAX_LISTEN_ATTEMPTS = 8;
const fetchPortAllowed = port => Number.isInteger(port) && port > 0 && port <= 65535 && !BAD_PORTS.has(port);

function bind(server, port) {
  return new Promise((resolve, reject) => {
    const clean = () => { server.removeListener('error', failed); server.removeListener('listening', listening); };
    const failed = error => { clean(); reject(error); };
    const listening = () => { clean(); resolve(); };
    server.once('error', failed);
    server.once('listening', listening);
    try { server.listen({ host: '127.0.0.1', port, exclusive: true }); }
    catch (error) { failed(error); }
  });
}

async function closeCandidate(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function listenLoopback(server, { port = 0, isClosing = () => false } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (port !== 0 && !fetchPortAllowed(port))) {
    throw new Error('브라우저에서 사용할 수 있는 로컬 포트를 선택해 주세요.');
  }
  for (let attempt = 0; attempt < MAX_LISTEN_ATTEMPTS; attempt++) {
    if (isClosing()) throw new Error('로컬 연결이 종료되었습니다.');
    await bind(server, port);
    const address = server.address();
    const acceptable = address?.address === '127.0.0.1' && fetchPortAllowed(address.port);
    if (!isClosing() && acceptable) return address.port;
    await closeCandidate(server);
    if (isClosing()) throw new Error('로컬 연결이 종료되었습니다.');
    if (port !== 0) break;
  }
  throw new Error('브라우저에서 사용할 로컬 포트를 확보하지 못했습니다. 다시 시도해 주세요.');
}

module.exports = { listenLoopback, fetchPortAllowed, MAX_LISTEN_ATTEMPTS };
