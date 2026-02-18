// Port 3201 - Tab switching and navigation tests
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page, BrowserContext } from 'playwright';
import { PORTS, SELECTORS, SWIPE, BODY_CLASSES, WAIT } from './helpers/constants.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { swipe, swipeViaCDP, swipeViaSynthetic } from './helpers/touch-sim.js';
import { assertHidden, assertVisible, getCSSProperty, getCSSNumericValue } from './helpers/assertions.js';
import { REPRESENTATIVE_DEVICES } from './devices.js';
import type { WebServer } from '../src/web/server.js';

const PORT = PORTS.TABS;
const BASE_URL = `http://localhost:${PORT}`;

const standardPhone = REPRESENTATIVE_DEVICES['standard-phone']; // iPhone 14 Pro

describe('Tab Navigation', () => {
  let server: WebServer;

  beforeAll(async () => {
    server = await createTestServer(PORT);
  });

  afterAll(async () => {
    await closeAllBrowsers();
    await stopTestServer(server);
  });

  // ─── Tab Rendering on Mobile ─────────────────────────────────────────────

  describe('Tab Rendering on Mobile', () => {
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      ({ context, page } = await createDevicePage(standardPhone, BASE_URL));
      // Wait for SSE and JS to fully initialize
      await page.waitForTimeout(WAIT.PAGE_SETTLE);
    });

    afterAll(async () => {
      await context.close();
    });

    it('tabs container has flex-wrap: nowrap', async () => {
      const flexWrap = await getCSSProperty(page, SELECTORS.TABS_CONTAINER, 'flex-wrap');
      expect(flexWrap).toBe('nowrap');
    });

    it('tabs container has overflow-x: auto', async () => {
      const overflowX = await getCSSProperty(page, SELECTORS.TABS_CONTAINER, 'overflow-x');
      expect(overflowX).toBe('auto');
    });

    it('tabs container hides scrollbar', async () => {
      // scrollbar-width: none is the standard way (Firefox/Chrome); WebKit uses ::-webkit-scrollbar
      const scrollbarWidth = await getCSSProperty(page, SELECTORS.TABS_CONTAINER, 'scrollbar-width');
      // On Chromium computed value should be 'none' if set via CSS
      // If the browser doesn't support the property, it may return '' — check either way
      const scrollbarHidden = scrollbarWidth === 'none' || scrollbarWidth === '';
      expect(scrollbarHidden).toBe(true);
    });

    it('tab count group hidden on phones', async () => {
      await assertHidden(page, SELECTORS.TAB_COUNT_GROUP);
    });

    it('tab has minimum height of 32px', async () => {
      const tabExists = await page.$(SELECTORS.TAB);
      if (tabExists) {
        const minHeight = await getCSSNumericValue(page, SELECTORS.TAB, 'min-height');
        expect(minHeight).toBeGreaterThanOrEqual(32);
      }
    });

    it('tab font size is 0.7rem (~11.2px)', async () => {
      const tabExists = await page.$(SELECTORS.TAB);
      if (tabExists) {
        const fontSize = await getCSSNumericValue(page, SELECTORS.TAB, 'font-size');
        // 0.7rem with default 16px root = 11.2px; allow small tolerance
        expect(fontSize).toBeGreaterThanOrEqual(10);
        expect(fontSize).toBeLessThanOrEqual(12);
      }
    });

    it('tab name truncated with max-width', async () => {
      const tabNameExists = await page.$(SELECTORS.TAB_NAME);
      if (tabNameExists) {
        const maxWidth = await getCSSProperty(page, SELECTORS.TAB_NAME, 'max-width');
        const maxWidthPx = parseFloat(maxWidth);
        // Should be 50px on mobile
        expect(maxWidthPx).toBeLessThanOrEqual(60);
        expect(maxWidthPx).toBeGreaterThan(0);
      }
    });
  });

  // ─── Swipe Navigation (CDP - Chromium) ───────────────────────────────────

  describe('Swipe Navigation (CDP - Chromium)', () => {
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      ({ context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium'));
      await page.waitForTimeout(WAIT.PAGE_SETTLE);
    });

    afterAll(async () => {
      await context.close();
    });

    async function installSwipeSpy(): Promise<void> {
      // app is a const (not on window) — use string-based evaluate
      await page.evaluate(`
        window.__swipeLog = [];
        if (typeof app !== 'undefined') {
          var origNext = app.nextSession;
          var origPrev = app.prevSession;
          app.nextSession = function() {
            window.__swipeLog.push('next');
            if (origNext) origNext.call(app);
          };
          app.prevSession = function() {
            window.__swipeLog.push('prev');
            if (origPrev) origPrev.call(app);
          };
        }
      `);
    }

    async function getSwipeLog(): Promise<string[]> {
      return page.evaluate(() => (window as any).__swipeLog ?? []);
    }

    async function clearSwipeLog(): Promise<void> {
      await page.evaluate(() => { (window as any).__swipeLog = []; });
    }

    it('swipe left calls nextSession', async () => {
      await installSwipeSpy();
      await swipeViaCDP(page, 'left', { distance: SWIPE.MIN_DISTANCE + 20, duration: 150 });
      await page.waitForTimeout(200);
      const log = await getSwipeLog();
      expect(log).toContain('next');
    });

    it('swipe right calls prevSession', async () => {
      await clearSwipeLog();
      await installSwipeSpy();
      await swipeViaCDP(page, 'right', { distance: SWIPE.MIN_DISTANCE + 20, duration: 150 });
      await page.waitForTimeout(200);
      const log = await getSwipeLog();
      expect(log).toContain('prev');
    });

    it('short swipe (<80px) does not trigger navigation', async () => {
      await clearSwipeLog();
      await installSwipeSpy();
      // Swipe distance below MIN_DISTANCE threshold
      await swipeViaCDP(page, 'left', { distance: 60, duration: 150 });
      await page.waitForTimeout(200);
      const log = await getSwipeLog();
      expect(log).toEqual([]);
    });

    it('slow swipe (>300ms) does not trigger navigation', async () => {
      await clearSwipeLog();
      await installSwipeSpy();
      // Duration exceeds MAX_TIME threshold
      await swipeViaCDP(page, 'left', { distance: SWIPE.MIN_DISTANCE + 20, duration: 400 });
      await page.waitForTimeout(200);
      const log = await getSwipeLog();
      expect(log).toEqual([]);
    });

    it('excessive vertical drift cancels swipe', async () => {
      await clearSwipeLog();
      await installSwipeSpy();

      // Manually perform a swipe with large vertical drift via CDP
      const { getCDP, dispatchTouchEvent } = await import('./helpers/cdp.js');
      const cdp = await getCDP(page);
      const box = await page.locator(SELECTORS.MAIN).boundingBox();
      if (!box) throw new Error('.main element not found');

      const startX = box.x + box.width * 0.75;
      const startY = box.y + box.height / 2;
      const endX = startX - (SWIPE.MIN_DISTANCE + 20); // sufficient horizontal
      const endY = startY + SWIPE.MAX_VERTICAL_DRIFT + 20; // excessive vertical drift

      await dispatchTouchEvent(cdp, 'touchStart', [{ x: startX, y: startY }]);
      const steps = 5;
      for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        await dispatchTouchEvent(cdp, 'touchMove', [{
          x: startX + (endX - startX) * progress,
          y: startY + (endY - startY) * progress,
        }]);
        await page.waitForTimeout(20);
      }
      await dispatchTouchEvent(cdp, 'touchEnd', []);
      await page.waitForTimeout(200);

      const log = await getSwipeLog();
      expect(log).toEqual([]);
    });
  });

  // ─── Swipe Navigation (Synthetic - WebKit) ──────────────────────────────

  describe('Swipe Navigation (Synthetic - WebKit)', () => {
    it('synthetic swipe left triggers navigation on WebKit', async () => {
      let context: BrowserContext | undefined;
      try {
        const result = await createDevicePage(standardPhone, BASE_URL, 'webkit');
        context = result.context;
        await result.page.waitForTimeout(WAIT.PAGE_SETTLE);

        // Install spy using string-based evaluate (app is a const, not on window)
        await result.page.evaluate(`
          window.__swipeLog = [];
          if (typeof app !== 'undefined') {
            var origNext = app.nextSession;
            app.nextSession = function() {
              window.__swipeLog.push('next');
              if (origNext) origNext.call(app);
            };
          }
        `);

        await swipeViaSynthetic(result.page, 'left', {
          distance: SWIPE.MIN_DISTANCE + 20,
          duration: 150,
        });
        await result.page.waitForTimeout(300);

        const log = await result.page.evaluate(() => (window as any).__swipeLog ?? []);
        expect(log).toContain('next');
      } catch (e: unknown) {
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

    it('synthetic swipe right triggers prevSession on WebKit', async () => {
      let context: BrowserContext | undefined;
      try {
        const result = await createDevicePage(standardPhone, BASE_URL, 'webkit');
        context = result.context;
        await result.page.waitForTimeout(WAIT.PAGE_SETTLE);

        await result.page.evaluate(`
          window.__swipeLog = [];
          if (typeof app !== 'undefined') {
            var origPrev = app.prevSession;
            app.prevSession = function() {
              window.__swipeLog.push('prev');
              if (origPrev) origPrev.call(app);
            };
          }
        `);

        await swipeViaSynthetic(result.page, 'right', {
          distance: SWIPE.MIN_DISTANCE + 20,
          duration: 150,
        });
        await result.page.waitForTimeout(300);

        const log = await result.page.evaluate(() => (window as any).__swipeLog ?? []);
        expect(log).toContain('prev');
      } catch (e: unknown) {
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

  // ─── Tab Keyboard Navigation ─────────────────────────────────────────────

  describe('Tab Keyboard Navigation', () => {
    /**
     * Inject multiple mock tabs into the DOM to test keyboard navigation.
     * Returns the number of tabs injected.
     */
    async function injectMockTabs(page: Page, count: number): Promise<void> {
      // App's keyboard nav handler uses .session-tab class and data-id attribute
      // Use string-based evaluate because app is a const (not on window)
      await page.evaluate(`(function(n) {
        var container = document.querySelector('.session-tabs') || document.getElementById('sessionTabs');
        if (!container) return;
        container.innerHTML = '';
        for (var i = 0; i < n; i++) {
          var tab = document.createElement('div');
          tab.className = i === 0 ? 'session-tab active' : 'session-tab';
          tab.setAttribute('tabindex', '0');
          tab.setAttribute('role', 'tab');
          tab.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
          tab.dataset.id = 'mock-session-' + i;
          tab.innerHTML = '<span class="tab-name">Tab ' + i + '</span>';
          container.appendChild(tab);
        }
        // Re-attach keyboard navigation handler
        if (typeof app !== 'undefined' && app.setupTabKeyboardNavigation) {
          app.setupTabKeyboardNavigation(container);
        }
      })(${count})`);
    }

    it('ArrowRight moves focus to next tab', async () => {
      const { context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium');
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);
        await injectMockTabs(page, 3);

        // Focus first tab
        await page.evaluate(() => {
          const firstTab = document.querySelector('.session-tab') as HTMLElement;
          firstTab?.focus();
        });

        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(100);

        const focusedId = await page.evaluate(() => {
          return (document.activeElement as HTMLElement)?.dataset?.id ?? '';
        });
        expect(focusedId).toBe('mock-session-1');
      } finally {
        await context.close();
      }
    });

    it('ArrowLeft moves focus to previous tab', async () => {
      const { context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium');
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);
        await injectMockTabs(page, 3);

        // Focus second tab
        await page.evaluate(() => {
          const tabs = document.querySelectorAll('.session-tab');
          (tabs[1] as HTMLElement)?.focus();
        });

        // Press ArrowLeft
        await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(100);

        const focusedId = await page.evaluate(() => {
          return (document.activeElement as HTMLElement)?.dataset?.id ?? '';
        });
        expect(focusedId).toBe('mock-session-0');
      } finally {
        await context.close();
      }
    });

    it('Home key focuses first tab', async () => {
      const { context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium');
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);
        await injectMockTabs(page, 4);

        // Focus last tab
        await page.evaluate(() => {
          const tabs = document.querySelectorAll('.session-tab');
          (tabs[tabs.length - 1] as HTMLElement)?.focus();
        });

        await page.keyboard.press('Home');
        await page.waitForTimeout(100);

        const focusedId = await page.evaluate(() => {
          return (document.activeElement as HTMLElement)?.dataset?.id ?? '';
        });
        expect(focusedId).toBe('mock-session-0');
      } finally {
        await context.close();
      }
    });

    it('End key focuses last tab', async () => {
      const { context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium');
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);
        await injectMockTabs(page, 4);

        // Focus first tab
        await page.evaluate(() => {
          const firstTab = document.querySelector('.session-tab') as HTMLElement;
          firstTab?.focus();
        });

        await page.keyboard.press('End');
        await page.waitForTimeout(100);

        const focusedId = await page.evaluate(() => {
          return (document.activeElement as HTMLElement)?.dataset?.id ?? '';
        });
        expect(focusedId).toBe('mock-session-3');
      } finally {
        await context.close();
      }
    });

    it('Enter activates focused tab', async () => {
      const { context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium');
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);
        await injectMockTabs(page, 3);

        // Install a click spy — Enter calls app.selectSession, not click
        await page.evaluate(`
          window.__tabActivated = '';
          if (typeof app !== 'undefined') {
            var origSelect = app.selectSession;
            app.selectSession = function(id) {
              window.__tabActivated = id || '';
              if (origSelect) origSelect.call(app, id);
            };
          }
        `);

        // Focus second tab and press Enter
        await page.evaluate(() => {
          const tabs = document.querySelectorAll('.session-tab');
          (tabs[1] as HTMLElement)?.focus();
        });

        await page.keyboard.press('Enter');
        await page.waitForTimeout(100);

        const activated = await page.evaluate(() => (window as any).__tabActivated);
        expect(activated).toBe('mock-session-1');
      } finally {
        await context.close();
      }
    });
  });

  // ─── Tab Close Button Visibility ─────────────────────────────────────────

  describe('Tab Close Button Visibility', () => {
    it('close button hidden on non-active tabs', async () => {
      const { context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium');
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);

        // Inject tabs with close buttons
        await page.evaluate(() => {
          const container = document.querySelector('.session-tabs') || document.getElementById('sessionTabs');
          if (!container) return;
          container.innerHTML = '';

          for (let i = 0; i < 3; i++) {
            const tab = document.createElement('div');
            tab.className = i === 0 ? 'session-tab active' : 'session-tab';
            tab.innerHTML = `
              <span class="tab-name">Tab ${i}</span>
              <span class="tab-close">&times;</span>
            `;
            container.appendChild(tab);
          }
        });

        // Non-active tab close buttons should be hidden
        const closeButtonsHidden = await page.evaluate(() => {
          const inactiveTabs = document.querySelectorAll('.session-tab:not(.active) .tab-close');
          return Array.from(inactiveTabs).every((btn) => {
            const style = getComputedStyle(btn);
            return style.display === 'none';
          });
        });
        expect(closeButtonsHidden).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('gear icon visible only on active tab', async () => {
      const { context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium');
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);

        // Inject tabs with gear icons
        await page.evaluate(() => {
          const container = document.querySelector('.session-tabs') || document.getElementById('sessionTabs');
          if (!container) return;
          container.innerHTML = '';

          for (let i = 0; i < 3; i++) {
            const tab = document.createElement('div');
            tab.className = i === 0 ? 'session-tab active' : 'session-tab';
            tab.innerHTML = `
              <span class="tab-name">Tab ${i}</span>
              <span class="tab-gear">&#9881;</span>
              <span class="tab-close">&times;</span>
            `;
            container.appendChild(tab);
          }
        });

        // Only the active tab's gear should be visible
        const gearVisibility = await page.evaluate(() => {
          const allGears = document.querySelectorAll('.session-tab .tab-gear');
          return Array.from(allGears).map((gear) => {
            const tab = gear.closest('.session-tab');
            const isActive = tab?.classList.contains('active') ?? false;
            const style = getComputedStyle(gear);
            // Gear hidden via display:none (mobile) or opacity:0 + width:0 (desktop)
            const isVisible = style.display !== 'none'
              && style.visibility !== 'hidden'
              && parseFloat(style.opacity) > 0
              && parseFloat(style.width) > 0;
            return { isActive, isVisible };
          });
        });

        for (const { isActive, isVisible } of gearVisibility) {
          if (isActive) {
            expect(isVisible).toBe(true);
          } else {
            expect(isVisible).toBe(false);
          }
        }
      } finally {
        await context.close();
      }
    });
  });

  // ─── Subagent Badge on Tab ───────────────────────────────────────────────

  describe('Subagent Badge on Tab', () => {
    it('subagent badge has correct dimensions', async () => {
      const { context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium');
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);

        // Inject a tab with a subagent badge (actual class: .tab-subagent-badge)
        await page.evaluate(() => {
          const container = document.querySelector('.session-tabs') || document.getElementById('sessionTabs');
          if (!container) return;
          container.innerHTML = '';

          const tab = document.createElement('div');
          tab.className = 'session-tab active';
          tab.innerHTML = `
            <span class="tab-name">Session</span>
            <span class="tab-subagent-badge">
              <span class="subagent-label">2 agents</span>
            </span>
          `;
          container.appendChild(tab);
        });

        const badgeExists = await page.$('.tab-subagent-badge');
        if (badgeExists) {
          const height = await getCSSNumericValue(page, '.tab-subagent-badge', 'height');
          const borderRadius = await getCSSProperty(page, '.tab-subagent-badge', 'border-radius');
          // Badge height should be 14px (from mobile.css)
          expect(height).toBeCloseTo(14, 0);
          // Border radius should be 7px (half of 14px height)
          expect(parseFloat(borderRadius)).toBeCloseTo(7, 0);
        }
      } finally {
        await context.close();
      }
    });
  });
});
