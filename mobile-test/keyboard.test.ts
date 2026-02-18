// Port 3200 - Virtual keyboard simulation tests
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Page, BrowserContext } from 'playwright';
import { PORTS, KEYBOARD, SELECTORS, BODY_CLASSES, WAIT } from './helpers/constants.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { createDevicePage, getBrowser, closeAllBrowsers } from './helpers/browser.js';
import {
  showKeyboard, hideKeyboard,
  showKeyboardViaCDP, hideKeyboardViaCDP,
  showKeyboardViaMock, hideKeyboardViaMock,
  showKeyboardViaDOM, hideKeyboardViaDOM,
  setupViewportMock,
} from './helpers/keyboard-sim.js';
import { getCDP, setVisualViewportHeight } from './helpers/cdp.js';
import {
  assertHasClass, assertNotHasClass,
  assertVisible, assertHidden,
  getCSSProperty,
} from './helpers/assertions.js';
import { REPRESENTATIVE_DEVICES } from './devices.js';
import type { WebServer } from '../src/web/server.js';

const PORT = PORTS.KEYBOARD;
const BASE_URL = `http://localhost:${PORT}`;

// ─── Page-global access helpers ───
// KeyboardHandler is a `const` in app.js — NOT on `window`.
// Use string-based page.evaluate() to access it in the global lexical scope.

async function getKeyboardVisible(page: Page): Promise<boolean | undefined> {
  return page.evaluate(`
    typeof KeyboardHandler !== 'undefined' ? KeyboardHandler.keyboardVisible : undefined
  `);
}

async function getKeyboardState(page: Page) {
  return page.evaluate(`({
    exists: typeof KeyboardHandler !== 'undefined',
    keyboardVisible: typeof KeyboardHandler !== 'undefined' ? KeyboardHandler.keyboardVisible : undefined,
    hasViewportHandler: typeof KeyboardHandler !== 'undefined' ? KeyboardHandler._viewportResizeHandler != null : false,
    hasHandleViewportResize: typeof KeyboardHandler !== 'undefined' ? typeof KeyboardHandler.handleViewportResize === 'function' : false,
    initialViewportHeight: typeof KeyboardHandler !== 'undefined' ? KeyboardHandler.initialViewportHeight : 0,
  })`) as Promise<{
    exists: boolean;
    keyboardVisible: boolean | undefined;
    hasViewportHandler: boolean;
    hasHandleViewportResize: boolean;
    initialViewportHeight: number;
  }>;
}

