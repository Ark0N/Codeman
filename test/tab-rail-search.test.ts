/**
 * @fileoverview Session-name search on the vertical tab rail.
 *
 * What is pinned, and why:
 * - The pure matcher (`CodemanTabSearch` in constants.js): trimmed,
 *   case-insensitive substring, a whitespace-only query is no query, and every
 *   section that ends up empty is reported so the caller can hide it.
 * - It is a VIEW filter over the one #sessionTabs list, the same row classes the
 *   sidebar filter box uses: grouping, order, Alt+N badges and the layout on the
 *   server never change, and nothing is written anywhere.
 * - A match inside a COLLAPSED group is shown: the projection ignores collapse
 *   while a search is active, without touching the per-device collapse state,
 *   and the header cannot be collapsed until the search is cleared.
 * - Groups with no match hide, an empty result says so, and it works on the
 *   flat rail (no groups) too.
 * - Only the grouped rail is a tree: hidden rows and the headers of hidden
 *   groups leave the roving walk and the posinset/setsize count.
 * - The rail matches the NAME (a web tab's title); the sidebar keeps matching
 *   name + working directory. Lower-casing never follows the browser locale
 *   (a Turkish locale lowers "API" to "apı").
 * - A session row with a tab alert is never hidden, and keeps its group or
 *   case box on screen (the owner's call on #580).
 * - Escape in a box that holds text clears the search and closes nothing else:
 *   the global key handler runs first (capture phase) and must route it.
 * - A change in what shows redraws the connector lines, which are anchored to
 *   row positions; an unchanged re-apply does not.
 * - The sidebar hides a case box its filter emptied, like the rail.
 * - The input is labelled, sits at the top of #tabRail, and every new string
 *   reads in zh-CN.
 *
 * The real modules run INSIDE a JSDOM window (runScripts: 'outside-only').
 *
 * Port: none.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = join(process.cwd(), 'src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');

type SearchResult = {
  active: boolean;
  hidden: Set<unknown>;
  counts: Map<unknown, number>;
  matchCount: number;
};
type TabSearch = {
  needle: (query: unknown) => string;
  filter: (
    rows: Array<{ key: unknown; text: string; section?: unknown; keep?: boolean }>,
    query: unknown
  ) => SearchResult;
};

function loadSearch(): TabSearch {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
  return (context.window as { CodemanTabSearch: TabSearch }).CodemanTabSearch;
}

describe('CodemanTabSearch (pure)', () => {
  const search = loadSearch();

  it('normalizes a query: trimmed, lower-cased, anything else is empty', () => {
    expect(search.needle('  ApI  ')).toBe('api');
    expect(search.needle('   ')).toBe('');
    expect(search.needle(undefined)).toBe('');
    expect(search.needle(42)).toBe('');
  });

  it('keeps case-insensitive substring matches and counts them per section', () => {
    const rows = [
      { key: 'a', text: 'Alpha API', section: 'g1' },
      { key: 'b', text: 'Roadmap', section: 'g1' },
      { key: 'c', text: 'api review', section: 'g2' },
      { key: 'd', text: 'Notes', section: 'g3' },
      { key: 'e', text: 'Flat API row', section: null },
    ];
    const result = search.filter(rows, 'aPi');
    expect(result.active).toBe(true);
    expect([...result.hidden]).toEqual(['b', 'd']);
    expect(result.matchCount).toBe(3);
    // Every section is reported, empty ones as 0, so the caller can hide them.
    expect([...result.counts]).toEqual([
      ['g1', 1],
      ['g2', 1],
      ['g3', 0],
    ]);
  });

  it('is a no-op for an empty or whitespace query', () => {
    const rows = [
      { key: 'a', text: 'One', section: 'g1' },
      { key: 'b', text: 'Two', section: null },
    ];
    for (const query of ['', '   ', undefined]) {
      const result = search.filter(rows, query);
      expect(result.active).toBe(false);
      expect(result.hidden.size).toBe(0);
      expect(result.matchCount).toBe(2);
    }
  });

  it('never hides a kept row, counts it toward its section, and leaves it out of matchCount', () => {
    const rows = [
      { key: 'a', text: 'Alpha', section: 'g1', keep: true },
      { key: 'b', text: 'Beta', section: 'g1' },
      { key: 'c', text: 'Gamma', section: 'g2' },
      { key: 'd', text: 'Delta', section: null, keep: true },
    ];
    const result = search.filter(rows, 'zzz');
    expect(result.active).toBe(true);
    expect([...result.hidden]).toEqual(['b', 'c']);
    // Zero TEXT matches: "No sessions match" still shows above the kept rows.
    expect(result.matchCount).toBe(0);
    // The kept row keeps its group on screen; the group without one empties.
    expect([...result.counts]).toEqual([
      ['g1', 1],
      ['g2', 0],
    ]);
    // A kept row that also matches is one match, not two.
    expect(search.filter(rows, 'alpha').matchCount).toBe(1);
    // Only a literal true keeps a row.
    expect(search.filter([{ key: 'x', text: 'X', keep: 'yes' as never }], 'zzz').hidden.has('x')).toBe(true);
  });

  it('reports no matches without throwing on odd input', () => {
    const result = search.filter([{ key: 'a', text: '', section: 'g' }], 'x');
    expect(result.matchCount).toBe(0);
    expect(result.counts.get('g')).toBe(0);
    expect(search.filter(null as never, 'x').matchCount).toBe(0);
  });

  it('lower-cases without the browser locale, so a Turkish locale still finds "API"', () => {
    // A context of its own, whose locale-aware lower-casing behaves like the
    // Turkish locale (I -> dotless i). The prototypes are this context's alone.
    const context = vm.createContext({ window: {}, globalThis: {} });
    vm.runInContext(
      "String.prototype.toLocaleLowerCase = function () { return String(this).replace(/I/g, '\\u0131').toLowerCase(); };",
      context
    );
    vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
    const turkish = (context.window as { CodemanTabSearch: TabSearch }).CodemanTabSearch;
    expect(vm.runInContext("'API'.toLocaleLowerCase()", context)).toBe('apı');

    expect(turkish.needle('API')).toBe('api');
    const result = turkish.filter([{ key: 'r', text: 'API Review', section: null }], 'api');
    expect(result.hidden.size).toBe(0);
    expect(result.matchCount).toBe(1);
  });
});

// ─── The rail, driven through the shipping CodemanApp ────────────────────────

let CodemanApp: { prototype: Record<string, any> };
let window: any;
let document: Document;
let localStorage: Storage;

beforeAll(async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://localhost/',
    runScripts: 'outside-only',
  });
  if (dom.window.document.readyState !== 'complete') {
    await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  }
  window = dom.window;
  document = window.document;
  localStorage = window.localStorage;
  window.setInterval = () => 0;
  window.requestAnimationFrame = () => 0;
  window.CSS = { escape: (value: string) => value };
  window.eval(
    'var MobileDetection = { isTouchDevice: () => false, getDeviceType: () => "desktop" }, KeyboardHandler = {}, ' +
      'SwipeHandler = {}, VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
      read('constants.js') +
      '\n' +
      read('tab-layout-browser.js') +
      '\n' +
      read('app.js') +
      '\n' +
      read('webview-tabs.js') +
      '\n;window.__RailSearchCodemanApp = CodemanApp;'
  );
  CodemanApp = window.__RailSearchCodemanApp;
});

const LAYOUT = {
  version: 8,
  updatedAt: '2026-10-01T00:00:00.000Z',
  groups: [
    {
      id: 'eng',
      name: 'Engineering',
      refs: [
        { kind: 'session', id: 'alpha' },
        { kind: 'webview', id: 'web' },
      ],
    },
    {
      id: 'plan',
      name: 'Planning',
      refs: [
        { kind: 'session', id: 'roadmap' },
        { kind: 'session', id: 'review' },
      ],
    },
  ],
  ungrouped: [{ kind: 'session', id: 'notes' }],
};

function makeApp(options: { tabLayout?: unknown } = {}) {
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  document.documentElement.setAttribute('data-tab-orientation', 'vertical');
  document.documentElement.dataset.tabRailSort = 'manual';
  document.body.innerHTML = `
    <aside class="tab-rail" id="tabRail">
      <div class="tab-rail-search">
        <input id="tabRailSearch" type="search" aria-label="Search sessions">
        <button id="tabRailSearchClear" type="button" aria-label="Clear search" hidden></button>
      </div>
      <div id="tabRailSearchEmpty" role="status" hidden>No sessions match</div>
      <div class="session-tabs" id="sessionTabs" role="tablist" aria-label="Session tabs"></div>
    </aside>`;
  app.$ = (id: string) => document.getElementById(id);
  app.sessions = new Map([
    ['alpha', { id: 'alpha', name: 'Alpha API', status: 'idle', workingDir: '/srv/alpha' }],
    ['roadmap', { id: 'roadmap', name: 'Roadmap', status: 'idle', workingDir: '/srv/api-plans' }],
    ['review', { id: 'review', name: 'API Review', status: 'idle' }],
    ['notes', { id: 'notes', name: 'Notes', status: 'busy' }],
  ]);
  app.sessionOrder = ['alpha', 'roadmap', 'review', 'notes'];
  app.webviews = new Map([['web', { id: 'web', name: 'Grafana Dashboard', url: 'https://example.test/api' }]]);
  app.webviewOrder = ['web'];
  app.activeSessionId = 'alpha';
  app.activeWebviewId = null;
  app.tabLayout = 'tabLayout' in options ? options.tabLayout : LAYOUT;
  app.collapsedTabGroupIds = new Set();
  app._hiddenTabGroupByRef = new Map();
  app._lastTabGroupStructureKey = null;
  app._tabCollapseStorageFailed = false;
  app._inlineRenameActive = false;
  app._sidebarFilter = '';
  app._tabRailSearch = '';
  app.tabAlerts = new Map();
  app.pendingHooks = new Map();
  app._debounceTimers = {};
  app.terminalLoadStates = new Map();
  app.minimizedSubagents = new Map();
  app.hasTabDetachOverride = () => false;
  app.renderSubagentTabBadge = () => '';
  app.cancelHideSubagentDropdown = () => {};
  app.updateTabOverflowMode = () => {};
  app.updateConnectionLines = () => {};
  app._applyTabEntrances = () => {};
  app._scrollActiveTabIntoView = () => {};
  app._refreshMobileOverviewIfVisible = () => {};
  app._refreshHomeSessionsIfVisible = () => {};
  app.isSessionSidebarActive = () => false;
  app._startSidebarRichClock = () => {};
  app._stopSidebarRichClock = () => {};
  return app;
}

/** Rows the user can see: rendered and not filtered out. */
const visibleRows = () =>
  [...document.querySelectorAll<HTMLElement>('#sessionTabs .session-tab:not(.tab-filtered-out)')].map(
    (tab) => tab.dataset.webviewId || tab.dataset.id
  );
