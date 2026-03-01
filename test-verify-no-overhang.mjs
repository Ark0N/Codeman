import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto('http://localhost:3099', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await page.locator('.session-tab').first().click();
await page.waitForTimeout(4000);

await page.evaluate(() => {
  const settings = JSON.parse(localStorage.getItem('codeman-settings') || '{}');
  settings.localEchoEnabled = true;
  localStorage.setItem('codeman-settings', JSON.stringify(settings));
  if (window.app?.updateLocalEchoState) window.app.updateLocalEchoState();
});

const result = await page.evaluate(() => {
  const overlay = window.app?._localEchoOverlay;
  if (!overlay) return { error: 'no overlay' };
  
  overlay._lastPromptPos = { row: 5, col: 0 };
  overlay._pendingText = 'hello test';
  overlay._lastRenderKey = '';
  overlay._render();
  
  const container = overlay._overlay;
  const lineDiv = container.querySelector('div');
  const charSpan = container.querySelector('div > span');
  
  const lineDivRect = lineDiv?.getBoundingClientRect();
  const charSpanRect = charSpan?.getBoundingClientRect();
  
  return {
    lineDiv: { bottom: lineDivRect?.bottom, height: lineDivRect?.height },
    charSpan: {
      bottom: charSpanRect?.bottom,
      height: charSpanRect?.height,
      transform: charSpan?.style.transform,
      top: charSpan?.style.top,
      lineHeight: charSpan?.style.lineHeight,
    },
    extendsBelow: charSpanRect && lineDivRect ?
      (charSpanRect.bottom - lineDivRect.bottom).toFixed(4) : 'N/A',
  };
});
console.log(JSON.stringify(result, null, 2));

// Screenshot
const screenEl = page.locator('.xterm-screen').first();
const screenBox = await screenEl.boundingBox();
if (screenBox) {
  await page.screenshot({
    path: '/tmp/no-overhang-zoomed.png',
    clip: { x: screenBox.x, y: screenBox.y + 4 * 19, width: 200, height: 57 },
  });
}

await page.evaluate(() => { window.app?._localEchoOverlay?.clear(); });
await browser.close();
console.log('Done');
