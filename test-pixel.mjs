import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto('http://localhost:3099', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

// Click first tab
await page.locator('.session-tab').first().click();
await page.waitForTimeout(4000);

// Get terminal and enable local echo via JS
const result = await page.evaluate(() => {
  const term = window.app.terminal;
  if (!term) return { error: 'no terminal' };
  
  const dims = term._core._renderService.dimensions;
  
  // Toggle local echo on via settings 
  const checkbox = document.getElementById('appSettingsLocalEcho');
  
  return {
    cellW: dims.css.cell.width,
    cellH: dims.css.cell.height,
    charTop: dims.device?.char?.top ?? 0,
    charHeight: dims.device?.char?.height ?? 0,
    dpr: window.devicePixelRatio,
    fontSize: term.options.fontSize,
    fontFamily: term.options.fontFamily,
    localEchoCheckbox: !!checkbox,
    localEchoChecked: checkbox?.checked,
  };
});
console.log('Terminal info:', JSON.stringify(result, null, 2));

// Enable local echo via the app settings checkbox 
await page.evaluate(() => {
  const cb = document.getElementById('appSettingsLocalEcho');
  if (cb && !cb.checked) {
    cb.click();
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
await page.waitForTimeout(500);

// Focus terminal and type
await page.locator('.xterm-helper-textarea').first().focus();
await page.waitForTimeout(300);
await page.keyboard.type('hello', { delay: 100 });
await page.waitForTimeout(1500);

// Take screenshots and analyze pixel positions
const pixelInfo = await page.evaluate(() => {
  const overlay = document.querySelector('.zl-overlay');
  if (!overlay) return { error: 'no overlay', overlayDisplay: overlay?.style?.display };
  
  const spans = overlay.querySelectorAll('span');
  const firstCharSpan = Array.from(spans).find(s => s.textContent === 'h');
  
  if (!firstCharSpan) {
    return { error: 'no h span', spanCount: spans.length, innerHTML: overlay.innerHTML.slice(0, 200) };
  }
  
  const spanRect = firstCharSpan.getBoundingClientRect();
  const containerRect = overlay.getBoundingClientRect();
  const lineDiv = firstCharSpan.parentElement;
  const lineDivRect = lineDiv.getBoundingClientRect();
  
  // Get the canvas position for comparison
  const canvasEl = document.querySelector('.xterm-screen canvas');
  const canvasRect = canvasEl?.getBoundingClientRect();
  
  return {
    span: {
      top: spanRect.top,
      bottom: spanRect.bottom,
      height: spanRect.height,
      relativeTop: spanRect.top - lineDivRect.top,
    },
    lineDiv: {
      top: lineDivRect.top,
      bottom: lineDivRect.bottom,
      height: lineDivRect.height,
    },
    container: {
      top: containerRect.top,
      height: containerRect.height,
    },
    canvas: canvasRect ? {
      top: canvasRect.top,
    } : null,
    spanStyle: {
      transform: firstCharSpan.style.transform,
      top: firstCharSpan.style.top,
      height: firstCharSpan.style.height,
      lineHeight: firstCharSpan.style.lineHeight,
    },
  };
});
console.log('Pixel info:', JSON.stringify(pixelInfo, null, 2));

// Screenshot the terminal area
const termScreen = page.locator('.xterm-screen').first();
await termScreen.screenshot({ path: '/tmp/overlay-test-zoomed.png' });
console.log('Screenshot saved to /tmp/overlay-test-zoomed.png');

await browser.close();
console.log('Done');
