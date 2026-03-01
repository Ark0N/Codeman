import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto('http://localhost:3099', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

await page.locator('.session-tab').first().click();
await page.waitForTimeout(4000);

// Enable local echo and update state
await page.evaluate(() => {
  const settings = JSON.parse(localStorage.getItem('codeman-settings') || '{}');
  settings.localEchoEnabled = true;
  localStorage.setItem('codeman-settings', JSON.stringify(settings));
  if (window.app?.updateLocalEchoState) window.app.updateLocalEchoState();
});
await page.waitForTimeout(500);

// Force render with fake prompt position and inspect
const result = await page.evaluate(() => {
  const overlay = window.app?._localEchoOverlay;
  if (!overlay || !overlay._overlay) return { error: 'no overlay' };
  
  const term = overlay._terminal;
  const dims = term._core._renderService.dimensions;
  const cellH = dims.css.cell.height;
  const charTop = dims.device?.char?.top ?? 0;
  const charHeight = dims.device?.char?.height ?? cellH;
  
  // Calculate the correction
  const cssCenter = (cellH - charHeight) / 2;
  const correction = charTop - cssCenter;
  
  // Force render
  overlay._lastPromptPos = { row: 5, col: 0 };
  overlay._pendingText = 'hello test';
  overlay._lastRenderKey = '';
  overlay._render();
  
  const spans = overlay._overlay.querySelectorAll('span');
  const firstChar = Array.from(spans).find(s => s.textContent === 'h');
  
  return {
    cellH, charTop, charHeight,
    cssCenter,
    correction: correction.toFixed(2),
    firstChar: firstChar ? {
      top: firstChar.style.top,
      height: firstChar.style.height,
      lineHeight: firstChar.style.lineHeight,
      transform: firstChar.style.transform,
    } : null,
  };
});
console.log('Fix result:', JSON.stringify(result, null, 2));

// Take screenshot
await page.locator('.xterm-screen').first().screenshot({ path: '/tmp/fix-verify-term.png' });
console.log('Screenshot saved');

// Clean up
await page.evaluate(() => {
  window.app?._localEchoOverlay?.clear();
});

await browser.close();
console.log('Done');
