import { chromium } from 'playwright';

const SESSION_ID = '9270f4e4-84f7-414c-b901-837f12c30e59';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

page.on('console', msg => {
  if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text());
});

await page.goto('http://localhost:3099', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

// Click on test session tab
const tab = page.locator(`.session-tab[data-id="${SESSION_ID}"]`);
if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
  await tab.click();
  await page.waitForTimeout(2000);
} else {
  console.log('Tab not found, using whatever is active');
}

await page.waitForTimeout(2000);

// Ensure local echo is OFF
const localEchoToggle = page.locator('#localEchoToggle');
const isChecked = await localEchoToggle.isChecked().catch(() => false);
console.log('Local echo initially:', isChecked);

if (isChecked) {
  await localEchoToggle.click();
  await page.waitForTimeout(500);
}

// Type with echo OFF
await page.locator('.xterm-helper-textarea').first().focus();
await page.waitForTimeout(300);
await page.keyboard.type('hello test', { delay: 80 });
await page.waitForTimeout(1000);

const termScreen = page.locator('.xterm-screen').first();
await termScreen.screenshot({ path: '/tmp/echo-off-term.png' });
console.log('Saved /tmp/echo-off-term.png');

// Clear
for (let i = 0; i < 10; i++) await page.keyboard.press('Backspace');
await page.waitForTimeout(500);

// Enable local echo
await localEchoToggle.click();
await page.waitForTimeout(500);
console.log('Local echo now:', await localEchoToggle.isChecked().catch(() => false));

// Type with echo ON
await page.locator('.xterm-helper-textarea').first().focus();
await page.waitForTimeout(300);
await page.keyboard.type('hello test', { delay: 80 });
await page.waitForTimeout(1500);

await termScreen.screenshot({ path: '/tmp/echo-on-term.png' });
console.log('Saved /tmp/echo-on-term.png');
await page.screenshot({ path: '/tmp/echo-on-full.png' });

// Inspect overlay DOM
const overlayInfo = await page.evaluate(() => {
  const overlay = document.querySelector('.zl-overlay');
  if (!overlay) return { found: false };

  const firstDiv = overlay.querySelector('div');
  const spans = overlay.querySelectorAll('span');
  const firstCharSpan = Array.from(spans).find(s => s.textContent && s.textContent.trim());

  return {
    found: true,
    display: overlay.style.display,
    top: overlay.style.top,
    containerOverflow: overlay.style.overflow,
    containerHeight: overlay.style.height,
    firstDiv: firstDiv ? {
      height: firstDiv.style.height,
      top: firstDiv.style.top,
      overflow: firstDiv.style.overflow,
      backgroundColor: firstDiv.style.backgroundColor,
    } : null,
    firstCharSpan: firstCharSpan ? {
      text: firstCharSpan.textContent,
      transform: firstCharSpan.style.transform,
      top: firstCharSpan.style.top,
      height: firstCharSpan.style.height,
      lineHeight: firstCharSpan.style.lineHeight,
      width: firstCharSpan.style.width,
    } : null,
    spanCount: spans.length,
  };
});
console.log('\nOverlay info:', JSON.stringify(overlayInfo, null, 2));

// Cell dimensions
const cellInfo = await page.evaluate(() => {
  if (window.app?.sessions) {
    for (const [, s] of Object.entries(window.app.sessions)) {
      const dims = s.terminal?._core?._renderService?.dimensions;
      if (dims) return { css: dims.css?.cell, device_char: dims.device?.char };
    }
  }
  return { error: 'not found' };
});
console.log('Cell dims:', JSON.stringify(cellInfo, null, 2));

// Cleanup
await page.evaluate(async (id) => {
  await fetch('/api/sessions/' + id, { method: 'DELETE' });
}, SESSION_ID);

await browser.close();
console.log('\nDone');
