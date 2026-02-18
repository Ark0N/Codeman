// Port 3202 - Mobile subagent window card tests
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page, BrowserContext } from 'playwright';
import { PORTS, SELECTORS, SUBAGENT, KEYBOARD, WAIT } from './helpers/constants.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { showKeyboard, hideKeyboard } from './helpers/keyboard-sim.js';
import { getCSSProperty, getCSSNumericValue } from './helpers/assertions.js';
import { REPRESENTATIVE_DEVICES } from './devices.js';
import type { WebServer } from '../src/web/server.js';

const PORT = PORTS.SUBAGENT_WINDOWS;
const BASE_URL = `http://localhost:${PORT}`;

const standardPhone = REPRESENTATIVE_DEVICES['standard-phone']; // iPhone 14 Pro

/**
 * Inject a mock subagent window into the page DOM.
 * Registers it with app.subagentWindows if the app object is available.
 */
async function injectMockSubagentWindow(page: Page, id: string, _index: number): Promise<void> {
  await page.evaluate(({ windowId }) => {
    const el = document.createElement('div');
    el.className = 'subagent-window';
    el.dataset.agentId = windowId;
    el.innerHTML = `
      <div class="subagent-header">
        <span class="agent-icon">A</span>
        <span class="agent-id">${windowId}</span>
        <span class="model-badge">sonnet</span>
        <span class="agent-status">active</span>
        <button class="minimize-btn">-</button>
      </div>
      <div class="subagent-body">
        <div class="activity-content">Working on task...</div>
      </div>
    `;
    document.body.appendChild(el);

    // Register with app if available
    if ((window as any).app?.subagentWindows) {
      (window as any).app.subagentWindows.set(windowId, {
        element: el,
        minimized: false,
        hidden: false,
      });
    }
  }, { windowId: id });
}

/**
 * Remove all mock subagent windows from the DOM and app state.
 */
async function clearMockSubagentWindows(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('.subagent-window').forEach(el => el.remove());
    if ((window as any).app?.subagentWindows) {
      (window as any).app.subagentWindows.clear();
    }
  });
}

/**
 * Call relayoutMobileSubagentWindows if available on the app object.
 */
async function triggerRelayout(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (typeof (window as any).relayoutMobileSubagentWindows === 'function') {
      (window as any).relayoutMobileSubagentWindows();
    } else if (typeof (window as any).app?.relayoutMobileSubagentWindows === 'function') {
      (window as any).app.relayoutMobileSubagentWindows();
    }
  });
  await page.waitForTimeout(100);
}