const visibleGroups = () =>
  [...document.querySelectorAll<HTMLElement>('#sessionTabs .tab-layout-group:not(.tab-filtered-out)')].map(
    (section) => section.dataset.tabGroupId
  );
const badgeOf = (id: string) => document.querySelector(`[data-id="${id}"] .tab-number`)?.textContent ?? null;
const input = () => document.getElementById('tabRailSearch') as HTMLInputElement;
const clearButton = () => document.getElementById('tabRailSearchClear') as HTMLButtonElement;
const emptyNote = () => document.getElementById('tabRailSearchEmpty') as HTMLElement;

beforeEach(() => {
  document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
  document.body.innerHTML = '';
  localStorage.removeItem('codeman:tab-groups-collapsed');
});

afterEach(() => vi.restoreAllMocks());

describe('grouped rail search', () => {
  it('shows a match inside a collapsed group without touching the stored collapse state', () => {
    const app = makeApp();
    localStorage.setItem('codeman:tab-groups-collapsed', '["plan"]');
    app.collapsedTabGroupIds = new Set(['plan']);
    app._fullRenderSessionTabs();
    expect(visibleRows()).toEqual(['alpha', 'web', 'notes']);
    const badgesBefore = ['alpha', 'notes'].map(badgeOf);

    app.setTabRailSearch('aPi');

    expect(visibleRows()).toEqual(['alpha', 'review']);
    expect(visibleGroups()).toEqual(['eng', 'plan']);
    const plan = document.querySelector('[data-tab-group-header="plan"]')!;
    expect(plan.getAttribute('aria-expanded')).toBe('true');
    // Counts follow the search, so a header never claims rows it is not showing.
    expect(plan.querySelector('.tab-layout-group-count')?.textContent).toBe('1');
    expect([...app.collapsedTabGroupIds]).toEqual(['plan']);
    expect(localStorage.getItem('codeman:tab-groups-collapsed')).toBe('["plan"]');
    // Alt+N badges name the session order, never the filtered position.
    expect(['alpha', 'notes'].map(badgeOf)).toEqual(badgesBefore);
    expect(badgeOf('review')).toBe('3');
  });

  it('will not collapse or expand a group while searching, and restores collapse on clear', () => {
    const app = makeApp();
    localStorage.setItem('codeman:tab-groups-collapsed', '["plan"]');
    app.collapsedTabGroupIds = new Set(['plan']);
    app._fullRenderSessionTabs();
    app.setTabRailSearch('review');

    expect(app.toggleTabGroupCollapsed('plan')).toBe(false);
    expect(app.toggleTabGroupCollapsed('eng', true)).toBe(false);
    expect([...app.collapsedTabGroupIds]).toEqual(['plan']);
    expect(localStorage.getItem('codeman:tab-groups-collapsed')).toBe('["plan"]');
    expect(visibleRows()).toEqual(['review']);

    app.clearTabRailSearch();
    expect(input().value).toBe('');
    expect(visibleRows()).toEqual(['alpha', 'web', 'notes']);
    expect(document.querySelector('[data-tab-group-header="plan"]')!.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-tab-group-header="plan"] .tab-layout-group-count')?.textContent).toBe('2');
  });

  it('filters web tabs by their title, and never by URL or working directory', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    app.setTabRailSearch('grafana');
    expect(visibleRows()).toEqual(['web']);
    // 'api' is in the web tab's URL and in roadmap's working directory: neither counts.
    app.setTabRailSearch('api');
    expect(visibleRows()).toEqual(['alpha', 'review']);
    app.setTabRailSearch('/srv');
    expect(visibleRows()).toEqual([]);
  });

  it('hides every group and says so when nothing matches', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    expect(emptyNote().hidden).toBe(true);

    app.setTabRailSearch('zzz');
    expect(visibleRows()).toEqual([]);
    expect(visibleGroups()).toEqual([]);
    expect(emptyNote().hidden).toBe(false);
    expect(clearButton().hidden).toBe(false);

    app.setTabRailSearch('   ');
    expect(visibleRows()).toEqual(['alpha', 'web', 'roadmap', 'review', 'notes']);
    expect(emptyNote().hidden).toBe(true);
  });

  it('keeps hidden rows and the headers of hidden groups out of the tree walk', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    const tabs = document.getElementById('sessionTabs')!;
    expect(tabs.getAttribute('role')).toBe('tree');

    app.setTabRailSearch('notes');
    const items = app._tabTreeItems(tabs) as HTMLElement[];
    expect(items.map((item) => item.dataset.id || item.dataset.tabGroupHeader || 'ungrouped')).toEqual(['notes']);
    // The one roving stop moved onto something the user can see.
    const stops = [...tabs.querySelectorAll('[role="treeitem"][tabindex="0"]')] as HTMLElement[];
    expect(stops.map((el) => el.dataset.id)).toEqual(['notes']);
    expect(stops[0].getAttribute('aria-posinset')).toBe('1');
    expect(stops[0].getAttribute('aria-setsize')).toBe('1');
  });

  it('survives the re-render an SSE tick triggers, and re-matches a renamed session', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    app.setTabRailSearch('api');
    app._fullRenderSessionTabs();
    expect(visibleRows()).toEqual(['alpha', 'review']);

    app.sessions.get('notes').name = 'API notes';
    app._renderSessionTabsImmediate();
    expect(visibleRows()).toEqual(['alpha', 'review', 'notes']);
  });

  it('is a view filter only: no request, no order change, no layout change', () => {
    const app = makeApp();
    const fetchSpy = vi.fn();
    window.fetch = fetchSpy;
    app._fullRenderSessionTabs();
    const layoutBefore = JSON.stringify(app.tabLayout);

    app.setTabRailSearch('api');
    app.clearTabRailSearch();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(app.sessionOrder).toEqual(['alpha', 'roadmap', 'review', 'notes']);
    expect(JSON.stringify(app.tabLayout)).toBe(layoutBefore);
  });
});

