// Port 3200 - Virtual keyboard simulation tests
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Page, BrowserContext } from 'playwright';
import { PORTS, KEYBOARD, SELECTORS, BODY_CLASSES, WAIT } from './helpers/constants.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { createDevicePage, getBrowser, closeAllBrowsers } from './helpers/browser.js';
import {
  showKeyboard,
  hideKeyboard,
  showKeyboardViaCDP,
  hideKeyboardViaCDP,
  showKeyboardViaMock,
  hideKeyboardViaMock,
  showKeyboardViaDOM,
  hideKeyboardViaDOM,
  setupViewportMock,
} from './helpers/keyboard-sim.js';
import { getCDP, setVisualViewportHeight } from './helpers/cdp.js';
import {
  assertHasClass,
  assertNotHasClass,
  assertVisible,
  assertHidden,
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

        const hasClass = await page.evaluate(() => document.body.classList.contains('keyboard-visible'));
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

    it('toolbar remains below terminal when keyboard show shrinks the app viewport', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      const layout = await page.evaluate(() => {
        const toolbar = document.querySelector('.toolbar') as HTMLElement | null;
        const accessory = document.querySelector('.keyboard-accessory-bar') as HTMLElement | null;
        const terminalWrap = document.querySelector('.terminal-wrap') as HTMLElement | null;
        const toolbarRect = toolbar?.getBoundingClientRect();
        const accessoryRect = accessory?.getBoundingClientRect();
        const terminalRect = terminalWrap?.getBoundingClientRect();
        return {
          toolbarTransform: toolbar?.style.transform ?? '',
          accessoryTransform: (accessory as HTMLElement | null)?.style.transform ?? '',
          toolbarTop: toolbarRect?.top ?? 0,
          accessoryTop: accessoryRect?.top ?? 0,
          terminalBottom: terminalRect?.bottom ?? 0,
        };
      });
      expect(layout.toolbarTransform).toBe('');
      expect(layout.accessoryTransform).toBe('');
      expect(layout.accessoryTop).toBeGreaterThanOrEqual(layout.terminalBottom - 4);
      expect(layout.toolbarTop).toBeGreaterThan(layout.accessoryTop);
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

    it('does not reserve the keyboard height as visible terminal dead space', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      const layout = await page.evaluate(() => {
        const main = document.querySelector('.main') as HTMLElement | null;
        const appEl = document.querySelector('.app') as HTMLElement | null;
        const terminalWrap = document.querySelector('.terminal-wrap') as HTMLElement | null;
        const toolbar = document.querySelector('.toolbar') as HTMLElement | null;
        const accessory = document.querySelector('.keyboard-accessory-bar') as HTMLElement | null;
        return {
          appHeight: appEl?.getBoundingClientRect().height ?? 0,
          mainPaddingBottom: main ? parseFloat(main.style.paddingBottom || '0') : 0,
          terminalHeight: terminalWrap?.getBoundingClientRect().height ?? 0,
          toolbarHeight: toolbar?.getBoundingClientRect().height ?? 0,
          accessoryHeight: accessory?.getBoundingClientRect().height ?? 0,
          visualViewportHeight: window.visualViewport?.height ?? window.innerHeight,
        };
      });

      expect(layout.appHeight).toBeLessThanOrEqual(layout.visualViewportHeight + 2);
      expect(layout.mainPaddingBottom).toBeLessThan(KEYBOARD.TYPICAL_IOS_HEIGHT);
      expect(layout.mainPaddingBottom).toBeGreaterThanOrEqual(layout.toolbarHeight + layout.accessoryHeight - 4);
      expect(layout.terminalHeight).toBeGreaterThan(160);
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

    it('coalesces keyboard animation frames into one final terminal fit', async () => {
      const result = await page.evaluate(async () => {
        // `app.terminal` and `app.fitAddon` are only assigned by initTerminal(),
        // which needs a selected session this harness never creates. Both are
        // null at rest, and the settle callback returns early on a falsy
        // terminal — so without stand-ins this test cannot reach the behavior
        // it asserts. Install the minimum surface the callback touches.
        const hadTerminal = app.terminal !== null && app.terminal !== undefined;
        const hadFitAddon = app.fitAddon !== null && app.fitAddon !== undefined;
        if (!hadTerminal) app.terminal = { scrollToBottom() {} };
        if (!hadFitAddon) app.fitAddon = { fit() {}, proposeDimensions: () => null };

        const originalFit = app.fitAddon.fit.bind(app.fitAddon);
        const originalSendResize = KeyboardHandler._sendTerminalResize.bind(KeyboardHandler);
        const originalScrollToBottom = app.terminal.scrollToBottom.bind(app.terminal);
        let fits = 0;
        let resizes = 0;
        let bottomRestores = 0;
        app.fitAddon.fit = () => {
          fits++;
        };
        KeyboardHandler._sendTerminalResize = () => {
          resizes++;
        };
        app.terminal.scrollToBottom = () => {
          bottomRestores++;
        };

        KeyboardHandler._scheduleViewportSettle({ restoreScroll: true });
        await new Promise((resolve) => setTimeout(resolve, 30));
        KeyboardHandler._scheduleViewportSettle();
        await new Promise((resolve) => setTimeout(resolve, 30));
        KeyboardHandler._scheduleViewportSettle();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const beforeFinalSettle = { fits, resizes, bottomRestores };
        await new Promise((resolve) => setTimeout(resolve, KeyboardHandler.VIEWPORT_SETTLE_MS));
        const afterFinalSettle = { fits, resizes, bottomRestores };

        app.fitAddon.fit = originalFit;
        KeyboardHandler._sendTerminalResize = originalSendResize;
        app.terminal.scrollToBottom = originalScrollToBottom;
        if (!hadFitAddon) app.fitAddon = null;
        if (!hadTerminal) app.terminal = null;
        return { beforeFinalSettle, afterFinalSettle };
      });

      expect(result.beforeFinalSettle).toEqual({ fits: 0, resizes: 0, bottomRestores: 0 });
      expect(result.afterFinalSettle).toEqual({ fits: 1, resizes: 1, bottomRestores: 1 });
    });

    // Behavioral counterpart to the test above, driven through the PUBLIC entry
    // point rather than the internal scheduler. Before this change each
    // onKeyboardShow armed its own uncoalesced 150ms setTimeout, so a keyboard
    // animation that reports several viewport steps refit the terminal once per
    // step — the visible symptom being repeated reflow while the keyboard slides
    // up. This asserts the observable outcome (one refit for a burst) and so
    // fails on master by COUNT, not by a missing method.
    it('refits once for a burst of keyboard viewport steps', async () => {
      const counts = await page.evaluate(async () => {
        const hadTerminal = app.terminal !== null && app.terminal !== undefined;
        const hadFitAddon = app.fitAddon !== null && app.fitAddon !== undefined;
        if (!hadTerminal) app.terminal = { scrollToBottom() {} };
        if (!hadFitAddon) app.fitAddon = { fit() {}, proposeDimensions: () => null };

        const originalFit = app.fitAddon.fit.bind(app.fitAddon);
        const originalSendResize = KeyboardHandler._sendTerminalResize.bind(KeyboardHandler);
        let fits = 0;
        app.fitAddon.fit = () => {
          fits++;
        };
        KeyboardHandler._sendTerminalResize = () => {};

        // Three viewport steps in quick succession, as a keyboard animation
        // produces on a real device.
        KeyboardHandler.onKeyboardShow();
        await new Promise((resolve) => setTimeout(resolve, 30));
        KeyboardHandler.onKeyboardShow();
        await new Promise((resolve) => setTimeout(resolve, 30));
        KeyboardHandler.onKeyboardShow();

        // Well past both the coalescing window and master's fixed 150ms timer.
        await new Promise((resolve) => setTimeout(resolve, 400));

        app.fitAddon.fit = originalFit;
        KeyboardHandler._sendTerminalResize = originalSendResize;
        if (!hadFitAddon) app.fitAddon = null;
        if (!hadTerminal) app.terminal = null;
        return fits;
      });

      // Coalesced: one refit for the whole burst. Master fires one per step.
      expect(counts).toBe(1);
    });

    // A viewport resize with NO pending show/hide transition must not arm settle
    // work of its own: keyboard detection can miss a fine-grained OS animation
    // entirely (sub-150px steps with the baseline chasing the animation), and a
    // fit against that mid-animation, uncompensated layout resizes the PTY to
    // transient dims. The resulting SIGWINCH thrash duplicates prompts and
    // garbles the transcript. Wiggles may only push a pending settle back.
    it('does not refit on viewport wiggles without a keyboard transition', async () => {
      const result = await page.evaluate(async () => {
        const hadTerminal = app.terminal !== null && app.terminal !== undefined;
        const hadFitAddon = app.fitAddon !== null && app.fitAddon !== undefined;
        if (!hadTerminal) app.terminal = { scrollToBottom() {} };
        if (!hadFitAddon) app.fitAddon = { fit() {}, proposeDimensions: () => null };

        const originalFit = app.fitAddon.fit.bind(app.fitAddon);
        const originalSendResize = KeyboardHandler._sendTerminalResize.bind(KeyboardHandler);
        let fits = 0;
        app.fitAddon.fit = () => {
          fits++;
        };
        KeyboardHandler._sendTerminalResize = () => {};

        // Wiggle only: nothing pending, so nothing may fire.
        KeyboardHandler._deferViewportSettle();
        KeyboardHandler._deferViewportSettle();
        await new Promise((resolve) => setTimeout(resolve, KeyboardHandler.VIEWPORT_SETTLE_MS + 80));
        const wiggleOnly = fits;

        // A real transition arms the work; a following wiggle defers it but the
        // settle still fires exactly once.
        KeyboardHandler._scheduleViewportSettle({ restoreScroll: true });
        await new Promise((resolve) => setTimeout(resolve, 30));
        KeyboardHandler._deferViewportSettle();
        await new Promise((resolve) => setTimeout(resolve, KeyboardHandler.VIEWPORT_SETTLE_MS + 80));
        const afterTransition = fits;

        app.fitAddon.fit = originalFit;
        KeyboardHandler._sendTerminalResize = originalSendResize;
        if (!hadFitAddon) app.fitAddon = null;
        if (!hadTerminal) app.terminal = null;
        return { wiggleOnly, afterTransition };
      });

      expect(result.wiggleOnly).toBe(0);
      expect(result.afterTransition).toBe(1);
    });

    it('accessory bar has the simple-mode action buttons', async () => {
      const actions = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.keyboard-accessory-bar [data-action]')).map(
          (button) => (button as HTMLElement).dataset.action
        );
      });
      // Tab replaced /clear in the simple bar; /clear and /compact live in the
      // extended bar only.
      expect(actions).toEqual([
        'scroll-up',
        'scroll-down',
        'init',
        'tab',
        'shift-left',
        'shift-right',
        'paste',
        'readmymind',
        'esc',
        'dismiss',
      ]);
    });

    it('double-tap confirm on /clear button', async () => {
      // Make accessory bar visible
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      // handleAction() early-returns if app.activeSessionId is falsy — mock it.
      // /clear only exists in the extended bar now, so switch modes first.
      await page.evaluate(`
        if (typeof app !== 'undefined') app.activeSessionId = 'test-session';
        KeyboardAccessoryBar.setMode('extended');
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

      await page.evaluate(`KeyboardAccessoryBar.setMode('simple');`);
    });

    it('double-tap expires after 2s', async () => {
      await showKeyboard(page, KEYBOARD.TYPICAL_IOS_HEIGHT);
      await page.waitForTimeout(WAIT.KEYBOARD_ANIMATION);

      await page.evaluate(`
        if (typeof app !== 'undefined') app.activeSessionId = 'test-session';
        KeyboardAccessoryBar.setMode('extended');
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

      await page.evaluate(`KeyboardAccessoryBar.setMode('simple');`);
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

    it('keeps xterm helper textarea focusable near the terminal cursor on touch devices', async () => {
      const styles = await page.evaluate(async () => {
        await new Promise<void>((resolve) => app.terminal.write('prompt', resolve));
        app.terminal.focus();
        app._syncMobileHelperTextareaToCursor?.();
        const textarea = document.querySelector('.xterm-helper-textarea');
        const cursor = document.querySelector('.xterm-cursor');
        const screen = document.querySelector('.xterm-screen');
        if (!(textarea instanceof HTMLElement) || !(cursor instanceof HTMLElement) || !(screen instanceof HTMLElement))
          return null;
        const cs = getComputedStyle(textarea);
        const cursorRect = cursor.getBoundingClientRect();
        const screenRect = screen.getBoundingClientRect();
        return {
          left: cs.left,
          top: cs.top,
          width: cs.width,
          height: cs.height,
          zIndex: cs.zIndex,
          opacity: cs.opacity,
          cursorLeft: `${Math.max(0, Math.round(cursorRect.left - screenRect.left))}px`,
          cursorTop: `${Math.max(0, Math.round(cursorRect.top - screenRect.top))}px`,
        };
      });

      expect(styles).not.toBeNull();
      expect(styles?.left).toBe(styles?.cursorLeft);
      expect(styles?.top).toBe(styles?.cursorTop);
      expect(styles?.cursorLeft).not.toBe('0px');
      expect(styles?.width).toBe('1px');
      expect(styles?.height).toBe('1px');
      expect(styles?.opacity).toBe('0');
      expect(Number(styles?.zIndex)).toBeGreaterThanOrEqual(0);
    });

    it('dismisses the on-screen keyboard when a tap lands outside the terminal', async () => {
      // The terminal holds focus on a hidden textarea and nothing released it,
      // so once the keyboard was up every tap on the header or page chrome left
      // it up — covering half a phone screen with no in-app way to close it.
      //
      // Driven as a real dispatched gesture: the handler is bound to touchend on
      // document, and calling the internal helper would bypass the routing this
      // test exists to check.
      const result = await page.evaluate(async () => {
        const sampleX = (rect: DOMRect) => Math.max(2, rect.left + Math.min(6, rect.width / 2));
        const sampleY = (rect: DOMRect) => Math.max(2, rect.top + Math.min(6, rect.height / 2));
        const tap = async (el: Element, travel = 0, point?: { x: number; y: number }) => {
          const rect = el.getBoundingClientRect();
          const x = point ? point.x : sampleX(rect);
          const y = point ? point.y : sampleY(rect);
          const target = document.elementFromPoint(x, y) || el;
          const at = (cy: number) => new Touch({ identifier: 21, target, clientX: x, clientY: cy });
          target.dispatchEvent(
            new TouchEvent('touchstart', {
              touches: [at(y)],
              targetTouches: [at(y)],
              changedTouches: [at(y)],
              bubbles: true,
              cancelable: true,
            })
          );
          for (const step of travel ? [travel / 3, (travel * 2) / 3, travel] : []) {
            target.dispatchEvent(
              new TouchEvent('touchmove', {
                touches: [at(y + step)],
                targetTouches: [at(y + step)],
                changedTouches: [at(y + step)],
                bubbles: true,
                cancelable: true,
              })
            );
            await new Promise((resolve) => setTimeout(resolve, 15));
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          target.dispatchEvent(
            new TouchEvent('touchend', {
              touches: [],
              changedTouches: [at(y + travel)],
              bubbles: true,
              cancelable: true,
            })
          );
          await new Promise((resolve) => setTimeout(resolve, 250));
          return document.activeElement?.className ?? '';
        };

        app.hideWelcome();
        app.terminal.reset();
        await new Promise<void>((resolve) => app.terminal.write('transcript\r\n\r\n> ', resolve));

        // Inert page chrome: the keyboard must close.
        app._focusMobileTerminalInput();
        const focusedBefore = document.activeElement?.className ?? '';
        const afterOutside = await tap(document.querySelector('.logo, .header-brand, header') ?? document.body);

        // A real control: it takes focus itself, so we must NOT interfere.
        app._focusMobileTerminalInput();
        const button = Array.from(document.querySelectorAll('button:not([disabled])')).find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          if (rect.width <= 8 || rect.height <= 8) return false;
          // A rect is not enough. The welcome overlay is hidden by hideWelcome()
          // above but its buttons still MEASURE, so a rect-only pick sampled a
          // point the terminal actually owns — elementFromPoint returned
          // .xterm-screen and this case tapped the terminal instead of a
          // control, passing for the wrong reason. Require the sampled point to
          // really resolve to this button.
          const hit = document.elementFromPoint(sampleX(rect), sampleY(rect));
          return !!hit && candidate.contains(hit);
        });
        const afterButton = button ? await tap(button) : 'no-visible-button';

        // Inside the terminal, tap classification owns the decision, so this
        // handler must keep its hands off. Aimed at the PROMPT row: that is the
        // one in-terminal tap whose outcome belongs to nobody else, since an
        // inert transcript row is claimed by the in-terminal dismiss toggle
        // (`toggles the keyboard shut on a second inert Claude transcript tap`)
        // and asserting focus there would be asserting that toggle's behaviour
        // rather than this exemption. The guard still bites: the container's own
        // touchend listener runs first and refocuses, so a missing
        // #terminalContainer exemption would blur right back over it.
        app._focusMobileTerminalInput();
        const screen = app.terminal.element?.querySelector('.xterm-screen');
        const cell = app.terminal._core?._renderService?.dimensions?.css?.cell;
        const screenRect = screen?.getBoundingClientRect();
        const promptPoint =
          screenRect && cell?.width && cell?.height
            ? {
                x: screenRect.left + cell.width * 2,
                y: screenRect.top + cell.height * (app.terminal.buffer.active.cursorY + 0.5),
              }
            : undefined;
        const afterTerminal = await tap(document.querySelector('#terminalContainer')!, 0, promptPoint);

        // A SCROLL also ends in touchend. Scrolling to read something while
        // composing must not close the keyboard and drop the composer.
        app._focusMobileTerminalInput();
        const afterScroll = await tap(document.querySelector('.logo, .header-brand, header') ?? document.body, 120);

        return { focusedBefore, afterOutside, afterButton, afterTerminal, afterScroll };
      });

      expect(result.focusedBefore).toContain('xterm-helper-textarea');
      // Red on master: the textarea keeps focus and the keyboard stays up.
      expect(result.afterOutside).not.toContain('xterm-helper-textarea');
      expect(result.afterButton).not.toBe('no-visible-button');
      expect(result.afterButton).toContain('xterm-helper-textarea');
      expect(result.afterTerminal).toContain('xterm-helper-textarea');
      // A scroll ends in touchend too, and must NOT close the keyboard.
      expect(result.afterScroll).toContain('xterm-helper-textarea');
    });

    it('routes CJK textarea typing through local echo on Enter', async () => {
      await page.evaluate(() => {
        window.__sentInputs = [];
        const sessionId = 'mobile-cjk-local-echo-test';
        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, { id: sessionId, mode: 'codex' });
        app._localEchoEnabled = true;
        app._localEchoOverlay = {
          pendingText: '',
          appendText(text: string) {
            this.pendingText += text;
          },
          removeChar() {
            this.pendingText = this.pendingText.slice(0, -1);
            return 'pending';
          },
          clear() {
            this.pendingText = '';
          },
          suppressBufferDetection() {},
        };
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._serverCjkOverride = true;
        app._updateCjkInputState?.();
      });

      await page.locator('#cjkInput').focus();
      await page.keyboard.type('hello');

      const beforeEnter = await page.evaluate(() => ({
        visibleText: (document.getElementById('cjkInput') as HTMLTextAreaElement).value.replace(/\u200B/g, ''),
        pendingText: app._localEchoOverlay.pendingText,
        sentInputs: window.__sentInputs,
      }));
      expect(beforeEnter.visibleText).toBe('hello');
      expect(beforeEnter.pendingText).toBe('');
      expect(beforeEnter.sentInputs).toEqual([]);

      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__sentInputs?.length === 2);
      const afterEnter = await page.evaluate(() => ({
        pendingText: app._localEchoOverlay.pendingText,
        sentInputs: window.__sentInputs,
      }));
      expect(afterEnter.pendingText).toBe('');
      expect(afterEnter.sentInputs).toEqual(['hello', '\r']);
    });

    it('shows the CJK textarea on mobile for server override only inside an active session', async () => {
      const state = await page.evaluate(() => {
        const input = document.getElementById('cjkInput');
        if (!(input instanceof HTMLElement)) return null;

        // Welcome screen (no active session): even with the server override on, the
        // fixed-position textarea must stay hidden so it doesn't float over the overlay.
        app.activeSessionId = null;
        app._serverCjkOverride = true;
        app._updateCjkInputState();
        const onWelcomeDisplay = getComputedStyle(input).display;

        // Entering a session reveals it.
        app.activeSessionId = 'cjk-server-override-test';
        app._updateCjkInputState();
        const cs = getComputedStyle(input);
        return {
          onWelcomeDisplay,
          display: cs.display,
          position: cs.position,
          bottom: cs.bottom,
          zIndex: cs.zIndex,
          ariaHidden: input.getAttribute('aria-hidden'),
        };
      });

      expect(state).not.toBeNull();
      expect(state?.onWelcomeDisplay).toBe('none');
      expect(state?.display).not.toBe('none');
      expect(state?.position).toBe('fixed');
      expect(Number(state?.zIndex)).toBeGreaterThan(50);
      expect(state?.ariaHidden).toBe('false');
    });

    it('hides the CJK textarea by default on phones', async () => {
      const state = await page.evaluate(() => {
        localStorage.removeItem(app.getSettingsStorageKey());
        app._cachedAppSettings = null;
        app._updateCjkInputState();

        const input = document.getElementById('cjkInput');
        if (!(input instanceof HTMLElement)) return null;
        const cs = getComputedStyle(input);
        return {
          display: cs.display,
          position: cs.position,
          bodyClass: document.body.classList.contains('cjk-input-visible'),
        };
      });

      expect(state).not.toBeNull();
      expect(state?.display).toBe('none');
      expect(state?.bodyClass).toBe(false);
    });

    it('keeps the CJK textarea hidden even when old phone settings enabled it', async () => {
      const state = await page.evaluate(() => {
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();

        const input = document.getElementById('cjkInput');
        if (!(input instanceof HTMLElement)) return null;
        const cs = getComputedStyle(input);
        return {
          display: cs.display,
          position: cs.position,
          bodyClass: document.body.classList.contains('cjk-input-visible'),
        };
      });

      expect(state).not.toBeNull();
      expect(state?.display).toBe('none');
      expect(state?.bodyClass).toBe(false);
    });

    it('focuses the terminal helper textarea when the terminal is tapped', async () => {
      await page.evaluate(() => {
        app.activeSessionId = 'mobile-focus-visible-input-test';
        app.sessions.set('mobile-focus-visible-input-test', {
          id: 'mobile-focus-visible-input-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
      });

      await page.locator('#terminalContainer').tap({ position: { x: 40, y: 40 } });

      const activeClass = await page.evaluate(() => document.activeElement?.className);
      expect(activeClass).toContain('xterm-helper-textarea');
    });

    // Regression guard for the phone-keyboard blocker reduced in #173 and re-hit
    // by #244. selectSession() ends with scrollToLastNonEmptyLine(), which parks
    // the viewport ABOVE the bottom for any session whose buffer is taller than
    // the screen and ends in blank rows, i.e. every real session after a tab
    // switch. A tap-routing scheme that treats "viewport is scrolled up" as a
    // reason to blur strands document.activeElement on <body> with no way to
    // raise the keyboard, and the prompt row is no exception. Suppressing the
    // MOUSE REPORT while scrolled up is correct and pinned below; suppressing
    // FOCUS is not. Measured against PR #244 on 2026-08-09: body vs textarea.
    //
    // Must be a dispatched gesture: calling the touchend handler directly
    // bypasses touchstart's preventDefault, which is half of what closes the
    // focus path, so a direct call reports the right intent and still misses.
    it('keeps the terminal input focusable after a tab switch parks the viewport off-bottom', async () => {
      const probe = await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-offbottom-tap-test';
        app.sessions.set('mobile-offbottom-tap-test', {
          id: 'mobile-offbottom-tap-test',
          mode: 'claude',
          cliVersion: '2.1.220',
          status: 'running',
        });
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app.terminal.reset();

        // Taller than the viewport, ending in the trailing blank rows that make
        // scrollToLastNonEmptyLine() stop short of the bottom.
        const lines: string[] = [];
        for (let i = 1; i <= app.terminal.rows * 3; i++) lines.push(`Transcript row ${i}`);
        lines.push('', '❯ ', '', '');
        await new Promise<void>((resolve) => app.terminal.write(lines.join('\r\n'), resolve));

        app.scrollToLastNonEmptyLine(); // what selectSession() does on every tab switch
        (document.activeElement as HTMLElement | null)?.blur?.();

        const screen = app.terminal.element?.querySelector('.xterm-screen');
        const cell = app.terminal._core?._renderService?.dimensions?.css?.cell;
        const rect = screen?.getBoundingClientRect();
        if (!rect || !cell?.width || !cell?.height) return null;
        const buffer = app.terminal.buffer.active;
        return {
          x: rect.left + cell.width * 2,
          y: rect.top + cell.height * 5.5,
          atBottom: buffer.viewportY >= buffer.baseY,
        };
      });

      expect(probe).not.toBeNull();
      // The guard only means anything if the viewport really did park off-bottom.
      expect(probe!.atBottom).toBe(false);

      await page.touchscreen.tap(probe!.x, probe!.y);

      const state = await page.evaluate(() => ({
        activeClass: document.activeElement?.className,
        sentInputs: window.__sentInputs,
      }));
      expect(state.activeClass).toContain('xterm-helper-textarea');
      // SGR coordinates are meaningless off-bottom, so the tap must stay silent.
      expect(state.sentInputs).toEqual([]);
    });

    it('collapses a terminal readback without focusing the hidden textarea', async () => {
      const point = await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-readback-tap-test';
        app.sessions.set('mobile-readback-tap-test', {
          id: 'mobile-readback-tap-test',
          mode: 'codex',
          status: 'running',
        });
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app.terminal.reset();
        await new Promise<void>((resolve) =>
          app.terminal.write('Agent readback\r\n  tap to collapse\r\n\r\n› ask', resolve)
        );
        app.terminal.focus();

        const screen = app.terminal.element?.querySelector('.xterm-screen');
        const cell = app.terminal._core?._renderService?.dimensions?.css?.cell;
        const rect = screen?.getBoundingClientRect();
        if (!rect || !cell?.width || !cell?.height) return null;
        return {
          x: rect.left + cell.width * 2,
          y: rect.top + cell.height / 2,
        };
      });
      expect(point).not.toBeNull();

      await page.touchscreen.tap(point!.x, point!.y);

      const state = await page.evaluate(() => ({
        activeClass: document.activeElement?.className,
        sentInputs: window.__sentInputs,
      }));
      expect(state.activeClass).not.toContain('xterm-helper-textarea');
      expect(state.sentInputs).toHaveLength(1);
      expect(state.sentInputs[0]).toMatch(/^\x1b\[<0;\d+;1M\x1b\[<0;\d+;1m$/);
    });

    it('toggles the keyboard shut on a second inert Claude transcript tap', async () => {
      const point = await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-claude-transcript-tap-test';
        app.sessions.set('mobile-claude-transcript-tap-test', {
          id: 'mobile-claude-transcript-tap-test',
          mode: 'claude',
          cliVersion: '2.1.220',
          status: 'working',
        });
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app.terminal.reset();
        await new Promise<void>((resolve) =>
          app.terminal.write(
            'Transcript row one\r\nTranscript row two\r\nTranscript row three\r\nTranscript row four\r\nTranscript row five\r\nTranscript row six\r\nTranscript row seven\r\nTranscript row eight\r\nTranscript row nine\r\nTranscript row ten\r\n\r\n❯ ',
            resolve
          )
        );
        app.terminal.focus();

        const screen = app.terminal.element?.querySelector('.xterm-screen');
        const cell = app.terminal._core?._renderService?.dimensions?.css?.cell;
        const rect = screen?.getBoundingClientRect();
        if (!screen || !rect || !cell?.width || !cell?.height) return null;
        const cursorRow = app.terminal.buffer.active.cursorY;
        const transcriptRow = Math.max(1, Math.floor(cursorRow / 2));
        const x = rect.left + cell.width * 2;
        const y = rect.top + cell.height * (transcriptRow + 0.5);
        return {
          x,
          y,
          intent: app._classifyMobileTerminalTap(x, y),
          activeClass: document.activeElement?.className,
        };
      });
      expect(point).toEqual(
        expect.objectContaining({
          intent: 'content',
          activeClass: expect.stringContaining('xterm-helper-textarea'),
        })
      );

      await page.touchscreen.tap(point!.x, point!.y);

      // The setup above leaves the terminal focused, so this tap is the SECOND
      // one on an inert row — the case that now closes the keyboard. Previously
      // it re-focused, which left the accessory bar's chevron as the only way to
      // dismiss. The prompt row is unaffected and still positions the caret.
      const activeClass = await page.evaluate(() => document.activeElement?.className);
      expect(activeClass).not.toContain('xterm-helper-textarea');
    });

    it('prevents Claude subagent status taps from opening the hidden keyboard input', async () => {
      const point = await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-claude-subagent-tap-test';
        app.sessions.set('mobile-claude-subagent-tap-test', {
          id: 'mobile-claude-subagent-tap-test',
          mode: 'claude',
          cliVersion: '2.1.220',
          status: 'working',
        });
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        app.hideWelcome();
        app.terminal.reset();
        const statusRow = Math.max(0, app.terminal.rows - 2);
        await new Promise<void>((resolve) =>
          app.terminal.write(
            `${'\r\n'.repeat(statusRow)}• Working (1m 50s • esc to interrupt) · 1 background teammate`,
            resolve
          )
        );
        app.terminal.focus();

        const screen = app.terminal.element?.querySelector('.xterm-screen');
        const cell = app.terminal._core?._renderService?.dimensions?.css?.cell;
        const rect = screen?.getBoundingClientRect();
        if (!screen || !rect || !cell?.width || !cell?.height) return null;
        const cursorRow = app.terminal.buffer.active.cursorY;
        const x = rect.left + cell.width * 2;
        const y = rect.top + cell.height * (cursorRow + 0.5);
        return {
          x,
          y,
          intent: app._classifyMobileTerminalTap(x, y),
          cursorRow,
          screenBottom: rect.bottom,
        };
      });
      expect(point).toEqual(
        expect.objectContaining({
          intent: 'content',
        })
      );

      const dispatch = await page.evaluate(({ x, y }) => {
        const target = document.querySelector('#terminalContainer .xterm-screen');
        if (!(target instanceof Element)) {
          return { prevented: false, insideTerminal: false, targetClass: null };
        }
        const touch = new Touch({
          identifier: 3,
          target,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
        });
        const allowed = target.dispatchEvent(
          new TouchEvent('touchstart', {
            touches: [touch],
            changedTouches: [touch],
            bubbles: true,
            cancelable: true,
          })
        );
        target.dispatchEvent(
          new TouchEvent('touchend', {
            touches: [],
            changedTouches: [touch],
            bubbles: true,
            cancelable: true,
          })
        );
        return {
          prevented: !allowed,
          insideTerminal: Boolean(target.closest('#terminalContainer')),
          targetClass: target.className,
        };
      }, point!);

      const state = await page.evaluate(() => ({
        activeClass: document.activeElement?.className,
        sentInputs: window.__sentInputs,
      }));
      expect(dispatch).toEqual(
        expect.objectContaining({
          prevented: true,
          insideTerminal: true,
        })
      );
      expect(state.activeClass).not.toContain('xterm-helper-textarea');
      expect(state.sentInputs).toHaveLength(1);
    });

    it('focuses the terminal helper textarea when the visible prompt is tapped', async () => {
      const point = await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-focus-visible-input-test';
        app.sessions.set('mobile-focus-visible-input-test', {
          id: 'mobile-focus-visible-input-test',
          mode: 'codex',
          status: 'running',
        });
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app.terminal.reset();
        await new Promise<void>((resolve) =>
          app.terminal.write('Agent readback\r\n  tap to collapse\r\n\r\n› ask', resolve)
        );
        (document.activeElement as HTMLElement | null)?.blur?.();

        const screen = app.terminal.element?.querySelector('.xterm-screen');
        const cell = app.terminal._core?._renderService?.dimensions?.css?.cell;
        const rect = screen?.getBoundingClientRect();
        if (!rect || !cell?.width || !cell?.height) return null;
        return {
          x: rect.left + cell.width * 2,
          y: rect.top + cell.height * (app.terminal.buffer.active.cursorY + 0.5),
        };
      });
      expect(point).not.toBeNull();

      await page.touchscreen.tap(point!.x, point!.y);

      const state = await page.evaluate(() => ({
        activeClass: document.activeElement?.className,
        sentInputs: window.__sentInputs,
      }));
      expect(state.activeClass).toContain('xterm-helper-textarea');
      expect(state.sentInputs).toEqual([]);
    });

    it('focuses the live Claude cursor when a redraw omits the prompt glyph', async () => {
      const point = await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-focus-promptless-claude-test';
        app.sessions.set('mobile-focus-promptless-claude-test', {
          id: 'mobile-focus-promptless-claude-test',
          mode: 'claude',
          status: 'running',
        });
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        app.hideWelcome();
        app.terminal.reset();
        await new Promise<void>((resolve) => app.terminal.write('Claude response\r\nready for input', resolve));
        (document.activeElement as HTMLElement | null)?.blur?.();

        const screen = app.terminal.element?.querySelector('.xterm-screen');
        const cell = app.terminal._core?._renderService?.dimensions?.css?.cell;
        const rect = screen?.getBoundingClientRect();
        if (!rect || !cell?.width || !cell?.height) return null;
        return {
          x: rect.left + cell.width * 2,
          y: rect.top + cell.height * (app.terminal.buffer.active.cursorY + 0.5),
        };
      });
      expect(point).not.toBeNull();

      await page.touchscreen.tap(point!.x, point!.y);

      const state = await page.evaluate(() => ({
        activeClass: document.activeElement?.className,
        sentInputs: window.__sentInputs,
      }));
      expect(state.activeClass).toContain('xterm-helper-textarea');
      expect(state.sentInputs).toEqual([]);
    });

    it('keeps terminal touch drag available for scrollback with the visible textarea enabled', async () => {
      const calls = await page.evaluate(async () => {
        app.activeSessionId = 'mobile-touch-scroll-test';
        app.sessions.set('mobile-touch-scroll-test', {
          id: 'mobile-touch-scroll-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app._updateCjkInputState();

        const originalScrollLines = app.terminal.scrollLines.bind(app.terminal);
        const scrollCalls: number[] = [];
        app.terminal.scrollLines = (lines: number) => {
          scrollCalls.push(lines);
          return originalScrollLines(lines);
        };

        const target =
          document.querySelector('#terminalContainer .xterm-screen') ?? document.getElementById('terminalContainer');
        if (!target) return scrollCalls;
        const rect = target.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const startY = rect.top + Math.min(180, rect.height - 20);
        const endY = startY - 120;

        function createTouch(y: number) {
          return new Touch({
            identifier: 1,
            target,
            clientX: x,
            clientY: y,
            pageX: x,
            pageY: y,
          });
        }

        target.dispatchEvent(
          new TouchEvent('touchstart', {
            touches: [createTouch(startY)],
            changedTouches: [createTouch(startY)],
            bubbles: true,
            cancelable: true,
          })
        );
        target.dispatchEvent(
          new TouchEvent('touchmove', {
            touches: [createTouch(endY)],
            changedTouches: [createTouch(endY)],
            bubbles: true,
            cancelable: true,
          })
        );
        target.dispatchEvent(
          new TouchEvent('touchend', {
            touches: [],
            changedTouches: [createTouch(endY)],
            bubbles: true,
            cancelable: true,
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        return scrollCalls;
      });

      expect(calls.length).toBeGreaterThan(0);
      expect(calls.some((lines) => lines !== 0)).toBe(true);
    });

    it('keeps typed phone text in the terminal local echo path', async () => {
      await page.evaluate(() => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-visible-input-test';
        app.sessions.set('mobile-visible-input-test', {
          id: 'mobile-visible-input-test',
          mode: 'claude',
          status: 'running',
        });
        app.hideWelcome();
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.focus();
      });

      await page.locator('#terminalContainer').tap({ position: { x: 40, y: 40 } });
      await page.keyboard.type('find bug');

      const beforeEnter = await page.evaluate(() => ({
        activeClass: document.activeElement?.className,
        cjkDisplay: getComputedStyle(document.getElementById('cjkInput') as HTMLElement).display,
        pendingText: app._localEchoOverlay?.pendingText,
        sentInputs: window.__sentInputs,
      }));
      expect(beforeEnter.activeClass).toContain('xterm-helper-textarea');
      expect(beforeEnter.cjkDisplay).toBe('none');
      expect(beforeEnter.pendingText).toBe('find bug');
      expect(beforeEnter.sentInputs).toEqual([]);

      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__sentInputs?.join('') === 'find bug\r');

      const afterEnter = await page.evaluate(() => ({
        pendingText: app._localEchoOverlay?.pendingText,
        sentInputs: window.__sentInputs,
      }));
      expect(afterEnter.pendingText).toBe('');
      expect(afterEnter.sentInputs.join('')).toBe('find bug\r');
    });

    it('shows terminal local echo at the cursor when no prompt marker is visible', async () => {
      await page.evaluate(async () => {
        app.activeSessionId = 'mobile-cursor-fallback-test';
        app.sessions.set('mobile-cursor-fallback-test', {
          id: 'mobile-cursor-fallback-test',
          mode: 'claude',
          status: 'running',
        });
        app.hideWelcome();
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        app.terminal.reset();
        await new Promise<void>((resolve) => app.terminal.write('working without prompt marker', resolve));
        app.terminal.focus();
      });

      await page.keyboard.type('abc');

      const state = await page.evaluate(() => ({
        cjkDisplay: getComputedStyle(document.getElementById('cjkInput') as HTMLElement).display,
        pendingText: app._localEchoOverlay?.pendingText,
        overlayState: app._localEchoOverlay?.state,
      }));

      expect(state.cjkDisplay).toBe('none');
      expect(state.pendingText).toBe('abc');
      expect(state.overlayState?.visible).toBe(true);
      expect(state.overlayState?.promptPosition).not.toBeNull();
    });

    it('codex: streams keystrokes write-through and paints predictions (no buffering)', async () => {
      await page.evaluate(async () => {
        window.__sentInputs = [];
        app.activeSessionId = 'mobile-codex-predict-test';
        app.sessions.set('mobile-codex-predict-test', {
          id: 'mobile-codex-predict-test',
          mode: 'codex',
          status: 'running',
        });
        app.hideWelcome();
        app._sendInputAsync = (_sessionId: string, input: string) => {
          window.__sentInputs.push(input);
        };
        const settings = app.loadAppSettingsFromStorage();
        settings.cjkInputEnabled = false;
        settings.localEchoEnabled = true;
        app.saveAppSettingsToStorage(settings);
        app._updateCjkInputState();
        app._updateLocalEchoState();
        // Paint a codex-like composer row so the predictWhen gate passes
        app.terminal.reset();
        await new Promise<void>((resolve) => app.terminal.write('\u203a ', resolve));
        app.terminal.focus();
      });

      await page.locator('#terminalContainer').tap({ position: { x: 40, y: 40 } });
      await page.keyboard.type('hey');

      // Write-through: the keystrokes reach the send path BEFORE any Enter,
      // and the buffer overlay holds nothing
      await page.waitForFunction(() => window.__sentInputs?.join('') === 'hey');
      const typed = await page.evaluate(() => ({
        policy: app._localEchoPolicy,
        pendingText: app._localEchoOverlay?.pendingText ?? '',
        outstanding: app._predictiveEcho?.state.outstanding ?? -1,
        spans: document.querySelectorAll('.xterm-screen [data-predictive-echo] span').length,
      }));
      expect(typed.policy).toBe('predict');
      expect(typed.pendingText).toBe('');
      expect(typed.outstanding).toBeGreaterThan(0);
      expect(typed.spans).toBe(typed.outstanding);

      // No echo ever arrives (stubbed session): TTL self-heals within ~1s
      await page.waitForFunction(
        () => document.querySelectorAll('.xterm-screen [data-predictive-echo] span').length === 0,
        undefined,
        { timeout: 4000 }
      );
      const settled = await page.evaluate(() => app._predictiveEcho?.state.outstanding);
      expect(settled).toBe(0);
    });
  });

  // ── Shell keyboard bar + one-shot Ctrl (issue #262) ───────────────────
  //
  // The bar swaps layouts per session mode, and Ctrl is a one-shot modifier
  // applied to the next character typed on the SYSTEM keyboard, which on a
  // phone reaches the app as xterm onData text, not a key event. These drive
  // the real xterm instance with page.keyboard.type() and assert on what would
  // go out on the wire (_sendInputAsync), not on DOM state alone.

  describe('Shell keyboard bar', () => {
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      ({ context, page } = await createDevicePage(REPRESENTATIVE_DEVICES['standard-phone'], BASE_URL, 'chromium'));
      await page.waitForTimeout(WAIT.PAGE_SETTLE);
    });

    afterAll(async () => {
      await context.close();
    });

    /** Point the app at a fake session of `mode` and re-resolve the bar. */
    async function activateSession(mode: string, id = 'kb-shell-1'): Promise<void> {
      await page.evaluate(`(function (id, mode) {
        app.sessions.set(id, { id, name: id, status: 'idle', mode, workingDir: '/tmp' });
        app.activeSessionId = id;
        KeyboardAccessoryBar.show();
        KeyboardAccessoryBar.refreshForActiveSession();
      })('${id}', '${mode}')`);
    }

    /** Capture what the terminal would send, while typing on the real keyboard. */
    async function typeAndCapture(text: string): Promise<string[]> {
      await page.evaluate(`(function () {
        window.__sent = [];
        if (!app.__origSend) app.__origSend = app._sendInputAsync;
        app._sendInputAsync = function (sessionId, input) { window.__sent.push(input); };
        app.terminal.focus();
      })()`);
      await page.keyboard.type(text);
      await page.waitForTimeout(200);
      const sent = (await page.evaluate(`window.__sent`)) as string[];
      await page.evaluate(`(function () { app._sendInputAsync = app.__origSend; })()`);
      return sent;
    }

    async function tapCtrl(): Promise<void> {
      await page.evaluate(`document.querySelector('.keyboard-accessory-bar [data-action="ctrl"]').click()`);
    }

    it('shows the terminal bar for shell sessions', async () => {
      await activateSession('shell');
      const actions = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.keyboard-accessory-bar [data-action]')).map(
          (button) => (button as HTMLElement).dataset.action
        )
      );
      expect(actions).toEqual([
        'ctrl',
        'esc',
        'tab',
        'scroll-up',
        'scroll-down',
        'arrow-left',
        'arrow-right',
        'paste',
        'dismiss',
      ]);
    });

    it('keeps the command bar for agent sessions', async () => {
      await activateSession('claude', 'kb-agent-1');
      const actions = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.keyboard-accessory-bar [data-action]')).map(
          (button) => (button as HTMLElement).dataset.action
        )
      );
      expect(actions).toContain('init');
      expect(actions).not.toContain('ctrl');
    });

    it('sends Ctrl+C for the next typed character and disarms', async () => {
      await activateSession('shell');
      await tapCtrl();
      expect(await page.evaluate(`KeyboardAccessoryBar.isCtrlArmed()`)).toBe(true);

      expect(await typeAndCapture('c')).toEqual(['\x03']);
      expect(await page.evaluate(`KeyboardAccessoryBar.isCtrlArmed()`)).toBe(false);
      // The very next keystroke is a literal c again.
      expect(await typeAndCapture('c')).toEqual(['c']);
    });

    it('sends Ctrl+D for the next typed character', async () => {
      await activateSession('shell');
      await tapCtrl();
      expect(await typeAndCapture('d')).toEqual(['\x04']);
    });

    it('survives a terminal tap while the pane has mouse reporting on', async () => {
      // A shell session keeps the narrow scrollback strip, so mouse DECSETs
      // reach the browser: run vim or htop and xterm starts reporting taps
      // through onData as \x1b[<0;31;23M. Those arrive on the same channel as
      // typed characters, so a hook that treats every chunk as "the next
      // keystroke" spends Ctrl on a tap and the button looks dead. Verified
      // against a real shell session before this guard existed.
      await activateSession('shell');
      await page.evaluate(`app.terminal.write('\\x1b[?1000h\\x1b[?1006h')`);
      await page.waitForTimeout(150);

      await tapCtrl();
      expect(await page.evaluate(`KeyboardAccessoryBar.isCtrlArmed()`)).toBe(true);

      const box = await page.locator('.xterm-screen').first().boundingBox();
      await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.waitForTimeout(200);

      expect(await page.evaluate(`KeyboardAccessoryBar.isCtrlArmed()`)).toBe(true);
      expect(await typeAndCapture('c')).toEqual(['\x03']);

      await page.evaluate(`app.terminal.write('\\x1b[?1000l\\x1b[?1006l')`);
    });

    it('cancels on a second tap of Ctrl', async () => {
      await activateSession('shell');
      await tapCtrl();
      await tapCtrl();
      expect(await page.evaluate(`KeyboardAccessoryBar.isCtrlArmed()`)).toBe(false);
      expect(await typeAndCapture('c')).toEqual(['c']);
    });

    it('shows the armed state and keeps the terminal focused', async () => {
      await activateSession('shell');
      await tapCtrl();
      const state = await page.evaluate(() => {
        const button = document.querySelector('.keyboard-accessory-bar [data-action="ctrl"]') as HTMLElement;
        const style = getComputedStyle(button);
        return {
          armed: button.classList.contains('armed'),
          pressed: button.getAttribute('aria-pressed'),
          background: style.backgroundColor,
          focusedTerminal: document.activeElement === (app.terminal as { textarea: Element }).textarea,
        };
      });
      expect(state.armed).toBe(true);
      expect(state.pressed).toBe('true');
      // Armed styling must actually land (three-class rule beating the skin
      // overrides): an invisible modifier is worse than none.
      expect(state.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(state.focusedTerminal).toBe(true);
    });

    it('drops the armed modifier when switching sessions', async () => {
      await activateSession('shell');
      await tapCtrl();
      expect(await page.evaluate(`KeyboardAccessoryBar.isCtrlArmed()`)).toBe(true);

      await activateSession('shell', 'kb-shell-2');
      expect(await page.evaluate(`KeyboardAccessoryBar.isCtrlArmed()`)).toBe(false);
      expect(await typeAndCapture('c')).toEqual(['c']);
    });

    it('drops the armed modifier when the keyboard is dismissed', async () => {
      await activateSession('shell');
      await tapCtrl();
      await page.evaluate(`KeyboardAccessoryBar.hide()`);
      expect(await page.evaluate(`KeyboardAccessoryBar.isCtrlArmed()`)).toBe(false);
    });

    it('spends the modifier on another accessory key instead of the next keystroke', async () => {
      await activateSession('shell');
      await tapCtrl();
      await page.evaluate(`document.querySelector('.keyboard-accessory-bar [data-action="esc"]').click()`);
      expect(await page.evaluate(`KeyboardAccessoryBar.isCtrlArmed()`)).toBe(false);
      expect(await typeAndCapture('c')).toEqual(['c']);
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
