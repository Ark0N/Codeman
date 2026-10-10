/**
 * @fileoverview Real-Chromium coverage for the Focus section of the vertical rail.
 *
 * What DOM emulation cannot answer: a real right-click reaching the inline
 * handlers, the section actually painting above the list (layout, not just DOM
 * order), the browser's own Tab order across the Focus toggle, the Focus list
 * and the grouped tree (one stop each), and a pointer drag on a shortcut doing
 * nothing. The shipping app.js, tab-layout-browser.js, tab-rail-resize.js,
 * api-client.js, webview-tabs.js and styles.css are loaded into a page;
 * PUT /api/tab-layout is answered by a route that records bodies.
 *
 * Port: none (page.route on a fake origin, no server).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');

const GROUPED = {
  version: 4,
  updatedAt: '2026-10-09T00:00:00.000Z',
  groups: [
    {
      id: 'gx',
      name: 'Core',
      refs: [
        { kind: 'session', id: 'two', focus: true },
        { kind: 'webview', id: 'web' },
      ],
    },
    { id: 'gy', name: 'Later', refs: [{ kind: 'session', id: 'three' }] },
  ],
  ungrouped: [{ kind: 'session', id: 'one' }],
};
const FLAT = {
  version: 4,
  updatedAt: '2026-10-09T00:00:00.000Z',
  groups: [],
  ungrouped: [
    { kind: 'session', id: 'one' },
    { kind: 'session', id: 'two', focus: true },
    { kind: 'session', id: 'three' },
    { kind: 'webview', id: 'web' },
  ],
};

const focusedIn = (layout: any): string[] =>
  [...layout.groups.flatMap((g: any) => g.refs), ...layout.ungrouped]
    .filter((ref: any) => ref.focus === true)
    .map((ref: any) => `${ref.kind}:${ref.id}`);

describe('Focus section in Chromium', () => {
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
          <button id="before">before</button>
          <main class="main" style="width:100%;height:760px">
            <aside class="tab-rail" id="tabRail" aria-label="Session navigation" style="width:280px"></aside>
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
        ['two', { id: 'two', name: 'Two', status: 'busy' }],
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
      app.showWebviewModal = () => undefined;
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

  async function load(layout: unknown) {
    puts = [];
    await page.evaluate((next) => {
      const w = window as any;
      localStorage.clear();
      document.querySelectorAll('.tab-rail-action-menu').forEach((menu) => menu.remove());
      document.getElementById('sessionTabs')?.remove();
      document.getElementById('tabFocus')?.remove();
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
      w.__app._tabFocusCollapsed = undefined;
      w.__app._lastTabFocusHtml = '';
      w.__app._tabFocusStopKey = undefined;
      w.__app.activeSessionId = 'one';
      w.__app.activeWebviewId = null;
      w.__app._lastTabGroupStructureKey = null;
      w.__app._fullRenderSessionTabs();
      w.__app._applyTabLayout(next);
      w.__activation = null;
    }, layout);
    await page.mouse.move(1, 1);
  }
  const settled = async () => {
    await page.waitForTimeout(80);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 20)));
  };
  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;

  beforeEach(async () => load(GROUPED));

  it('paints the section above the list, and a click on a shortcut selects its tab', async () => {
    const section = await box('#tabFocus');
    const list = await box('#sessionTabs');
    expect(section.height).toBeGreaterThan(20);
    expect(section.y + section.height).toBeLessThanOrEqual(list.y + 1);
    expect(await page.locator('#tabFocus .tab-focus-name').allTextContents()).toEqual(['Two']);
    // The real row is still in its group.
    expect(await page.locator('[data-tab-group-id="gx"] .session-tab[data-id="two"]').count()).toBe(1);
    await page.click('#tabFocus .tab-focus-item');
    expect(await page.evaluate(() => (window as any).__activation)).toBe('session:two');
  });

  it('a real right-click on a web tab in the FLAT rail pins it, and its shortcut opens it', async () => {
    await load(FLAT);
    expect(await page.locator('#sessionTabs').getAttribute('role')).toBe('tablist');
    await page.click('#sessionTabs .session-tab[data-webview-id="web"]', { button: 'right' });
    const labels = await page.locator('.tab-rail-action-menu button').allTextContents();
    expect(labels).toEqual(['Web tab settings', 'Add to Focus', 'Move to new group']);
    await page.click('.tab-rail-action-menu button:text-is("Add to Focus")');
    await settled();
    expect(puts).toHaveLength(1);
    expect(focusedIn(puts[0].layout)).toEqual(['session:two', 'webview:web']);
    expect(await page.locator('#tabFocus .tab-focus-name').allTextContents()).toEqual(['Two', 'Web']);
    await page.click('#tabFocus .tab-focus-item[data-focus-key="webview:web"]');
    expect(await page.evaluate(() => (window as any).__activation)).toBe('webview:web');
  });

  it('a real right-click on a shortcut removes it; the row stays', async () => {
    await page.click('#tabFocus .tab-focus-item', { button: 'right' });
    expect(await page.locator('.tab-rail-action-menu button').allTextContents()).toEqual(['Remove from Focus']);
    await page.click('.tab-rail-action-menu button:text-is("Remove from Focus")');
    await settled();
    expect(focusedIn(puts[0].layout)).toEqual([]);
    expect(await page.locator('#tabFocus').isHidden()).toBe(true);
    expect(await page.locator('[data-tab-group-id="gx"] .session-tab[data-id="two"]').count()).toBe(1);
  });

  it('Tab walks: Focus toggle, ONE Focus list stop, then ONE tree stop', async () => {
    await page.evaluate(() => {
      const w = window as any;
      w.__app._applyTabLayout({
        ...w.__app.tabLayout,
        version: 5,
        ungrouped: [{ kind: 'session', id: 'one', focus: true }],
      });
    });
    expect(await page.locator('#tabFocus .tab-focus-item').count()).toBe(2);
    await page.focus('#before');
    const stops: string[] = [];
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab');
      stops.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          return el.id || el.dataset.focusKey || el.dataset.tabGroupHeader || el.dataset.id || el.tagName;
        })
      );
    }
    // 'one' is the active session: its shortcut holds the list stop, its row the tree stop.
    expect(stops).toEqual(['tabFocusToggle', 'session:one', 'one']);
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.focusKey)).toBe('session:two');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => (window as any).__activation)).toBe('session:two');
  });

  it('the toggle collapses per device, and a drag from a shortcut moves nothing', async () => {
    await page.click('#tabFocusToggle');
    expect(await page.locator('#tabFocusList').isHidden()).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('codeman:tab-focus-collapsed'))).toBe('true');
    await page.click('#tabFocusToggle');
    const a = await box('#tabFocus .tab-focus-item');
    const b = await box('[data-tab-group-header="gy"]');
    await page.mouse.move(a.x + 20, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
    await settled();
    expect(puts).toHaveLength(0);
    expect(await page.locator('.tab-layout-dragging, .tab-layout-drop-into').count()).toBe(0);
  });
});
