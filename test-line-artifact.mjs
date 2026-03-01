import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, deviceScaleFactor: 2 });
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
await page.waitForTimeout(500);

// Force render and capture zoomed area of just the overlay
const result = await page.evaluate(() => {
  const overlay = window.app?._localEchoOverlay;
  if (!overlay || !overlay._overlay) return { error: 'no overlay' };
  
  overlay._lastPromptPos = { row: 5, col: 0 };
  overlay._pendingText = 'h';
  overlay._lastRenderKey = '';
  overlay._render();
  
  const container = overlay._overlay;
  const lineDiv = container.querySelector('div');
  const charSpan = container.querySelector('div > span');
  
  // Get precise rects
  const lineDivRect = lineDiv?.getBoundingClientRect();
  const charSpanRect = charSpan?.getBoundingClientRect();
  const screenRect = document.querySelector('.xterm-screen')?.getBoundingClientRect();
  
  // Check what's right below the line div
  const belowY = (lineDivRect?.bottom || 0) + 1;
  const belowX = lineDivRect?.left || 0;
  const elBelow = document.elementFromPoint(belowX, belowY);
  
  return {
    dpr: window.devicePixelRatio,
    lineDiv: {
      rect: lineDivRect,
      bg: lineDiv?.style.backgroundColor,
      height: lineDiv?.style.height,
    },
    charSpan: {
      rect: charSpanRect,
      transform: charSpan?.style.transform,
      // Check if span bottom exceeds lineDiv bottom
      extendsBelow: charSpanRect && lineDivRect ? 
        (charSpanRect.bottom - lineDivRect.bottom).toFixed(2) : 'N/A',
    },
    elBelow: elBelow ? {
      tag: elBelow.tagName,
      class: elBelow.className,
    } : null,
    // Check the exact background color of the canvas
    canvasBg: document.querySelector('.xterm-screen')?.style.backgroundColor,
    themeBg: window.app?.terminal?.options?.theme?.background,
    overlayBg: lineDiv?.style.backgroundColor,
  };
});
console.log(JSON.stringify(result, null, 2));

// Take tight screenshot around the first char area
const screenEl = page.locator('.xterm-screen').first();
const screenBox = await screenEl.boundingBox();
if (screenBox) {
  // Crop to just the overlay area (row 5, first few columns)
  const cellH = 19;
  const promptRow = 5;
  const cropY = screenBox.y + (promptRow - 1) * cellH;
  const cropH = cellH * 3;
  await page.screenshot({
    path: '/tmp/first-char-zoomed.png',
    clip: { x: screenBox.x, y: cropY, width: 200, height: cropH },
  });
  console.log('Zoomed screenshot saved');
}

await page.evaluate(() => { window.app?._localEchoOverlay?.clear(); });
await browser.close();
console.log('Done');