describe('alerted rows stay visible during a search', () => {
  /** What the app does on a hook event: pendingHooks, then updateTabAlertFromHooks (debounced render). */
  async function setHook(app: Record<string, any>, id: string, hook: string | null) {
    if (hook) app.pendingHooks.set(id, new Set([hook]));
    else app.pendingHooks.delete(id);
    app.updateTabAlertFromHooks(id);
    await new Promise((resolve) => window.setTimeout(resolve, 150));
  }

  it('keeps a non-matching alerted row painted and its group on screen', async () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    await setHook(app, 'alpha', 'permission_prompt');
    expect(app.tabAlerts.get('alpha')).toBe('action');

    app.setTabRailSearch('review');
    expect(visibleRows()).toEqual(['alpha', 'review']);
    expect(visibleGroups()).toEqual(['eng', 'plan']);
    // The header counts the rows it is showing, the kept one included.
    expect(document.querySelector('[data-tab-group-header="eng"] .tab-layout-group-count')?.textContent).toBe('1');
    expect(emptyNote().hidden).toBe(true);
  });

  it('keeps the yellow idle alert too, and still says nothing matched', async () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    await setHook(app, 'roadmap', 'idle_prompt');
    expect(app.tabAlerts.get('roadmap')).toBe('idle');

    app.setTabRailSearch('zzz');
    expect(visibleRows()).toEqual(['roadmap']);
    expect(visibleGroups()).toEqual(['plan']);
    // matchCount is text matches only: the note explains why the row is there.
    expect(emptyNote().hidden).toBe(false);
  });

  it('hides the row again once the alert clears and the rail re-renders', async () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    app.setTabRailSearch('review');
    expect(visibleRows()).toEqual(['review']);

    await setHook(app, 'alpha', 'elicitation_dialog');
    expect(visibleRows()).toEqual(['alpha', 'review']);

    await setHook(app, 'alpha', null);
    expect(app.tabAlerts.has('alpha')).toBe(false);
    expect(visibleRows()).toEqual(['review']);
    expect(visibleGroups()).toEqual(['plan']);
  });

  it('applies to the sidebar filter box as well', async () => {
    const app = makeApp({ tabLayout: null });
    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    app.isSessionSidebarActive = () => true;
    app._fullRenderSessionTabs();
    await setHook(app, 'notes', 'permission_prompt');
    app.applySidebarFilter('/srv/api');
    expect(visibleRows()).toEqual(['roadmap', 'notes']);
  });
});

