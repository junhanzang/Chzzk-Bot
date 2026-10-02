'use strict';

// This is a fixture-driven UI/session test, not a successful real NAVER login.
// It never loads .env or reads an existing browser/app profile.
const { _electron: electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '../.artifacts');
const dataDir = path.join(root, `auth-${randomUUID()}`);
const channelId = '11111111111111111111111111111111';
const fixtureNickname = '로그인 검증용 계정';
const env = { ...process.env, DESK_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
let application;

async function waitUntil(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
}

async function fixtureState(update) {
  return application.evaluate((_electron, update) => {
    if (update) Object.assign(globalThis.__authSmokeFixture, update);
    const fixture = globalThis.__authSmokeFixture;
    return { loggedIn: fixture.loggedIn, statusCalls: fixture.statusCalls, playerLoads: fixture.playerLoads };
  }, update);
}

(async () => {
  await fs.mkdir(dataDir, { recursive: true });
  application = await electron.launch({
    executablePath: require('electron'), args: [path.resolve(__dirname, '..')], env, timeout: 30000
  });
  // Install fixtures before waiting for the first window. The fresh profile has
  // no real cookies even if the app's initial anonymous status check wins the race.
  await application.evaluate(({ session }, nickname) => {
    const fixture = globalThis.__authSmokeFixture = {
      loggedIn: false, nickname, statusCalls: 0, playerLoads: 0, cookieObservations: []
    };
    const remote = session.fromPartition('persist:chzzk-viewer');
    remote.protocol.handle('https', request => {
      const url = new URL(request.url);
      const html = body => new Response('<!doctype html><html><head><meta charset="utf-8">' +
        '<title>Auth fixture — no real login</title></head><body>' + body + '</body></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      if (url.hostname === 'comm-api.game.naver.com' && url.pathname === '/nng_main/v1/user/getUserStatus') {
        fixture.statusCalls++;
        return new Response(JSON.stringify({ code: 200, content: {
          loggedIn: fixture.loggedIn, nickname: fixture.loggedIn ? fixture.nickname : null
        } }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/__auth-cookie-probe') {
        const cookie = request.headers.get('cookie');
        fixture.cookieObservations.push({ host: url.hostname, present: cookie !== null,
          hasSynthetic: Boolean(cookie?.includes('NID_SES=AUTH_SMOKE_SYNTHETIC_ONLY')) });
        return new Response('fixture', { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.hostname === 'nid.naver.com' && url.pathname === '/nidlogin.login') {
        return html('<h1>가짜 로그인 화면</h1><p>실제 로그인 정보를 입력하지 마세요.</p>' +
          '<a id="return-to-chzzk" href="https://chzzk.naver.com/">검증용 치지직 복귀</a>' +
          '<iframe title="검증용 프레임" src="https://chzzk.naver.com/auth-smoke-frame"></iframe>');
      }
      if (url.hostname === 'chzzk.naver.com' && url.pathname === '/auth-smoke-frame') {
        return html('<p>별도 iframe fixture</p>');
      }
      if (url.hostname === 'chzzk.naver.com' && url.pathname.startsWith('/live/')) {
        fixture.playerLoads++;
        return html('<h1>가짜 방송 페이지</h1><p>실제 영상은 연결하지 않습니다.</p>');
      }
      if (url.hostname === 'chzzk.naver.com' && url.pathname === '/') return html('<h1>검증용 로그인 복귀 페이지</h1>');
      return new Response('Unconfigured test route', { status: 404 });
    });
  }, fixtureNickname);

  const page = await application.firstWindow();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => typeof window.desk?.refreshAuth === 'function');
  // Finish any initial request, then make a request that is certainly fixtured.
  await page.evaluate(() => window.desk.refreshAuth());
  const signedOut = await page.evaluate(() => window.desk.refreshAuth());
  assert.deepEqual(signedOut, { status: 'signed_out', nickname: null });
  assert.equal((await page.evaluate(() => window.desk.getState())).auth.status, 'signed_out');
  await page.waitForFunction(() => document.querySelector('#login-label')?.textContent === '네이버 로그인');

  await page.evaluate(channelId => window.desk.addChannel({ input: channelId, name: '로그인 검증용 방송' }), channelId);
  await waitUntil(async () => (await fixtureState()).playerLoads >= 1, 'initial player fixture load');
  const beforeLogin = await fixtureState();
  await page.evaluate(() => window.desk.login());
  await waitUntil(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .some(window => window.webContents.getURL().startsWith('https://nid.naver.com/nidlogin.login'))), 'direct NAVER login URL');
  const loginPage = application.windows().find(window => window.url().startsWith('https://nid.naver.com/nidlogin.login'));
  assert.ok(loginPage, 'The login BrowserWindow must be available');
  const loginUrl = new URL(loginPage.url());
  assert.equal(loginUrl.searchParams.get('url'), 'https://chzzk.naver.com/');
  await loginPage.locator('#return-to-chzzk').waitFor();
  await loginPage.frameLocator('iframe').locator('p').waitFor();
  assert.equal((await page.evaluate(() => window.desk.getState())).auth.status, 'signed_out',
    'Loading a CHZZK iframe must not count as a completed login');
  assert.equal((await fixtureState()).statusCalls, beforeLogin.statusCalls,
    'A CHZZK subframe must not trigger the main-frame login-return check');

  const beforeReturn = await fixtureState();
  await fixtureState({ loggedIn: true });
  // Click a real link in the fixture so the app's navigation/return handlers run.
  await loginPage.locator('#return-to-chzzk').click({ noWaitAfter: true });
  await waitUntil(async () => (await page.evaluate(() => window.desk.getState())).auth.status === 'signed_in', 'signed-in fixture state');
  await waitUntil(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1), 'login window closes');
  await waitUntil(async () => (await fixtureState()).playerLoads > beforeReturn.playerLoads, 'player reload after fixture login');
  const signedIn = await page.evaluate(() => window.desk.getState());
  assert.deepEqual(signedIn.auth, { status: 'signed_in', nickname: fixtureNickname });
  await page.waitForFunction(() => document.querySelector('#login-label')?.textContent === '로그인됨');
  assert.ok((await page.locator('#login-button').getAttribute('title')).includes(fixtureNickname));
  assert.ok(!JSON.stringify(signedIn).includes('NID_SES'), 'No cookie data may be exposed to the UI');
  assert.ok(signedIn.slots.every(slot => slot.replay.state === 'idle'), 'Logging in must not start recording');

  const cookieResult = await application.evaluate(async ({ session }) => {
    const remote = session.fromPartition('persist:chzzk-viewer');
    await remote.cookies.set({ url: 'https://naver.com/', domain: '.naver.com', path: '/',
      name: 'NID_SES', value: 'AUTH_SMOKE_SYNTHETIC_ONLY', secure: true, httpOnly: true, sameSite: 'no_restriction' });
    try {
      const apiCookies = await remote.cookies.get({ url: 'https://api.chzzk.naver.com/' });
      const cdnCookies = await remote.cookies.get({ url: 'https://nvelop-livecloud.pstatic.net/' });
      const apiResponse = await remote.fetch('https://api.chzzk.naver.com/__auth-cookie-probe', {
        credentials: 'include', headers: { Origin: 'https://chzzk.naver.com' }
      });
      await apiResponse.body?.cancel();
      const cdnResponse = await remote.fetch('https://nvelop-livecloud.pstatic.net/__auth-cookie-probe', {
        credentials: 'include', headers: { Origin: 'https://chzzk.naver.com' }
      });
      await cdnResponse.body?.cancel();
      return {
        jarApiScoped: apiCookies.some(cookie => cookie.name === 'NID_SES' && cookie.value === 'AUTH_SMOKE_SYNTHETIC_ONLY'),
        jarCdnScoped: cdnCookies.some(cookie => cookie.name === 'NID_SES'),
        observations: globalThis.__authSmokeFixture.cookieObservations
      };
    } finally { await remote.cookies.remove('https://naver.com/', 'NID_SES'); }
  });
  assert.equal(cookieResult.jarApiScoped, true, 'The synthetic .naver.com cookie should match the API domain');
  assert.equal(cookieResult.jarCdnScoped, false, 'The synthetic .naver.com cookie must not match the CDN domain');
  const apiObservation = cookieResult.observations.find(item => item.host === 'api.chzzk.naver.com');
  const cdnObservation = cookieResult.observations.find(item => item.host === 'nvelop-livecloud.pstatic.net');
  assert.ok(apiObservation && cdnObservation, 'Both fetch requests must reach their fixtures');
  assert.equal(cdnObservation.hasSynthetic, false, 'No NAVER cookie may appear at the CDN fixture');
  if (apiObservation.hasSynthetic) console.log('PASS: Synthetic session cookie transport is scoped to the NAVER API and absent from the CDN fixture.');
  else console.log('SKIP: HTTPS protocol fixtures do not expose the session Cookie header; native cookie-jar domain matching passed, but real network cookie transport was not verified.');

  await fixtureState({ loggedIn: false });
  assert.deepEqual(await page.evaluate(() => window.desk.refreshAuth()), { status: 'signed_out', nickname: null });
  await page.waitForFunction(() => document.querySelector('#login-label')?.textContent === '네이버 로그인');
  assert.deepEqual(pageErrors, []);
  console.log('PASS: Fixture-only auth UI/session flow — signed-out refresh, direct NAVER login window, isolated iframe, CHZZK return, signed-in nickname, login window close, player reload, and signed-out refresh.');
  console.log('LIMITATION: This uses synthetic responses in a new test profile. It does not verify a real NAVER login or real authenticated media access.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (application) await application.close();
});
