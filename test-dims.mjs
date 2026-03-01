import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto('http://localhost:3099', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

const firstTab = page.locator('.session-tab').first();
await firstTab.click();
await page.waitForTimeout(5000);

const info = await page.evaluate(() => {
  const term = window.app?.terminal;
  if (!term) return { error: 'no app.terminal' };
  
  const core = term._core;
  const renderService = core?._renderService;
  const dims = renderService?.dimensions;
  
  if (!dims) return { error: 'no dimensions', hasCore: !!core, hasRenderService: !!renderService };
  
  return {
    css: {
      cell: dims.css?.cell,
      char: dims.css?.char,
      canvas: dims.css?.canvas,
    },
    device: {
      cell: dims.device?.cell,
      char: dims.device?.char,
      canvas: dims.device?.canvas,
    },
    topLevelKeys: Object.keys(dims),
    cssKeys: dims.css ? Object.keys(dims.css) : [],
    deviceKeys: dims.device ? Object.keys(dims.device) : [],
    cssAllDetail: dims.css ? Object.fromEntries(
      Object.entries(dims.css).map(([k, v]) => [k, v && typeof v === 'object' ? { ...v } : v])
    ) : null,
    deviceAllDetail: dims.device ? Object.fromEntries(
      Object.entries(dims.device).map(([k, v]) => [k, v && typeof v === 'object' ? { ...v } : v])
    ) : null,
    dpr: window.devicePixelRatio,
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