describe('flat rail search (no groups)', () => {
  it('filters the flat list, keeps it a tablist, and reports an empty result', () => {
    const app = makeApp({ tabLayout: null });
    app._fullRenderSessionTabs();
    const tabs = document.getElementById('sessionTabs')!;
    expect(tabs.getAttribute('role')).toBe('tablist');

    app.setTabRailSearch('ROAD');
    expect(visibleRows()).toEqual(['roadmap']);
    expect(tabs.getAttribute('role')).toBe('tablist');
    expect(badgeOf('roadmap')).toBe('2');

    app.setTabRailSearch('nothing here');
    expect(visibleRows()).toEqual([]);
    expect(emptyNote().hidden).toBe(false);
  });

  it('does not apply on the horizontal strip, where there is no box to clear it', () => {
    const app = makeApp({ tabLayout: null });
    app._fullRenderSessionTabs();
    app.setTabRailSearch('road');
    expect(visibleRows()).toEqual(['roadmap']);

    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    app._fullRenderSessionTabs();
    expect(visibleRows()).toEqual(['alpha', 'roadmap', 'review', 'notes', 'web']);
  });
});

describe('the search box', () => {
  it('clears on Escape and on the clear button, handing focus back to the box', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    input().value = 'review';
    app.setTabRailSearch(input().value);
    expect(clearButton().hidden).toBe(false);

    const escape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    app.handleTabRailSearchKeydown(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(input().value).toBe('');
    expect(clearButton().hidden).toBe(true);
    expect(visibleRows()).toEqual(['alpha', 'web', 'roadmap', 'review', 'notes']);
    expect(document.activeElement).toBe(input());

    // Escape on an empty box is left alone for the global handler.
    const second = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    app.handleTabRailSearchKeydown(second);
    expect(second.defaultPrevented).toBe(false);

    app.setTabRailSearch('notes');
    input().blur();
    app.clearTabRailSearch();
    expect(document.activeElement).toBe(input());
    expect(visibleRows()).toHaveLength(5);
  });

  it('is cleared when the list leaves the vertical orientation (settings-ui.js)', () => {
    const settings = read('settings-ui.js');
    const start = settings.indexOf('  applyTabOrientation(options = {}) {');
    const body = settings.slice(start, settings.indexOf('\n  },\n', start));
    expect(body).toMatch(/orientation !== 'vertical'[\s\S]*_resetTabRailSearch\?\.\(\)/);
    // ...and before the render the orientation change triggers.
    expect(body.indexOf('_resetTabRailSearch')).toBeLessThan(body.indexOf('_fullRenderSessionTabs'));
  });

  it('resets state and box without rendering', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    app.setTabRailSearch('notes');
    const full = vi.spyOn(app, '_fullRenderSessionTabs');
    app._resetTabRailSearch();
    expect(app._tabRailSearch).toBe('');
    expect(input().value).toBe('');
    expect(clearButton().hidden).toBe(true);
    expect(full).not.toHaveBeenCalled();
  });
});

