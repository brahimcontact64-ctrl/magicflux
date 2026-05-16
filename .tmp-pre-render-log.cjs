const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (msg) => logs.push(msg.type() + ': ' + msg.text()));
  await page.goto('http://localhost:3000/builder', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);
  console.log('URL=' + page.url());
  console.log('TITLE=' + await page.title());
  const text = await page.locator('body').innerText().catch(() => 'NO_BODY_TEXT');
  console.log('BODY=' + text.slice(0, 1000));
  console.log('LOGS_START');
  console.log(logs.join('\n'));
  console.log('LOGS_END');
  await browser.close();
})();
