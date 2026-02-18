// Port 3206 - Screenshot comparison tests
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import type { WebServer } from '../src/web/server.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { PORTS, SELECTORS, VISUAL, VISUAL_BREAKPOINTS, WAIT } from './helpers/constants.js';
import { showKeyboard, hideKeyboard } from './helpers/keyboard-sim.js';
import { compareScreenshot, assertScreenshotMatch } from './helpers/visual.js';
import { REPRESENTATIVE_DEVICES } from './devices.js';

const PORT = PORTS.VISUAL_REGRESSION;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;

// Use a representative subset of breakpoints to keep test time reasonable
// Covers: small phone, standard phone, large phone/small tablet boundary, tablet, desktop
const KEY_BREAKPOINTS = [320, 375, 393, 430, 768, 1024] as const;

describe('Visual Regression', () => {
  beforeAll(async () => {
    server = await createTestServer(PORT);
  });

  afterAll(async () => {
    await closeAllBrowsers();
    await stopTestServer(server);
  });

  // ─── Breakpoint Screenshots ───────────────────────────────────────────────

  describe.each(
    KEY_BREAKPOINTS.map(w => [w] as [number]),
  )('Width %ipx', (width) => {
    const height = 812; // Standard phone height for consistency

    it('landing page (no sessions)', async () => {
      const device = {
        name: `custom-${width}`,
        category: 'standard-phone' as const,
        viewport: { width, height },
        deviceScaleFactor: 2,
        isMobile: width < 768,
        hasTouch: width < 768,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
        expectedBreakpoint: (width < 430 ? 'phone' : width < 768 ? 'tablet' : 'desktop') as 'phone' | 'tablet' | 'desktop',
        isIOS: true,
        defaultBrowserType: 'chromium' as const,
      };

      const { context, page } = await createDevicePage(device, BASE_URL);
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);
        const result = await compareScreenshot(page, `landing-${width}w`);
        if (result.isNewBaseline) {
          console.log(`[visual] Created new baseline: landing-${width}w.png`);
        }
        expect(result.passed).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('with keyboard visible', async () => {
      const device = {
        name: `custom-${width}`,
        category: 'standard-phone' as const,
        viewport: { width, height },
        deviceScaleFactor: 2,
        isMobile: width < 768,
        hasTouch: width < 768,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
        expectedBreakpoint: (width < 430 ? 'phone' : width < 768 ? 'tablet' : 'desktop') as 'phone' | 'tablet' | 'desktop',
        isIOS: true,
        defaultBrowserType: 'chromium' as const,
      };

      const { context, page } = await createDevicePage(device, BASE_URL);
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);
        // Show keyboard via DOM manipulation (works on all engines)
        await showKeyboard(page, 336, { preferredLayer: 'dom' });
        await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

        const result = await compareScreenshot(page, `keyboard-${width}w`);
        if (result.isNewBaseline) {
          console.log(`[visual] Created new baseline: keyboard-${width}w.png`);
        }
        expect(result.passed).toBe(true);

        await hideKeyboard(page, { preferredLayer: 'dom' });
      } finally {
        await context.close();
      }
    });

    it('with settings modal open', async () => {
      const device = {
        name: `custom-${width}`,
        category: 'standard-phone' as const,
        viewport: { width, height },
        deviceScaleFactor: 2,
        isMobile: width < 768,
        hasTouch: width < 768,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
        expectedBreakpoint: (width < 430 ? 'phone' : width < 768 ? 'tablet' : 'desktop') as 'phone' | 'tablet' | 'desktop',
        isIOS: true,
        defaultBrowserType: 'chromium' as const,
      };

      const { context, page } = await createDevicePage(device, BASE_URL);
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);

        // Open settings modal - try mobile button first, then desktop
        const mobileBtn = page.locator(SELECTORS.SETTINGS_MOBILE);
        const isPhone = width < 430;
        if (isPhone && await mobileBtn.isVisible()) {
          await mobileBtn.click();
        } else {
          // Try clicking a desktop settings trigger if available
          await page.evaluate(() => {
            const modal = document.getElementById('appSettingsModal');
            if (modal) modal.style.display = 'flex';
          });
        }
        await page.waitForTimeout(500);

        const result = await compareScreenshot(page, `settings-${width}w`);
        if (result.isNewBaseline) {
          console.log(`[visual] Created new baseline: settings-${width}w.png`);
        }
        expect(result.passed).toBe(true);
      } finally {
        await context.close();
      }
    });
  });

  // ─── Representative Device Screenshots ────────────────────────────────────

  describe('Representative Devices', () => {
    for (const [category, device] of Object.entries(REPRESENTATIVE_DEVICES)) {
      it(`${device.name} (${category}) landing page`, async () => {
        const { context, page } = await createDevicePage(device, BASE_URL);
        try {
          await page.waitForTimeout(WAIT.PAGE_SETTLE);
          const name = `device-${device.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
          const result = await compareScreenshot(page, name);
          if (result.isNewBaseline) {
            console.log(`[visual] Created new baseline: ${name}.png`);
          }
          expect(result.passed).toBe(true);
        } finally {
          await context.close();
        }
      });
    }
  });

  // ─── Baseline Management ──────────────────────────────────────────────────

  describe('Baseline management', () => {
    /*
     * To update visual baselines:
     *
     * 1. Delete the specific snapshot:
     *    rm mobile-test/snapshots/<name>.png
     *
     * 2. Re-run the test:
     *    npx vitest run mobile-test/visual-regression.test.ts
     *
     * 3. Review the new baseline:
     *    The test will create a fresh .png and pass (isNewBaseline = true).
     *
     * To update ALL baselines:
     *    rm -rf mobile-test/snapshots/ && npx vitest run mobile-test/visual-regression.test.ts
     *
     * Diff images for failed comparisons are saved as <name>.diff.png
     * alongside the baseline in mobile-test/snapshots/.
     */
    it('placeholder — see comments above for baseline update instructions', () => {
      expect(true).toBe(true);
    });
  });
});
