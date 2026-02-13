/**
 * Take screenshots of the typing-visible-below bug.
 * Intercepts input to prevent damage to live sessions.
 */
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--window-size=1280,800'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Intercept input to prevent sending to real sessions
  await page.route('**/api/sessions/*/input', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '{"success":true}'
  }));

  console.log('Opening Claudeman...');
  await page.goto('http://localhost:3000');
  await page.waitForSelector('.xterm-screen', { timeout: 10000 });
  await page.waitForTimeout(3000);

  // Screenshot 1: Before typing
  await page.screenshot({ path: '/tmp/before-typing.png' });
  console.log('Screenshot 1: /tmp/before-typing.png');

  // Click on the terminal to focus it
  await page.click('.xterm-screen');
  await page.waitForTimeout(500);

  // Type a short string
  await page.keyboard.type('hello world this is a test', { delay: 30 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/after-short-typing.png' });
  console.log('Screenshot 2: /tmp/after-short-typing.png');

  // Type a LONG string that approaches the right edge
  await page.keyboard.type(' and now I am typing a very long line that should approach the right edge of the terminal to test whether text wraps incorrectly below the status bar area which would be the typing visible below bug', { delay: 15 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/after-long-typing.png' });
  console.log('Screenshot 3: /tmp/after-long-typing.png');

  // Wait for flush + SIGWINCH to settle
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/after-settle.png' });
  console.log('Screenshot 4: /tmp/after-settle.png (after 1s settle)');

  // Try typing even MORE to really push past the edge
  await page.keyboard.type(' AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH IIII JJJJ KKKK LLLL MMMM NNNN OOOO PPPP', { delay: 10 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/after-overflow.png' });
  console.log('Screenshot 5: /tmp/after-overflow.png (past right edge)');

  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/after-overflow-settle.png' });
  console.log('Screenshot 6: /tmp/after-overflow-settle.png (settled)');

  await browser.close();
  console.log('Done');
}

main().catch(err => { console.error(err); process.exit(1); });
