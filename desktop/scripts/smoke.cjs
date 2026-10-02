'use strict';
const { _electron: electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../.artifacts');
const dataDir = path.join(root, `smoke-${randomUUID()}`);
const ids = ['11111111111111111111111111111111', '22222222222222222222222222222222'];
const env = { ...process.env, DESK_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE;
let application;

async function launch() {
  application = await electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '..')], env, timeout: 30000 });
  const page = await application.firstWindow();
  await page.waitForFunction(() => Boolean(window.desk));
  return page;
}
async function saveScreenshot(name) {
  await new Promise(resolve => setTimeout(resolve, 250));
  const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
  await fs.writeFile(path.join(root, name), Buffer.from(png, 'base64'));
}

(async () => {
  await fs.mkdir(root, { recursive: true });
  let page = await launch();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#recorder-status').textContent.includes('준비됨'));
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await saveScreenshot('desk-empty.png');
  await page.locator('#channel-input').fill('https://example.com/wrong');
  await page.locator('#add-channel').click();
  await page.waitForFunction(() => !document.querySelector('#notice').hidden);
  assert.equal((await page.evaluate(() => window.desk.getState())).channels.length, 0);
  // Intercept remote pages inside the isolated test session: no real channel, login or cookies are used.
  await application.evaluate(({ session }) => {
    session.fromPartition('persist:chzzk-viewer').protocol.handle('https', request => new Response(
      '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>검증용 플레이어</title></head>' +
      '<body style="background:#13212a;color:#a5dbbe;font:24px sans-serif;display:grid;place-items:center;height:90vh">' +
      '<div>검증용 방송 페이지<br><small style="font-size:14px">실제 생방송이 아닌 UI 테스트입니다.</small><p><input placeholder="채팅 입력 테스트"></p></div></body></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    ));
  });
  for (let i = 0; i < 2; i++) {
    await page.locator('#channel-input').fill(`https://chzzk.naver.com/live/${ids[i]}`);
    await page.locator('#channel-name').fill(`검증용 채널 ${i + 1}`);
    await page.locator('#add-channel').click();
    await page.waitForFunction(count => document.querySelectorAll('.channel-item').length === count, i + 1);
  }
  await page.waitForFunction(() => [...document.querySelectorAll('.player-card')].slice(0, 2)
    .every(card => card.querySelector('[data-role="page-status"]').textContent.startsWith('공식 치지직 페이지')));
  await page.locator('[data-slot="1"] [data-action="audio"]').click();
  const players = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map(view => ({
    url: view.webContents?.getURL(), muted: view.webContents?.isAudioMuted(), bounds: view.getBounds()
  })).filter(item => item.url?.startsWith('https://chzzk.naver.com/live/')));
  assert.equal(players.length, 2, JSON.stringify(players));
  assert.equal(players[0].muted, true); assert.equal(players[1].muted, false);
  assert.ok(players.every(player => player.bounds.width > 200 && player.bounds.height > 100), 'Native player bounds must update after assignment');
  await saveScreenshot('desk-two-players.png');
  await page.locator('#mute-button').click();
  assert.equal((await page.evaluate(() => window.desk.getState())).audioSlot, null);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 760));
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await saveScreenshot('desk-small.png');
  assert.deepEqual(errors, []);
  await application.close(); application = null;
  page = await launch();
  const restored = await page.evaluate(() => window.desk.getState());
  assert.equal(restored.channels.length, 2);
  assert.deepEqual(restored.slots.map(slot => slot.channelId), [...ids, null, null]);
  assert.equal(restored.audioSlot, null);
  assert.ok(restored.slots.every(slot => slot.replay.state === 'idle'), 'Recording must never restart silently');
  await page.evaluate(id => window.desk.assignSlot({ slotId: 1, channelId: id }), ids[0]);
  const race = await page.evaluate(async ids => {
    const results = await Promise.allSettled([
      window.desk.removeChannel(ids[0]),
      window.desk.assignSlot({ slotId: 1, channelId: ids[1] })
    ]);
    return { results: results.map(result => result.status), state: await window.desk.getState() };
  }, ids);
  assert.equal(race.results[0], 'fulfilled');
  // The competing switch either waits for a later retry or completes after deletion;
  // it must never report success and then lose the newly assigned channel.
  if (race.results[1] === 'fulfilled') assert.equal(race.state.slots[1].channelId, ids[1]);
  assert.ok(race.state.channels.every(channel => channel.id !== ids[0]));
  await page.evaluate(id => window.desk.assignSlot({ slotId: 1, channelId: id }), ids[1]);
  assert.equal((await page.evaluate(() => window.desk.getState())).slots[1].channelId, ids[1]);
  console.log('PASS: URL validation, isolated renderer, two native players, audio selection, bounds, small layout, persisted favorites, recording opt-in, concurrent deletion.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (application) await application.close(); });