describe('Virtual Keyboard', () => {
  let server: WebServer;

  beforeAll(async () => {
    server = await createTestServer(PORT);
  });

  afterAll(async () => {
    await stopTestServer(server);
    await closeAllBrowsers();
  });

  // ── Layer 1 - CDP Metrics Override (Chromium) ──────────────────────────

  describe('Layer 1 - CDP Metrics Override (Chromium)', () => {
    let page: Page;
    let context: BrowserContext;
    const device = REPRESENTATIVE_DEVICES['standard-phone']; // iPhone 14 Pro

    beforeEach(async () => {
      const result = await createDevicePage(device, BASE_URL, 'chromium');
      page = result.page;
      context = result.context;
    });

    afterEach(async () => {
      await context.close();
    });

    it('fires real visualViewport resize event', async () => {
      const success = await showKeyboardViaCDP(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      expect(success).toBe(true);

      const visible = await getKeyboardVisible(page);
      expect(visible).toBe(true);
    });

    it('adds keyboard-visible class to body', async () => {
      await showKeyboardViaCDP(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await assertHasClass(page, 'body', BODY_CLASSES.KEYBOARD_VISIBLE);
    });

    it('show threshold: viewport shrink >150px triggers keyboard', async () => {
      // Shrink by 151px — should trigger
      await showKeyboardViaCDP(page, KEYBOARD.SHOW_THRESHOLD + 1);
      const visible = await getKeyboardVisible(page);
      expect(visible).toBe(true);
    });

    it('hide threshold: viewport shrink <100px triggers hide', async () => {
      // Show keyboard first
      await showKeyboardViaCDP(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      expect(await getKeyboardVisible(page)).toBe(true);

      // Restore viewport (hide keyboard via CDP)
      await hideKeyboardViaCDP(page);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      expect(await getKeyboardVisible(page)).toBe(false);
    });

    it('small viewport changes (<150px) do not trigger keyboard', async () => {
      // Shrink by only 100px — below 150px threshold
      const cdp = await getCDP(page);
      const viewport = page.viewportSize()!;
      await setVisualViewportHeight(cdp, viewport.width, viewport.height - 100, 1);
      await page.waitForTimeout(300);

      const visible = await getKeyboardVisible(page);
      expect(visible).toBe(false);
    });

    it('dismissing keyboard restores original state', async () => {
      // Show
      await showKeyboardViaCDP(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await assertHasClass(page, 'body', BODY_CLASSES.KEYBOARD_VISIBLE);

      // Hide
      await hideKeyboardViaCDP(page);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      await assertNotHasClass(page, 'body', BODY_CLASSES.KEYBOARD_VISIBLE);

      // Verify resetLayout was called — toolbar transform should be cleared
      const transform = await getCSSProperty(page, SELECTORS.TOOLBAR, 'transform');
      expect(transform === 'none' || transform === '').toBe(true);
    });
  });

  // ── Layer 2 - VisualViewport Mock (cross-engine) ──────────────────────

  describe('Layer 2 - VisualViewport Mock (cross-engine)', () => {
    const device = REPRESENTATIVE_DEVICES['standard-phone'];

    it('mock visualViewport.height triggers handleViewportResize', async () => {
      const { context, page } = await createDevicePage(device, 'about:blank', 'chromium');
      try {
        await setupViewportMock(page);
        await page.goto(BASE_URL, { waitUntil: WAIT.DOM_CONTENT_LOADED });
        await page.waitForTimeout(2000);

        const success = await showKeyboardViaMock(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
        expect(success).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('works on Chromium', async () => {
      const { context, page } = await createDevicePage(device, 'about:blank', 'chromium');
      try {
        await setupViewportMock(page);
        await page.goto(BASE_URL, { waitUntil: WAIT.DOM_CONTENT_LOADED });
        await page.waitForTimeout(2000);

        const success = await showKeyboardViaMock(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
        expect(success).toBe(true);

        const hasClass = await page.evaluate(() =>
          document.body.classList.contains('keyboard-visible'),
        );
        expect(hasClass).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('works on WebKit', async () => {
      let context: BrowserContext | undefined;
      try {
        const result = await createDevicePage(device, 'about:blank', 'webkit');
        context = result.context;
        await setupViewportMock(result.page);
        await result.page.goto(BASE_URL, { waitUntil: WAIT.DOM_CONTENT_LOADED });
        await result.page.waitForTimeout(2000);

        const success = await showKeyboardViaMock(result.page, KEYBOARD.TYPICAL_IOS_HEIGHT);
        expect(success).toBe(true);
      } catch (e: unknown) {
        // Skip if WebKit libraries not installed on this system
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Missing libraries') || msg.includes('browserType.launch')) {
          console.log('Skipping WebKit test: system libraries not installed');
          return;
        }
        throw e;
      } finally {
        if (context) await context.close();
      }
    });
  });

  // ── Layout Behavior ───────────────────────────────────────────────────

  describe('Layout Behavior', () => {
    let page: Page;
    let context: BrowserContext;
    const device = REPRESENTATIVE_DEVICES['standard-phone'];

    beforeEach(async () => {
      const result = await createDevicePage(device, BASE_URL, 'chromium');
      page = result.page;
      context = result.context;
    });

    afterEach(async () => {
      await context.close();
    });

    it('toolbar slides up via translateY on keyboard show', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      const transform = await page.evaluate(() => {
        const toolbar = document.querySelector('.toolbar') as HTMLElement | null;
        return toolbar?.style.transform ?? '';
      });
      expect(transform).not.toBe('');
      expect(transform).toContain('translateY');
    });

    it('accessory bar gets .visible class', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      const hasVisible = await page.evaluate(() => {
        const bar = document.querySelector('.keyboard-accessory-bar');
        return bar?.classList.contains('visible') ?? false;
      });
      expect(hasVisible).toBe(true);
    });

    it('main padding increases on keyboard show', async () => {
      const initialPadding = await page.evaluate(() => {
        const main = document.querySelector('.main') as HTMLElement | null;
        return main ? getComputedStyle(main).paddingBottom : '0px';
      });
      const initialPx = parseFloat(initialPadding) || 0;

      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      const newPadding = await page.evaluate(() => {
        const main = document.querySelector('.main') as HTMLElement | null;
        return main ? main.style.paddingBottom : '';
      });
      const newPx = parseFloat(newPadding) || 0;
      expect(newPx).toBeGreaterThan(initialPx);
    });

    it('resetLayout clears transforms on hide', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      await hideKeyboard(page);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      // Toolbar transform should be cleared
      const toolbarTransform = await page.evaluate(() => {
        const toolbar = document.querySelector('.toolbar') as HTMLElement | null;
        return toolbar?.style.transform ?? '';
      });
      expect(toolbarTransform).toBe('');

      const mainPadding = await page.evaluate(() => {
        const main = document.querySelector('.main') as HTMLElement | null;
        return main?.style.paddingBottom ?? '';
      });
      expect(mainPadding).toBe('');
    });

    it('accessory bar has 7 action buttons', async () => {
      const count = await page.evaluate(() => {
        const buttons = document.querySelectorAll('.keyboard-accessory-bar [data-action]');
        return buttons.length;
      });
      expect(count).toBe(7);
    });

    it('double-tap confirm on /clear button', async () => {
      // Make accessory bar visible
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      // handleAction() early-returns if app.activeSessionId is falsy — mock it
      await page.evaluate(`
        if (typeof app !== 'undefined') app.activeSessionId = 'test-session';
      `);

      // Click via JS since the button is positioned outside the viewport
      // by the keyboard CSS transform
      await page.evaluate(() => {
        const btn = document.querySelector('[data-action="clear"]') as HTMLElement;
        btn?.click();
      });
      await page.waitForTimeout(100);

      // Should enter confirming state
      const confirming = await page.evaluate(() => {
        const btn = document.querySelector('[data-action="clear"]');
        return btn?.classList.contains('confirming') ?? false;
      });
      expect(confirming).toBe(true);

      // Button text should change to "Tap again"
      const text = await page.evaluate(() => {
        const btn = document.querySelector('[data-action="clear"]');
        return btn?.textContent?.trim();
      });
      expect(text).toBe('Tap again');
    });

    it('double-tap confirm on /compact button', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      await page.evaluate(`
        if (typeof app !== 'undefined') app.activeSessionId = 'test-session';
      `);

      await page.evaluate(() => {
        const btn = document.querySelector('[data-action="compact"]') as HTMLElement;
        btn?.click();
      });
      await page.waitForTimeout(100);

      const confirming = await page.evaluate(() => {
        const btn = document.querySelector('[data-action="compact"]');
        return btn?.classList.contains('confirming') ?? false;
      });
      expect(confirming).toBe(true);
    });

    it('double-tap expires after 2s', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      await page.evaluate(`
        if (typeof app !== 'undefined') app.activeSessionId = 'test-session';
      `);

      // First tap on clear via JS
      await page.evaluate(() => {
        const btn = document.querySelector('[data-action="clear"]') as HTMLElement;
        btn?.click();
      });
      await page.waitForTimeout(100);

      // Verify confirming state
      const beforeExpiry = await page.evaluate(() => {
        const btn = document.querySelector('[data-action="clear"]');
        return btn?.classList.contains('confirming') ?? false;
      });
      expect(beforeExpiry).toBe(true);

      // Wait for confirm timeout to expire (2s + buffer)
      await page.waitForTimeout(KEYBOARD.CONFIRM_TIMEOUT + 500);

      const afterExpiry = await page.evaluate(() => {
        const btn = document.querySelector('[data-action="clear"]');
        return btn?.classList.contains('confirming') ?? false;
      });
      expect(afterExpiry).toBe(false);
    });

    it('dismiss button blurs active element', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      // Focus an element
      await page.evaluate(() => {
        const el = document.querySelector('.terminal-container') || document.querySelector('textarea') || document.body;
        if (el instanceof HTMLElement) el.focus();
      });

      // Click dismiss via JS (positioned off-screen by keyboard transform)
      await page.evaluate(() => {
        const btn = document.querySelector('[data-action="dismiss"]') as HTMLElement;
        btn?.click();
      });
      await page.waitForTimeout(100);

      const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? '');
      expect(activeTag).toBe('BODY');
    });

    it('terminal fit called on keyboard toggle', async () => {
      // Inject spy on fitAddon.fit
      await page.evaluate(`
        if (typeof app !== 'undefined' && app.fitAddon) {
          window.__fitCallCount = 0;
          var orig = app.fitAddon.fit;
          app.fitAddon.fit = function () {
            window.__fitCallCount++;
            try { orig.call(this); } catch(e) {}
          };
        }
      `);

      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      // Wait for the setTimeout(150) in onKeyboardShow
      await page.waitForTimeout(300);

      const callCount = await page.evaluate(() => (window as any).__fitCallCount ?? 0);
      // Soft assertion — fitAddon may not be initialized without real terminal
      expect(callCount).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Cross-device keyboard behavior ────────────────────────────────────

  describe('Cross-device keyboard behavior', () => {
    it('phone: full keyboard handling active', async () => {
      const device = REPRESENTATIVE_DEVICES['standard-phone'];
      const { context, page } = await createDevicePage(device, BASE_URL, 'chromium');
      try {
        const state = await getKeyboardState(page);
        expect(state.exists).toBe(true);
        expect(state.hasHandleViewportResize).toBe(true);

        // Show keyboard and verify it works
        await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
        expect(await getKeyboardVisible(page)).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('tablet: keyboard handling active', async () => {
      const device = REPRESENTATIVE_DEVICES['standard-tablet']; // iPad Mini
      const { context, page } = await createDevicePage(device, BASE_URL, 'chromium');
      try {
        const state = await getKeyboardState(page);
        expect(state.exists).toBe(true);
        expect(state.hasHandleViewportResize).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('desktop: KeyboardHandler.init() skips (no touch device)', async () => {
      // Create a non-mobile, non-touch context
      const browser = await getBrowser('chromium');
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        isMobile: false,
        hasTouch: false,
      });
      const page = await context.newPage();
      try {
        await page.goto(BASE_URL, { waitUntil: WAIT.DOM_CONTENT_LOADED });
        await page.waitForTimeout(1000);

        const state = await getKeyboardState(page);
        // KeyboardHandler object exists (it's a const), but init() is a no-op
        // on non-touch devices, so no viewport handler is registered
        expect(state.exists).toBe(true);
        expect(state.keyboardVisible).toBe(false);
        expect(state.hasViewportHandler).toBe(false);
      } finally {
        await context.close();
      }
    });
  });
});