describe('the sidebar filter keeps its own matching', () => {
  it('still matches the working directory in the sidebar, where the rail does not', () => {
    const app = makeApp({ tabLayout: null });
    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    app.isSessionSidebarActive = () => true;
    app._fullRenderSessionTabs();
    app.applySidebarFilter('/srv/api');
    expect(visibleRows()).toEqual(['roadmap']);
    expect(emptyNote().hidden).toBe(true);
  });

  it('marks a case box the sidebar filter emptied, unless an alerted row keeps it', () => {
    const app = makeApp({ tabLayout: null });
    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    document.documentElement.dataset.tabArrangement = 'case';
    app.isSessionSidebarActive = () => true;
    // alpha and notes share a folder, so they share a box.
    app.sessions.get('notes').workingDir = '/srv/alpha';
    const box = (key: string) => document.querySelector<HTMLElement>(`.tab-cluster[data-cluster-key="${key}"]`)!;
    try {
      app._fullRenderSessionTabs();
      expect(box('/srv/alpha').querySelector('.tab-cluster-count')?.textContent).toBe('2');

      app.applySidebarFilter('notes');
      expect(visibleRows()).toEqual(['notes']);
      expect(box('/srv/alpha').classList.contains('tab-filtered-out')).toBe(false);
      expect(box('/srv/alpha').querySelector('.tab-cluster-count')?.textContent).toBe('1');
      // The emptied box is marked (styles.css hides it in the sidebar too).
      expect(box('/srv/api-plans').classList.contains('tab-filtered-out')).toBe(true);
      expect(box('/srv/api-plans').querySelector('.tab-cluster-count')?.textContent).toBe('0');

      // A row that needs the user keeps its box on screen, counted.
      app.tabAlerts.set('roadmap', 'action');
      app._applyTabListFilter();
      // DOM order is box order: the /srv/alpha box (alpha, notes) comes first.
      expect(visibleRows()).toEqual(['notes', 'roadmap']);
      expect(box('/srv/api-plans').classList.contains('tab-filtered-out')).toBe(false);
      expect(box('/srv/api-plans').querySelector('.tab-cluster-count')?.textContent).toBe('1');

      app.applySidebarFilter('');
      expect(document.querySelectorAll('.tab-cluster.tab-filtered-out')).toHaveLength(0);
      expect(box('/srv/alpha').querySelector('.tab-cluster-count')?.textContent).toBe('2');
    } finally {
      delete document.documentElement.dataset.tabArrangement;
    }
  });

  it('hides an emptied case box in the sidebar stylesheet, scoped to the sidebar layout', () => {
    const css = read('styles.css');
    const rule = /([^{}]+)\{\s*display:\s*none\s*!important;\s*\}/g;
    const selectorsHiding = [...css.matchAll(rule)].flatMap((match) =>
      match[1]
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(',')
        .map((selector) => selector.trim())
    );
    expect(selectorsHiding).toContain('html[data-session-list="sidebar"] .tab-cluster.tab-filtered-out');
    // Never unscoped: a leaked class must not hide a box on the header strip.
    expect(selectorsHiding).not.toContain('.tab-cluster.tab-filtered-out');
  });
});

