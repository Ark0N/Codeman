/**
 * @fileoverview The vertical tab rail's row ORDER and its card styling.
 *
 * The rail lists exactly the sessions both home screens list (the phone
 * overview and the desktop home rail), so it now answers their question the
 * same way: `CodemanSessionOrder` (constants.js) puts whatever is blocked on a
 * human first, then whatever has been running longest, then the most recently
 * quiet. Three things about that can go wrong silently and are pinned here.
 *
 * 1. THE ROW MODEL. The comparator reads `state` plus two raw stamps, and a
 *    WORKING row is ranked by `lastSubmitAt` rather than `lastActivityAt`
 *    (a working pane repaints about once a second, so its last-activity stamp
 *    is always "now"). Dropping `lastSubmitAt` from the row would not throw and
 *    would not fail a rendering test — every running turn would just quietly
 *    rank as freshly started.
 *
 * 2. THE ALT+N BADGE. The sort is applied as the flex `order` property while
 *    the DOM stays in `sessionOrder`, which is what keeps the number badge
 *    honest: it names the Alt+N key, not the row's position, so it deliberately
 *    does NOT run 1,2,3 down a sorted rail.
 *
 * 3. THE OPT-OUT. A self-sorting list cannot also be drag-reorderable, so the
 *    drag affordance is dropped while sorting is on and `tabRailSort: 'manual'`
 *    is the way back. That decision lives in one place and must stay wired to
 *    the attribute the render paths read.
 *
 * Port: none (vm-loaded app.js + static source/markup assertions).
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const appJs = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
const html = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
const settingsUi = readFileSync(resolve(PUBLIC, 'settings-ui.js'), 'utf8');
const styles = readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8');

/** The rail's rich-row scope, spelled exactly as styles.css must spell it. */
const RAIL_RICH = "html[data-tab-orientation='vertical'][data-tab-rail-detail='rich']:not(.tab-rail-compact) .tab-rail";

/** The <html> element the vm's app.js reads. Mutable, so the REAL gate runs. */
type Root = { dataset: Record<string, string>; getAttribute: (name: string) => string | null };

/**
 * Load app.js + mobile-overview.js in one vm context, so `_tabRailSortOrder()`
 * runs against the REAL `_mobileOverviewState()` rather than a copy of it that
 * could drift. Same stubbing technique as session-close-fallback.test.ts, plus a
 * writable `document.documentElement`: `isTabRailSorted()` reads the layout off
 * <html>, and stubbing THAT out on the instance would leave the shipped gate
 * untested while these assertions kept passing.
 */
function loadCodemanAppClass(): { CodemanApp: new () => unknown; root: Root } {
  const attrs: Record<string, string> = {};
  const root: Root = { dataset: {}, getAttribute: (name: string) => attrs[name] ?? null };
  Object.defineProperty(root, '__attrs', { value: attrs });
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: vi.fn(),
    document: {
      addEventListener: vi.fn(),
      getElementById: () => null,
      querySelector: () => null,
      documentElement: root,
    },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: { isTouchDevice: () => false, getDeviceType: () => 'desktop' },
  });
  const read = (f: string) => readFileSync(resolve(PUBLIC, f), 'utf8');
  vm.runInContext(
    `${read('constants.js')}\n${read('app.js')}\n${read('mobile-overview.js')}\nglobalThis.__CodemanApp = CodemanApp;`,
    context
  );
  return { CodemanApp: (context as { __CodemanApp: new () => unknown }).__CodemanApp, root };
}

const { CodemanApp, root: railRoot } = loadCodemanAppClass();

/** Point the shared <html> stub at one rail configuration. */
function setLayout(attrs: Record<string, string>): void {
  const raw = (railRoot as unknown as { __attrs: Record<string, string> }).__attrs;
  for (const key of Object.keys(raw)) delete raw[key];
  for (const key of Object.keys(railRoot.dataset)) delete railRoot.dataset[key];
  raw['data-tab-orientation'] = attrs['data-tab-orientation'] ?? 'vertical';
  railRoot.dataset.tabRailSort = attrs.tabRailSort ?? 'activity';
  railRoot.dataset.tabRailDetail = attrs.tabRailDetail ?? 'rich';
}

