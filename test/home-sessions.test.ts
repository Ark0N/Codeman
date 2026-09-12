// Port: none (pure model + static markup assertions — no browser, no server).
//
// The desktop home screen's tab column (src/web/public/home-sessions.js) fills
// the welcome overlay's left gutter. Two things about it can silently go wrong
// and are pinned here: the row ORDER (shared with the phone overview via
// CodemanSessionOrder, with the number badge still carrying the TAB index so
// Alt+N keeps working), and the WIDTH GATE, which lives in two places at once —
// the JS constant and a CSS media query — because the column is absolutely
// positioned and would overlap the search panel in a narrow window.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');

/** Minimal fake DOM node — enough surface for the programmatic row builders. */
function fakeElement(): any {
  const el: any = {
    className: '',
    type: '',
    title: '',
    textContent: '',
    dataset: {},
    style: {},
    children: [] as any[],
    setAttribute() {},
    appendChild(child: any) {
      el.children.push(child);
      return child;
    },
  };
  return el;
}

/**
 * home-sessions.js reuses `_mobileOverviewState` / `_mobileOverviewCaseFor` /
 * `shouldUseMobileOverview` from mobile-overview.js and the row comparator from
 * constants.js, so all three files run in the same context, which is also the
 * point: if that reuse ever breaks, these tests stop loading rather than
 * quietly testing a divergent copy.
 */
