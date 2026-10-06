/**
 * @fileoverview Tab grouping by state (`tabArrangement: 'state'`, Discussion #426
 * option C): the pure layout in constants.js and the render paths in app.js.
 *
 * What is pinned, and why it matters:
 *  - The four groups and their order (needs you, waiting, working, idle) and
 *    which home-screen state lands in which, including the two folds that are
 *    easy to get wrong: a failed session joins "needs you", and an agent that
 *    exited inside a live pane (#446) is idle even while its status says busy.
 *  - It is applied as flex `order` only. The DOM stays in tab order, so Alt+N
 *    badges, drag and the keyboard walk keep reading the list they always read.
 *  - A state change is an INCREMENTAL pass: the tab element survives, only its
 *    `order` and the heading counts move, and a group that empties loses its
 *    heading.
 *  - `tabArrangement: 'classic'` leaves no trace (no headings, no inline order, no
 *    class), and named groups in the vertical rail win over it.
 *
 * The real modules run INSIDE a JSDOM window (runScripts: 'outside-only'), so
 * `document` below is that window's.
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

type Row = { id: string; state: string; exited?: boolean; pos?: number };
type Layout = {
  order: Map<string, number>;
  webOrder: Map<string, number>;
  groups: Array<{ key: string; label: string; count: number; headOrder: number; breakOrder: number }>;
};
type Triage = {
  GROUPS: Array<{ key: string; label: string }>;
  STRIDE: number;
  groupFor: (state: string, exited: boolean) => string;
  layout: (rows: Row[], webviewIds?: string[]) => Layout;
};

function loadTriage(): Triage {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
  return (context.window as { CodemanTabTriage: Triage }).CodemanTabTriage;
}

describe('CodemanTabTriage (pure)', () => {
  const triage = loadTriage();

  it('has four groups, most urgent first', () => {
    expect(triage.GROUPS.map((g) => g.key)).toEqual(['needs', 'waiting', 'working', 'idle']);
    expect(triage.GROUPS.map((g) => g.label)).toEqual(['Needs you', 'Waiting', 'Working', 'Idle']);
    // Only idle is quiet: it keeps a heading element but draws no label.
    expect(triage.GROUPS.filter((g) => (g as { quiet?: boolean }).quiet).map((g) => g.key)).toEqual(['idle']);
  });

  it('folds the six home-screen states into the four groups', () => {
    expect(triage.groupFor('needs', false)).toBe('needs');
    expect(triage.groupFor('error', false)).toBe('needs');
    expect(triage.groupFor('waiting', false)).toBe('waiting');
    expect(triage.groupFor('working', false)).toBe('working');
    expect(triage.groupFor('idle', false)).toBe('idle');
    expect(triage.groupFor('done', false)).toBe('idle');
    expect(triage.groupFor('something-new', false)).toBe('idle');
  });

  it('puts an exited agent with idle, never with working', () => {
    expect(triage.groupFor('working', true)).toBe('idle');
    expect(triage.groupFor('idle', true)).toBe('idle');
    // A human being blocked still outranks the agent having exited.
    expect(triage.groupFor('needs', true)).toBe('needs');
    expect(triage.groupFor('waiting', true)).toBe('waiting');
  });

  it('gives each group a band of order values and lists only non-empty groups', () => {
    const out = triage.layout([
      { id: 'a', state: 'idle', pos: 0 },
      { id: 'b', state: 'needs', pos: 1 },
      { id: 'c', state: 'idle', pos: 2 },
    ]);
    expect(out.groups.map((g) => [g.key, g.count])).toEqual([
      ['needs', 1],
      ['idle', 2],
    ]);
    const needs = out.groups[0];
    const idle = out.groups[1];
    expect(out.order.get('b')).toBeGreaterThan(needs.headOrder);
    expect(out.order.get('b')).toBeLessThan(needs.breakOrder);
    // Rows keep their relative position inside a group.
    expect(out.order.get('a')).toBeLessThan(out.order.get('c')!);
    expect(out.order.get('a')).toBeGreaterThan(idle.headOrder);
    // A heading opens its band, the break closes it, and bands never overlap.
    expect(needs.breakOrder).toBeLessThan(idle.headOrder);
    expect(Math.floor(out.order.get('b')! / triage.STRIDE)).toBe(Math.floor(needs.headOrder / triage.STRIDE));
  });

  it('ranks rows inside a group by `pos`, stably', () => {
    const out = triage.layout([
      { id: 'x', state: 'working', pos: 5 },
      { id: 'y', state: 'working', pos: 1 },
      { id: 'z', state: 'working', pos: 1 },
    ]);
    const sorted = [...out.order.entries()].sort((p, q) => p[1] - q[1]).map(([id]) => id);
    expect(sorted).toEqual(['y', 'z', 'x']);
  });

  it('closes the idle group with the web tabs and counts them', () => {
    const out = triage.layout([{ id: 's', state: 'idle', pos: 0 }], ['w1', 'w2']);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]).toMatchObject({ key: 'idle', count: 3 });
    expect(out.webOrder.get('w1')).toBeGreaterThan(out.order.get('s')!);
    expect(out.webOrder.get('w2')).toBeGreaterThan(out.webOrder.get('w1')!);
    expect(out.webOrder.get('w2')).toBeLessThan(out.groups[0].breakOrder);
  });

  it('turns the groups the other way up with reverse, rows unchanged inside them', () => {
    const rows = [
      { id: 'a', state: 'idle', pos: 0 },
      { id: 'b', state: 'needs', pos: 1 },
      { id: 'c', state: 'working', pos: 2 },
      { id: 'd', state: 'working', pos: 3 },
    ];
    const out = triage.layout(rows, ['w1'], { reverse: true });
    expect(out.groups.map((g) => g.key)).toEqual(['idle', 'working', 'needs']);
    const sorted = [...out.order.entries()].sort((p, q) => p[1] - q[1]).map(([id]) => id);
    expect(sorted).toEqual(['a', 'c', 'd', 'b']);
    // Web tabs still close the idle group, which now comes first.
    expect(out.webOrder.get('w1')).toBeLessThan(out.order.get('c')!);
    for (let i = 1; i < out.groups.length; i++) {
      expect(out.groups[i].headOrder).toBeGreaterThan(out.groups[i - 1].breakOrder);
    }
  });

  it('shows the idle group for web tabs alone, and nothing for nothing', () => {
    expect(triage.layout([], ['w1']).groups.map((g) => g.key)).toEqual(['idle']);
    expect(triage.layout([], []).groups).toEqual([]);
    expect(triage.layout(undefined as unknown as Row[], undefined).groups).toEqual([]);
  });
});

describe('tab grouping in the render paths (app.js)', () => {
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
        '\n;window.__TriageCodemanApp = CodemanApp;'
    );
    CodemanApp = window.__TriageCodemanApp;
  });

  function makeApp(arrangement: 'state' | 'case' | 'ledger' | 'classic' = 'state') {
    const app = Object.create(CodemanApp.prototype) as Record<string, any>;
    const root = document.documentElement;
    root.setAttribute('data-tab-orientation', 'horizontal');
    root.dataset.tabRailSort = 'activity';
    root.dataset.tabArrangement = arrangement;
    delete root.dataset.tabStateOrder;
    document.body.innerHTML = '<div class="session-tabs-host"><div id="sessionTabs" class="session-tabs"></div></div>';
    app.$ = (id: string) => document.getElementById(id);
    app.sessions = new Map([
      ['s1', { id: 's1', name: 'w1-alpha', status: 'idle' }],
      ['s2', { id: 's2', name: 'w2-beta', status: 'busy' }],
      ['s3', { id: 's3', name: 'w3-gamma', status: 'idle' }],
      ['s4', { id: 's4', name: 'w4-delta', status: 'busy' }],
    ]);
    app.sessionOrder = ['s1', 's2', 's3', 's4'];
    app.pendingHooks = new Map([
      ['s3', new Set(['permission_prompt'])],
      ['s1', new Set(['idle_prompt'])],
    ]);
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
  const orderOf = (el: HTMLElement) => Number(el.style.order);
  /** What the eye sees: every ordered child, by `order`, as `head:<key>` / `<id>`. */
  const visual = () =>
    [...container().children]
      .filter((el) => !(el as HTMLElement).classList.contains('tab-triage-break'))
      .sort((a, b) => orderOf(a as HTMLElement) - orderOf(b as HTMLElement))
      .map((el) => {
        const h = el as HTMLElement;
        if (h.classList.contains('tab-triage-head')) return `head:${h.dataset.triageGroup}`;
        return h.dataset.webviewId ? `web:${h.dataset.webviewId}` : h.dataset.id!;
      });
  const heads = () =>
    [...container().querySelectorAll<HTMLElement>(':scope > .tab-triage-head')]
      .sort((a, b) => orderOf(a) - orderOf(b))
      .map((h) =>
        h.classList.contains('tab-triage-head--quiet')
          ? `${h.dataset.triageGroup}:quiet`
          : `${h.querySelector('.tab-triage-label')!.textContent}:${h.querySelector('.tab-triage-count')!.textContent}`
      );

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('draws a heading per non-empty state and places every tab in its group', () => {
    makeApp()._fullRenderSessionTabs();
    expect(container().classList.contains('tabs-triage')).toBe(true);
    expect(heads()).toEqual(['Needs you:1', 'Waiting:1', 'Working:2', 'idle:quiet']);
    // The idle row keeps its heading as an anchor, with nothing drawn in it.
    expect(container().querySelector('.tab-triage-head[data-triage-group="idle"]')!.textContent).toBe('');
    expect(visual()).toEqual([
      'head:needs',
      's3',
      'head:waiting',
      's1',
      'head:working',
      's2',
      's4',
      'head:idle',
      'web:w1',
    ]);
    // One row break per heading; headings and breaks stay out of the tablist.
    expect(container().querySelectorAll(':scope > .tab-triage-break')).toHaveLength(4);
    for (const el of container().querySelectorAll(':scope > .tab-triage-head, :scope > .tab-triage-break')) {
      expect(el.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it("puts needs you in the bottom row with tabStateOrder 'urgent-last'", () => {
    const app = makeApp();
    document.documentElement.dataset.tabStateOrder = 'urgent-last';
    app._fullRenderSessionTabs();
    expect(heads()).toEqual(['idle:quiet', 'Working:2', 'Waiting:1', 'Needs you:1']);
    expect(visual()).toEqual([
      'head:idle',
      'web:w1',
      'head:working',
      's2',
      's4',
      'head:waiting',
      's1',
      'head:needs',
      's3',
    ]);
  });

  it('marks the first row heading as the lead, in either state order', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    const lead = () =>
      [...container().querySelectorAll<HTMLElement>(':scope > .tab-triage-head--lead')].map((h) => h.dataset.triageGroup);
    expect(lead()).toEqual(['needs']);
    document.documentElement.dataset.tabStateOrder = 'urgent-last';
    app._renderSessionTabsImmediate();
    expect(lead()).toEqual(['idle']);
  });

  it('keeps the DOM, and with it the Alt+N badges, in tab order', () => {
    makeApp()._fullRenderSessionTabs();
    const domOrder = [...container().querySelectorAll<HTMLElement>('.session-tab[data-id]')].map((t) => t.dataset.id);
    expect(domOrder).toEqual(['s1', 's2', 's3', 's4']);
    expect(tab('s3').querySelector('.tab-number')?.textContent).toBe('3');
  });

  it('moves a tab between groups on an incremental pass, without rebuilding it', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    const s2 = tab('s2');
    const fullRender = vi.spyOn(app, '_fullRenderSessionTabs');
    // s2 finishes its turn; the dialog on s3 is answered.
    app.sessions.get('s2').status = 'idle';
    app.pendingHooks.delete('s3');
    app._renderSessionTabsImmediate();
    expect(fullRender).not.toHaveBeenCalled();
    expect(tab('s2')).toBe(s2);
    expect(heads()).toEqual(['Waiting:1', 'Working:1', 'idle:quiet']);
    expect(container().querySelector('.tab-triage-head[data-triage-group="needs"]')).toBeNull();
    expect(container().querySelector('.tab-triage-break[data-triage-group="needs"]')).toBeNull();
    expect(visual()).toEqual(['head:waiting', 's1', 'head:working', 's4', 'head:idle', 's2', 's3', 'web:w1']);
  });

  it('reconciles headings in place: an unchanged pass rewrites nothing', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    app._renderSessionTabsImmediate();
    const head = container().querySelector('.tab-triage-head[data-triage-group="working"]');
    app._renderSessionTabsImmediate();
    expect(container().querySelector('.tab-triage-head[data-triage-group="working"]')).toBe(head);
    expect(container().querySelectorAll(':scope > .tab-triage-head')).toHaveLength(4);
  });

  it('files an agent that exited in a live pane under idle, a failed session under needs you', () => {
    const app = makeApp();
    app.pendingHooks = new Map();
    app.sessions.get('s2').paneExit = { at: 1, status: 0 };
    app.sessions.get('s1').status = 'error';
    app._fullRenderSessionTabs();
    expect(visual()).toEqual(['head:needs', 's1', 'head:working', 's4', 'head:idle', 's2', 's3', 'web:w1']);
  });

  it("leaves no trace with tabArrangement 'classic'", () => {
    makeApp('classic')._fullRenderSessionTabs();
    expect(container().classList.contains('tabs-triage')).toBe(false);
    expect(container().querySelector('.tab-triage-head, .tab-triage-break')).toBeNull();
    expect(container().innerHTML).not.toContain('order:');
    expect(container().querySelector<HTMLElement>('.session-tab[data-webview-id]')!.style.order).toBe('');
  });

  it('switching off removes the headings and every inline order it wrote', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    document.documentElement.dataset.tabArrangement = 'classic';
    app._renderSessionTabsImmediate();
    expect(container().querySelector('.tab-triage-head, .tab-triage-break')).toBeNull();
    for (const el of container().querySelectorAll<HTMLElement>('.session-tab')) expect(el.style.order).toBe('');
    expect(container().classList.contains('tabs-triage')).toBe(false);
  });

  it('ranks rows inside each section by the activity sort on a sorted rail', () => {
    const app = makeApp();
    document.documentElement.setAttribute('data-tab-orientation', 'vertical');
    app.pendingHooks = new Map();
    // Both working; s4 has been running longer, so the activity sort puts it first.
    app.sessions.get('s2').lastSubmitAt = 2_000;
    app.sessions.get('s4').lastSubmitAt = 1_000;
    app._fullRenderSessionTabs();
    expect(visual()).toEqual(['head:working', 's4', 's2', 'head:idle', 's1', 's3', 'web:w1']);
  });

  it('keeps tab order inside each row on the header strip', () => {
    const app = makeApp();
    app.pendingHooks = new Map();
    app.sessions.get('s2').lastSubmitAt = 2_000;
    app.sessions.get('s4').lastSubmitAt = 1_000;
    app._fullRenderSessionTabs();
    expect(visual()).toEqual(['head:working', 's2', 's4', 'head:idle', 's1', 's3', 'web:w1']);
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
    expect(container().classList.contains('tabs-triage')).toBe(false);
    expect(container().querySelector('.tab-triage-head')).toBeNull();
  });

  it('refuses a drop into another group and allows one inside the same group', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    app.draggedTabId = 's2';
    expect(app._isTabDropAcrossGroups(tab('s4'))).toBe(false);
    expect(app._isTabDropAcrossGroups(tab('s1'))).toBe(true);
    expect(app._isTabDropAcrossGroups(tab('s3'))).toBe(true);
    document.documentElement.dataset.tabArrangement = 'classic';
    app._fullRenderSessionTabs();
    expect(app._isTabDropAcrossGroups(tab('s1'))).toBe(false);
  });

  it('degrades to the flat strip when mobile-overview.js is stale or missing', () => {
    const app = makeApp();
    app._mobileOverviewState = undefined;
    app._fullRenderSessionTabs();
    expect(container().querySelector('.tab-triage-head')).toBeNull();
    expect(container().classList.contains('tabs-triage')).toBe(false);
  });
});

