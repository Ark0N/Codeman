/**
 * @fileoverview Real-Chromium coverage for the vertical rail's session search.
 *
 * What DOM emulation cannot answer: that the shipped CSS actually hides a
 * filtered row and an emptied group (and, in the sidebar layout, an emptied
 * case box), that the box shows only on the vertical rail, that the inline
 * oninput/onkeydown/onclick handlers in index.html reach the app, that a match
 * inside a collapsed group can be clicked, and that Escape in the box clears
 * the search WITHOUT the global key handler (installed for real, capture
 * phase, so it runs before the box's own onkeydown) also closing every panel.
 * The real #tabRail markup is lifted from index.html, and the shipping
 * constants.js, tab-layout-browser.js, app.js, webview-tabs.js and styles.css
 * are loaded into a page.
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
      app.updateConnectionLines = () => {
        w.__redraws++;
      };
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
      // The real global key handler (document, capture phase). The close
      // methods it calls live in settings-ui.js / panels-ui.js, which are not
      // loaded here, so they record instead.
      app.setupColorPicker = () => undefined;
      app.closeAllPanels = () => w.__closed.push('panels');
      app.closeHelp = () => w.__closed.push('help');
      app.closeSessionManager = () => w.__closed.push('session-manager');
      app.setupEventListeners();
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
      w.__closed = [];
      w.__redraws = 0;
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

  it('Escape with text in the box clears it and closes nothing else', async () => {
    const search = page.getByRole('searchbox', { name: 'Search sessions' });
    await search.fill('review');
    expect(await paintedRows()).toEqual(['review']);

    await search.press('Escape');
    expect(await search.inputValue()).toBe('');
    expect(await paintedRows()).toEqual(['alpha', 'web', 'notes']);
    expect(await page.evaluate(() => (window as any).__closed)).toEqual([]);

    // An empty box leaves Escape to the global handler, which closes as always.
    await search.press('Escape');
    expect(await page.evaluate(() => (window as any).__closed)).toEqual(['panels', 'help', 'session-manager']);
  });

  it('redraws the connector lines when a keystroke moves the rows', async () => {
    const search = page.getByRole('searchbox', { name: 'Search sessions' });
    const notesTop = () =>
      page.evaluate(() => document.querySelector('#sessionTabs [data-id="notes"]')!.getBoundingClientRect().top);
    // The first keystroke opens the collapsed Planning group, a render that
    // redraws on its own. The next one only toggles classes.
    await search.fill('e');
    expect(await paintedRows()).toEqual(['review', 'notes']);
    const before = await notesTop();
    await page.evaluate(() => {
      (window as any).__redraws = 0;
    });

    await search.fill('es');
    expect(await paintedRows()).toEqual(['notes']);
    expect(await notesTop()).toBeLessThan(before);
    expect(await page.evaluate(() => (window as any).__redraws)).toBe(1);
  });

  it('hides a case box the sidebar filter emptied, in the sidebar layout only', async () => {
    const painted = await page.evaluate(() => {
      const root = document.documentElement;
      const probeHtml =
        '<aside class="session-sidebar" id="sidebarProbe"><div class="session-tabs tabs-clusters">' +
        '<div class="tab-cluster tab-filtered-out" data-probe="emptied">' +
        '<span class="tab-cluster-label">api <span class="tab-cluster-count">0</span></span></div>' +
        '<div class="tab-cluster" data-probe="kept">' +
        '<span class="tab-cluster-label">web <span class="tab-cluster-count">1</span></span>' +
        '<div class="session-tab">w1-web</div></div>' +
        '</div></aside>';
      const measure = () => {
        const probe = document.getElementById('sidebarProbe')!;
        return {
          emptied: probe.querySelector('[data-probe="emptied"]')!.getClientRects().length,
          kept: probe.querySelector('[data-probe="kept"]')!.getClientRects().length,
        };
      };
      root.setAttribute('data-tab-orientation', 'horizontal');
      document.body.insertAdjacentHTML('beforeend', probeHtml);
      const probe = document.getElementById('sidebarProbe')!;
      // Header layout (the box outside any sidebar, which that layout hides):
      // the rule is scoped to the sidebar, so a leaked class hides nothing.
      root.setAttribute('data-session-list', 'header');
      probe.classList.remove('session-sidebar');
      const header = measure();
      root.setAttribute('data-session-list', 'sidebar');
      probe.classList.add('session-sidebar');
      const sidebar = measure();
      document.getElementById('sidebarProbe')!.remove();
      root.removeAttribute('data-session-list');
      root.setAttribute('data-tab-orientation', 'vertical');
      return { header, sidebar };
    });
    expect(painted.sidebar).toEqual({ emptied: 0, kept: 1 });
    expect(painted.header.emptied).toBe(1);
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