type Row = {
  id: string;
  status?: string;
  lastActivityAt?: number;
  lastSubmitAt?: number;
  hooks?: string[];
};

type RailApp = {
  isTabRailSorted: () => boolean;
  _tabRailSortOrder: (ids: string[]) => Map<string, number> | null;
};

/**
 * Instance with the two inputs the order needs real (`sessions`,
 * `pendingHooks`); the rail gate answers from the shared <html> stub, so the
 * shipped `isTabRailSorted()` is what decides.
 */
function makeApp(rows: Row[], attrs: Record<string, string> = {}): RailApp {
  setLayout(attrs);
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as RailApp & Record<string, unknown>;
  app.sessions = new Map(rows.map((r) => [r.id, { ...r, mode: 'claude' }]));
  app.pendingHooks = new Map(rows.filter((r) => r.hooks).map((r) => [r.id, new Set(r.hooks)]));
  return app;
}

/** Visual positions keyed by id, for readable assertions. */
function positions(app: RailApp, ids: string[]): Record<string, number> | null {
  const map = app._tabRailSortOrder(ids);
  if (!map) return null;
  return Object.fromEntries(map);
}

const NOW = 1_700_000_000_000;
const minsAgo = (m: number) => NOW - m * 60_000;

describe('vertical tab rail row order', () => {
  it('puts a blocked session first, longest-blocked ahead of the newest block', () => {
    const ids = ['fresh-block', 'old-block', 'quiet'];
    const app = makeApp([
      { id: 'fresh-block', status: 'idle', lastActivityAt: minsAgo(1), hooks: ['permission_prompt'] },
      { id: 'old-block', status: 'idle', lastActivityAt: minsAgo(30), hooks: ['permission_prompt'] },
      { id: 'quiet', status: 'idle', lastActivityAt: minsAgo(2) },
    ]);
    expect(positions(app, ids)).toEqual({ 'old-block': 0, 'fresh-block': 1, quiet: 2 });
  });

  it('ranks a running session by its last Enter, not by the repaint it just did', () => {
    // Both panes printed a byte a moment ago, which is what a working pane does
    // about once a second. Only lastSubmitAt says which turn actually started
    // first, so reading lastActivityAt here would call this a tie and fall
    // through to tab order — silently, and in the wrong direction.
    const ids = ['short-turn', 'long-turn'];
    const app = makeApp([
      { id: 'short-turn', status: 'busy', lastActivityAt: minsAgo(0), lastSubmitAt: minsAgo(2) },
      { id: 'long-turn', status: 'busy', lastActivityAt: minsAgo(0), lastSubmitAt: minsAgo(40) },
    ]);
    expect(positions(app, ids)).toEqual({ 'long-turn': 0, 'short-turn': 1 });
  });

  it('flips the tiebreak for quiet sessions: most recently quiet first', () => {
    const ids = ['yesterday', 'just-finished'];
    const app = makeApp([
      { id: 'yesterday', status: 'idle', lastActivityAt: minsAgo(1440) },
      { id: 'just-finished', status: 'idle', lastActivityAt: minsAgo(1) },
    ]);
    expect(positions(app, ids)).toEqual({ 'just-finished': 0, yesterday: 1 });
  });

  it('orders the whole fleet blocked → running → quiet', () => {
    const ids = ['idle-a', 'working', 'needs', 'waiting', 'idle-b'];
    const app = makeApp([
      { id: 'idle-a', status: 'idle', lastActivityAt: minsAgo(2) },
      { id: 'working', status: 'busy', lastActivityAt: minsAgo(0), lastSubmitAt: minsAgo(12) },
      { id: 'needs', status: 'idle', lastActivityAt: minsAgo(5), hooks: ['permission_prompt'] },
      { id: 'waiting', status: 'idle', lastActivityAt: minsAgo(3), hooks: ['idle_prompt'] },
      { id: 'idle-b', status: 'idle', lastActivityAt: minsAgo(90) },
    ]);
    expect(positions(app, ids)).toEqual({ needs: 0, waiting: 1, working: 2, 'idle-a': 3, 'idle-b': 4 });
  });

  it('returns no order at all when the rail is horizontal or set to manual', () => {
    const rows: Row[] = [{ id: 'a', status: 'idle', lastActivityAt: minsAgo(1) }];
    const horizontal = makeApp(rows, { 'data-tab-orientation': 'horizontal' });
    expect(horizontal.isTabRailSorted()).toBe(false);
    expect(horizontal._tabRailSortOrder(['a'])).toBeNull();
    const manual = makeApp(rows, { tabRailSort: 'manual' });
    expect(manual.isTabRailSorted()).toBe(false);
    expect(manual._tabRailSortOrder(['a'])).toBeNull();
    expect(makeApp(rows).isTabRailSorted()).toBe(true);
  });

  it('sorts a SIMPLE rail too — it lists the same sessions, it just says less', () => {
    const ids = ['quiet', 'blocked'];
    const app = makeApp(
      [
        { id: 'quiet', status: 'idle', lastActivityAt: minsAgo(1) },
        { id: 'blocked', status: 'idle', lastActivityAt: minsAgo(9), hooks: ['permission_prompt'] },
      ],
      { tabRailDetail: 'simple' }
    );
    expect(positions(app, ids)).toEqual({ blocked: 0, quiet: 1 });
  });

  it('keeps the Alt+N badge on the tab index while the cards are sorted', () => {
    // `_tabIdx` counts the loop over sessionOrder, and only `style="order:…"`
    // moves the card — so the badge names a shortcut, not a row position.
    expect(appJs).toContain(
      'const railSortOrder = this._tabRailSortOrder(tabOrder.filter((id) => this.sessions.has(id)));'
    );
    expect(appJs).toContain('` style="order:${railSortOrder.get(id)}"`');
    expect(appJs).toMatch(/_tabIdx < 9 \? '<span class="tab-number">' \+ \(_tabIdx \+ 1\)/);
    // The loop itself still walks the user's order, which is what makes the
    // badge, drag-and-drop and the arrow-key walk agree with each other.
    expect(appJs).toContain('const tabOrder = this.sessionOrder;');
  });

  it('re-applies the order from the incremental path, since a state change adds no tab', () => {
    // A session going working→idle never adds or removes a tab, so the full
    // rebuild is not reached — and a rebuild here would restart every card's
    // animation on every SSE tick anyway.
    expect(appJs).toContain(
      'const railSortOrder = this._tabRailSortOrder(this.sessionOrder.filter((sid) => this.sessions.has(sid)));'
    );
    expect(appJs).toContain('if (tab.style.order !== railOrder) tab.style.order = railOrder;');
    // An empty string is what clears the property when the rail stops sorting.
    expect(appJs).toContain("const railOrder = railSortOrder?.has(id) ? String(railSortOrder.get(id)) : '';");
  });

  it('drops the drag affordance while sorting, so a card cannot snap back', () => {
    const drag = appJs.slice(appJs.indexOf('setupTabDragHandlers() {'));
    expect(drag.indexOf('if (this.isTabRailSorted()) {')).toBeLessThan(
      drag.indexOf("tab.setAttribute('draggable', 'true')")
    );
    expect(drag).toContain("tabs.forEach((tab) => tab.setAttribute('draggable', 'false'));");
  });

  it('classifies and compares through the shared helpers, never a local copy', () => {
    const fn = appJs.slice(appJs.indexOf('_tabRailSortOrder(ids) {'), appJs.indexOf('_tabRailSortOrder(ids) {') + 1200);
    expect(fn).toContain('window.CodemanSessionOrder.sort(rows)');
    expect(fn).toContain('this._mobileOverviewState(session, this.pendingHooks?.get(ids[i]))');
    // Both raw stamps, or the comparator silently ranks every running turn as
    // freshly started (see the file header).
    expect(fn).toContain('lastActivityAt:');
    expect(fn).toContain('lastSubmitAt:');
    expect(fn).toContain('orderIndex: i');
    // Degrades to tab order rather than throwing when a cached constants.js or
    // mobile-overview.js is stale.
    expect(fn).toContain("!window.CodemanSessionOrder || typeof this._mobileOverviewState !== 'function'");
  });
});

