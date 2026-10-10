const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');

(async () => {
  const { createDemoServer } = await import('../server.mjs');
  const server = createDemoServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(fs.existsSync(edge) ? { executablePath: edge } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addInitScript(() => {
      window.__readouts = [];
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      Object.defineProperty(window, 'speechSynthesis', { value: { cancel() {}, getVoices() { return []; }, speak(u) { window.__readouts.push(u.text); u.onstart?.(); u.onend?.(); } } });
      window.SpeechRecognition = class { start() { window.__recognizer = this; this.onstart?.(); } stop() { this.onend?.(); } };
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    const idle = () => page.waitForFunction(() => !document.querySelector('#send').disabled);
    const send = async text => { await page.locator('#prompt').fill(text); await page.locator('#send').click(); await idle(); };
    const choose = async value => { await page.locator('[data-choice="' + value + '"]').click(); await idle(); };
    const approve = async () => {
      await page.locator('#review').click();
      assert.equal(await page.locator('#approve').isDisabled(), true);
      await page.locator('#confirm-check').check(); await page.locator('#approve').click();
      await page.waitForFunction(() => !document.querySelector('#confirm-dialog').open);
      await idle();
    };
    const reset = async () => {
      await page.locator('#reset').click(); await page.locator('#confirm-reset').click();
      await page.waitForFunction(() => !document.querySelector('#reset-dialog').open); await idle();
    };
    await idle();
    await page.locator('#font-size').click(); await page.locator('#speech-rate').selectOption('0.7'); await page.locator('#auto-read').uncheck();
    await page.reload(); await idle();
    assert.equal(await page.locator('#font-size').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#speech-rate').inputValue(), '0.7');
    assert.equal(await page.locator('#auto-read').isChecked(), false);
    await page.locator('#font-size').click(); await page.locator('#auto-read').check();
    await page.locator('#help').click(); await page.locator('#close-help').click();

    await page.locator('#voice').click();
    assert.equal(await page.locator('#voice').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => { window.__recognizer.onresult({ results: [[{ transcript: '给小明转三百块' }]] }); window.__recognizer.stop(); });
    assert.equal(await page.locator('#draft-status').textContent(), '待生成');
    assert.equal(await page.locator('#prompt').inputValue(), '给小明转三百块');
    await page.locator('#send').click(); await idle();
    assert.equal(await page.locator('.guided-question').count(), 1);
    await choose('SGD'); await choose('savings');
    await send('金额改成五百');
    assert.match(await page.locator('#draft-content .item-amount').textContent(), /500.00/);
    await page.locator('[data-edit-index="0"]').click();
    await page.locator('#edit-value').fill('1.005'); await page.locator('#save-edit').click();
    assert.match(await page.locator('#edit-error').textContent(), /两位小数/);
    await page.locator('#edit-value').fill('400'); await page.locator('#save-edit').click();
    await page.waitForFunction(() => !document.querySelector('#edit-dialog').open); await idle();
    await page.locator('[data-edit-index="0"]').click(); await page.locator('#edit-field').selectOption('source');
    await page.locator('#edit-value').selectOption('current'); await page.locator('#save-edit').click();
    await page.waitForFunction(() => !document.querySelector('#edit-dialog').open); await idle();
    await page.locator('#read-draft').click();
    const text = await page.evaluate(() => window.__readouts.at(-1));
    assert.match(text, /400新加坡元/); assert.match(text, /6 0 0 8/); assert.match(text, /往来账户/);
    assert.equal(await page.locator('#current').textContent(), '3,200.00');

    // Commit on the server but drop its response: UI must query, not pay twice.
    await page.route('**/api/execute', async route => { await route.fetch(); await route.abort('failed'); }, { times: 1 });
    await approve();
    assert.equal(await page.locator('#current').textContent(), '2,800.00');
    assert.equal(await page.locator('#transaction-count').textContent(), '1');
    assert.equal(await page.locator('.payment-receipt').count(), 1);
    assert.equal(await page.locator('#recovery-banner').isVisible(), false);
    await page.reload(); await idle();
    assert.equal(await page.locator('#current').textContent(), '2,800.00');
    await page.locator('#reset').click(); await page.locator('#cancel-reset').click();
    assert.equal(await page.locator('#current').textContent(), '2,800.00');

    // A lost/unresolved request survives refresh and blocks new payments.
    await send('从储蓄账户给妈妈转200新元');
    await page.evaluate(async () => { const s = await fetch('/api/state').then(r => r.json()); sessionStorage.setItem('dcta-pending', s.draft.id); });
    await page.reload(); await page.locator('#recovery-banner').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#send').isDisabled(), true);
    await page.locator('#stop-pending').click(); await idle();
    assert.equal(await page.locator('#draft-status').textContent(), '已取消');
    assert.equal(await page.locator('#savings').textContent(), '12,500.00');
    await reset();

    await send('给 John 转500'); await choose('john-tan'); await choose('SGD'); await choose('savings');
    await approve();
    await send('从储蓄账户给妈妈转200新元，再给Alice转150新元');
    assert.equal(await page.locator('#draft-content .transfer-item').count(), 2); await approve();
    await send('从储蓄账户给妈妈转2500新元'); assert.equal(await page.locator('#review').count(), 0);
    await page.locator('[data-tab="lab"]').click();
    for (const name of ['unsigned', 'tamper', 'replay', 'injection', 'audit']) {
      await page.locator('[data-lab="' + name + '"]').click(); await idle();
      assert.match(await page.locator('#lab-result').textContent(), /拦截与账本检查通过/);
    }
    await page.locator('[data-tab="audit"]').click();
    assert.match(await page.locator('#integrity').textContent(), /已验证/);
    await page.locator('[data-tab="transfer"]').click(); await reset();
    await send('<img src=x onerror="window.__xss=true">'); assert.equal(await page.evaluate(() => window.__xss), undefined);

    const output = path.resolve(__dirname, '../output'); fs.mkdirSync(output, { recursive: true });
    await reset(); await page.locator('#toast').evaluate(el => { el.hidden = true; });
    await page.screenshot({ path: path.join(output, 'senior-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await send('给小明转三百块'); await choose('SGD'); await choose('savings');
    await page.locator('#font-size').click();
    for (const width of [320, 390, 768, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No overflow at ' + width);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'senior-mobile-review.png'), fullPage: true });
    await approve(); assert.equal(await page.locator('#savings').textContent(), '12,200.00');
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: guided transfer, voice events, preferences, amendments, dropped response, pending recovery, mobile, lab, audit and XSS.');
    console.log('Speech events are mocked; microphone recognition quality requires a real-device check.');
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
