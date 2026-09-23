// Port: none (pure model + fake-DOM row builders — no browser, no server).
//
// The phone overview and the desktop home rail showing an exited agent as
// "exited" rather than "idle" (Ark0N/Codeman#446).
//
// The server publishes `session.paneExit` when the agent inside a local tmux
// pane has exited, while `status` stays `idle` or `busy` by design. Part 1 of
// #446 taught the tab strip and the rich rail rows to say so; both home screens
// still said "idle" beside nothing running. `_mobileOverviewExit()`
// (mobile-overview.js) is now the one rule all three surfaces read. It changes
// what a row SHOWS and leaves its `state` alone, because `state` picks the
// section and the sort order.
//
// `paneExitLabel()` is lifted out of the shipped app.js rather than restated
// here, so a change to what counts as "exited" there reaches these tests.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');

/** The shipped `paneExitLabel()` from app.js, as source text. */
function paneExitLabelSource(): string {
  const appJs = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
  const match = appJs.match(/function paneExitLabel\(paneExit\) \{[\s\S]*?\n\}\n/);
  if (!match) throw new Error('paneExitLabel() not found in app.js');
  return match[0];
}

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

/** Every className in a fake-DOM subtree, depth first. */
function classNames(el: any): string[] {
  return [el.className, ...(el.children || []).flatMap(classNames)].filter(Boolean);
}

function loadApp({ withPaneExitLabel = true } = {}) {
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({
    CodemanApp,
    console,
    window: { innerWidth: 1512 },
    document: {
      documentElement: { getAttribute: () => null },
      getElementById: () => null,
      createElement: () => fakeElement(),
      createElementNS: () => fakeElement(),
    },
    MobileDetection: { getDeviceType: () => 'desktop' },
  });
  if (withPaneExitLabel) vm.runInContext(paneExitLabelSource(), context, { filename: 'app.js' });
  for (const file of ['constants.js', 'mobile-overview.js', 'home-sessions.js']) {
    vm.runInContext(readFileSync(resolve(PUBLIC, file), 'utf8'), context, { filename: file });
  }
  const app = new (CodemanApp as any)();
  app.getSessionName = (session: any) => session.name || session.id.slice(0, 8);
  app._shortenHomePath = (p: string) => p || '';
  app.loadAppSettingsFromStorage = () => ({});
  app.cases = [];
  app.pendingHooks = new Map();
  return app;
}

const EXIT_AT = 1_700_000_000_000;

function sessions(list: Array<Record<string, any>>) {
  return new Map(list.map((s) => [s.id, { status: 'idle', mode: 'claude', workingDir: '/w', ...s }]));
}

describe('the desktop home rail', () => {
  it('says "exited" for an idle session whose agent exited, and measures from the exit', () => {
    const app = loadApp();
    app.sessions = sessions([{ id: 'gone', paneExit: { status: 3, at: EXIT_AT }, lastActivityAt: 5 }]);
    app.sessionOrder = ['gone'];

    const [row] = app.buildHomeSessionRows();
    expect(row.state).toBe('idle');
    expect(row.display).toBe('exited');
    expect(row.pill).toBe('exited');
    expect(row.since).toEqual({ key: 'exited', at: EXIT_AT });
  });

  it('draws a neutral row: no idle or working class on the row, the dot or the pill', () => {
    // A pane whose agent died mid-turn still has `status: 'busy'`, so without
    // the display class its dot would pulse green beside "exited".
    const app = loadApp();
    app.sessions = sessions([{ id: 'gone', status: 'busy', paneExit: { at: EXIT_AT } }]);
    app.sessionOrder = ['gone'];

    const [row] = app.buildHomeSessionRows();
    expect(row.state).toBe('working');
    const classes = classNames(app._buildHomeSessionRow(row));
    expect(classes).toEqual(
      expect.arrayContaining([
        'home-sessions-row home-sessions-row--exited',
        'home-sessions-dot home-sessions-dot--exited',
        'home-sessions-pill home-sessions-pill--exited',
      ])
    );
    expect(classes.join(' ')).not.toMatch(/--(working|idle)\b/);
  });

  it('lets a pending permission prompt win over the exit', () => {
    const app = loadApp();
    app.sessions = sessions([{ id: 'blocked', paneExit: { status: 0, at: EXIT_AT } }]);
    app.sessionOrder = ['blocked'];
    app.pendingHooks = new Map([['blocked', new Set(['permission_prompt'])]]);

    const [row] = app.buildHomeSessionRows();
    expect(row.display).toBe('needs');
    expect(row.pill).toBe('needs you');
  });

  it('leaves a session without an exit exactly as it was', () => {
    const app = loadApp();
    app.sessions = sessions([{ id: 'live', lastActivityAt: 5 }]);
    app.sessionOrder = ['live'];

    const [row] = app.buildHomeSessionRows();
    expect(row.display).toBe('idle');
    expect(row.pill).toBe('idle');
    expect(row.since).toEqual({ key: 'idle', at: 5 });
  });

  it('degrades to no override when a stale cached app.js lacks paneExitLabel', () => {
    const app = loadApp({ withPaneExitLabel: false });
    app.sessions = sessions([{ id: 'gone', paneExit: { status: 3, at: EXIT_AT } }]);
    app.sessionOrder = ['gone'];

    expect(app.buildHomeSessionRows()[0].pill).toBe('idle');
  });
});

describe('the phone overview', () => {
  it('says "exited" and keeps the row in its section', () => {
    const app = loadApp();
    const model = app.buildMobileOverviewModel({
      sessions: sessions([
        { id: 'gone', paneExit: { status: 137, at: EXIT_AT } },
        { id: 'live', lastActivityAt: 5 },
      ]),
      cases: [],
      sessionOrder: ['gone', 'live'],
    });

    const byId = Object.fromEntries(model.current.map((r: any) => [r.id, r]));
    expect(byId.gone).toMatchObject({ state: 'idle', display: 'exited', pill: 'exited' });
    expect(byId.gone.since).toEqual({ key: 'exited', at: EXIT_AT });
    expect(byId.live).toMatchObject({ display: 'idle', pill: 'idle' });
  });

  it('draws a neutral row', () => {
    const app = loadApp();
    const model = app.buildMobileOverviewModel({
      sessions: sessions([{ id: 'gone', status: 'busy', paneExit: { at: EXIT_AT } }]),
      cases: [],
    });
    app._pendingApprovalForSession = () => null;

    const classes = classNames(app._buildMobileOverviewRow(model.current[0]));
    expect(classes).toEqual(
      expect.arrayContaining([
        'mobile-overview-row mobile-overview-row--exited',
        'mobile-overview-dot mobile-overview-dot--exited',
        'mobile-overview-pill mobile-overview-pill--exited',
      ])
    );
    expect(classes.join(' ')).not.toMatch(/--(working|idle)\b/);
  });
});

describe('the exited pill styles', () => {
  it('gives both home screens a neutral exited pill', () => {
    expect(readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8')).toMatch(/\.home-sessions-pill--exited \{/);
    expect(readFileSync(resolve(PUBLIC, 'mobile.css'), 'utf8')).toMatch(/\.mobile-overview-pill--exited \{/);
  });
});