describe('vertical tab rail sort setting', () => {
  it('accepts only the two documented values', () => {
    for (const v of ['activity', 'manual']) {
      expect(SettingsUpdateSchema.safeParse({ tabRailSort: v }).success).toBe(true);
    }
    for (const v of ['', 'auto', 'Activity', 1, true]) {
      expect(SettingsUpdateSchema.safeParse({ tabRailSort: v }).success).toBe(false);
    }
  });

  it('is a per-device display key with a control the load/save path can find', () => {
    expect(settingsUi).toContain("'tabRailSort'");
    expect(settingsUi).toContain("tabRailSort: 'activity',");
    expect(settingsUi).toContain("document.getElementById('appSettingsTabRailSort').value");
    expect(settingsUi).toContain("tabRailSort: document.getElementById('appSettingsTabRailSort').value,");
    expect(html).toContain('id="appSettingsTabRailSort"');
    expect(html).toContain('<option value="activity">');
    expect(html).toContain('<option value="manual">');
  });

  it('stamps the attribute before first paint and on every settings apply', () => {
    // Without the pre-paint stamp the rail renders unsorted for a frame and
    // then reshuffles, which is exactly the flash the other two rail attributes
    // are stamped there to avoid.
    expect(html).toContain(
      "document.documentElement.dataset.tabRailSort=(A.tabRailSort==='manual')?'manual':'activity';"
    );
    expect(html).toContain("document.documentElement.dataset.tabRailSort='activity';");
    expect(settingsUi).toContain('root.dataset.tabRailSort = sort;');
    // A sort flip leaves orientation on 'vertical' both times, so it has to
    // count as a change of its own or nothing re-renders.
    expect(settingsUi).toContain(
      'const changed = orientationChanged || previousDetail !== detail || previousSort !== sort;'
    );
  });
});