describe('Escape in the search box', () => {
  /**
   * The real global key handler from setupEventListeners(), on document in the
   * capture phase, with the close methods it calls (settings-ui.js and
   * panels-ui.js are not loaded here) as recorders. The box in this harness
   * has no inline onkeydown, so only the global handler can clear it.
   */
  function installGlobalKeys(app: Record<string, any>) {
    const closed: string[] = [];
    app.setupColorPicker = () => {};
    app.closeAllPanels = () => closed.push('panels');
    app.closeHelp = () => closed.push('help');
    app.closeSessionManager = () => closed.push('session-manager');
    app.closeCommandPalette = () => {};
    app.closeShortcutOverlay = () => {};
    const add = vi.spyOn(document, 'addEventListener');
    app.setupEventListeners();
    const listener = add.mock.calls.find(([type]) => type === 'keydown')![1] as EventListener;
    add.mockRestore();
    return { closed, remove: () => document.removeEventListener('keydown', listener, true) };
  }
  const escape = () => new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

  it('clears a search and closes nothing else, though the global handler runs first', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    const keys = installGlobalKeys(app);
    try {
      input().value = 'review';
      app.setTabRailSearch(input().value);
      input().focus();

      const event = escape();
      input().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(input().value).toBe('');
      expect(app._tabRailSearch).toBe('');
      expect(visibleRows()).toEqual(['alpha', 'web', 'roadmap', 'review', 'notes']);
      expect(keys.closed).toEqual([]);

      // The box is empty now: the next Escape is the global handler's again.
      input().dispatchEvent(escape());
      expect(keys.closed).toEqual(['panels', 'help', 'session-manager']);
    } finally {
      keys.remove();
    }
  });

  it('only claims an Escape that lands in the box', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    const keys = installGlobalKeys(app);
    try {
      app.setTabRailSearch('review');
      document.body.dispatchEvent(escape());
      expect(keys.closed).toEqual(['panels', 'help', 'session-manager']);
      expect(app._tabRailSearch).toBe('review');
      expect(visibleRows()).toEqual(['review']);
    } finally {
      keys.remove();
    }
  });

  it('leaves an Escape that cancels an IME composition to the IME', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    app.setTabRailSearch('review');
    const composing = new window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, cancelable: true });
    app.handleTabRailSearchKeydown(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(app._tabRailSearch).toBe('review');
  });
});

