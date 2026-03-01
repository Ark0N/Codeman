import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto('http://localhost:3099', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await page.locator('.session-tab').first().click();
await page.waitForTimeout(4000);

// Enable local echo
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('codeman-settings') || '{}');
  s.localEchoEnabled = true;
  localStorage.setItem('codeman-settings', JSON.stringify(s));
  window.app?.updateLocalEchoState?.();
});
await page.waitForTimeout(500);

// Force render overlay with single char at a realistic prompt position
await page.evaluate(() => {
  const ov = window.app?._localEchoOverlay;
  if (!ov) return;
  // Find actual bottom row for a realistic position
  const buf = ov._terminal?.buffer?.active;
  const row = buf ? Math.max(0, buf.baseY + ov._terminal.rows - 2) - buf.viewportY : 5;
  ov._lastPromptPos = { row, col: 0 };
  ov._pendingText = 'hello test';
  ov._lastRenderKey = '';
  ov._render();
});
await page.waitForTimeout(500);

// Take full-page and zoomed screenshots
await page.screenshot({ path: '/tmp/sc-full.png' });

// Zoom into overlay area — find where the overlay actually is
const overlayRect = await page.evaluate(() => {
  const ov = window.app?._localEchoOverlay?._overlay;
  if (!ov) return null;
  const r = ov.getBoundingClientRect();
  const lineDiv = ov.querySelector('div');
  const lr = lineDiv?.getBoundingClientRect();
  return {
    container: { x: r.x, y: r.y, w: r.width, h: r.height },
    lineDiv: lr ? { x: lr.x, y: lr.y, w: lr.width, h: lr.height } : null,
  };
});
console.log('Overlay rect:', JSON.stringify(overlayRect));

if (overlayRect?.lineDiv) {
  const ld = overlayRect.lineDiv;
  // Capture area around the overlay: 1 row above, the overlay, 1 row below
  const margin = 20; // ~1 cell height
  await page.screenshot({
    path: '/tmp/sc-overlay-zoomed.png',
    clip: {
      x: Math.max(0, ld.x - 5),
      y: Math.max(0, ld.y - margin),
      width: Math.min(400, ld.w),
      height: ld.h + margin * 2 + 5,
    },
  });
  console.log('Zoomed screenshot saved');
}

await page.evaluate(() => { window.app?._localEchoOverlay?.clear(); });
await browser.close();
console.log('Done');