describe('tab grouping wiring (static)', () => {
  const html = read('index.html');
  const css = read('styles.css');
  const mobileCss = read('mobile.css');

  it('stamps data-tab-arrangement and data-tab-state-order before first paint', () => {
    expect(html).toContain(
      "dataset.tabArrangement=(T==='case'||T==='ledger'||T==='classic')?T:'state'"
    );
    expect(html).toContain("dataset.tabStateOrder=(A.tabStateOrder==='urgent-last')?'urgent-last':'urgent-first'");
    // The catch branch (localStorage threw) must set both too.
    expect(html).toContain(
      "document.documentElement.dataset.tabArrangement='state';document.documentElement.dataset.tabStateOrder='urgent-first';"
    );
  });

  it('offers the four layouts with "By state" as the default, and the state order', () => {
    expect(html).toMatch(
      /<select id="appSettingsTabArrangement"[^>]*>\s*<option value="state">By state \(default\)<\/option>\s*<option value="case">[^<]+<\/option>\s*<option value="ledger">[^<]+<\/option>\s*<option value="classic">Classic \(as before\)<\/option>/
    );
    expect(html).toMatch(
      /<select id="appSettingsTabStateOrder"[^>]*>\s*<option value="urgent-first">Needs you on top \(default\)<\/option>\s*<option value="urgent-last">/
    );
  });

  it('only shows row breaks in a wrapping header strip', () => {
    expect(css).toMatch(/\.tab-triage-break \{\s*display: none;/);
    expect(css).toContain(
      '.session-tabs-host > .session-tabs.tabs-triage:is(.tabs-auto-wrap, .tabs-two-rows) > .tab-triage-break'
    );
  });

  it('lets the rows after the first start under the brand, labels left-aligned', () => {
    expect(css).toMatch(
      /\.header:has\(> \.session-tabs-host > \.session-tabs\.tabs-triage:is\(\.tabs-auto-wrap, \.tabs-two-rows\)\) > \.header-brand \{\s*position: absolute;/
    );
    expect(css).toMatch(/> \.tab-triage-head \{\s*justify-content: flex-start;/);
    expect(css).toMatch(
      /> \.tab-triage-head--lead \{\s*width: auto;\s*margin-left: calc\(var\(--tab-triage-brand, 100px\) - var\(--tab-triage-gutter, 92px\)\);/
    );
  });

  it('hides the headings on phones, whose strip stays one scrolling row', () => {
    expect(mobileCss).toMatch(/:where\(\.header\) \.tab-triage-head \{\s*display: none;/);
  });
});