describe('connector lines follow the rows a search moves', () => {
  it('redraws on a rail keystroke that hides or reveals rows, and only then', () => {
    const app = makeApp({ tabLayout: null });
    app._fullRenderSessionTabs();
    const redraw = vi.fn();
    app.updateConnectionLines = redraw;
    const full = vi.spyOn(app, '_fullRenderSessionTabs');

    app.setTabRailSearch('road');
    // The keystroke path: no render, which would have redrawn them itself.
    expect(full).not.toHaveBeenCalled();
    expect(redraw).toHaveBeenCalledTimes(1);

    // Same rows showing: nothing moved, nothing to redraw.
    app.setTabRailSearch('roa');
    expect(redraw).toHaveBeenCalledTimes(1);

    app.setTabRailSearch('');
    expect(redraw).toHaveBeenCalledTimes(2);
    // The re-apply every render tail runs costs nothing when nothing changed.
    app._applyTabListFilter();
    expect(redraw).toHaveBeenCalledTimes(2);
  });

  it('redraws on a grouped rail when a group empties, and when the empty note shows', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    const redraw = vi.fn();
    app.updateConnectionLines = redraw;
    const full = vi.spyOn(app, '_fullRenderSessionTabs');

    app.setTabRailSearch('notes');
    expect(full).not.toHaveBeenCalled();
    // Only the Ungrouped section (no group id) is left showing.
    expect(visibleGroups()).toEqual(['']);
    expect(redraw).toHaveBeenCalledTimes(1);

    // Nothing matches: the rows were already gone, but the note pushes the list down.
    app.setTabRailSearch('notesz');
    expect(emptyNote().hidden).toBe(false);
    expect(redraw).toHaveBeenCalledTimes(2);
  });

  it('redraws on a sidebar filter keystroke too', () => {
    const app = makeApp({ tabLayout: null });
    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    app.isSessionSidebarActive = () => true;
    app._fullRenderSessionTabs();
    const redraw = vi.fn();
    app.updateConnectionLines = redraw;

    app.applySidebarFilter('/srv/api');
    expect(visibleRows()).toEqual(['roadmap']);
    expect(redraw).toHaveBeenCalledTimes(1);
    app.applySidebarFilter('/srv/api');
    expect(redraw).toHaveBeenCalledTimes(1);
  });
});

