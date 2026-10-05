/**
 * @fileoverview Real-Chromium coverage for tab-row activation and the grouped rail tree.
 *
 * A tab row is one activation target: its status dot, mode chip, name and unused
 * padding all select it, while its own controls (gear, detach, close, the rail's
 * overflow button, a web tab's gear and close) run only their own action. The
 * controls must also keep a stable hit target: revealing one on hover may not
 * slide its neighbours out from under a pointer already aiming at them.
 *
 * DOM emulation cannot answer either question (hit testing, hover reveal and
 * layout are Chromium's), which is why this runs in a real browser. The shipping
 * app.js, webview-tabs.js, terminal-ui.js (for the touch keyboard dismissal) and
 * styles.css are loaded into a page; the CodemanApp instance gets stub actions
 * that only record what ran.
 *
 * Port: none (page.setContent, no server).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');

describe('tab row activation in Chromium', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    // A real origin, so localStorage (per-device collapse) works as it does in the app.
    await page.route('http://codeman.test/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' })
    );
    await page.goto('http://codeman.test/');
    await page.setContent(`<!doctype html>
      <html data-tab-orientation="horizontal" data-tab-rail-sort="manual">
        <head><style>${read('styles.css')}</style></head>
        <body>
          <header class="header"><div id="sessionTabsHost"></div></header>
          <main class="main" style="width:100%;height:700px">
            <aside class="tab-rail" id="tabRail" aria-label="Session navigation"></aside>
          </main>
        </body>
      </html>`);
    await page.addScriptTag({
      content:
        'var MobileDetection = { isTouchDevice: () => false, getDeviceType: () => "desktop" }, KeyboardHandler = {}, ' +
        'SwipeHandler = {}, VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
        read('constants.js') +
        '\n' +
        read('tab-layout-browser.js') +
        '\n' +
        read('app.js') +
        '\nwindow.CodemanApp = CodemanApp; window.__setApp = (value) => { app = value; };',
    });
    await page.addScriptTag({ content: read('webview-tabs.js') });
    await page.addScriptTag({ content: read('terminal-ui.js') });
    await page.evaluate(() => {
      const w = window as any;
      const app = Object.create(w.CodemanApp.prototype);
      app.$ = (id: string) => document.getElementById(id);
      app.sessions = new Map([
        ['one', { id: 'one', name: 'One', status: 'idle', mode: 'shell' }],
        ['two', { id: 'two', name: 'Two', status: 'idle' }],
      ]);
      app.sessionOrder = ['one', 'two'];
      app.webviews = new Map([['web', { id: 'web', name: 'Web', url: 'https://example.test', icon: 'W' }]]);
      app.webviewOrder = ['web'];
      app.activeSessionId = 'one';
      app.activeWebviewId = null;
      app.tabLayout = null;
      app.collapsedTabGroupIds = new Set();
      app._hiddenTabGroupByRef = new Map();
      app._lastTabGroupStructureKey = null;
      app._inlineRenameActive = false;
      app.tabAlerts = new Map();
      app.terminalLoadStates = new Map();
      app.minimizedSubagents = new Map();
      app.hasTabDetachOverride = () => true;
      app.renderSubagentTabBadge = () => '';
      app.cancelHideSubagentDropdown = () => undefined;
      app.updateTabOverflowMode = () => undefined;
      app.updateConnectionLines = () => undefined;
      app._applyTabEntrances = () => undefined;
      app._scrollActiveTabIntoView = () => undefined;
      app.applySidebarFilter = () => undefined;
      app.isSessionSidebarActive = () => false;
      app._startSidebarRichClock = () => undefined;
      app._stopSidebarRichClock = () => undefined;
      const record = (key: string, value: string) => () => {
        w[key] = value;
      };
      app.selectSession = (id: string) => {
        w.__activation = `session:${id}`;
      };
      app.openWebview = (id: string) => {
        w.__activation = `webview:${id}`;
      };
      app.openSessionOptions = record('__action', 'settings');
      app.detachSession = record('__action', 'detach');
      app.requestCloseSession = record('__action', 'close');
      app.openTabRailActionMenu = record('__action', 'overflow');
      app.showWebviewModal = record('__action', 'web-settings');
      app.closeWebviewTab = record('__action', 'web-close');
      w.__setApp(app);
      w.__app = app;
    });
  });

  afterAll(async () => browser.close());

  /** Render the strip/rail in a given shape, from scratch. */
  async function render(orientation: 'horizontal' | 'vertical', grouped = false) {
    await page.evaluate(
      ({ orientation, grouped }) => {
        const w = window as any;
        document.documentElement.setAttribute('data-tab-orientation', orientation);
        const host =
          orientation === 'vertical'
            ? document.getElementById('tabRail')!
            : document.getElementById('sessionTabsHost')!;
        document.getElementById('sessionTabs')?.remove();
        host.insertAdjacentHTML(
          'afterbegin',
          '<div class="session-tabs" id="sessionTabs" role="tablist" aria-label="Session tabs"></div>'
        );
        w.__app._tabKeydownHandler = null;
        w.__app.activeSessionId = 'one';
        w.__app.activeWebviewId = null;
        w.__app.tabLayout = grouped
          ? {
              version: 1,
              groups: [
                {
                  id: 'g',
                  name: 'Group',
                  refs: [
                    { kind: 'session', id: 'one' },
                    { kind: 'webview', id: 'web' },
                  ],
                },
              ],
              ungrouped: [{ kind: 'session', id: 'two' }],
            }
          : null;
        w.__app._fullRenderSessionTabs();
        w.__activation = null;
        w.__action = null;
      },
      { orientation, grouped }
    );
    await page.mouse.move(1, 1);
  }

  const result = () =>
    page.evaluate(() => ({ activation: (window as any).__activation, action: (window as any).__action }));
  const reset = () => page.evaluate(() => ((window as any).__activation = (window as any).__action = null));

  for (const [label, orientation, grouped] of [
    ['horizontal strip', 'horizontal', false],
    ['flat vertical rail', 'vertical', false],
    ['grouped vertical rail', 'vertical', true],
  ] as const) {
    it(`activates a row from its status, mode, name and padding (${label})`, async () => {
      await render(orientation, grouped);
      for (const [selector, expected] of [
        ['[data-id="two"] .tab-status', 'session:two'],
        ['[data-id="two"] .tab-name', 'session:two'],
        ['[data-id="one"] .tab-mode', 'session:one'],
        ['[data-webview-id="web"] .tab-name', 'webview:web'],
      ] as const) {
        await reset();
        await page.locator(selector).click();
        expect((await result()).activation, selector).toBe(expected);
      }
      for (const [selector, expected] of [
        ['[data-id="two"]', 'session:two'],
        ['[data-webview-id="web"]', 'webview:web'],
      ] as const) {
        await reset();
        const box = (await page.locator(selector).boundingBox())!;
        await page.mouse.click(box.x + 2, box.y + box.height / 2);
        expect((await result()).activation, `${selector} leading padding`).toBe(expected);
        // The cursor advertises the whole row: a pointer, or the grab hand where
        // the row is also a drag-reorder handle (the flat lists).
        const { cursor, draggable } = await page
          .locator(selector)
          .evaluate((el) => ({ cursor: getComputedStyle(el).cursor, draggable: el.getAttribute('draggable') }));
        expect(cursor, selector).toBe(draggable === 'true' ? 'grab' : 'pointer');
      }
    });

    it(`runs a control's own action without selecting the row (${label})`, async () => {
      await render(orientation, grouped);
      for (const [selector, expected] of [
        ['[data-id="one"] .tab-gear', 'settings'],
        ['[data-id="one"] .tab-detach', 'detach'],
        ['[data-id="one"] .tab-close', 'close'],
      ] as const) {
        await reset();
        const control = page.locator(selector);
        expect(await control.isVisible(), selector).toBe(true);
        expect(await control.evaluate((el) => getComputedStyle(el).cursor), selector).toBe('pointer');
        await control.click();
        expect(await result(), selector).toEqual({ activation: null, action: expected });
      }
      if (orientation === 'vertical') {
        await reset();
        await page.locator('[data-id="one"] .tab-more').click();
        expect(await result()).toEqual({ activation: null, action: 'overflow' });
      }
      await page.evaluate(() => {
        (window as any).__app.activeWebviewId = 'web';
        (window as any).__app._fullRenderSessionTabs();
      });
      for (const [selector, expected] of [
        ['[data-webview-id="web"] .tab-gear', 'web-settings'],
        ['[data-webview-id="web"] .tab-close', 'web-close'],
      ] as const) {
        await reset();
        await page.locator(selector).click();
        expect(await result(), selector).toEqual({ activation: null, action: expected });
      }
    });

    it(`keeps action controls anchored under the pointer when a row is hovered (${label})`, async () => {
      // Revealing a control on hover must not reflow its row: a button that
      // toggled `display` on hover once slid the gear 28px left, so the click
      // aimed at the gear landed on the close button instead. Assert the
      // geometry, not a CSS property, so any reflow-on-hover rewrite fails here.
      await render(orientation, grouped);
      for (const selector of ['[data-id="one"] .tab-gear', '[data-id="one"] .tab-close']) {
        await page.mouse.move(1, 1);
        const control = page.locator(selector);
        const before = (await control.boundingBox())!;
        const aim = { x: Math.round(before.x + before.width / 2), y: Math.round(before.y + before.height / 2) };
        await page.mouse.move(aim.x, aim.y);
        await page.waitForTimeout(250);
        const after = (await control.boundingBox())!;
        expect(Math.abs(after.x - before.x), selector).toBeLessThanOrEqual(4);
        const stillOnTarget = await page.evaluate(
          ({ point, selector }) => !!document.elementFromPoint(point.x, point.y)?.closest(selector),
          { point: aim, selector }
        );
        expect(stillOnTarget, selector).toBe(true);
      }
    });
  }

  it('toggles a group from its header without selecting anything', async () => {
    await render('vertical', true);
    const header = page.locator('[data-tab-group-header="g"]');
    await header.click();
    expect(await result()).toEqual({ activation: null, action: null });
    expect(await header.getAttribute('aria-expanded')).toBe('false');
    await page.locator('[data-tab-group-header="g"]').click();
    expect(await page.locator('[data-tab-group-header="g"]').getAttribute('aria-expanded')).toBe('true');
  });

  it('walks the grouped rail tree from the keyboard with one tab stop', async () => {
    await render('vertical', true);
    const tree = page.locator('#sessionTabs[role="tree"]');
    expect(await tree.count()).toBe(1);
    expect(await page.locator('#sessionTabs [tabindex="0"]').count()).toBe(1);
    // The roving tab stop starts on the selected row.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-id'))).toBe('one');

    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-tab-group-header'))).toBe('g');
    await page.keyboard.press('ArrowLeft');
    expect(await page.locator('[data-tab-group-header="g"]').getAttribute('aria-expanded')).toBe('false');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-tab-group-header'))).toBe('g');
    await page.keyboard.press('ArrowRight');
    expect(await page.locator('[data-tab-group-header="g"]').getAttribute('aria-expanded')).toBe('true');
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-id'))).toBe('one');
    await page.keyboard.press('End');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-id'))).toBe('two');
    await page.keyboard.press('Home');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-tab-group-header'))).toBe('g');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-webview-id'))).toBe('web');
    await reset();
    await page.keyboard.press('Enter');
    expect((await result()).activation).toBe('webview:web');
    expect(await page.locator('#sessionTabs [tabindex="0"]').count()).toBe(1);
  });

  it('leaves Enter on a focused in-row control to that control in the tree', async () => {
    await render('vertical', true);
    // A click focuses the overflow button (the action menu hands focus back the
    // same way on Escape). Enter there must run the button, not re-select the row.
    await page.locator('[data-id="one"] .tab-more').click();
    expect(await page.evaluate(() => document.activeElement?.classList.contains('tab-more'))).toBe(true);
    await reset();
    await page.keyboard.press('Enter');
    expect(await result()).toEqual({ activation: null, action: 'overflow' });
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('tab-more'))).toBe(true);
  });

  it('keeps the touch keyboard up when a tree header or unselected row is tapped', async () => {
    await render('vertical', true);
    const state = await page.evaluate(() => {
      const w = window as any;
      const app = w.__app;
      const input = document.createElement('textarea');
      input.className = 'xterm-helper-textarea';
      document.body.appendChild(input);
      app._installMobileKeyboardDismiss();
      // A finger that lifts where it landed (no travel): the handler reads only
      // `touches`, so a plain Event carrying them stands in for a TouchEvent.
      const tap = (target: Element) => {
        const at = (type: string, touches: Array<{ clientX: number; clientY: number }>) => {
          const ev = new Event(type, { bubbles: true });
          Object.defineProperty(ev, 'touches', { value: touches });
          target.dispatchEvent(ev);
        };
        at('touchstart', [{ clientX: 10, clientY: 10 }]);
        at('touchend', []);
      };
      const keptAfterTap = (selector: string) => {
        input.focus();
        tap(document.querySelector(selector)!);
        return document.activeElement === input;
      };
      const out = {
        header: keptAfterTap('[data-tab-group-header="g"] .tab-layout-group-name'),
        unselectedRow: keptAfterTap('[data-webview-id="web"] .tab-name'),
        inertChrome: false,
      };
      // Inert chrome still dismisses, so the handler is live.
      out.inertChrome = !keptAfterTap('.tab-layout-ungrouped-header');
      document.removeEventListener('touchstart', app._mobileKeyboardDismissStart);
      document.removeEventListener('touchmove', app._mobileKeyboardDismissMove);
      document.removeEventListener('touchend', app._mobileKeyboardDismissHandler);
      app._mobileKeyboardDismissHandler = null;
      input.remove();
      return out;
    });
    expect(state).toEqual({ header: true, unselectedRow: true, inertChrome: true });
  });

  it('rings a collapsed header in the tab alert colour of the row it hides', async () => {
    await render('vertical', true);
    const ring = await page.evaluate(() => {
      const app = (window as any).__app;
      // "two" is the selection, so collapsing the group hides "one".
      app.activeSessionId = 'two';
      app.tabAlerts.set('one', 'action');
      app.toggleTabGroupCollapsed('g', true);
      const header = document.querySelector('[data-tab-group-header="g"]')!;
      const before = getComputedStyle(header, '::before');
      const out = {
        hidden: !document.querySelector('[data-id="one"]'),
        className: header.classList.contains('tab-alert-action'),
        content: before.content,
        borderColor: before.borderTopColor,
      };
      app.tabAlerts.clear();
      app.toggleTabGroupCollapsed('g', false);
      return out;
    });
    expect(ring.hidden).toBe(true);
    expect(ring.className).toBe(true);
    expect(ring.content).not.toBe('none');
    // --red, whatever the skin resolves it to: a real colour, not transparent.
    expect(ring.borderColor).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  it('keeps tab semantics and no tree roles without groups', async () => {
    await render('vertical', false);
    expect(await page.locator('#sessionTabs').getAttribute('role')).toBe('tablist');
    expect(
      await page
        .locator('#sessionTabs [role="tree"], #sessionTabs [role="treeitem"], #sessionTabs [role="group"]')
        .count()
    ).toBe(0);
    expect(await page.locator('#sessionTabs .session-tab[role="tab"]').count()).toBe(3);
  });
});