function loadHomeSessionsApp(overrides: Record<string, any> = {}, innerWidth = 1512, tabOrientation = 'horizontal') {
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({
    CodemanApp,
    console,
    window: { innerWidth },
    document: {
      documentElement: {
        getAttribute: (name: string) => (name === 'data-tab-orientation' ? tabOrientation : null),
      },
      getElementById: () => null,
      createElement: () => fakeElement(),
      createElementNS: () => fakeElement(),
    },
    MobileDetection: { getDeviceType: () => (innerWidth < 600 ? 'mobile' : 'desktop') },
  });
  for (const file of ['constants.js', 'mobile-overview.js', 'home-sessions.js']) {
    vm.runInContext(readFileSync(resolve(PUBLIC, file), 'utf8'), context, { filename: file });
  }

  const app = new (CodemanApp as any)();
  app.getSessionName = (session: any) => session.name || session.id.slice(0, 8);
  app._shortenHomePath = (p: string) => (p || '').replace(/^\/home\/[^/]+\//, '~/');
  app.loadAppSettingsFromStorage = () => ({});
  Object.assign(app, overrides);
  return app;
}

const CASES = [{ name: 'claudeman', path: '/home/arkon/default/claudeman', location: 'local' }];

function sessionMap(list: Array<Record<string, any>>) {
  return new Map(
    list.map((over) => {
      const s = { id: 'x', status: 'idle', mode: 'claude', workingDir: '/home/arkon/default/claudeman', ...over };
      return [s.id, s];
    })
  );
}

describe('home sessions column: model', () => {
  it('hoists a session blocked on you, and keeps its badge on the TAB index', () => {
    // The badge names the Alt+N shortcut, so a sorted rail shows 2,1,3 rather
    // than renumbering itself 1,2,3 and lying about which key selects what.
    const app = loadHomeSessionsApp({
      sessions: sessionMap([{ id: 'first' }, { id: 'needy' }, { id: 'third' }]),
      sessionOrder: ['first', 'needy', 'third'],
      cases: CASES,
      pendingHooks: new Map([['needy', new Set(['permission_prompt'])]]),
    });

    const rows = app.buildHomeSessionRows();
    expect(rows.map((r: any) => r.id)).toEqual(['needy', 'first', 'third']);
    expect(rows.map((r: any) => r.orderIndex)).toEqual([1, 0, 2]);
    expect(rows[0].state).toBe('needs');
    expect(rows[0].pill).toBe('needs you');
  });

  it('orders running sessions longest-turn-first and quiet ones most-recent-first', () => {
    // The same rule the phone overview follows, and the reason the rail exists:
    // what is running longest is what is most likely to be done or stuck, and
    // once nothing is running the session that just stopped is the one you came
    // back for.
    const app = loadHomeSessionsApp({
      sessions: sessionMap([
        { id: 'young-turn', status: 'busy', lastSubmitAt: 9_000, lastActivityAt: 10_000 },
        { id: 'old-turn', status: 'busy', lastSubmitAt: 1_000, lastActivityAt: 10_000 },
        { id: 'stale-idle', status: 'idle', lastActivityAt: 2_000 },
        { id: 'fresh-idle', status: 'idle', lastActivityAt: 8_000 },
      ]),
      sessionOrder: ['young-turn', 'old-turn', 'stale-idle', 'fresh-idle'],
      cases: CASES,
    });

    expect(app.buildHomeSessionRows().map((r: any) => r.id)).toEqual([
      'old-turn',
      'young-turn',
      'fresh-idle',
      'stale-idle',
    ]);
  });

  it('shows a session that is not in the order list yet', () => {
    // A freshly created session exists in this.sessions before the order array
    // catches up; its tab is already on screen, so its row must be too.
    const app = loadHomeSessionsApp({
      sessions: sessionMap([{ id: 'known' }, { id: 'fresh' }]),
      sessionOrder: ['known'],
      cases: CASES,
    });

    expect(app.buildHomeSessionRows().map((r: any) => r.id)).toEqual(['known', 'fresh']);
  });

  it('classifies state through the shared phone-overview helper', () => {
    const app = loadHomeSessionsApp({
      sessions: sessionMap([
        { id: 'w', status: 'busy' },
        { id: 'i', status: 'idle' },
        { id: 'd', status: 'stopped' },
        { id: 'e', status: 'error' },
      ]),
      sessionOrder: ['w', 'i', 'd', 'e'],
      cases: CASES,
    });

    // Unstamped rows fall back to the tab order inside a state, so this reads
    // as the state ranking alone: an errored session is blocked on you.
    expect(app.buildHomeSessionRows().map((r: any) => [r.state, r.pill])).toEqual([
      ['error', 'error'],
      ['working', 'working'],
      ['idle', 'idle'],
      ['done', 'done'],
    ]);
  });

  it('labels a row with its case and a short backend badge', () => {
    const app = loadHomeSessionsApp({
      sessions: sessionMap([{ id: 'a', name: 'w1-claudeman', mode: 'codex' }]),
      sessionOrder: ['a'],
      cases: CASES,
    });

    const [row] = app.buildHomeSessionRows();
    expect(row.caseName).toBe('claudeman');
    expect(row.modeBadge).toBe('cx');
    // claude is the default backend and gets no badge — the strip does the same.
    const plain = loadHomeSessionsApp({
      sessions: sessionMap([{ id: 'a', mode: 'claude' }]),
      sessionOrder: ['a'],
      cases: CASES,
    });
    expect(plain.buildHomeSessionRows()[0].modeBadge).toBe('');
  });

  it('badges every non-claude backend, so a new run mode cannot read as claude here', () => {
    // The badge map is a per-mode lookup with a '' fallback, so a mode missing from it
    // is indistinguishable from claude in this rail while the tab strip badges it fine.
    for (const [mode, badge] of [
      ['shell', 'sh'],
      ['opencode', 'oc'],
      ['codex', 'cx'],
      ['gemini', 'gm'],
      ['antigravity', 'ag'],
      ['pi', 'pi'],
    ] as const) {
      const app = loadHomeSessionsApp({
        sessions: sessionMap([{ id: 'a', mode }]),
        sessionOrder: ['a'],
        cases: CASES,
      });
      expect(app.buildHomeSessionRows()[0].modeBadge).toBe(badge);
    }
  });
});

describe('home sessions column: gate', () => {
  it('renders on a wide desktop', () => {
    const app = loadHomeSessionsApp({}, 1512);
    expect(app.shouldShowHomeSessions()).toBe(true);
  });

  it('yields to the persistent rail when the effective tab orientation is vertical', () => {
    expect(loadHomeSessionsApp({}, 1512, 'vertical').shouldShowHomeSessions()).toBe(false);
    expect(loadHomeSessionsApp({}, 1512, 'horizontal').shouldShowHomeSessions()).toBe(true);
  });

  it('stays out of a window too narrow to hold it beside the centered content', () => {
    // Absolutely positioned: below the gate it would overlap the search panel
    // rather than push it aside.
    expect(loadHomeSessionsApp({}, 1100).shouldShowHomeSessions()).toBe(false);
    expect(loadHomeSessionsApp({}, 1179).shouldShowHomeSessions()).toBe(false);
    expect(loadHomeSessionsApp({}, 1180).shouldShowHomeSessions()).toBe(true);
  });

  it('yields to the phone overview, which already lists the same sessions', () => {
    const app = loadHomeSessionsApp({}, 390);
    expect(app.shouldUseMobileOverview()).toBe(true);
    expect(app.shouldShowHomeSessions()).toBe(false);
  });

  it('stays out of a popped-out solo window', () => {
    expect(loadHomeSessionsApp({ isSoloWindow: true }, 1512).shouldShowHomeSessions()).toBe(false);
  });
});

describe('home sessions column: wiring', () => {
  const js = readFileSync(resolve(PUBLIC, 'home-sessions.js'), 'utf8');
  const css = readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8');
  const html = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');

  it('keeps the JS width gate and the CSS media query in agreement', () => {
    // Two gates for one decision: the JS one hides the element, the CSS one is
    // the backstop for a resize that outruns the matchMedia listener. Drift
    // means a column that overlaps the welcome content at some widths.
    const jsMin = Number(/HOME_SESSIONS_MIN_WIDTH = (\d+)/.exec(js)?.[1]);
    const cssMax = Number(/@media \(max-width: (\d+)px\) \{\s*\.home-sessions \{/.exec(css)?.[1]);
    expect(jsMin).toBeGreaterThan(0);
    expect(cssMax).toBe(jsMin - 1);
  });

  it('re-asserts [hidden] over the flex display', () => {
    // .home-sessions is display:flex, which defeats the `hidden` attribute — the
    // module's only visibility lever — unless this rule exists.
    expect(css).toMatch(/\.home-sessions\[hidden\]\s*\{\s*display:\s*none;/);
  });

  it('has a CSS backstop that suppresses the homepage rail in vertical mode', () => {
    expect(css).toMatch(
      /html\[data-tab-orientation='vertical'\]\s+\.home-sessions\s*\{\s*display:\s*none\s*!important;/
    );
  });

  it('reuses the tab-load spinner rather than declaring a second one', () => {
    // The working ring is the same motion a tab shows while it loads, on both
    // home screens. Re-declaring the keyframes here is how they drift apart.
    expect(js).toContain('tab-load-spin');
    expect(css).toMatch(/\.home-sessions-dot--working::after[\s\S]*?animation: tab-load-spin/);
    expect(css).not.toMatch(/@keyframes home-sessions-load-spin/);
    const mobileCss = readFileSync(resolve(PUBLIC, 'mobile.css'), 'utf8');
    expect(mobileCss).toMatch(/\.mobile-overview-dot--working::after[\s\S]*?animation: tab-load-spin/);
  });

  it('gives the working dot the same green halo on both home screens', () => {
    const halo = /box-shadow: 0 0 8px 2px color-mix\(in srgb, var\(--green\) 55%, transparent\)/;
    expect(css).toMatch(halo);
    expect(readFileSync(resolve(PUBLIC, 'mobile.css'), 'utf8')).toMatch(halo);
  });

  it('ships the container hidden, inside the welcome overlay, loaded after mobile-overview.js', () => {
    expect(html).toMatch(/<aside class="home-sessions" id="homeSessions" hidden><\/aside>/);
    const overlayStart = html.indexOf('id="welcomeOverlay"');
    const aside = html.indexOf('id="homeSessions"');
    const content = html.indexOf('class="welcome-content"');
    expect(overlayStart).toBeGreaterThan(-1);
    expect(aside).toBeGreaterThan(overlayStart);
    expect(aside).toBeLessThan(content);
    // Load order: the module reuses prototype methods installed by
    // mobile-overview.js and the comparator installed by constants.js. Compare
    // the <script> tags, not any mention: both files are named in explanatory
    // comments earlier in the document.
    expect(html.indexOf('src="home-sessions.js"')).toBeGreaterThan(html.indexOf('src="mobile-overview.js"'));
    expect(html.indexOf('src="mobile-overview.js"')).toBeGreaterThan(html.indexOf('src="constants.js"'));
  });
});

describe('home screens: one order, one numbering', () => {
  it('produces the same order on the rail and the phone overview for one input', () => {
    // Both surfaces claim to share CodemanSessionOrder. Nothing used to assert
    // they actually produce one order for one input, so a future local sort in
    // either builder would silently split them. The rail is one list; the phone
    // splits NEEDS YOU / CURRENT, so rail order must equal the concatenation.
    const fixture = [
      { id: 'blocked-new', lastActivityAt: 5_000 },
      { id: 'idle-old', lastActivityAt: 3_000 },
      { id: 'run-new', status: 'busy', lastSubmitAt: 8_000, lastActivityAt: 9_500 },
      { id: 'blocked-old', lastActivityAt: 1_000 },
      { id: 'run-old', status: 'busy', lastSubmitAt: 2_000, lastActivityAt: 9_600 },
      { id: 'idle-new', lastActivityAt: 9_000 },
    ];
    const pendingHooks = new Map([
      ['blocked-new', new Set(['permission_prompt'])],
      ['blocked-old', new Set(['permission_prompt'])],
    ]);
    const sessionOrder = fixture.map((s) => s.id);
    const app = loadHomeSessionsApp({
      sessions: sessionMap(fixture),
      sessionOrder,
      cases: CASES,
      pendingHooks,
    });

    const railIds = app.buildHomeSessionRows().map((r: any) => r.id);
    const model = app.buildMobileOverviewModel({
      sessions: app.sessions,
      cases: CASES,
      sessionOrder,
      pendingHooks,
    });
    const phoneIds = [...model.needsYou, ...model.current].map((r: any) => r.id);

    expect(railIds).toEqual(phoneIds);
    // And the shared order is the documented one: blocked longest-first, then
    // running longest-first, then quiet newest-first.
    expect(railIds).toEqual(['blocked-old', 'blocked-new', 'run-old', 'run-new', 'idle-new', 'idle-old']);
  });

  it('numbers rows over the LIVE projection when sessionOrder holds a dead id', () => {
    // sessionOrder can transiently contain a deleted session (delete raced the
    // order sync). The strip paints numbers over live sessions only, and the
    // Alt+digit handler resolves through the same projection, so the rail must
    // number alpha=1, beta=2 with no hole where the ghost sits.
    const app = loadHomeSessionsApp({
      sessions: sessionMap([{ id: 'alpha' }, { id: 'beta' }]),
      sessionOrder: ['ghost', 'alpha', 'beta'],
      cases: CASES,
    });
    expect(app.buildHomeSessionRows().map((r: any) => [r.id, r.orderIndex])).toEqual([
      ['alpha', 0],
      ['beta', 1],
    ]);
  });

  it('Alt+digit resolves through the live-session projection in app.js', () => {
    // Static guard for the handler half of the invariant above: the digit
    // branch must filter sessionOrder against live sessions before indexing,
    // for sessions AND for the web-tab continuation.
    const appJs = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
    const start = appJs.indexOf('^Digit([1-9])$');
    expect(start).toBeGreaterThan(-1);
    const branch = appJs.slice(start, start + 1200);
    expect(branch).toContain('this.sessionOrder.filter((id) => this.sessions.has(id))');
    expect(branch).toContain('idx < live.length');
    expect(branch).toContain('idx - live.length');
    expect(branch).not.toContain('this.sessionOrder[idx]');
  });
});