// ─── Markup + zh-CN ───────────────────────────────────────────────────────────

describe('markup and zh-CN', () => {
  const INDEX = read('index.html');
  const doms: JSDOM[] = [];
  afterAll(() => doms.forEach((dom) => dom.window.close()));

  it('puts a labelled search box at the top of #tabRail', () => {
    const dom = new JSDOM(INDEX);
    doms.push(dom);
    const rail = dom.window.document.getElementById('tabRail')!;
    const box = rail.querySelector<HTMLInputElement>('#tabRailSearch')!;
    expect(box).not.toBeNull();
    expect(box.getAttribute('aria-label')).toBe('Search sessions');
    expect(box.getAttribute('placeholder')).toBe('Search sessions');
    expect(box.getAttribute('oninput')).toBe('app.setTabRailSearch(this.value)');
    expect(box.getAttribute('onkeydown')).toBe('app.handleTabRailSearchKeydown(event)');
    expect(rail.firstElementChild?.contains(box)).toBe(true);
    const clear = rail.querySelector('#tabRailSearchClear')!;
    expect(clear.getAttribute('aria-label')).toBe('Clear search');
    expect(clear.hasAttribute('hidden')).toBe(true);
    const empty = rail.querySelector('#tabRailSearchEmpty')!;
    expect(empty.getAttribute('role')).toBe('status');
    expect(empty.textContent!.trim()).toBe('No sessions match');
  });

  it('reads in Chinese', () => {
    const dom = new JSDOM(INDEX, { runScripts: 'outside-only', url: 'http://localhost/' });
    doms.push(dom);
    vm.runInContext(read('i18n.js'), dom.getInternalVMContext(), { filename: 'i18n.js' });
    const api = (dom.window as unknown as { CodemanI18n: { start(): void; configure(o: object): void } }).CodemanI18n;
    api.start();
    api.configure({ language: 'zh-CN' });
    const doc = dom.window.document;
    const box = doc.getElementById('tabRailSearch')!;
    expect(box.getAttribute('placeholder')).toBe('搜索会话');
    expect(box.getAttribute('aria-label')).toBe('搜索会话');
    expect(doc.getElementById('tabRailSearchClear')!.getAttribute('aria-label')).toBe('清除搜索');
    expect(doc.getElementById('tabRailSearchEmpty')!.textContent!.trim()).toBe('没有匹配的会话');
  });
});
