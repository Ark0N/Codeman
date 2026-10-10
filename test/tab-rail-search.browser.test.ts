/**
 * @fileoverview Real-Chromium coverage for the vertical rail's session search.
 *
 * What DOM emulation cannot answer: that the shipped CSS actually hides a
 * filtered row and an emptied group, that the box shows only on the vertical
 * rail, that the inline oninput/onkeydown/onclick handlers in index.html reach
 * the app, and that a match inside a collapsed group can be clicked. The real
 * #tabRail markup is lifted from index.html, and the shipping constants.js,
 * tab-layout-browser.js, app.js, webview-tabs.js and styles.css are loaded
 * into a page.
 *
 * Port: none (page.route on a fake origin, no server).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');

/** The shipped rail markup, so the inline handlers under test are the real ones. */
const RAIL_HTML = (() => {
  const dom = new JSDOM(read('index.html'));
  const html = dom.window.document.getElementById('tabRail')!.outerHTML;
  dom.window.close();
  return html;
})();

const LAYOUT = {
  version: 1,
  updatedAt: '2026-10-01T00:00:00.000Z',
  groups: [
    { id: 'eng', name: 'Engineering', refs: [{ kind: 'session', id: 'alpha' }] },
    {
      id: 'plan',
      name: 'Planning',
      refs: [
        { kind: 'session', id: 'roadmap' },
        { kind: 'session', id: 'review' },
      ],
    },
  ],
  ungrouped: [
    { kind: 'webview', id: 'web' },
    { kind: 'session', id: 'notes' },
  ],
};

describe('vertical rail session search in Chromium', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.route('http://codeman.test/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' })
    );
    await page.goto('http://codeman.test/');
    await page.setContent(`<!doctype html>
      <html data-tab-orientation="vertical" data-tab-rail-sort="manual">
        <head><style>${read('styles.css')}</style></head>
        <body>
          <main class="main" style="width:100%;height:760px">${RAIL_HTML}</main>
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
    await page.evaluate(() => {
      const w = window as any;
      const app = Object.create(w.CodemanApp.prototype);
      app.$ = (id: string) => document.getElementById(id);
      app.sessions = new Map([
        ['alpha', { id: 'alpha', name: 'Alpha API', status: 'idle' }],
        ['roadmap', { id: 'roadmap', name: 'Roadmap', status: 'idle' }],
        ['review', { id: 'review', name: 'API Review', status: 'idle' }],
        ['notes', { id: 'notes', name: 'Notes', status: 'idle' }],
      ]);
      app.sessionOrder = ['alpha', 'roadmap', 'review', 'notes'];
      app.webviews = new Map([['web', { id: 'web', name: 'Dashboard', url: 'https://example.test', icon: 'D' }]]);
      app.webviewOrder = ['web'];
      app._hiddenTabGroupByRef = new Map();
      app._inlineRenameActive = false;
      app._sidebarFilter = '';
      app._tabRailSearch = '';
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
      app.isSessionSidebarActive = () => false;
      app._startSidebarRichClock = () => undefined;
      app._stopSidebarRichClock = () => undefined;
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
    await page.evaluate((layout) => {
      const w = window as any;
      const app = w.__app;
      document.getElementById('sessionTabs')?.remove();
      document
        .getElementById('tabRail')!
        .insertAdjacentHTML(
          'beforeend',
          '<div class="session-tabs" id="sessionTabs" role="tablist" aria-label="Session tabs"></div>'
        );
      localStorage.setItem('codeman:tab-groups-collapsed', '["plan"]');
      app._tabKeydownHandler = null;
      app._tabTreeFocusinHandler = null;
      app.tabLayout = layout;
      app.collapsedTabGroupIds = new Set(['plan']);
      app.activeSessionId = 'alpha';
      app.activeWebviewId = null;
      app._lastTabGroupStructureKey = null;
      app._resetTabRailSearch();
      app._fullRenderSessionTabs();
      w.__activation = null;
    }, LAYOUT);
  });

  /** Rows actually painted (display != none), in DOM order. */
  const paintedRows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#sessionTabs .session-tab')]
        .filter((tab) => tab.getClientRects().length > 0)
        .map((tab) => tab.dataset.webviewId || tab.dataset.id)
    );
  const paintedGroups = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#sessionTabs .tab-layout-group')]
        .filter((section) => section.getClientRects().length > 0)
        .map((section) => section.dataset.tabGroupId)
    );

  it('reveals a collapsed match, selects it, and restores the collapse when cleared', async () => {
    const search = page.getByRole('searchbox', { name: 'Search sessions' });
    expect(await search.isVisible()).toBe(true);
    expect(await paintedRows()).toEqual(['alpha', 'web', 'notes']);
    expect(await page.locator('[data-tab-group-header="plan"]').getAttribute('aria-expanded')).toBe('false');

    await search.fill('aPi');

    expect(await paintedRows()).toEqual(['alpha', 'review']);
    expect(await paintedGroups()).toEqual(['eng', 'plan']);
    expect(await page.locator('[data-tab-group-header="plan"]').getAttribute('aria-expanded')).toBe('true');

    await page.locator('#sessionTabs [data-id="review"]').click();
    expect(await page.evaluate(() => (window as any).__activation)).toBe('session:review');

    const clear = page.getByRole('button', { name: 'Clear search' });
    expect(await clear.isVisible()).toBe(true);
    await clear.click();

    expect(await search.inputValue()).toBe('');
    expect(await search.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await clear.isHidden()).toBe(true);
    expect(await page.locator('[data-tab-group-header="plan"]').getAttribute('aria-expanded')).toBe('false');
    expect(await paintedRows()).toEqual(['alpha', 'web', 'notes']);
    expect(await page.evaluate(() => localStorage.getItem('codeman:tab-groups-collapsed'))).toBe('["plan"]');
  });

  it('says so when nothing matches, and Escape in the box clears it', async () => {
    const search = page.getByRole('searchbox', { name: 'Search sessions' });
    await search.fill('zzz');
    expect(await paintedRows()).toEqual([]);
    expect(await paintedGroups()).toEqual([]);
    expect(await page.getByRole('status').filter({ hasText: 'No sessions match' }).isVisible()).toBe(true);

    await search.press('Escape');
    expect(await search.inputValue()).toBe('');
    expect(await page.locator('#tabRailSearchEmpty').isHidden()).toBe(true);
    expect(await paintedRows()).toEqual(['alpha', 'web', 'notes']);
  });

  it('walks only the matches with the arrow keys', async () => {
    await page.getByRole('searchbox', { name: 'Search sessions' }).fill('a');
    // 'a' matches Alpha API, Roadmap, API Review and Dashboard, not Notes.
    expect(await paintedRows()).toEqual(['alpha', 'roadmap', 'review', 'web']);
    await page.locator('#sessionTabs [data-id="alpha"]').focus();
    const walk: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('ArrowDown');
      walk.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          return el.dataset.webviewId || el.dataset.id || el.dataset.tabGroupHeader || el.id;
        })
      );
    }
    expect(walk).toEqual(['plan', 'roadmap', 'review', 'web', 'eng', 'alpha']);
  });

  it('is hidden with the rail, on the horizontal strip', async () => {
    await page.evaluate(() => document.documentElement.setAttribute('data-tab-orientation', 'horizontal'));
    expect(await page.locator('#tabRailSearch').isVisible()).toBe(false);
    await page.evaluate(() => document.documentElement.setAttribute('data-tab-orientation', 'vertical'));
  });
});
