/**
 * @fileoverview The grouped vertical rail, driven through the shipping CodemanApp.
 *
 * Covers the app.js half of the owner-tab-layout frontend: the rail renders the
 * owner's groups only when it is vertical AND there is at least one group (every
 * other case must be byte-for-byte the flat rail), collapse is per-device and
 * keeps the active row, a structural change escapes the incremental patch path,
 * drag-reorder and cross-group Ctrl+Shift moves are withheld, a collapsed
 * header carries the alert it hides, layout reads rebuild only on a structural
 * change and back off when they fail, lineage arcs to a collapse-hidden session
 * anchor to its group header, and the grouped rail (only) is an ARIA tree with
 * one roving tab stop, a tree keyboard model and focus restored across rebuilds.
 *
 * The real modules run INSIDE a JSDOM window (runScripts: 'outside-only'), so
 * `document`, `localStorage` and `window` below are that window's, not Node's.
 *
 * Port: none.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
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

  it('keeps collapse working after a malformed stored value, and repairs it', () => {
    localStorage.setItem('codeman:tab-groups-collapsed', '{"group-x":true}');
    const app = makeApp({ tabLayout: null });
    app._applyTabLayout(layout);
    expect(app._tabCollapseStorageFailed).toBe(false);
    expect(localStorage.getItem('codeman:tab-groups-collapsed')).toBe('[]');
    expect(app.toggleTabGroupCollapsed('group-x', true)).toBe(true);
    expect(localStorage.getItem('codeman:tab-groups-collapsed')).toBe('["group-x"]');
    expect(document.querySelector('[data-tab-group-header="group-x"]')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('lights a collapsed header with the most urgent alert it hides, on both render paths', () => {
    const app = makeApp();
    app.tabAlerts.set('s1', 'idle');
    app.collapsedTabGroupIds = new Set(['group-x']);
    app._fullRenderSessionTabs();
    const header = () => document.querySelector('[data-tab-group-header="group-x"]')!;
    const ring = () => ['tab-alert-action', 'tab-alert-idle'].filter((c) => header().classList.contains(c));
    // s1 is hidden (s2 is the kept selection): its yellow alert moves to the header.
    expect(rowIds()).toEqual(['s2', 's3']);
    expect(ring()).toEqual(['tab-alert-idle']);

    // A red alert arriving later is patched in place, without a rebuild.
    const full = vi.spyOn(app, '_fullRenderSessionTabs');
    app.tabAlerts.set('s1', 'action');
    app._renderSessionTabsImmediate();
    expect(full).not.toHaveBeenCalled();
    expect(ring()).toEqual(['tab-alert-action']);

    // The kept selection draws its own ring, so its alert never reaches the header.
    app.tabAlerts.clear();
    app.tabAlerts.set('s2', 'action');
    app._renderSessionTabsImmediate();
    expect(ring()).toEqual([]);
    expect(document.querySelector('[data-id="s2"]')!.classList.contains('tab-alert-action')).toBe(true);

    // Expanded, every row shows its own alert and the header shows none.
    app.tabAlerts.set('s1', 'action');
    app.toggleTabGroupCollapsed('group-x', false);
    expect(ring()).toEqual([]);
  });

  it("lets Ctrl+Shift moves swap only within the active session's own section", () => {
    const app = makeApp();
    app.saveSessionOrder = vi.fn();
    app._fullRenderSessionTabs();
    // s2's neighbours in sessionOrder (s1,s2,s3): s3 is Ungrouped, s1 shares group-x.
    app.moveActiveTabRight();
    expect(app.sessionOrder).toEqual(['s1', 's2', 's3']);
    expect(app.saveSessionOrder).not.toHaveBeenCalled();
    app.moveActiveTabLeft();
    expect(app.sessionOrder).toEqual(['s2', 's1', 's3']);
    expect(app.saveSessionOrder).toHaveBeenCalledTimes(1);

    // A row a collapse hides is still in its section.
    app.sessionOrder = ['s1', 's2', 's3'];
    app.collapsedTabGroupIds = new Set(['group-x']);
    app._fullRenderSessionTabs();
    expect(rowIds()).not.toContain('s1');
    app.moveActiveTabLeft();
    expect(app.sessionOrder).toEqual(['s2', 's1', 's3']);

    // The flat rail (and the strip) keep moving across every neighbour.
    const flat = makeApp({ tabLayout: null });
    flat.saveSessionOrder = vi.fn();
    flat._fullRenderSessionTabs();
    flat.moveActiveTabRight();
    expect(flat.sessionOrder).toEqual(['s1', 's3', 's2']);
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

  it('rebuilds the strip on adoption only when what the rail draws changed', () => {
    const flat = makeApp({ tabLayout: null });
    flat._fullRenderSessionTabs();
    const flatRender = vi.spyOn(flat, '_fullRenderSessionTabs');
    // The flat rail (every owner without groups) never rebuilds for a layout read.
    flat._applyTabLayout({ version: 3, groups: [], ungrouped: [{ kind: 'session', id: 's3' }] });
    flat._applyTabLayout({ version: 4, groups: [], ungrouped: [] });
    flat._applyTabLayout(null);
    expect(flatRender).not.toHaveBeenCalled();

    const app = makeApp({ tabLayout: null });
    app._fullRenderSessionTabs();
    const render = vi.spyOn(app, '_fullRenderSessionTabs');
    app._applyTabLayout(layout);
    expect(render).toHaveBeenCalledTimes(1);
    // A version bump that moves nothing (the broadcast after any session event).
    app._applyTabLayout({ ...layout, version: 9 });
    expect(render).toHaveBeenCalledTimes(1);
    // A rename does change the rail.
    app._applyTabLayout({ ...layout, version: 10, groups: [{ ...layout.groups[0], name: 'Ops' }] });
    expect(render).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.tab-layout-group-name')?.textContent).toBe('Ops');
    // Grouped to flat (a failed read) rebuilds once.
    app._applyTabLayout(null);
    expect(render).toHaveBeenCalledTimes(3);
    expect(document.querySelectorAll('.tab-layout-group')).toHaveLength(0);
  });

  it('backs off failed layout reads and stops, without rebuilding a flat rail', async () => {
    const app = makeApp({ tabLayout: null });
    app._fullRenderSessionTabs();
    app._tabLayoutCoordinator = null;
    app._apiJson = vi.fn(async () => {
      throw new Error('offline');
    });
    const render = vi.spyOn(app, '_fullRenderSessionTabs');
    const realSetTimeout = window.setTimeout;
    const delays: number[] = [];
    let queued: (() => Promise<boolean>) | null = null;
    window.setTimeout = (fn: () => Promise<boolean>, ms: number) => {
      delays.push(ms);
      queued = fn;
      return delays.length;
    };
    try {
      await app._loadTabLayout();
      // Bounded: an uncapped retry must fail the assertion below, not hang.
      for (let drained = 0; queued && drained < 10; drained++) {
        const next: () => Promise<boolean> = queued;
        queued = null;
        await next();
      }
    } finally {
      window.setTimeout = realSetTimeout;
    }
    expect(delays).toEqual([5000, 10000, 20000, 40000]);
    expect(app._apiJson).toHaveBeenCalledTimes(5);
    expect(render).not.toHaveBeenCalled();
    app._tabLayoutCoordinator.dispose();
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

describe('grouped rail tree semantics', () => {
  const tabs = () => document.getElementById('sessionTabs')!;
  const press = (key: string, init: Record<string, unknown> = {}) =>
    (document.activeElement as HTMLElement).dispatchEvent(
      new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    );
  const focused = () => {
    const el = document.activeElement as HTMLElement;
    return el.dataset.tabGroupHeader ? `group:${el.dataset.tabGroupHeader}` : el.dataset.webviewId || el.dataset.id;
  };
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"], [data-webview-id="${id}"]`)!;

  function makeTreeApp(options: { tabLayout?: unknown } = {}) {
    const app = makeApp(options);
    // The container as index.html ships it.
    tabs().setAttribute('role', 'tablist');
    tabs().setAttribute('aria-label', 'Session tabs');
    app.selectSession = vi.fn();
    app.openWebview = vi.fn();
    app.openTabRailActionMenu = vi.fn();
    app.showWebviewModal = vi.fn();
    return app;
  }

  it('is a tree only while grouped, and the flat list returns byte-identical as a tablist', () => {
    const app = makeTreeApp({ tabLayout: null });
    app._fullRenderSessionTabs();
    const flat = tabs().innerHTML;
    expect(tabs().querySelectorAll('[role="tree"], [role="treeitem"], [role="group"]')).toHaveLength(0);
    expect(tabs().querySelectorAll('.session-tab[role="tab"]')).toHaveLength(4);

    app._applyTabLayout(layout);
    expect(tabs().getAttribute('role')).toBe('tree');
    expect(tabs().getAttribute('aria-label')).toBe('Sessions');
    expect(tabs().querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(tabs().querySelectorAll('.session-tab[role="treeitem"]')).toHaveLength(4);

    app._applyTabLayout(null);
    expect(tabs().getAttribute('role')).toBe('tablist');
    expect(tabs().getAttribute('aria-label')).toBe('Session tabs');
    expect(tabs().innerHTML).toBe(flat);

    // The horizontal strip never becomes a tree, groups or not.
    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    app._applyTabLayout(layout);
    expect(tabs().getAttribute('role')).toBe('tablist');
    expect(tabs().querySelectorAll('[role="treeitem"]')).toHaveLength(0);
  });

  it('nests group rows under their owning header with levels and positions', () => {
    const app = makeTreeApp();
    app._fullRenderSessionTabs();
    const header = document.querySelector<HTMLElement>('[data-tab-group-header="group-x"]')!;
    const group = document.getElementById(header.getAttribute('aria-owns')!)!;
    expect(group.getAttribute('role')).toBe('group');
    expect(
      [...group.querySelectorAll<HTMLElement>('[role="treeitem"]')].map((el) => el.dataset.webviewId || el.dataset.id)
    ).toEqual(['s2', 'w1', 's1']);
    const aria = (el: HTMLElement) => ['aria-level', 'aria-posinset', 'aria-setsize'].map((a) => el.getAttribute(a));
    // Level 1: the group header and the ungrouped row.
    expect(aria(header)).toEqual(['1', '1', '2']);
    expect(aria(row('s3'))).toEqual(['1', '2', '2']);
    expect(aria(row('s2'))).toEqual(['2', '1', '3']);
    expect(aria(row('w1'))).toEqual(['2', '2', '3']);
    expect(aria(row('s1'))).toEqual(['2', '3', '3']);
    // aria-selected follows the active row, exactly once.
    expect([...tabs().querySelectorAll('[aria-selected="true"]')].map((el) => (el as HTMLElement).dataset.id)).toEqual([
      's2',
    ]);
  });

  it('has exactly one tab stop, on the selected row, and no tabbable control inside rows', () => {
    const app = makeTreeApp();
    app._fullRenderSessionTabs();
    const stops = [...tabs().querySelectorAll<HTMLElement>('[tabindex="0"]')];
    expect(stops).toEqual([row('s2')]);
    const controls = [...tabs().querySelectorAll<HTMLElement>('.session-tab button, .session-tab [tabindex]')];
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((el) => el.tabIndex === -1)).toBe(true);

    // Collapse keeps a single stop (the selection stays visible as a level-1 item).
    app.toggleTabGroupCollapsed('group-x', true);
    expect(tabs().querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(row('s2').getAttribute('aria-level')).toBe('1');
    expect(document.querySelector('[data-tab-group-header="group-x"]')!.hasAttribute('aria-owns')).toBe(false);
  });

  it('walks Up/Down/Home/End, collapses and enters groups with Left/Right, and activates with Enter/Space', () => {
    const app = makeTreeApp();
    app._fullRenderSessionTabs();
    row('s2').focus();
    press('ArrowUp');
    expect(focused()).toBe('group:group-x');
    press('ArrowUp');
    expect(focused()).toBe('s3');
    press('Home');
    expect(focused()).toBe('group:group-x');
    press('End');
    expect(focused()).toBe('s3');
    // An ungrouped row has no parent to climb to.
    expect(press('ArrowLeft')).toBe(true);
    expect(focused()).toBe('s3');

    row('w1').focus();
    press('Enter');
    expect(app.openWebview).toHaveBeenCalledWith('w1');
    row('s1').focus();
    press(' ');
    expect(app.selectSession).toHaveBeenCalledWith('s1', { forceReload: true });
    expect(app.selectSession).toHaveBeenCalledTimes(1);

    press('ArrowLeft');
    expect(focused()).toBe('group:group-x');
    press('ArrowLeft');
    expect(app.collapsedTabGroupIds.has('group-x')).toBe(true);
    // The header was re-rendered; focus and the tab stop moved to the new node.
    expect(focused()).toBe('group:group-x');
    expect(document.querySelector('[data-tab-group-header="group-x"]')!.getAttribute('tabindex')).toBe('0');
    press('ArrowRight');
    expect(app.collapsedTabGroupIds.has('group-x')).toBe(false);
    expect(focused()).toBe('group:group-x');
    press('ArrowRight');
    expect(focused()).toBe('s2');
    press('Home');
    press('Enter');
    expect(app.collapsedTabGroupIds.has('group-x')).toBe(true);
    // The header was rebuilt by the toggle; focus followed it, never to <body>.
    expect(focused()).toBe('group:group-x');
    expect(tabs().querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it('leaves keys pressed on a control inside a row to that control', () => {
    const app = makeTreeApp();
    app._fullRenderSessionTabs();
    // The overflow button gets focus from a click, or back from its action menu.
    const more = row('s2').querySelector<HTMLElement>('.tab-more')!;
    more.focus();
    expect(press('Enter')).toBe(true);
    expect(press(' ')).toBe(true);
    expect(press('ArrowDown')).toBe(true);
    expect(press('ArrowLeft')).toBe(true);
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.collapsedTabGroupIds.size).toBe(0);
    expect(document.activeElement).toBe(more);
  });

  it('treats a group with no open rows as a leaf that Left/Right cannot open or close', () => {
    const app = makeTreeApp({
      tabLayout: { ...layout, groups: [...layout.groups, { id: 'empty', name: 'Empty', refs: [] }] },
    });
    app._fullRenderSessionTabs();
    const header = document.querySelector<HTMLElement>('[data-tab-group-header="empty"]')!;
    expect(header.hasAttribute('aria-expanded')).toBe(false);
    expect(header.hasAttribute('aria-owns')).toBe(false);
    header.focus();
    press('ArrowRight');
    press('ArrowLeft');
    expect(app.collapsedTabGroupIds.size).toBe(0);
    expect(focused()).toBe('group:empty');
  });

  it('keeps tree positions in painted order when the sorted rail re-sorts rows in place', () => {
    const app = makeTreeApp();
    document.documentElement.dataset.tabRailSort = 'activity';
    let order = new Map([
      ['s2', 0],
      ['s1', 1],
      ['s3', 2],
    ]);
    app._tabRailSortOrder = () => order;
    app._fullRenderSessionTabs();
    row('w1').style.order = '9999'; // styles.css pins web tabs last; JSDOM loads no stylesheet
    app._applyTabTreePositions(tabs());
    const pos = (id: string) => row(id).getAttribute('aria-posinset');
    expect([pos('s2'), pos('s1'), pos('w1')]).toEqual(['1', '2', '3']);

    // s1 goes working: the incremental pass moves its card up with `order` only.
    const full = vi.spyOn(app, '_fullRenderSessionTabs');
    order = new Map([
      ['s1', 0],
      ['s2', 1],
      ['s3', 2],
    ]);
    app._renderSessionTabsImmediate();
    expect(full).not.toHaveBeenCalled();
    expect(row('s1').style.order).toBe('0');
    expect([pos('s1'), pos('s2'), pos('w1')]).toEqual(['1', '2', '3']);
    expect(row('s1').getAttribute('aria-setsize')).toBe('3');
  });

  it('exempts tree items from the touch keyboard dismissal, like every other control', () => {
    // terminal-ui.js publishes the selector on window.CodemanTerminalInput; its
    // top level only needs a window and a CodemanApp prototype to assign to.
    const context = vm.createContext({ window: {}, CodemanApp: function CodemanApp() {} });
    vm.runInContext(readFileSync(join(PUBLIC, 'terminal-ui.js'), 'utf8'), context);
    const selector = (context.window as any).CodemanTerminalInput.MOBILE_KEYBOARD_DISMISS_EXEMPT_SELECTOR as string;

    const app = makeTreeApp();
    app._fullRenderSessionTabs();
    const header = document.querySelector<HTMLElement>('[data-tab-group-header="group-x"]')!;
    // The roving stop sits on s2: the header and the other rows are tabindex=-1.
    expect(header.tabIndex).toBe(-1);
    expect(row('s1').tabIndex).toBe(-1);
    for (const target of [header, header.querySelector('.tab-layout-group-name')!, row('s1'), row('w1')]) {
      expect(target.closest(selector), (target as HTMLElement).className).not.toBeNull();
    }
    // Inert rail chrome still dismisses.
    expect(document.querySelector('.tab-layout-ungrouped-header')!.closest(selector)).toBeNull();
  });

  it('opens row actions from the keyboard, since its controls left the tab order', () => {
    const app = makeTreeApp();
    app._fullRenderSessionTabs();
    row('s2').focus();
    press('F10', { shiftKey: true });
    expect(app.openTabRailActionMenu).toHaveBeenCalledWith(expect.objectContaining({ currentTarget: row('s2') }), 's2');
    row('w1').focus();
    press('ContextMenu');
    expect(app.showWebviewModal).toHaveBeenCalledWith('w1');
    press('F10');
    expect(app.showWebviewModal).toHaveBeenCalledTimes(1);
  });

  it('restores focus by identity across a background rebuild and follows pointer focus', () => {
    const app = makeTreeApp();
    app._fullRenderSessionTabs();
    row('w1').focus();
    app._fullRenderSessionTabs();
    expect(focused()).toBe('w1');
    expect([...tabs().querySelectorAll('[tabindex="0"]')]).toEqual([row('w1')]);

    // Focus arriving by pointer (or any other route) takes the tab stop with it.
    row('s3').focus();
    expect([...tabs().querySelectorAll('[tabindex="0"]')]).toEqual([row('s3')]);

    // A rebuild never pulls focus into the rail when it was elsewhere.
    (document.activeElement as HTMLElement).blur();
    app._fullRenderSessionTabs();
    expect(document.activeElement).toBe(document.body);
  });

  it('keeps aria-selected in step when the selection changes without a rebuild', () => {
    const app = makeTreeApp();
    app._fullRenderSessionTabs();
    const full = vi.spyOn(app, '_fullRenderSessionTabs');
    app.activeSessionId = 's1';
    app._updateActiveTabImmediate('s1');
    expect(full).not.toHaveBeenCalled();
    expect([...tabs().querySelectorAll('[aria-selected="true"]')].map((el) => (el as HTMLElement).dataset.id)).toEqual([
      's1',
    ]);
  });

  it('walks a sorted rail in painted order: per group in the tree, across the list when flat', () => {
    const app = makeTreeApp();
    app._fullRenderSessionTabs();
    document.documentElement.dataset.tabRailSort = 'activity';
    row('s1').style.order = '0';
    row('s2').style.order = '1';
    row('w1').style.order = '9999';
    row('s3').style.order = '2';
    document.querySelector<HTMLElement>('[data-tab-group-header="group-x"]')!.focus();
    const walk = () =>
      Array.from({ length: 4 }, () => {
        press('ArrowDown');
        return focused();
      });
    expect(walk()).toEqual(['s1', 's2', 'w1', 's3']);

    const flat = makeTreeApp({ tabLayout: null });
    flat._fullRenderSessionTabs();
    document.documentElement.dataset.tabRailSort = 'activity';
    row('s1').style.order = '2';
    row('s2').style.order = '0';
    row('s3').style.order = '1';
    row('w1').style.order = '9999'; // styles.css pins web tabs last; JSDOM loads no stylesheet
    row('s2').focus();
    expect(
      Array.from({ length: 3 }, () => {
        press('ArrowDown');
        return focused();
      })
    ).toEqual(['s3', 's1', 'w1']);
  });
});

describe('flat list keyboard activation', () => {
  it('opens a web tab with Enter/Space instead of selecting an undefined session', () => {
    const app = makeApp({ tabLayout: null });
    app.selectSession = vi.fn();
    app.openWebview = vi.fn();
    app._fullRenderSessionTabs();
    const web = document.querySelector<HTMLElement>('[data-webview-id="w1"]')!;
    web.focus();
    web.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    web.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(app.openWebview).toHaveBeenCalledTimes(2);
    expect(app.selectSession).not.toHaveBeenCalled();

    const s2 = document.querySelector<HTMLElement>('[data-id="s2"]')!;
    s2.focus();
    s2.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(app.selectSession).toHaveBeenCalledWith('s2', { forceReload: true });
  });
});
