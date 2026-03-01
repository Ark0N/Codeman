import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto('http://localhost:3099', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await page.locator('.session-tab').first().click();
await page.waitForTimeout(4000);

// Check ALL background colors in the xterm rendering stack
const bgInfo = await page.evaluate(() => {
  const term = window.app?.terminal;
  if (!term) return { error: 'no terminal' };
  
  const el = term.element;
  if (!el) return { error: 'no element' };
  
  const results = {};
  
  // Walk up from xterm-screen to find who provides the background
  const screen = el.querySelector('.xterm-screen');
  const viewport = el.querySelector('.xterm-viewport');
  const rows = el.querySelector('.xterm-rows');
  
  const elements = {
    '.xterm (term.element)': el,
    '.xterm-viewport': viewport,
    '.xterm-screen': screen,
    '.xterm-rows': rows,
  };
  
  // Also check parent elements
  let parent = el.parentElement;
  let depth = 0;
  while (parent && depth < 5) {
    elements[`parent-${depth} (${parent.tagName}.${parent.className?.split(' ')[0] || ''})`] = parent;
    parent = parent.parentElement;
    depth++;
  }
  
  for (const [name, elem] of Object.entries(elements)) {
    if (!elem) { results[name] = 'not found'; continue; }
    const cs = getComputedStyle(elem);
    results[name] = {
      background: cs.background?.slice(0, 80),
      backgroundColor: cs.backgroundColor,
      inlineStyle: elem.style.backgroundColor || elem.style.background || '(none)',
    };
  }
  
  // Also check if xterm-viewport has inline style set by xterm.js
  if (viewport) {
    results['viewport-inline-full'] = viewport.style.cssText?.slice(0, 200);
  }
  
  // Theme config
  results.theme = term.options?.theme;
  
  // Overlay bg
  results.overlayBg = window.app?._localEchoOverlay?._font?.backgroundColor;
  
  return results;
});

console.log(JSON.stringify(bgInfo, null, 2));
await browser.close();