describe('vertical tab rail card styling', () => {
  it('gives detailed rail rows the home screen card, and only the rail', () => {
    const block = styles.slice(styles.indexOf(`${RAIL_RICH} .session-tabs {`));
    expect(block).toContain(`${RAIL_RICH} .session-tab {`);
    for (const decl of ['border-radius: 10px;', 'background: var(--bg-card);', 'flex-wrap: wrap;']) {
      expect(block.slice(0, 2000)).toContain(decl);
    }
    // The detailed SIDEBAR shares the meta line and must stay flat: every rule
    // in the card block is rail-scoped, never added to the comma-grouped
    // selectors that carry both surfaces.
    const cardBlock = block.slice(0, block.indexOf('/* --- Collapsed rail'));
    expect(cardBlock).not.toContain('.session-sidebar');
  });

  it('states read in the same three colours as both home screens', () => {
    const block = styles.slice(styles.indexOf(`${RAIL_RICH} .session-tabs {`));
    const cardBlock = block.slice(0, block.indexOf('/* --- Collapsed rail'));
    expect(cardBlock).toContain('.session-tab.tab-state-needs');
    expect(cardBlock).toContain('.session-tab.tab-state-waiting');
    expect(cardBlock).toContain('.session-tab.tab-state-working');
    // Reuses the home rail's keyframes rather than declaring a second pair that
    // could drift out of step with it.
    expect(cardBlock).toContain('home-sessions-blink-red');
    expect(cardBlock).toContain('home-sessions-blink-yellow');
  });

  it('never lets a state dot outrank the red/yellow alert dot', () => {
    // The dot rules are (0,5,1)+; the alert rules that mark a session blocked on
    // a human are only (0,3,0), so each state rule excludes them by hand.
    const block = styles.slice(styles.indexOf(`${RAIL_RICH} .session-tabs {`));
    const cardBlock = block.slice(0, block.indexOf('/* --- Collapsed rail'));
    const dotRules = cardBlock.match(/\.session-tab\.tab-state-\w+[^{]*\.tab-status\b/g) ?? [];
    expect(dotRules.length).toBeGreaterThanOrEqual(3);
    for (const rule of dotRules) {
      expect(rule).toContain(':not(.tab-alert-action):not(.tab-alert-idle)');
    }
  });

  it('pins web tabs past the sorted cards instead of interleaving them at order 0', () => {
    expect(styles).toContain(
      "html[data-tab-orientation='vertical'][data-tab-rail-sort='activity'] .tab-rail .session-tab[data-webview-id] {"
    );
  });
});
