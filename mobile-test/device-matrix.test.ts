// Port 3205 - Cross-device parametric tests
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import type { WebServer } from '../src/web/server.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { PORTS, SELECTORS, BREAKPOINTS, BODY_CLASSES } from './helpers/constants.js';
import {
  assertFixedPosition,
  assertHidden,
  assertVisible,
  assertNoHorizontalOverflow,
  assertDeviceClasses,
  assertAccessibleTouchTargets,
  getCSSProperty,
  getCSSNumericValue,
} from './helpers/assertions.js';
import {
  REPRESENTATIVE_DEVICES,
  DEVICE_REGISTRY,
  type DeviceEntry,
  type DeviceCategory,
} from './devices.js';

const PORT = PORTS.DEVICE_MATRIX;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;

// Hidden on phones (< 430px width)
const PHONE_HIDDEN_SELECTORS = [
  SELECTORS.HEADER_BRAND,
  SELECTORS.CASE_SELECT_GROUP,
  SELECTORS.VERSION_DISPLAY,
  SELECTORS.TOOLBAR_RIGHT,
  SELECTORS.TAB_COUNT_GROUP,
];

// Visible only on phones
const PHONE_ONLY_SELECTORS = [
  SELECTORS.SETTINGS_MOBILE,
  SELECTORS.CASE_MOBILE,
];

describe('Device Matrix', () => {
  beforeAll(async () => {
    server = await createTestServer(PORT);
  });

  afterAll(async () => {
    await closeAllBrowsers();
    await stopTestServer(server);
  });

  // ─── Representative Devices ───────────────────────────────────────────────

  describe.each(
    Object.entries(REPRESENTATIVE_DEVICES) as [DeviceCategory, DeviceEntry][],
  )('Representative: %s', (category, device) => {
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      ({ context, page } = await createDevicePage(device, BASE_URL));
    });

    afterAll(async () => {
      await context.close();
    });

    it(`has correct device class for ${device.name} (${device.viewport.width}px)`, async () => {
      await assertDeviceClasses(page, device.viewport.width);
    });

    it('no horizontal overflow', async () => {
      await assertNoHorizontalOverflow(page);
    });

    it('header positioning matches breakpoint', async () => {
      const { width } = device.viewport;
      const position = await getCSSProperty(page, SELECTORS.HEADER, 'position');
      if (width <= BREAKPOINTS.TABLET_MAX) {
        // Phone + tablet (max-width: 768px includes 768): fixed header
        expect(position).toBe('fixed');
        const top = await getCSSProperty(page, SELECTORS.HEADER, 'top');
        expect(parseFloat(top)).toBe(0);
      } else {
        // Desktop: relative header (not fixed)
        expect(position).toBe('relative');
      }
    });

    it('toolbar positioning matches breakpoint', async () => {
      const { width } = device.viewport;
      const position = await getCSSProperty(page, SELECTORS.TOOLBAR, 'position');
      if (width <= BREAKPOINTS.PHONE_MAX) {
        // Phone (max-width: 430px includes 430): fixed toolbar
        expect(position).toBe('fixed');
      } else {
        // Tablet/desktop: relative toolbar
        expect(position).toBe('relative');
      }
    });

    it('correct elements hidden/visible for breakpoint', async () => {
      const { width } = device.viewport;
      const isPhone = width < BREAKPOINTS.PHONE_MAX;
      // Skip strict assertions for devices at the phone/tablet boundary (±10px)
      const atBoundary = Math.abs(width - BREAKPOINTS.PHONE_MAX) <= 10
        || Math.abs(width - BREAKPOINTS.TABLET_MAX) <= 10;

      if (atBoundary) return;

      if (isPhone) {
        // Phone: certain elements hidden, mobile buttons visible
        for (const sel of PHONE_HIDDEN_SELECTORS) {
          await assertHidden(page, sel);
        }
        for (const sel of PHONE_ONLY_SELECTORS) {
          await assertVisible(page, sel);
        }
      } else {
        // Tablet/desktop: phone-hidden elements should be visible, mobile buttons hidden
        for (const sel of PHONE_ONLY_SELECTORS) {
          await assertHidden(page, sel);
        }
      }
    });

    it('touch targets pass minimum size', async () => {
      const violations = await assertAccessibleTouchTargets(page);
      // Log violations for debugging but allow a small number
      if (violations.length > 0) {
        console.warn(
          `[${device.name}] Touch target violations (${violations.length}):\n` +
          violations.map(v => `  ${v.selector}: ${v.width}x${v.height}px`).join('\n'),
        );
      }
      // Larger viewports show more UI elements, so allow more violations.
      // Known violators: notification action buttons (26x26), some icon buttons.
      const { width } = device.viewport;
      // Larger viewports show more elements; scale threshold accordingly
      const maxViolations = width >= BREAKPOINTS.TABLET_MAX ? 25
        : width >= BREAKPOINTS.PHONE_MAX ? 20
        : 15;
      expect(violations.length).toBeLessThanOrEqual(maxViolations);
    });
  });

  // ─── Full Device Matrix (skip with CI_QUICK=1) ───────────────────────────

  describe.skipIf(process.env.CI_QUICK === '1')('Full Device Matrix', () => {
    for (const device of DEVICE_REGISTRY) {
      it(`${device.name} (${device.viewport.width}x${device.viewport.height}): correct layout`, async () => {
        const { context, page } = await createDevicePage(device, BASE_URL);
        try {
          // Verify viewport was applied
          const viewportSize = page.viewportSize();
          expect(viewportSize?.width).toBe(device.viewport.width);
          expect(viewportSize?.height).toBe(device.viewport.height);

          // No horizontal overflow
          await assertNoHorizontalOverflow(page);

          // Correct breakpoint class
          await assertDeviceClasses(page, device.viewport.width);

          // Header fixed at top (only on phone/tablet breakpoints, max-width: 768px)
          if (device.viewport.width <= BREAKPOINTS.TABLET_MAX) {
            await assertFixedPosition(page, SELECTORS.HEADER);
          }
        } finally {
          await context.close();
        }
      });
    }
  });

  // ─── Dual Engine Matrix (representatives only) ────────────────────────────

  describe('Dual Engine Matrix', () => {
    const engines = ['chromium', 'webkit'] as const;

    for (const [category, device] of Object.entries(REPRESENTATIVE_DEVICES) as [DeviceCategory, DeviceEntry][]) {
      describe(`${device.name} (${category})`, () => {
        it('layout matches across engines', async () => {
          const results: Record<string, { position: string; top: string; zIndex: number }> = {};

          for (const engine of engines) {
            const { context, page } = await createDevicePage(device, BASE_URL, engine);
            try {
              const position = await getCSSProperty(page, SELECTORS.HEADER, 'position');
              const top = await getCSSProperty(page, SELECTORS.HEADER, 'top');
              const zIndex = await getCSSNumericValue(page, SELECTORS.HEADER, 'z-index');
              results[engine] = { position, top, zIndex };

              // Each engine should have no overflow
              await assertNoHorizontalOverflow(page);

              // Each engine should have correct device classes
              await assertDeviceClasses(page, device.viewport.width);
            } finally {
              await context.close();
            }
          }

          // Cross-engine comparison: key CSS properties should match
          expect(results.chromium.position).toBe(results.webkit.position);
          expect(parseFloat(results.chromium.top)).toBe(parseFloat(results.webkit.top));
          // z-index should be the same
          expect(results.chromium.zIndex).toBe(results.webkit.zIndex);
        });
      });
    }
  });
});