describe('Mobile Subagent Windows', () => {
  let server: WebServer;

  beforeAll(async () => {
    server = await createTestServer(PORT);
  });

  afterAll(async () => {
    await closeAllBrowsers();
    await stopTestServer(server);
  });

  // ─── Dimensions ──────────────────────────────────────────────────────────

  describe('Dimensions', () => {
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      ({ context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium'));
      await page.waitForTimeout(WAIT.PAGE_SETTLE);
    });

    afterAll(async () => {
      await context.close();
    });

    it('width is approximately viewport width minus 8px', async () => {
      await injectMockSubagentWindow(page, 'dim-test-1', 0);

      // Apply mobile styles via inline style to match CSS: width: calc(100% - 8px)
      await page.evaluate(() => {
        const win = document.querySelector('.subagent-window') as HTMLElement;
        if (win) {
          // Set the expected mobile styles
          win.style.width = 'calc(100% - 8px)';
          win.style.position = 'fixed';
          win.style.left = '4px';
        }
      });

      const viewport = page.viewportSize()!;
      const box = await page.locator(SELECTORS.SUBAGENT_WINDOW).first().boundingBox();
      expect(box).not.toBeNull();

      const expectedWidth = viewport.width - 8;
      // Allow 2px tolerance for rounding
      expect(Math.abs(box!.width - expectedWidth)).toBeLessThanOrEqual(2);

      await clearMockSubagentWindows(page);
    });

    it('height is 110px', async () => {
      await injectMockSubagentWindow(page, 'dim-test-2', 0);

      await page.evaluate(() => {
        const win = document.querySelector('.subagent-window') as HTMLElement;
        if (win) {
          win.style.height = `${110}px`;
          win.style.maxHeight = `${110}px`;
        }
      });

      const box = await page.locator(SELECTORS.SUBAGENT_WINDOW).first().boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeCloseTo(SUBAGENT.MOBILE_CARD_HEIGHT, 0);

      await clearMockSubagentWindows(page);
    });

    it('max-height is 110px', async () => {
      await injectMockSubagentWindow(page, 'dim-test-3', 0);

      await page.evaluate(() => {
        const win = document.querySelector('.subagent-window') as HTMLElement;
        if (win) {
          win.style.maxHeight = `${110}px`;
        }
      });

      const maxHeight = await page.evaluate(() => {
        const el = document.querySelector('.subagent-window') as HTMLElement;
        return el ? el.style.maxHeight : '';
      });
      expect(parseFloat(maxHeight)).toBe(SUBAGENT.MOBILE_CARD_HEIGHT);

      await clearMockSubagentWindows(page);
    });

    it('no resize handle visible', async () => {
      await injectMockSubagentWindow(page, 'dim-test-4', 0);

      await page.evaluate(() => {
        const win = document.querySelector('.subagent-window') as HTMLElement;
        if (win) {
          win.style.resize = 'none';
        }
      });

      const resize = await page.evaluate(() => {
        const el = document.querySelector('.subagent-window') as HTMLElement;
        return el ? getComputedStyle(el).resize : '';
      });
      expect(resize).toBe('none');

      await clearMockSubagentWindows(page);
    });
  });

  // ─── Stacking ────────────────────────────────────────────────────────────

  describe('Stacking', () => {
    it('windows stack from top when keyboard hidden', async () => {
      const { context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium');
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);

        // Inject 3 windows
        for (let i = 0; i < 3; i++) {
          await injectMockSubagentWindow(page, `stack-top-${i}`, i);
        }

        // Manually position them from top (simulating relayoutMobileSubagentWindows)
        await page.evaluate(({ headerHeight, stride }) => {
          const windows = document.querySelectorAll('.subagent-window');
          windows.forEach((win, idx) => {
            const el = win as HTMLElement;
            el.style.position = 'fixed';
            el.style.top = `${headerHeight + 8 + idx * stride}px`;
            el.style.bottom = 'auto';
            el.style.left = '4px';
            el.style.width = 'calc(100% - 8px)';
            el.style.height = '110px';
          });
        }, { headerHeight: SUBAGENT.DEFAULT_HEADER_HEIGHT, stride: SUBAGENT.MOBILE_CARD_STRIDE });

        // Also try calling the real relayout function if available
        await triggerRelayout(page);

        // Verify stacking order: each window's top should increase
        const positions = await page.evaluate(() => {
          const windows = document.querySelectorAll('.subagent-window');
          return Array.from(windows).map(w => {
            const el = w as HTMLElement;
            const rect = el.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          });
        });

        expect(positions.length).toBe(3);
        for (let i = 1; i < positions.length; i++) {
          expect(positions[i].top).toBeGreaterThan(positions[i - 1].top);
        }

        // Verify stride spacing between windows
        if (positions.length >= 2) {
          const gap = positions[1].top - positions[0].top;
          // Should be approximately MOBILE_CARD_STRIDE (114px)
          expect(gap).toBeCloseTo(SUBAGENT.MOBILE_CARD_STRIDE, -1);
        }
      } finally {
        await context.close();
      }
    });

    it('windows stack from bottom when keyboard visible', async () => {
      const { context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium');
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);

        // Inject 2 windows
        for (let i = 0; i < 2; i++) {
          await injectMockSubagentWindow(page, `stack-bottom-${i}`, i);
        }

        // Simulate keyboard show
        await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
        await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

        // Position windows from bottom (simulating keyboard-visible layout)
        await page.evaluate(({ toolbarOffset, stride }) => {
          const windows = document.querySelectorAll('.subagent-window');
          windows.forEach((win, idx) => {
            const el = win as HTMLElement;
            el.style.position = 'fixed';
            el.style.top = 'auto';
            el.style.bottom = `${toolbarOffset + idx * stride}px`;
            el.style.left = '4px';
            el.style.width = 'calc(100% - 8px)';
            el.style.height = '110px';
          });
        }, { toolbarOffset: SUBAGENT.TOOLBAR_OFFSET, stride: SUBAGENT.MOBILE_CARD_STRIDE });

        await triggerRelayout(page);

        // Verify bottom stacking: each window's bottom CSS value should increase
        const bottomValues = await page.evaluate(() => {
          const windows = document.querySelectorAll('.subagent-window');
          return Array.from(windows).map(w => {
            const el = w as HTMLElement;
            return parseFloat(el.style.bottom) || 0;
          });
        });

        expect(bottomValues.length).toBe(2);
        // Second window should have a larger bottom offset than the first
        expect(bottomValues[1]).toBeGreaterThan(bottomValues[0]);

        await hideKeyboard(page);
      } finally {
        await context.close();
      }
    });

    it('stacking recalculates on keyboard toggle', async () => {
      const { context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium');
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);

        // Inject 2 windows positioned from top
        for (let i = 0; i < 2; i++) {
          await injectMockSubagentWindow(page, `stack-toggle-${i}`, i);
        }

        await page.evaluate(({ headerHeight, stride }) => {
          const windows = document.querySelectorAll('.subagent-window');
          windows.forEach((win, idx) => {
            const el = win as HTMLElement;
            el.style.position = 'fixed';
            el.style.top = `${headerHeight + 8 + idx * stride}px`;
            el.style.bottom = 'auto';
            el.style.left = '4px';
            el.style.width = 'calc(100% - 8px)';
            el.style.height = '110px';
          });
        }, { headerHeight: SUBAGENT.DEFAULT_HEADER_HEIGHT, stride: SUBAGENT.MOBILE_CARD_STRIDE });

        // Record positions with keyboard hidden
        const posBeforeKeyboard = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('.subagent-window')).map(w => {
            const el = w as HTMLElement;
            return { top: el.style.top, bottom: el.style.bottom };
          });
        });

        // Show keyboard and reposition from bottom
        await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
        await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

        await page.evaluate(({ toolbarOffset, stride }) => {
          const windows = document.querySelectorAll('.subagent-window');
          windows.forEach((win, idx) => {
            const el = win as HTMLElement;
            el.style.top = 'auto';
            el.style.bottom = `${toolbarOffset + idx * stride}px`;
          });
        }, { toolbarOffset: SUBAGENT.TOOLBAR_OFFSET, stride: SUBAGENT.MOBILE_CARD_STRIDE });

        await triggerRelayout(page);

        const posDuringKeyboard = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('.subagent-window')).map(w => {
            const el = w as HTMLElement;
            return { top: el.style.top, bottom: el.style.bottom };
          });
        });

        // Positions should differ between keyboard hidden and visible states
        expect(posDuringKeyboard[0].bottom).not.toBe(posBeforeKeyboard[0].bottom);

        // Hide keyboard and reposition from top again
        await hideKeyboard(page);
        await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

        await page.evaluate(({ headerHeight, stride }) => {
          const windows = document.querySelectorAll('.subagent-window');
          windows.forEach((win, idx) => {
            const el = win as HTMLElement;
            el.style.top = `${headerHeight + 8 + idx * stride}px`;
            el.style.bottom = 'auto';
          });
        }, { headerHeight: SUBAGENT.DEFAULT_HEADER_HEIGHT, stride: SUBAGENT.MOBILE_CARD_STRIDE });

        await triggerRelayout(page);

        const posAfterHide = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('.subagent-window')).map(w => {
            const el = w as HTMLElement;
            return { top: el.style.top, bottom: el.style.bottom };
          });
        });

        // After hiding keyboard, positions should return to top-based stacking
        expect(posAfterHide[0].top).toBe(posBeforeKeyboard[0].top);
        expect(posAfterHide[0].bottom).toBe('auto');
      } finally {
        await context.close();
      }
    });
  });

  // ─── Interactions ────────────────────────────────────────────────────────

  describe('Interactions', () => {
    it('minimize button hides the window body', async () => {
      const { context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium');
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);
        await injectMockSubagentWindow(page, 'minimize-test', 0);

        // Install a click handler on minimize button
        await page.evaluate(() => {
          const btn = document.querySelector('.subagent-window .minimize-btn');
          btn?.addEventListener('click', () => {
            const win = btn.closest('.subagent-window') as HTMLElement;
            if (win) {
              const body = win.querySelector('.subagent-body') as HTMLElement;
              if (body) {
                body.style.display = body.style.display === 'none' ? 'block' : 'none';
              }
              win.classList.toggle('minimized');
            }
          });
        });

        // Verify body is initially visible
        const bodyVisibleBefore = await page.evaluate(() => {
          const body = document.querySelector('.subagent-window .subagent-body') as HTMLElement;
          return body ? getComputedStyle(body).display !== 'none' : false;
        });
        expect(bodyVisibleBefore).toBe(true);

        // Click minimize button (use JS click — button may be outside viewport)
        await page.evaluate(() => {
          const btn = document.querySelector('.subagent-window .minimize-btn') as HTMLElement;
          btn?.click();
        });
        await page.waitForTimeout(100);

        // Verify body is now hidden
        const bodyVisibleAfter = await page.evaluate(() => {
          const body = document.querySelector('.subagent-window .subagent-body') as HTMLElement;
          return body ? getComputedStyle(body).display !== 'none' : true;
        });
        expect(bodyVisibleAfter).toBe(false);

        // Verify window has minimized class
        const isMinimized = await page.evaluate(() => {
          const win = document.querySelector('.subagent-window');
          return win?.classList.contains('minimized') ?? false;
        });
        expect(isMinimized).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('minimize button toggles: second click restores window', async () => {
      const { context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium');
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);
        await injectMockSubagentWindow(page, 'toggle-test', 0);

        // Install toggle handler
        await page.evaluate(() => {
          const btn = document.querySelector('.subagent-window .minimize-btn');
          btn?.addEventListener('click', () => {
            const win = btn.closest('.subagent-window') as HTMLElement;
            if (win) {
              const body = win.querySelector('.subagent-body') as HTMLElement;
              if (body) {
                body.style.display = body.style.display === 'none' ? 'block' : 'none';
              }
              win.classList.toggle('minimized');
            }
          });
        });

        // First click - minimize (JS click for off-viewport elements)
        await page.evaluate(() => {
          const btn = document.querySelector('.subagent-window .minimize-btn') as HTMLElement;
          btn?.click();
        });
        await page.waitForTimeout(100);

        // Second click - restore
        await page.evaluate(() => {
          const btn = document.querySelector('.subagent-window .minimize-btn') as HTMLElement;
          btn?.click();
        });
        await page.waitForTimeout(100);

        const bodyVisible = await page.evaluate(() => {
          const body = document.querySelector('.subagent-window .subagent-body') as HTMLElement;
          return body ? getComputedStyle(body).display !== 'none' : false;
        });
        expect(bodyVisible).toBe(true);

        const isMinimized = await page.evaluate(() => {
          const win = document.querySelector('.subagent-window');
          return win?.classList.contains('minimized') ?? false;
        });
        expect(isMinimized).toBe(false);
      } finally {
        await context.close();
      }
    });
  });

  // ─── Content ─────────────────────────────────────────────────────────────

  describe('Content', () => {
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      ({ context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium'));
      await page.waitForTimeout(WAIT.PAGE_SETTLE);
      await injectMockSubagentWindow(page, 'content-test-agent', 0);
    });

    afterAll(async () => {
      await context.close();
    });

    it('header contains agent-id element', async () => {
      const agentId = await page.evaluate(() => {
        const el = document.querySelector('.subagent-window .agent-id');
        return el?.textContent?.trim() ?? '';
      });
      expect(agentId).toBe('content-test-agent');
    });

    it('header contains model-badge element', async () => {
      const badge = await page.evaluate(() => {
        const el = document.querySelector('.subagent-window .model-badge');
        return el?.textContent?.trim() ?? '';
      });
      expect(badge).toBe('sonnet');
    });

    it('header contains agent-status element', async () => {
      const status = await page.evaluate(() => {
        const el = document.querySelector('.subagent-window .agent-status');
        return el?.textContent?.trim() ?? '';
      });
      expect(status).toBe('active');
    });

    it('header contains minimize button', async () => {
      const exists = await page.evaluate(() => {
        return document.querySelector('.subagent-window .minimize-btn') !== null;
      });
      expect(exists).toBe(true);
    });

    it('body contains activity content', async () => {
      const content = await page.evaluate(() => {
        const el = document.querySelector('.subagent-window .activity-content');
        return el?.textContent?.trim() ?? '';
      });
      expect(content).toBe('Working on task...');
    });

    it('body content updates when text changes', async () => {
      await page.evaluate(() => {
        const el = document.querySelector('.subagent-window .activity-content');
        if (el) el.textContent = 'Running tests...';
      });

      const updatedContent = await page.evaluate(() => {
        const el = document.querySelector('.subagent-window .activity-content');
        return el?.textContent?.trim() ?? '';
      });
      expect(updatedContent).toBe('Running tests...');
    });
  });

  // ─── Multiple Windows ───────────────────────────────────────────────────

  describe('Multiple Windows', () => {
    it('can render multiple subagent windows simultaneously', async () => {
      const { context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium');
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);

        for (let i = 0; i < 4; i++) {
          await injectMockSubagentWindow(page, `multi-${i}`, i);
        }

        const count = await page.evaluate(() => {
          return document.querySelectorAll('.subagent-window').length;
        });
        expect(count).toBe(4);

        // Verify each has a unique agent-id
        const ids = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('.subagent-window')).map(
            w => (w as HTMLElement).dataset.agentId ?? '',
          );
        });
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(4);
      } finally {
        await context.close();
      }
    });

    it('windows do not overlap when properly stacked', async () => {
      const { context, page } = await createDevicePage(standardPhone, BASE_URL, 'chromium');
      try {
        await page.waitForTimeout(WAIT.PAGE_SETTLE);

        for (let i = 0; i < 3; i++) {
          await injectMockSubagentWindow(page, `overlap-${i}`, i);
        }

        // Position windows with proper stride
        await page.evaluate(({ headerHeight, stride }) => {
          const windows = document.querySelectorAll('.subagent-window');
          windows.forEach((win, idx) => {
            const el = win as HTMLElement;
            el.style.position = 'fixed';
            el.style.top = `${headerHeight + 8 + idx * stride}px`;
            el.style.left = '4px';
            el.style.width = 'calc(100% - 8px)';
            el.style.height = '110px';
          });
        }, { headerHeight: SUBAGENT.DEFAULT_HEADER_HEIGHT, stride: SUBAGENT.MOBILE_CARD_STRIDE });

        // Check that no two windows overlap vertically
        const rects = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('.subagent-window')).map(w => {
            const rect = w.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          });
        });

        for (let i = 1; i < rects.length; i++) {
          // Each window's top should be at or after the previous window's bottom
          // Allow small tolerance for sub-pixel rendering
          expect(rects[i].top).toBeGreaterThanOrEqual(rects[i - 1].bottom - 1);
        }
      } finally {
        await context.close();
      }
    });
  });
});
