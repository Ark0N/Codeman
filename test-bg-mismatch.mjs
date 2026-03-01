import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto('http://localhost:3099', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await page.locator('.session-tab').first().click();
await page.waitForTimeout(4000);

// Sample the ACTUAL canvas pixel color at an empty area
const colorInfo = await page.evaluate(() => {
  const term = window.app?.terminal;
  if (!term) return { error: 'no terminal' };
  
  // Find the WebGL canvas
  const screen = term.element?.querySelector('.xterm-screen');
  const canvases = screen?.querySelectorAll('canvas');
  
  const results = {};
  
  for (const canvas of canvases || []) {
    const ctx = canvas.getContext('2d') || canvas.getContext('webgl') || canvas.getContext('webgl2');
    const ctxType = ctx?.constructor?.name;
    
    if (ctx && (ctxType === 'CanvasRenderingContext2D')) {
      // 2D context — can read pixels directly
      try {
        const pixel = ctx.getImageData(10, 10, 1, 1).data;
        results['2d'] = {
          r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3],
          hex: '#' + [pixel[0], pixel[1], pixel[2]].map(v => v.toString(16).padStart(2, '0')).join(''),
        };
      } catch (e) {
        results['2d'] = { error: e.message };
      }
    } else if (ctx) {
      // WebGL context — use readPixels
      try {
        const gl = ctx;
        const pixel = new Uint8Array(4);
        // Read from an empty area (bottom-left corner, row 0 col 0)
        gl.readPixels(10, canvas.height - 10, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        results['webgl'] = {
          r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3],
          hex: '#' + [pixel[0], pixel[1], pixel[2]].map(v => v.toString(16).padStart(2, '0')).join(''),
        };
      } catch (e) {
        results['webgl'] = { error: e.message };
      }
    }
  }
  
  // Also check what the terminal theme says
  results.theme = {
    background: term.options?.theme?.background,
    foreground: term.options?.theme?.foreground,
  };
  
  // Check the overlay's configured background
  const overlay = window.app?._localEchoOverlay;
  results.overlayBg = overlay?._font?.backgroundColor;
  
  // Check xterm-rows computed style
  const rows = term.element?.querySelector('.xterm-rows');
  if (rows) {
    results.rowsBg = getComputedStyle(rows).backgroundColor;
  }
  
  // Check .xterm element bg
  const xtermEl = term.element;
  if (xtermEl) {
    results.xtermBg = getComputedStyle(xtermEl).backgroundColor;
  }
  
  // Canvas count and types
  results.canvasCount = canvases?.length;
  results.canvasClasses = Array.from(canvases || []).map(c => c.className);
  
  return results;
});

console.log(JSON.stringify(colorInfo, null, 2));
await browser.close();
console.log('Done');
