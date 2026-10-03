/**
 * @fileoverview Real-Chromium coverage for editing the grouped vertical rail.
 *
 * What DOM emulation cannot answer: a pointer drag (hit testing, capture, the
 * click that ends a drag), whether the inline group editor actually paints
 * inside the rail's nowrap/ellipsis header, and whether Escape on an open group
 * menu reaches the menu first. The shipping app.js, tab-layout-browser.js,
 * tab-rail-resize.js, api-client.js, webview-tabs.js and styles.css are loaded
 * into a page; PUT /api/tab-layout is answered by a route that records bodies.
 *
 * Port: none (page.route on a fake origin, no server).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');

const LAYOUT = {
  version: 4,
  updatedAt: '2026-10-01T00:00:00.000Z',
  groups: [
    {
      id: 'gx',
      name: 'Core',
      refs: [
        { kind: 'session', id: 'two' },
        { kind: 'webview', id: 'web' },
      ],
    },
    { id: 'gy', name: 'Later', refs: [{ kind: 'session', id: 'three' }] },
  ],
  ungrouped: [{ kind: 'session', id: 'one' }],
};

describe('grouped rail editing in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let puts: any[] = [];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.route('http://codeman.test/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' })
    );
    await page.route('http://codeman.test/api/tab-layout', async (route) => {
      const request = route.request();
      if (request.method() !== 'PUT') return route.fulfill({ status: 404, body: '' });
      const body = JSON.parse(request.postData() || '{}');
      puts.push(body);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { layout: { ...body.layout, version: body.baseVersion + 1 } } }),
      });
    });
    await page.goto('http://codeman.test/');
    await page.setContent(`<!doctype html>
      <html data-tab-orientation="vertical" data-tab-rail-sort="manual">
        <head><style>${read('styles.css')}</style></head>
        <body>
          <main class="main" style="width:100%;height:760px">
            <aside class="tab-rail" id="tabRail" aria-label="Session navigation" style="width:280px"></aside>
            <button id="elsewhere">elsewhere</button>
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
    await page.addScriptTag({ content: read('tab-rail-resize.js') });
    await page.addScriptTag({ content: read('api-client.js') });
    await page.addScriptTag({ content: read('webview-tabs.js') });
    await page.evaluate(() => {
      const w = window as any;
      const app = Object.create(w.CodemanApp.prototype);
      app.$ = (id: string) => document.getElementById(id);
      app.sessions = new Map([
        ['one', { id: 'one', name: 'One', status: 'idle' }],
        ['two', { id: 'two', name: 'Two', status: 'idle' }],
        ['three', { id: 'three', name: 'Three', status: 'idle' }],
      ]);
      app.sessionOrder = ['one', 'two', 'three'];
      app.webviews = new Map([['web', { id: 'web', name: 'Web', url: 'https://example.test', icon: 'W' }]]);
      app.webviewOrder = ['web'];
      app.collapsedTabGroupIds = new Set();
      app._hiddenTabGroupByRef = new Map();
      app._inlineRenameActive = false;
      app.tabAlerts = new Map();
      app.terminalLoadStates = new Map();
      app.minimizedSubagents = new Map();
      app.hasTabDetachOverride = () => false;
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
      app.loadAppSettingsFromStorage = () => ({});
      app.showToast = () => undefined;
      app.closeAllPanels = () => {
        w.__panelsClosed = true;
      };
      app.selectSession = (id: string) => {
        w.__activation = `session:${id}`;
      };
      app.openWebview = (id: string) => {
        w.__activation = `webview:${id}`;
      };
      w.__setApp(app);
      w.__app = app;
    });
  });

  afterAll(async () => browser.close());

  beforeEach(async () => {
    puts = [];
    await page.evaluate((layout) => {
      const w = window as any;
      document.getElementById('sessionTabs')?.remove();
      document
        .getElementById('tabRail')!
        .insertAdjacentHTML(
          'afterbegin',
          '<div class="session-tabs" id="sessionTabs" role="tablist" aria-label="Session tabs"></div>'
        );
      w.__app._tabKeydownHandler = null;
      w.__app._tabLayoutEditor?.dispose();
      w.__app._tabLayoutEditor = null;
      w.__app.tabLayout = null;
      w.__app.activeSessionId = 'one';
      w.__app.activeWebviewId = null;
      w.__app._applyTabLayout(layout);
      w.__activation = null;
      w.__panelsClosed = false;
    }, LAYOUT);
    await page.mouse.move(1, 1);
  });

  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
  async function drag(from: string, to: string, yFraction = 0.5) {
    const a = await box(from);
    const b = await box(to);
    await page.mouse.move(a.x + 20, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 24, a.y + a.height / 2 + 8, { steps: 3 });
    await page.mouse.move(b.x + 30, b.y + b.height * yFraction, { steps: 6 });
    await page.mouse.up();
  }
  const settled = async () => {
    await page.waitForTimeout(80);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 20)));
  };

  it('drags a row from Ungrouped onto a group header: one PUT appending it there', async () => {
    await drag('.session-tab[data-id="one"]', '[data-tab-group-header="gy"]');
    await settled();
    expect(puts).toHaveLength(1);
    expect(puts[0].baseVersion).toBe(4);
    expect(puts[0].layout.groups[1].refs).toEqual([
      { kind: 'session', id: 'three' },
      { kind: 'session', id: 'one' },
    ]);
    expect(puts[0].layout.ungrouped).toEqual([]);
    // The click that ends a drag neither selected the row nor toggled the header.
    expect(await page.evaluate(() => (window as any).__activation)).toBeNull();
    expect(await page.evaluate(() => (window as any).__app.collapsedTabGroupIds.size)).toBe(0);
    expect(await page.locator('.tab-layout-dragging, .tab-layout-drop-into').count()).toBe(0);
  });

  it('drags a row between two rows of another group (upper half = before)', async () => {
    await drag('.session-tab[data-id="three"]', '.session-tab[data-webview-id="web"]', 0.25);
    await settled();
    expect(puts).toHaveLength(1);
    expect(puts[0].layout.groups[0].refs.map((r: any) => r.id)).toEqual(['two', 'three', 'web']);
    expect(puts[0].layout.groups[1].refs).toEqual([]);
  });

  it('drags a group header above another group: a reorder', async () => {
    await drag('[data-tab-group-header="gy"]', '[data-tab-group-header="gx"]');
    await settled();
    expect(puts).toHaveLength(1);
    expect(puts[0].layout.groups.map((g: any) => g.id)).toEqual(['gy', 'gx']);
    expect(await page.locator('.tab-layout-group').first().getAttribute('data-tab-group-id')).toBe('gy');
  });

  it('Escape mid-drag cancels it without a write; a plain click still selects', async () => {
    const a = await box('.session-tab[data-id="one"]');
    const b = await box('[data-tab-group-header="gy"]');
    await page.mouse.move(a.x + 20, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 6 });
    expect(await page.locator('.tab-layout-drop-into').count()).toBe(1);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await settled();
    expect(puts).toHaveLength(0);

    await page.locator('.session-tab[data-id="two"] .tab-name').click();
    expect(await page.evaluate(() => (window as any).__activation)).toBe('session:two');
  });

  it('paints the inline group editor as you type, then saves the trimmed name', async () => {
    await page.evaluate(() => (window as any).__app.startTabGroupRename('gx'));
    const input = page.locator('.tab-layout-group-rename-input');
    await expect.poll(() => input.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Front end');
    const paint = await input.evaluate((el: HTMLInputElement) => ({
      value: el.value,
      width: el.getBoundingClientRect().width,
      label: getComputedStyle(el.parentElement!).display,
      scrollWidth: el.scrollWidth,
    }));
    expect(paint.value).toBe('Front end');
    // The editor gets the header's free width, not a collapsed ellipsis slot.
    expect(paint.width).toBeGreaterThan(120);
    expect(paint.label).toBe('flex');
    await page.keyboard.press('Enter');
    await settled();
    expect(puts.at(-1).layout.groups[0].name).toBe('Front end');
    expect(await page.locator('[data-tab-group-header="gx"] .tab-layout-group-name').textContent()).toBe('Front end');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset?.tabGroupHeader)).toBe('gx');
  });

  it('opens the group menu from the header glyph and Escape closes only it', async () => {
    await page.locator('[data-tab-group-header="gy"]').hover();
    await page.locator('[data-tab-group-header="gy"] .tab-layout-group-menu').click();
    expect(await page.locator('.tab-layout-group-action-menu').count()).toBe(1);
    // The glyph opened the menu without toggling the group.
    expect(await page.evaluate(() => (window as any).__app.collapsedTabGroupIds.size)).toBe(0);
    await page.keyboard.press('Escape');
    expect(await page.locator('.tab-layout-group-action-menu').count()).toBe(0);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset?.tabGroupHeader)).toBe('gy');

    await page.locator('[data-tab-group-header="gy"]').click({ button: 'right' });
    expect(await page.locator('.tab-layout-group-action-menu').count()).toBe(1);
    await page.locator('#elsewhere').click();
    expect(await page.locator('.tab-layout-group-action-menu').count()).toBe(0);
  });
});
