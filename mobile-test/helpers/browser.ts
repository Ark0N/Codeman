import { chromium, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import type { DeviceEntry } from '../devices.js';

const browsers: Record<string, Browser> = {};

export async function getBrowser(engine: 'chromium' | 'webkit' = 'chromium'): Promise<Browser> {
  if (!browsers[engine]?.isConnected()) {
    const launcher = engine === 'webkit' ? webkit : chromium;
    try {
      browsers[engine] = await launcher.launch({ headless: true });
    } catch (e: unknown) {
      // Fall back to Chromium if WebKit libraries are missing
      if (engine === 'webkit') {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Missing') || msg.includes('dependencies') || msg.includes('browserType.launch')) {
          console.log('WebKit unavailable, falling back to Chromium');
          return getBrowser('chromium');
        }
      }
      throw e;
    }
  }
  return browsers[engine];
}

export async function createDeviceContext(
  device: DeviceEntry,
  engineOverride?: 'chromium' | 'webkit',
): Promise<BrowserContext> {
  const engine = engineOverride ?? device.defaultBrowserType;
  const browser = await getBrowser(engine);
  return browser.newContext({
    viewport: device.viewport,
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
    userAgent: device.userAgent,
  });
}

export async function createDevicePage(
  device: DeviceEntry,
  url: string,
  engineOverride?: 'chromium' | 'webkit',
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await createDeviceContext(device, engineOverride);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Wait for initial JS to execute and device classes to be applied
  await page.waitForTimeout(1000);
  return { context, page };
}

export async function closeAllBrowsers(): Promise<void> {
  for (const [key, browser] of Object.entries(browsers)) {
    if (browser.isConnected()) {
      await browser.close();
    }
    delete browsers[key];
  }
}

export function isChromium(engine: 'chromium' | 'webkit'): boolean {
  return engine === 'chromium';
}
