/**
 * @fileoverview Tab layouts by case and ledger (`tabArrangement: 'case'` and
 * `'ledger'`, Discussion #426 options A and B).
 *
 * What is pinned, and why it matters:
 *  - By case, each case's tabs sit in ONE box, in the order the case first
 *    appears in the tab order, with a colour that is a pure function of the
 *    case (no storage, the same on every device).
 *  - Inside a box with company, a generated `w75-api-gateway` reads `w75`, but
 *    the full name stays in the DOM and in the accessible name; a custom or
 *    described name is never touched.
 *  - The Alt+N badges keep counting the tab order, and an incremental pass
 *    patches tabs in place unless the cluster structure changed.
 *  - Drag only reorders inside a box. Named groups in the vertical rail win.
 *  - The ledger changes no markup at all: it is a class on #sessionTabs and
 *    CSS scoped to the desktop header strip.
 *
 * The real modules run INSIDE a JSDOM window (runScripts: 'outside-only').
 *
 * Port: none.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = join(process.cwd(), 'src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');

type Cluster = { key: string; label: string; color: string; ids: string[] };
type Clusters = {
  COLORS: string[];
  colorFor: (key: string) => string;
  compute: (rows: Array<{ id: string; key: string; label: string }>) => Cluster[];
  nameSplit: (name: string, label: string) => { shown: string; hidden: string } | null;
};

function loadClusters(): Clusters {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
  return (context.window as { CodemanTabClusters: Clusters }).CodemanTabClusters;
}

describe('CodemanTabClusters (pure)', () => {
  const C = loadClusters();

  it('groups by case in first-appearance order, members in tab order', () => {
    const out = C.compute([
      { id: 'a', key: '/c/web', label: 'web' },
      { id: 'b', key: '/c/api', label: 'api' },
      { id: 'c', key: '/c/web', label: 'web' },
    ]);
    expect(out.map((c) => [c.key, c.ids])).toEqual([
      ['/c/web', ['a', 'c']],
      ['/c/api', ['b']],
    ]);
  });

  it('gives a session with no case a cluster of its own', () => {
    const out = C.compute([
      { id: 'a', key: '', label: '' },
      { id: 'b', key: '', label: '' },
    ]);
    expect(out.map((c) => c.ids)).toEqual([['a'], ['b']]);
  });

  it('colours a case from the session palette, the same way every time', () => {
    for (const key of ['/c/web', '/c/api', '/home/x/codeman-cases/long-name', '']) {
      expect(C.COLORS).toContain(C.colorFor(key));
      expect(C.colorFor(key)).toBe(C.colorFor(key));
    }
  });

  it('only shortens a generated name that carries this case', () => {
    expect(C.nameSplit('w75-api-gateway', 'api-gateway')).toEqual({ shown: 'w75', hidden: '-api-gateway' });
    expect(C.nameSplit('s2-API-Gateway', 'api-gateway')).toEqual({ shown: 's2', hidden: '-API-Gateway' });
    expect(C.nameSplit('w75-api-gateway', 'webshop')).toBeNull();
    expect(C.nameSplit('w3-x: fix login', 'x')).toBeNull();
    expect(C.nameSplit('DocsBot', 'docsbot')).toBeNull();
    expect(C.nameSplit('w1-webshop', '')).toBeNull();
  });
});

describe('tab layouts by case and ledger (app.js)', () => {
  let CodemanApp: { prototype: Record<string, any> };
  let window: any;
  let document: Document;

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
        read('mobile-overview.js') +
        '\n' +
        read('webview-tabs.js') +
        '\n;window.__ClusterCodemanApp = CodemanApp;'
    );
    CodemanApp = window.__ClusterCodemanApp;
  });

  function makeApp(arrangement: 'state' | 'case' | 'ledger' | 'classic' = 'case') {
    const app = Object.create(CodemanApp.prototype) as Record<string, any>;
    const root = document.documentElement;
    root.setAttribute('data-tab-orientation', 'horizontal');
    root.dataset.tabRailSort = 'activity';
    root.dataset.tabArrangement = arrangement;
    document.body.innerHTML = '<div class="session-tabs-host"><div id="sessionTabs" class="session-tabs"></div></div>';
    app.$ = (id: string) => document.getElementById(id);
    app.cases = [
      { name: 'webshop', path: '/c/webshop' },
      { name: 'api-gateway', path: '/c/api-gateway' },
    ];
    app.sessions = new Map([
      ['s1', { id: 's1', name: 'w1-webshop', status: 'idle', workingDir: '/c/webshop' }],
      ['s2', { id: 's2', name: 'w75-api-gateway', status: 'busy', workingDir: '/c/api-gateway' }],
      ['s3', { id: 's3', name: 'w3-webshop', status: 'idle', workingDir: '/c/webshop/sub' }],
      ['s4', { id: 's4', name: 'landing', status: 'idle', workingDir: '/srv/landing/' }],
      ['s5', { id: 's5', name: 'w4-webshop: fix login', status: 'busy', workingDir: '/c/webshop' }],
    ]);
    app.sessionOrder = ['s1', 's2', 's3', 's4', 's5'];
    app.pendingHooks = new Map();
    app.webviews = new Map([['w1', { id: 'w1', name: 'Dashboard', url: 'https://example.test' }]]);
    app.webviewOrder = ['w1'];
    app.activeSessionId = 's2';
    app.activeWebviewId = null;
    app.tabLayout = null;
    app.collapsedTabGroupIds = new Set();
    app._hiddenTabGroupByRef = new Map();
    app._lastTabGroupStructureKey = null;
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

  const container = () => document.getElementById('sessionTabs')!;
  const tab = (id: string) => container().querySelector<HTMLElement>(`.session-tab[data-id="${id}"]`)!;
  const boxes = () =>
    [...container().querySelectorAll<HTMLElement>(':scope > .tab-cluster')].map((box) => ({
      name: box.querySelector('.tab-cluster-name')?.textContent ?? null,
      count: box.querySelector('.tab-cluster-count')?.textContent ?? null,
      single: box.classList.contains('tab-cluster--single'),
      rows: [...box.querySelectorAll<HTMLElement>('.session-tab')].map(
        (t) => t.dataset.id || `web:${t.dataset.webviewId}`
      ),
    }));

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('puts each case in one box, in first-appearance order, a web tab in its own', () => {
    makeApp()._fullRenderSessionTabs();
    expect(container().classList.contains('tabs-clusters')).toBe(true);
    expect(boxes()).toEqual([
      // s3 sits in a subdirectory of the case and still joins it.
      { name: 'webshop', count: '3', single: false, rows: ['s1', 's3', 's5'] },
      { name: 'api-gateway', count: '1', single: true, rows: ['s2'] },
      // No case matches: the directory names the cluster, trailing slash and all.
      { name: 'landing', count: '1', single: true, rows: ['s4'] },
      { name: null, count: null, single: true, rows: ['web:w1'] },
    ]);
    for (const box of container().querySelectorAll<HTMLElement>(':scope > .tab-cluster:not(.tab-cluster--web)')) {
      expect(box.getAttribute('style')).toMatch(
        /^--cluster-color: var\(--session-(blue|green|purple|orange|pink|yellow|red)\)$/
      );
      expect(box.getAttribute('role')).toBe('presentation');
    }
  });

  it('drops the case from a generated name inside a box with company, and only there', () => {
    makeApp()._fullRenderSessionTabs();
    const nameOf = (id: string) => tab(id).querySelector('.tab-name')!;
    expect(nameOf('s1').innerHTML).toBe('w1<span class="tab-name-case">-webshop</span>');
    expect(nameOf('s1').textContent).toBe('w1-webshop');
    expect(tab('s1').getAttribute('aria-label')).toContain('w1-webshop');
    // A described name keeps its #232 treatment.
    expect(nameOf('s5').querySelector('.tab-name-prefix')?.textContent).toBe('w4-webshop: ');
    // Alone in its box, nothing is redundant, so nothing is hidden.
    expect(nameOf('s2').innerHTML).toBe('w75-api-gateway');
  });

  it('keeps the Alt+N badges on the tab order', () => {
    makeApp()._fullRenderSessionTabs();
    expect(tab('s3').querySelector('.tab-number')?.textContent).toBe('3');
    expect(tab('s2').querySelector('.tab-number')?.textContent).toBe('2');
    expect(container().querySelector('.session-tab[data-webview-id="w1"] .tab-number')?.textContent).toBe('6');
  });

  it('patches in place while the clusters stay the same, and rebuilds when they change', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    const s1 = tab('s1');
    const full = vi.spyOn(app, '_fullRenderSessionTabs');
    app.sessions.get('s1').status = 'busy';
    app._renderSessionTabsImmediate();
    expect(full).not.toHaveBeenCalled();
    expect(tab('s1')).toBe(s1);
    // s4 moves into the webshop case: a different box, so a full rebuild.
    app.sessions.get('s4').workingDir = '/c/webshop';
    app._renderSessionTabsImmediate();
    expect(full).toHaveBeenCalledTimes(1);
    expect(boxes()[0].rows).toEqual(['s1', 's3', 's4', 's5']);
  });

  it('only accepts a drop inside the same box', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    app.draggedTabId = 's1';
    expect(app._isTabDropAcrossGroups(tab('s3'))).toBe(false);
    expect(app._isTabDropAcrossGroups(tab('s2'))).toBe(true);
  });

  it('lets named groups in the vertical rail win', () => {
    const app = makeApp();
    document.documentElement.setAttribute('data-tab-orientation', 'vertical');
    app.tabLayout = {
      version: 1,
      groups: [{ id: 'g1', name: 'Core', refs: [{ kind: 'session', id: 's1' }] }],
      ungrouped: [],
    };
    app._fullRenderSessionTabs();
    expect(container().classList.contains('session-tabs--grouped')).toBe(true);
    expect(container().classList.contains('tabs-clusters')).toBe(false);
    expect(container().querySelector('.tab-cluster, .tab-name-case')).toBeNull();
  });

  it('switching back to classic leaves no boxes and no name splits', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    document.documentElement.dataset.tabArrangement = 'classic';
    app._renderSessionTabsImmediate();
    expect(container().querySelector('.tab-cluster, .tab-name-case')).toBeNull();
    expect(container().classList.contains('tabs-clusters')).toBe(false);
  });

  it('wraps the header strip when a case box wraps inside itself', () => {
    // A case wider than the strip wraps in its own box and never overflows, so
    // the measured auto-wrap alone would leave the strip unwrapped, and with it the
    // lineage routing room unreserved.
    const app = makeApp();
    app._fullRenderSessionTabs();
    Object.assign(app, {
      _syncLineageGutter: () => {},
      isSessionSidebarActive: () => false,
      loadAppSettingsFromStorage: () => ({ tabArrangement: 'case' }),
      getDefaultSettings: () => ({ tabTwoRows: false, tabOrientation: 'horizontal' }),
    });
    const webshop = [...container().querySelectorAll<HTMLElement>('[data-cluster-key="/c/webshop"] > .session-tab')];
    expect(webshop).toHaveLength(3);
    const place = (tops: number[]) =>
      webshop.forEach((el, i) => Object.defineProperty(el, 'offsetTop', { configurable: true, value: tops[i] }));
    const overflow = CodemanApp.prototype.updateTabOverflowMode;

    place([0, 0, 0]);
    overflow.call(app);
    expect(container().classList.contains('tabs-auto-wrap')).toBe(false);
    expect(app._tabClustersWrapInside(container())).toBe(false);

    place([0, 0, 38]);
    overflow.call(app);
    expect(app._tabClustersWrapInside(container())).toBe(true);
    expect(container().classList.contains('tabs-auto-wrap')).toBe(true);
  });

  it('draws the ledger with the classic markup and one class', () => {
    makeApp('classic')._fullRenderSessionTabs();
    const classic = container().innerHTML;
    makeApp('ledger')._fullRenderSessionTabs();
    expect(container().innerHTML).toBe(classic);
    expect(container().classList.contains('tabs-ledger')).toBe(true);
    expect(container().classList.contains('tabs-triage')).toBe(false);
  });
});

describe('tab layouts by case and ledger (static)', () => {
  const css = read('styles.css');
  const mobileCss = read('mobile.css');

  it('hides the case part of a name only in the clustered strip', () => {
    expect(css).toMatch(/\.session-tabs\.tabs-clusters \.tab-name-case \{\s*display: none;/);
  });

  it('keeps each case box its width on the desktop header strip, so the strip wraps box by box', () => {
    // Allowed to shrink, every box squeezed and wrapped inside itself at 1440px
    // (overlapping tab rows, the lineage routes through tabs and labels) and the
    // strip never overflowed, so it never wrapped.
    const media = css.indexOf(
      '@media (min-width: 768px) {\n  .session-tabs-host > .session-tabs.tabs-clusters > .tab-cluster {'
    );
    expect(media).toBeGreaterThan(-1);
    expect(css.slice(media, css.indexOf('}', media))).toContain('flex-shrink: 0;');
    // Only a case wider than the strip wraps inside its box.
    expect(css).toMatch(/\.session-tabs-host > \.session-tabs\.tabs-clusters > \.tab-cluster \{[^}]*max-width: 100%;/);
  });

  it('keeps the ledger to the desktop header strip', () => {
    const media = css.indexOf('@media (min-width: 768px) {\n  .session-tabs-host > .session-tabs.tabs-ledger {');
    expect(media).toBeGreaterThan(-1);
    // Every ledger rule lives inside that block.
    const before = css.slice(0, media);
    expect(before).not.toContain('.tabs-ledger');
  });

  it('keeps every ledger row one height and makes the active cell stand out', () => {
    const ledger = css.slice(
      css.indexOf('@media (min-width: 768px) {\n  .session-tabs-host > .session-tabs.tabs-ledger {')
    );
    expect(ledger).toContain('align-items: stretch;');
    expect(ledger).toContain('min-height: 30px;');
    expect(ledger).toMatch(
      /\.tabs-ledger > \.session-tab\.active \{[^}]*box-shadow: inset 0 0 0 1px var\(--accent\), inset 4px 0 0 var\(--accent\) !important;/
    );
  });

  it('dissolves the boxes into the one chip row on phones', () => {
    expect(mobileCss).toMatch(
      /:where\(\.header\) \.session-tabs-host > \.session-tabs\.tabs-clusters > \.tab-cluster \{\s*display: contents;/
    );
    expect(mobileCss).toMatch(/:where\(\.header\) \.tab-cluster-label \{\s*display: none;/);
  });
});
