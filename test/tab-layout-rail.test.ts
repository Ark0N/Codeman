/**
 * @fileoverview The grouped vertical rail, driven through the shipping CodemanApp.
 *
 * Covers the app.js half of the owner-tab-layout frontend: the rail renders the
 * owner's groups only when it is vertical AND there is at least one group (every
 * other case must be byte-for-byte the flat rail), collapse is per-device and
 * keeps the active row, a structural change escapes the incremental patch path,
 * drag-reorder is withheld, and lineage arcs to a collapse-hidden session anchor
 * to its group header.
 *
 * The real modules run INSIDE a JSDOM window (runScripts: 'outside-only'), so
 * `document`, `localStorage` and `window` below are that window's, not Node's.
 *
 * Port: none.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = join(process.cwd(), 'src/web/public');
let CodemanApp: { prototype: Record<string, any> };
let window: any;
let document: Document;
let localStorage: Storage;
let localStorageDescriptor: PropertyDescriptor | undefined;

beforeAll(async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://localhost/',
    runScripts: 'outside-only',
  });
  // Evaluate after DOMContentLoaded so app.js's own bootstrap (new CodemanApp()
  // on that event) never runs: each test builds the instance it needs.
  if (dom.window.document.readyState !== 'complete') {
    await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  }
  window = dom.window;
  document = window.document;
  localStorage = window.localStorage;
  localStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
  const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');
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
      '\n' +
      read('session-lineage.js') +
      '\n;window.__GroupedRailCodemanApp = CodemanApp;'
  );
  CodemanApp = window.__GroupedRailCodemanApp;
});

const layout = {
  version: 8,
  updatedAt: '2026-08-16T00:00:00.000Z',
  groups: [
    {
      id: 'group-x',
      name: '<Core & Ops>',
      refs: [
        { kind: 'session', id: 's2' },
        { kind: 'webview', id: 'w1' },
        { kind: 'session', id: 's1' },
      ],
    },
  ],
  ungrouped: [{ kind: 'session', id: 's3' }],
};

function makeApp(options: { tabLayout?: unknown } = {}) {
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  document.documentElement.setAttribute('data-tab-orientation', 'vertical');
  document.documentElement.dataset.tabRailSort = 'manual';
  document.body.innerHTML = '<div id="sessionTabs"></div>';
  app.$ = (id: string) => document.getElementById(id);
  app.sessions = new Map([
    ['s1', { id: 's1', name: 'One', status: 'idle' }],
    ['s2', { id: 's2', name: 'Two', status: 'busy' }],
    ['s3', { id: 's3', name: 'Three', status: 'idle' }],
  ]);
  app.sessionOrder = ['s1', 's2', 's3'];
  app.webviews = new Map([['w1', { id: 'w1', name: 'Dashboard', url: 'https://example.test' }]]);
  app.webviewOrder = ['w1'];
  app.activeSessionId = 's2';
  app.activeWebviewId = null;
  app.tabLayout = 'tabLayout' in options ? options.tabLayout : layout;
  app.collapsedTabGroupIds = new Set();
  app._hiddenTabGroupByRef = new Map();
  app._lastTabGroupStructureKey = null;
  app._tabCollapseStorageFailed = false;
  app._inlineRenameActive = false;
  app.tabAlerts = new Map();
  app.terminalLoadStates = new Map();
  app.minimizedSubagents = new Map();
  app.hasTabDetachOverride = () => false;
  app.renderSubagentTabBadge = () => '';
  app.cancelHideSubagentDropdown = () => {};
  app.updateTabOverflowMode = () => {};
  app.updateConnectionLines = vi.fn();
  app._applyTabEntrances = () => {};
  app._scrollActiveTabIntoView = () => {};
  app._refreshMobileOverviewIfVisible = () => {};
  app._refreshHomeSessionsIfVisible = () => {};
  app.applySidebarFilter = () => {};
  return app;
}

const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>('#sessionTabs .session-tab')].map(
    (tab) => tab.dataset.webviewId || tab.dataset.id
  );
const badges = () =>
  [...document.querySelectorAll<HTMLElement>('#sessionTabs .session-tab')].map(
    (tab) => tab.querySelector('.tab-number')?.textContent ?? null
  );

beforeEach(() => {
  delete window.__codemanUser;
  document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
  document.body.innerHTML = '';
  localStorage.removeItem('codeman:tab-groups-collapsed');
});

afterEach(() => {
  if (localStorageDescriptor) Object.defineProperty(window, 'localStorage', localStorageDescriptor);
  else delete window.localStorage;
});

describe('flat rail is unchanged without groups', () => {
  it('renders identical markup for no layout, a failed read and a layout with zero groups', () => {
    const none = makeApp({ tabLayout: null });
    none._fullRenderSessionTabs();
    const flat = document.getElementById('sessionTabs')!.innerHTML;
    expect(rowIds()).toEqual(['s1', 's2', 's3', 'w1']);

    const empty = makeApp({ tabLayout: { version: 3, groups: [], ungrouped: [{ kind: 'session', id: 's3' }] } });
    empty._fullRenderSessionTabs();
    expect(document.getElementById('sessionTabs')!.innerHTML).toBe(flat);
    expect(document.querySelectorAll('.tab-layout-group')).toHaveLength(0);
    expect(document.getElementById('sessionTabs')!.classList.contains('session-tabs--grouped')).toBe(false);
  });

  it('keeps the horizontal strip flat even when the owner has groups', () => {
    const app = makeApp();
    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    app._fullRenderSessionTabs();
    expect(document.querySelectorAll('.tab-layout-group')).toHaveLength(0);
    expect(rowIds()).toEqual(['s1', 's2', 's3', 'w1']);
  });
});

describe('grouped vertical rail', () => {
  it('draws escaped sections in layout order while badges keep their Alt+N slot', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    expect([...document.querySelectorAll('.tab-layout-group-name')].map((el) => el.textContent)).toEqual([
      '<Core & Ops>',
      'Ungrouped',
    ]);
    expect(document.querySelectorAll('.tab-layout-group-name *')).toHaveLength(0);
    expect(rowIds()).toEqual(['s2', 'w1', 's1', 's3']);
    // sessionOrder is s1,s2,s3 and the web tab follows every session: the badge
    // names the Alt+N key, never the row position.
    expect(badges()).toEqual(['2', '4', '1', '3']);
    expect(document.querySelectorAll('.session-tab.active')).toHaveLength(1);
  });

  it('withholds drag-reorder in the grouped rail only', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    const draggable = () =>
      [...document.querySelectorAll<HTMLElement>('.session-tab[data-id]')].map((t) => t.getAttribute('draggable'));
    expect(draggable()).toEqual(['false', 'false', 'false']);

    const flat = makeApp({ tabLayout: null });
    flat._fullRenderSessionTabs();
    expect(draggable()).toEqual(['true', 'true', 'true']);
  });

  it('collapses from the header button, persists per device, and keeps the active row', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    const button = document.querySelector<HTMLElement>('[data-tab-group-header="group-x"]')!;
    // The inline onclick calls the GLOBAL app with the button's own dataset.
    expect(button.getAttribute('onclick')).toBe('app.toggleTabGroupCollapsed(this.dataset.tabGroupHeader)');
    app.toggleTabGroupCollapsed(button.dataset.tabGroupHeader);

    expect([...app.collapsedTabGroupIds]).toEqual(['group-x']);
    expect(localStorage.getItem('codeman:tab-groups-collapsed')).toBe('["group-x"]');
    const header = document.querySelector('[data-tab-group-header="group-x"]')!;
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.querySelector('.tab-layout-group-count')?.textContent).toBe('3');
    expect(rowIds()).toEqual(['s2', 's3']);
    expect(app._hiddenTabGroupByRef.get('session:s1')).toBe('group-x');

    app.toggleTabGroupCollapsed('group-x');
    expect(rowIds()).toEqual(['s2', 'w1', 's1', 's3']);
    expect(localStorage.getItem('codeman:tab-groups-collapsed')).toBe('[]');
  });

  it('reveals a hidden session when it is selected, without expanding its group', () => {
    const app = makeApp();
    app.collapsedTabGroupIds = new Set(['group-x']);
    app._fullRenderSessionTabs();
    expect(rowIds()).toEqual(['s2', 's3']);

    app.activeSessionId = 's1';
    app._updateActiveTabImmediate('s1');

    expect([...app.collapsedTabGroupIds]).toEqual(['group-x']);
    expect(rowIds()).toEqual(['s1', 's3']);
    expect(badges()).toEqual(['1', '3']);
    expect(document.querySelector('.session-tab.active')?.getAttribute('data-id')).toBe('s1');
  });

  it('patches rows in place while the structure holds, and rebuilds when it changes', () => {
    const app = makeApp();
    app.collapsedTabGroupIds = new Set(['group-x']);
    app._fullRenderSessionTabs();
    const full = vi.spyOn(app, '_fullRenderSessionTabs');

    app.sessions.get('s3').status = 'busy';
    app._renderSessionTabsImmediate();
    expect(full).not.toHaveBeenCalled();
    expect(document.querySelector('[data-id="s3"] .tab-status')?.className).toBe('tab-status busy');

    // Same rows on screen, different grouping: s3 moves into group-x. The id
    // sets still match, so only the structure key can catch this.
    app.collapsedTabGroupIds = new Set();
    app._fullRenderSessionTabs();
    full.mockClear();
    app.tabLayout = {
      ...layout,
      version: 9,
      groups: [{ ...layout.groups[0], refs: [...layout.groups[0].refs, { kind: 'session', id: 's3' }] }],
      ungrouped: [],
    };
    app._renderSessionTabsImmediate();
    expect(full).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.tab-layout-group')).toHaveLength(1);
    expect(rowIds()).toEqual(['s2', 'w1', 's1', 's3']);
  });

  it('falls back to all-expanded when collapse cannot be stored', () => {
    const app = makeApp();
    const setItem = vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    app.toggleTabGroupCollapsed('group-x', true);
    setItem.mockRestore();
    expect(app.collapsedTabGroupIds.size).toBe(0);
    expect(app._tabCollapseStorageFailed).toBe(true);
    expect(document.querySelector('[data-tab-group-header="group-x"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('survives localStorage itself being unavailable', () => {
    const app = makeApp({ tabLayout: null });
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new window.DOMException('denied', 'SecurityError');
      },
    });
    expect(() => app._applyTabLayout(layout)).not.toThrow();
    expect(document.querySelectorAll('.tab-layout-group')).toHaveLength(2);
    expect(app.collapsedTabGroupIds.size).toBe(0);
  });
});

describe('layout adoption', () => {
  it('garbage-collects stale collapse ids and renders on adoption; a failed read renders flat', () => {
    localStorage.setItem('codeman:tab-groups-collapsed', '["gone","group-x"]');
    const app = makeApp({ tabLayout: null });
    app._applyTabLayout(layout);
    expect([...app.collapsedTabGroupIds]).toEqual(['group-x']);
    expect(localStorage.getItem('codeman:tab-groups-collapsed')).toBe('["group-x"]');
    expect(document.querySelectorAll('.tab-layout-group')).toHaveLength(2);

    app._applyTabLayout(null);
    expect(app.tabLayout).toBeNull();
    expect(document.querySelectorAll('.tab-layout-group')).toHaveLength(0);
    expect(rowIds()).toEqual(['s1', 's2', 's3', 'w1']);
  });

  it('ignores an older layout than the one it already shows', () => {
    const app = makeApp();
    app.tabLayout = { ...layout, version: 9 };
    app._applyTabLayout({ ...layout, version: 8, groups: [] });
    expect(app.tabLayout.version).toBe(9);
  });

  it('re-reads on tab:layoutChanged only for its own owner and a newer version', () => {
    const app = makeApp();
    app._loadTabLayout = vi.fn();
    app.tabLayout = { version: 8, groups: [], ungrouped: [] };

    app._onTabLayoutChanged({ owner: '@single', version: 8 });
    expect(app._loadTabLayout).not.toHaveBeenCalled();
    app._onTabLayoutChanged({ owner: '@single', version: 9 });
    expect(app._loadTabLayout).toHaveBeenCalledTimes(1);

    window.__codemanUser = { username: 'alice', multiUser: true };
    app._onTabLayoutChanged({ owner: 'bob', version: 20 });
    expect(app._loadTabLayout).toHaveBeenCalledTimes(1);
    app._onTabLayoutChanged({ owner: 'alice', version: 20 });
    expect(app._loadTabLayout).toHaveBeenCalledTimes(2);
  });

  it('loads through GET /api/tab-layout and adopts the envelope payload', async () => {
    const app = makeApp({ tabLayout: null });
    app._tabLayoutCoordinator = null;
    app._apiJson = vi.fn(async () => ({ layout }));
    await app._loadTabLayout();
    expect(app._apiJson).toHaveBeenCalledWith('/api/tab-layout');
    expect(app.tabLayout.version).toBe(8);
    expect(document.querySelectorAll('.tab-layout-group')).toHaveLength(2);
    app._tabLayoutCoordinator.dispose();
  });
});

describe('lineage in the grouped rail', () => {
  function rect(top: number) {
    return () => ({ left: 32, top, right: 292, bottom: top + 36, width: 260, height: 36, x: 32, y: top }) as DOMRect;
  }

  it('anchors a collapse-hidden endpoint to its group header', () => {
    const app = makeApp();
    app.activeSessionId = 's3';
    app.sessions.get('s3').status = 'working';
    app.sessions.get('s3').parentSessionId = 's1';
    app.collapsedTabGroupIds = new Set(['group-x']);
    app._lineageLinesEnabled = () => true;
    app._fullRenderSessionTabs();
    expect(rowIds()).toEqual(['s3']);

    document.getElementById('sessionTabs')!.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 320, bottom: 320, width: 320, height: 320 }) as DOMRect;
    document.querySelector<HTMLElement>('[data-tab-group-header="group-x"]')!.getBoundingClientRect = rect(20);
    document.querySelector<HTMLElement>('[data-id="s3"]')!.getBoundingClientRect = rect(180);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

    app._appendLineageConnectionLines(svg, new Map());

    const line = svg.querySelector('.lineage-line');
    expect(line?.classList.contains('lineage-line--proxied')).toBe(true);
    expect(line?.getAttribute('data-parent-tab')).toBe('s1');
    expect(svg.querySelector('.lineage-line-dot')?.classList.contains('lineage-line-dot--proxied')).toBe(true);
    expect(app._lineageEdgeCount).toBe(1);
  });

  it('draws nothing when both endpoints hide behind the same header', () => {
    const app = makeApp();
    app.activeSessionId = 's3';
    app.sessions.get('s1').parentSessionId = 's2';
    app.collapsedTabGroupIds = new Set(['group-x']);
    app._lineageLinesEnabled = () => true;
    app._fullRenderSessionTabs();
    document.getElementById('sessionTabs')!.getBoundingClientRect = rect(0);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

    app._appendLineageConnectionLines(svg, new Map());

    expect(svg.querySelectorAll('.lineage-line')).toHaveLength(0);
    expect(app._lineageEdgeCount).toBe(0);
  });
});
